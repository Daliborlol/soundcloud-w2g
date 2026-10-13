/*
 * w2g room tab, top frame, document_start (see docs/ARCHITECTURE.md, "content/w2g-room.js").
 *
 * - Detects the room (streamkey, joined, name) and keeps the background's room registry up to date.
 * - Owns the extension's only write path into w2g: a FIFO add queue that posts to the room's playlist API.
 * - Adds the SoundCloud launcher next to w2g's search box and the panel (preview, add, the user's library).
 * - Opens the panel when a SoundCloud link that w2g can't play by itself is pasted or dropped into w2g's search box.
 */
(function () {
  'use strict';

  // Closed shadow roots keep page and ad scripts from reaching into the launcher and the panel (no element references,
  // no input values, no way to click our buttons). They do NOT hide rendered text: window.find() matches text inside
  // closed shadow trees, so whatever the open panel shows (the library, a preview) can be read by page scripts.
  // Hence: every action needs a trusted event, and only a real paste or drop into w2g's search box counts as a
  // detected link (document.execCommand lets page scripts make the browser fire trusted input events, but never a
  // paste or a drop). The library shows only after a trusted click on the launcher (or inside the panel); a panel
  // opened for a detected link shows just that link's preview. Residual risk: a page script that controls what the
  // user pastes or drops into w2g's box (e.g. through the clipboard) can still get the preview of a link of its choice
  // rendered and read it. Only rendering the panel in an extension-origin iframe would close that.
  const SHADOW_MODE = 'closed';
  const INSTANCE_KEY = '__scw2gRoom';
  const TAKEOVER_EVENT = 'scw2g:room-takeover';

  const previous = globalThis[INSTANCE_KEY];
  if (previous && previous.isAlive()) return;
  if (previous) previous.destroy();

  const scUrl = globalThis.SCW2G && globalThis.SCW2G.url;
  if (!scUrl || typeof chrome === 'undefined' || !chrome.runtime) return;

  const API = 'https://w2g-api.w2g.tv';
  const BATCH_SIZE = 50; // w2g answers 403 to more than 50 items per request
  const BATCH_GAP_MS = 3000; // w2g's own client waits 3 s between chunks
  const POST_GAP_MS = 1000;
  const FAILURE_WAIT_MS = 11000; // Cloudflare's 429 carries Retry-After: 10
  const MAX_RETRIES = 2;
  // A POST still pending after this is treated like an opaque failure (Cloudflare gives a slow origin ~100 s; a
  // connection that died while the laptop slept can hang even longer).
  const POST_TIMEOUT_MS = 30000;
  const CANCEL_SETTLE_MS = 2000; // after a cancel, let a POST that reached w2g finish there before checking
  const LANDED_CHECK_MS = 8000;
  const QUEUED_REPORT_MS = 60 * 1000; // the background gives up on a job after 10 min without progress
  const REPROBE_MS = 5000;
  const TAIL_SLACK = 5; // items other members may append while a failed batch is being verified
  const GET_TRIES = 3;
  const PANEL_WIDTH = 440;
  // Above w2g's bottom banners (PWA install prompt: 1500); the panel closes whenever w2g opens a modal instead.
  const PANEL_Z = 1600;
  const SECTION_LIMIT = 5;
  const FINISHED_JOB_TTL_MS = 8000;
  const BADGE_MS = 4000;
  const FLOATING_DELAY_MS = 3000;

  const ERROR_TEXT = {
    INVALID_URL: "That doesn't look like a SoundCloud link.",
    UNSUPPORTED_URL: "This SoundCloud page has no tracks to add. Try a playlist, album, station, or a profile's tracks or likes.",
    NOT_FOUND: "SoundCloud couldn't find it. It may be deleted, private (use its secret link), or someone else's personal playlist.",
    AUTH_REQUIRED: 'This needs your SoundCloud login. Log in on soundcloud.com in this browser, then try again.',
    AUTH_EXPIRED: 'Your SoundCloud login needs a refresh. Open soundcloud.com once, then try again.',
    BOT_CHALLENGE: 'SoundCloud wants to check that you are human. Open soundcloud.com, then try again.',
    RATE_LIMITED: 'Too many requests right now. Wait a minute, then try again.',
    NETWORK: 'Network problem. Check your connection, then try again.',
    SC_HTTP: 'SoundCloud had a problem. Try again in a moment.',
    EMPTY: 'Nothing here can be played in w2g.',
    NO_ROOM: 'No w2g room is open.',
    NOT_JOINED: "This browser hasn't joined the room. Click 'Join the Room' first.",
    W2G_UNREACHABLE: "Couldn't reach this room on w2g. Check your connection, then try again.",
    MODERATED: 'The room owner locked the playlist.',
    ROOM_UNREACHABLE: 'Reload this page, then try again.',
    W2G_FAILED: "w2g didn't accept the tracks. Wait a moment, then try again.",
    PLAYLIST_CHANGED: 'The room switched to another playlist, so adding stopped.',
    ROOM_STALLED: "The room tab stopped responding, so adding stopped. Check the room's playlist.",
    CANCELLED: 'Cancelled.',
    INTERNAL: 'Something went wrong in the extension. Reload this page, then try again.',
  };
  const LOST_CONNECTION_TEXT = 'Lost the connection to w2g, so adding stopped.';
  // Read out when a detected link opens the panel: the focus stays in w2g's box, so nothing else says so.
  const LINK_OPENED_TEXT = "SoundCloud panel opened for your link. The SoundCloud button next to w2g's search takes you there.";
  const LINK_SHOWN_TEXT = 'The SoundCloud panel now shows your link.';
  const OPEN_SOUNDCLOUD_FIXES = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'BOT_CHALLENGE']);
  const LOGIN_ERRORS = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED']);
  const RETRYABLE = new Set(['NETWORK', 'RATE_LIMITED', 'SC_HTTP', 'INTERNAL', 'BOT_CHALLENGE', 'AUTH_EXPIRED', 'W2G_UNREACHABLE']);

  const SKIP_TEXT = {
    geo_blocked: (n) => `${n} not available in your country`,
    preview_only: (n) => `${n} Go+ ${n === 1 ? 'preview' : 'previews'} skipped`,
    unavailable: (n) => `${n} unavailable`,
    not_streamable: (n) => `${n} not streamable`,
    not_embeddable: (n) => `${n} can't play outside SoundCloud`,
    processing: (n) => `${n} still processing`,
  };
  const WARNING_TEXT = {
    truncated: 'Only the first 1,000 tracks are included.',
    private_tracks: 'Includes private tracks, shared through their secret links.',
  };
  const KIND_LABEL = {
    track: 'Track',
    playlist: 'Playlist',
    'system-playlist': 'SoundCloud mix',
    'user-tracks': 'Tracks',
    'user-likes': 'Likes',
    'user-reposts': 'Reposts',
    'user-popular-tracks': 'Popular tracks',
  };

  const lifetime = new AbortController();
  const cleanups = [];
  const startedAt = Date.now();
  let destroyed = false;

  function on(target, type, listener, options) {
    target.addEventListener(type, listener, Object.assign({}, options, { signal: lifetime.signal }));
  }

  function isAlive() {
    if (destroyed) return false;
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  const instance = { isAlive, destroy };
  globalThis[INSTANCE_KEY] = instance;

  // ---------------------------------------------------------------------------------------------------------------
  // Small helpers

  class RoomError extends Error {
    constructor(code, message, details) {
      super(message || ERROR_TEXT[code] || code);
      this.code = code;
      if (details) Object.assign(this, details);
    }
  }

  const isCancel = (e) => Boolean(e && e.code === 'CANCELLED');
  const cancelled = () => new RoomError('CANCELLED');
  // Page scripts can dispatch any event; only real user input may start an action.
  const trusted = (fn) => (e) => {
    if (e && e.isTrusted) fn(e);
  };
  const fmt = (n) => Number(n).toLocaleString('en');
  const plural = (n, word) => `${fmt(n)} ${n === 1 ? word : word + 's'}`;
  const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u) ? u : null);

  function failure(code, message, details) {
    return { ok: false, error: Object.assign({ code, message: message || ERROR_TEXT[code] || code }, details) };
  }

  function errorText(error) {
    if (!error) return ERROR_TEXT.INTERNAL;
    return ERROR_TEXT[error.code] || error.message || ERROR_TEXT.INTERNAL;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(cancelled());
      const done = () => {
        if (signal) signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        reject(cancelled());
      };
      const timer = setTimeout(done, Math.max(0, ms));
      if (signal) signal.addEventListener('abort', abort, { once: true });
    });
  }

  const sleepUntil = (time, signal) => sleep(time - Date.now(), signal);

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
  }

  function randomId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Messaging with the background

  async function send(message) {
    if (!isAlive()) {
      queueMicrotask(destroy);
      return failure('INTERNAL', 'The extension was updated or reloaded. Reload this page.');
    }
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response && typeof response === 'object') return response;
    } catch (_) {
      if (!isAlive()) queueMicrotask(destroy);
    }
    return failure('INTERNAL', 'The extension did not answer. Reload this page, then try again.');
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object' || !isAlive() || sender.id !== chrome.runtime.id) return false;
    const reply = (response) => {
      try {
        sendResponse(response);
      } catch (_) { /* the background went away */ }
    };
    if (msg.type === 'room:ping') {
      ping().then(reply, () => reply(failure('INTERNAL')));
      return true;
    }
    if (msg.type === 'room:add') {
      handleRoomAdd(msg).then(reply, (e) => reply(failure('INTERNAL', String((e && e.message) || e), { added: 0 })));
      return true;
    }
    if (msg.type === 'room:cancel') {
      handleRoomCancel(msg).then(reply, () => reply(failure('INTERNAL')));
      return true;
    }
    if (msg.type === 'sc:login-changed') {
      onLoginChanged();
      reply({ ok: true });
      return false;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Room detection

  const API_ENTRY_RE = /^https:\/\/w2g-api\.w2g\.tv\/(?:rooms|streams)\/([A-Za-z0-9]+)\/([^?#]*)/;
  const JOINED_PATH_RE = /^(?:sync_state|playlists\/[^/]+\/playlist_items)$/;

  const room = {
    streamkey: streamkeyFromUrl(),
    joined: false,
    roomName: null,
    locked: false, // the playlist is moderated and this user is neither owner nor moderator
    playlistTitle: null,
    checkedAt: 0,
    unreachable: false, // the last check failed while w2g's join dialog wasn't showing
  };
  let announced = '';
  let announceTimer = 0;
  let pendingActive = false;
  let lastActiveAt = 0;
  let probing = null;

  function streamkeyFromUrl() {
    const query = new URLSearchParams(location.search);
    const id = query.get('room_id') || query.get('r');
    const key = id ? id.split('-').pop() : null; // persistent rooms use <name>-<streamkey>
    return key && /^[A-Za-z0-9]+$/.test(key) ? key : null;
  }

  function setStreamkey(key) {
    if (!key || key === room.streamkey) return;
    Object.assign(room, { streamkey: key, joined: false, locked: false, playlistTitle: null, checkedAt: 0, unreachable: false });
    announce();
    scheduleRender();
  }

  function setJoined(joined) {
    if (joined) room.unreachable = false;
    if (room.joined === joined) return;
    room.joined = joined;
    announce();
    scheduleRender();
  }

  // After joining, the URL only holds a per-user ?access_key=, so w2g's own API traffic is the main streamkey source.
  function onResourceEntries(entries) {
    for (const entry of entries) {
      const match = API_ENTRY_RE.exec(entry.name);
      if (!match || match[1] === 'default') continue;
      const status = entry.responseStatus;
      // w2g reads sync_state and playlist_items only after joining. Failed requests (like our own probes of a room
      // this browser hasn't joined) show up with status 0.
      if (JOINED_PATH_RE.test(match[2]) && (status === undefined || (status >= 200 && status < 300))) {
        setStreamkey(match[1]);
        setJoined(true);
      } else if (!room.streamkey) {
        setStreamkey(match[1]);
      }
    }
  }

  function watchResources() {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const observer = new PerformanceObserver((list) => onResourceEntries(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
      cleanups.push(() => observer.disconnect());
    } catch (_) {
      onResourceEntries(performance.getEntriesByType('resource'));
    }
  }

  function announce(force) {
    const state = JSON.stringify([room.streamkey, room.joined, room.roomName, room.unreachable]);
    if (state === announced && !force && !pendingActive) return;
    announced = state;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      send({
        type: 'room:hello',
        streamkey: room.streamkey,
        joined: room.joined,
        roomName: room.roomName,
        unreachable: room.unreachable,
        url: location.href,
      });
      if (pendingActive) {
        pendingActive = false;
        send({ type: 'room:active' });
      }
    }, 50);
  }

  function activate() {
    if (document.visibilityState !== 'visible' || Date.now() - lastActiveAt < 1000) return;
    lastActiveAt = Date.now();
    pendingActive = true;
    announce(true);
    // Coming back from logging in on soundcloud.com: refresh the login hint.
    const lib = view.library;
    if (ui.open && ui.libraryShown && lib && lib.data && !lib.data.loggedIn) loadLibrary(false);
  }

  // Last resort when neither the URL nor w2g's traffic named the room: w2g's invite links (https://w2g.tv/?r=<sk>).
  function streamkeyFromShareLink() {
    const link = document.querySelector('a[href*="w2g.tv%2F%3Fr%3D"]');
    const match = link && /w2g\.tv%2F%3Fr%3D([A-Za-z0-9]+)/.exec(link.getAttribute('href'));
    return match ? match[1] : null;
  }

  function readRoomName() {
    // Desktop shows it in .w2g-users; the mobile header only has the bound element.
    for (const el of document.querySelectorAll('.w2g-users a.w2g-bind-moderation, [data-w2g*="room_name"]')) {
      const name = el.textContent.trim();
      if (name) return name;
    }
    return null;
  }

  function introOpen() {
    const modal = document.getElementById('intro-modal');
    return Boolean(modal && !modal.classList.contains('hidden') && modal.querySelector('#w2g-join-button'));
  }

  // body.mod-pl-active is w2g's live flag for a moderated playlist; owners and moderators also get body.moderator.
  function lockHint() {
    const classes = document.body && document.body.classList;
    if (!classes || !(classes.contains('w2g-desktop') || classes.contains('w2g-mobile'))) return null;
    return classes.contains('mod-pl-active') && !classes.contains('moderator');
  }

  function ownRole(users) {
    const tile = document.querySelector('[id^="user-"].self');
    const jid = tile ? tile.id.slice('user-'.length) : null;
    const me = jid ? users.find((u) => u.jid === jid) : null;
    if (me && me.role) return me.role;
    const classes = document.body ? document.body.classList : null;
    if (classes && classes.contains('owner')) return 'owner';
    if (classes && classes.contains('moderator')) return 'moderator';
    return 'user';
  }

  async function ping() {
    // The background pings before every add; settle a doubtful "not joined" first, but answer quickly.
    if (room.streamkey && !room.joined && !introOpen()) await withTimeout(probe(), 1500);
    return { ok: true, streamkey: room.streamkey, joined: room.joined, roomName: room.roomName, unreachable: room.unreachable };
  }

  function probe() {
    if (!room.streamkey) return Promise.resolve();
    if (!probing) {
      probing = checkRoom({ tries: 2 }).catch(() => {}).finally(() => {
        probing = null;
        scheduleRender();
      });
      scheduleRender();
    }
    return probing;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // w2g API (content-script fetches go out with Origin https://w2g.tv, which w2g's CORS allows)

  async function w2gGet(path, { signal, tries = GET_TRIES } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) await sleep(700 * attempt, signal);
      try {
        const res = await fetch(API + path, { credentials: 'include', cache: 'no-store', signal });
        if (!res.ok) {
          lastError = new Error('HTTP ' + res.status);
          if (res.status < 500 && res.status !== 429) break;
          continue;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (e) {
        if (signal && signal.aborted) throw cancelled();
        if (e instanceof SyntaxError) throw e;
        // w2g's and Cloudflare's error responses carry no CORS headers: 403, 404 and 429 look like network errors.
        lastError = e;
      }
    }
    throw lastError || new Error('request failed');
  }

  async function w2gPost(path, body, signal) {
    const res = await fetch(API + path, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  }

  function parseSyncState(body) {
    if (!body || !Array.isArray(body.state)) return null;
    const out = { lists: [], selectedPlaylist: null, moderation: {}, users: [] };
    for (const entry of body.state) {
      if (!Array.isArray(entry)) continue;
      const [name, value] = entry;
      if (name === 'playlists') {
        const payload = (value && value.payload) || {};
        out.lists = Array.isArray(payload.lists) ? payload.lists : [];
        out.selectedPlaylist = typeof payload.selectedPlaylist === 'string' ? payload.selectedPlaylist : null;
      } else if (name === 'stream_moderation') {
        for (const x of [].concat(value || [])) if (x && x.payload) Object.assign(out.moderation, x.payload);
      } else if (name === 'user_list') {
        out.users = [].concat(value || []).map((x) => x && x.payload).filter(Boolean);
      }
    }
    return out;
  }

  // GET sync_state: proves membership and yields the selected playlist and the moderation state.
  // transient: membership was proven moments ago (a job's later checks), so a failed read is a network blip: it must
  // not mark the room as not joined, and the caller waits and retries.
  async function checkRoom({ signal, tries = GET_TRIES, transient = false } = {}) {
    const key = room.streamkey;
    if (!key) throw new RoomError('NOT_JOINED', "Couldn't find this room's ID. Reload the page.");
    let state = null;
    try {
      state = parseSyncState(await w2gGet(`/rooms/${key}/sync_state`, { signal, tries }));
    } catch (e) {
      if (isCancel(e)) throw e;
    }
    if (key !== room.streamkey) throw new RoomError('NOT_JOINED', 'The room changed. Try again.');
    if (!state) {
      if (transient) throw new RoomError('W2G_FAILED', LOST_CONNECTION_TEXT, { transient: true });
      // Errors carry no CORS headers, so "not a member" (403) and a network failure look the same here; only w2g's
      // join dialog tells them apart. Either way this is a probe or a job's first check: nothing was posted yet.
      const intro = introOpen();
      room.unreachable = !intro;
      setJoined(false);
      announce(); // also when only `unreachable` changed
      scheduleRender();
      throw new RoomError(intro ? 'NOT_JOINED' : 'W2G_UNREACHABLE');
    }
    const role = ownRole(state.users);
    const locked = Boolean(state.moderation.moderated_playlist) && role !== 'owner' && role !== 'moderator';
    const list = state.lists.find((l) => l && l.key === state.selectedPlaylist);
    Object.assign(room, { locked, playlistTitle: list && list.title ? String(list.title) : null, checkedAt: Date.now() });
    setJoined(true);
    scheduleRender();
    return Object.assign(state, { locked, playlistTitle: room.playlistTitle });
  }

  // A job's checks after its first one: wait out a network blip like the POST path does instead of giving up.
  async function recheckRoom(signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await checkRoom({ signal, transient: true });
      } catch (e) {
        if (!e.transient || attempt >= MAX_RETRIES) throw e;
      }
      await sleep(FAILURE_WAIT_MS, signal);
    }
  }

  function selectedKey(state) {
    if (!state.selectedPlaylist) throw new RoomError('W2G_FAILED', "w2g didn't report which playlist is selected. Reload the page.");
    return state.selectedPlaylist;
  }

  // A job writes only to the list that was selected when it started: w2g's live patches carry no list id (members
  // would see the items in whatever list they show), and one import must not end up split across two lists.
  function assertTarget(state, pinnedKey) {
    if (state.locked) throw new RoomError('MODERATED');
    if (state.selectedPlaylist !== pinnedKey) throw new RoomError('PLAYLIST_CHANGED');
  }

  // Does the playlist end with this batch (allowing a few items other members added meanwhile)? null = can't tell.
  async function batchLanded(key, playlistKey, batch, signal) {
    let items;
    try {
      items = await w2gGet(`/streams/${key}/playlists/${encodeURIComponent(playlistKey)}/playlist_items`, { signal });
    } catch (e) {
      if (isCancel(e)) throw e;
      return null;
    }
    const urls = (Array.isArray(items) ? items : []).map((x) => x && x.url);
    const last = urls.length - batch.length;
    for (let start = last; start >= 0 && start >= last - TAIL_SLACK; start--) {
      if (batch.every((item, i) => urls[start + i] === item.url)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Add queue: FIFO, one job at a time; jobs come from room:add (background) and from the panel.

  const jobs = [];
  let pumping = false;
  let lastPostAt = 0;

  function normalizeItems(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const url = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!httpsUrl(url)) continue;
      // w2g silently drops items with an empty title.
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : url;
      const item = { url, title };
      const thumb = httpsUrl(raw.thumb);
      if (thumb) item.thumb = thumb;
      out.push(item);
    }
    return out;
  }

  function createJob({ id, origin, title, items, addedBefore = [] }) {
    let resolve;
    const finished = new Promise((r) => { resolve = r; });
    return {
      id: id || randomId(origin),
      origin,
      title,
      items,
      total: items.length,
      addedBefore, // panel jobs: URLs of the link's tracks that the jobs it continues added ("Add the remaining N")
      done: 0,
      unsure: 0, // tracks of a batch whose fate is unknown because the job stopped while it was in flight
      status: 'queued',
      cancelling: false,
      error: null,
      playlistKey: null,
      playlistTitle: null,
      controller: new AbortController(),
      queuedTimer: 0,
      endedAt: 0,
      finished,
      settle: resolve,
    };
  }

  const isActive = (job) => job.status === 'queued' || job.status === 'running';
  const jobById = (id) => jobs.find((j) => j.id === id) || null;

  function enqueue(job) {
    jobs.push(job);
    scheduleRender();
    pump();
    return job.finished;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (let job = nextQueued(); job; job = nextQueued()) await execute(job);
    } finally {
      pumping = false;
    }
  }

  const nextQueued = () => jobs.find((j) => j.status === 'queued');

  async function execute(job) {
    clearInterval(job.queuedTimer);
    job.status = 'running';
    reportProgress(job);
    try {
      await runJob(job);
      job.status = 'done';
    } catch (e) {
      job.status = isCancel(e) ? 'cancelled' : 'failed';
      job.error = { code: e.code || 'INTERNAL', message: e.code ? e.message : ERROR_TEXT.INTERNAL };
      if (!e.code) console.warn('[scw2g] add failed', e);
    }
    finish(job);
  }

  function finish(job) {
    clearInterval(job.queuedTimer);
    job.cancelling = false;
    job.endedAt = Date.now();
    job.settle();
    pruneJobs();
    scheduleRender();
    setTimeout(scheduleRender, BADGE_MS + 50);
    setTimeout(scheduleRender, FINISHED_JOB_TTL_MS + 50);
  }

  function pruneJobs() {
    // A link's last panel job stays: its preview, rebuilt or not, shows its result and adds only what it didn't.
    const linked = new Set(panelJobs.values());
    const keep = (job) => isActive(job) || linked.has(job.id);
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (!keep(jobs[i]) && jobs[i].endedAt < cutoff) jobs.splice(i, 1);
    }
    for (let i = 0; jobs.length > 30 && i < jobs.length;) {
      if (keep(jobs[i])) i++;
      else jobs.splice(i, 1);
    }
  }

  function cancelJob(job) {
    if (!job || !isActive(job)) return;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: ERROR_TEXT.CANCELLED };
      finish(job);
    } else {
      job.cancelling = true;
      job.controller.abort();
      scheduleRender();
    }
  }

  async function runJob(job) {
    const { signal } = job.controller;
    const key = room.streamkey;
    let state = await checkRoom({ signal });
    const pinnedKey = selectedKey(state);
    job.playlistKey = pinnedKey;
    job.playlistTitle = state.playlistTitle;
    let lastBatchAt = 0;
    for (let start = 0; start < job.items.length; start += BATCH_SIZE) {
      if (signal.aborted) throw cancelled();
      if (start > 0) {
        await sleepUntil(lastBatchAt + BATCH_GAP_MS, signal);
        // Fresh state per batch: stop early if the playlist got locked or the room switched to another list.
        state = await recheckRoom(signal);
      }
      assertTarget(state, pinnedKey);
      if (room.streamkey !== key) throw new RoomError('NOT_JOINED', 'The room changed. Try again.');
      const batch = job.items.slice(start, start + BATCH_SIZE);
      await postBatch(job, key, pinnedKey, batch);
      lastBatchAt = Date.now();
      job.done += batch.length;
      reportProgress(job);
    }
  }

  // Posts one batch to the job's list; returns once it is there.
  async function postBatch(job, key, pinnedKey, batch) {
    const { signal } = job.controller;
    for (let attempt = 0; ; attempt++) {
      await sleepUntil(lastPostAt + POST_GAP_MS, signal);
      let landed;
      try {
        landed = await sendBatch(key, pinnedKey, batch, signal);
      } catch (e) {
        // Cancelled while the batch's fate was open: find out before reporting.
        if (isCancel(e) && await landedAfterCancel(job, key, pinnedKey, batch)) return;
        throw e;
      }
      if (landed) return;
      if (landed === null) {
        job.unsure = batch.length;
        throw new RoomError('W2G_FAILED');
      }
      assertTarget(await recheckRoom(signal), pinnedKey);
      if (attempt >= MAX_RETRIES) throw new RoomError('W2G_FAILED');
    }
  }

  // true: w2g took the batch. After a failed POST: whether the batch landed anyway (null: can't tell).
  async function sendBatch(key, pinnedKey, batch, signal) {
    const path = `/rooms/${key}/playlists/${encodeURIComponent(pinnedKey)}/playlist_items/sync_update`;
    try {
      await w2gPost(path, { add_items: batch }, AbortSignal.any([signal, AbortSignal.timeout(POST_TIMEOUT_MS)]));
      return true;
    } catch (_) {
      if (signal.aborted) throw cancelled();
      // Opaque: a 403 (locked, not a member), Cloudflare's 429, a real network failure and our own timeout all look
      // the same here, and the POST may have landed anyway. Never retry blindly.
    } finally {
      lastPostAt = Date.now();
    }
    await sleep(FAILURE_WAIT_MS, signal);
    return batchLanded(key, pinnedKey, batch, signal);
  }

  // The job was cancelled during a POST or before its failure was verified. The job signal is aborted, so check with
  // a fresh one; true when the batch is in the playlist, and an unknown outcome is flagged for the result text.
  async function landedAfterCancel(job, key, pinnedKey, batch) {
    await sleep(lastPostAt + CANCEL_SETTLE_MS - Date.now());
    const landed = await batchLanded(key, pinnedKey, batch, AbortSignal.timeout(LANDED_CHECK_MS)).catch(() => null);
    if (landed === null) job.unsure = batch.length;
    return landed === true;
  }

  function reportProgress(job) {
    if (job.origin === 'background') {
      send({ type: 'job:progress', jobId: job.id, phase: 'adding', done: job.done, total: job.total });
    }
    scheduleRender();
  }

  // A background job waiting behind another one: say so at once and every minute, so the background's stall timer
  // measures the room tab's silence and not the queue.
  function reportQueued(job) {
    const report = () => {
      if (job.status !== 'queued') {
        clearInterval(job.queuedTimer);
        return;
      }
      const position = jobs.filter((j) => j.status === 'queued').indexOf(job) + 1;
      send({ type: 'job:progress', jobId: job.id, phase: 'queued', done: 0, total: job.total, position });
    };
    report();
    if (!job.queuedTimer) job.queuedTimer = setInterval(report, QUEUED_REPORT_MS);
  }

  async function handleRoomAdd(msg) {
    if (!Array.isArray(msg.items)) return failure('INTERNAL', 'room:add needs an items array.', { added: 0 });
    const id = msg.jobId != null ? String(msg.jobId) : null;
    // A re-sent request (e.g. after a service worker restart) joins the running or finished job instead of adding
    // twice; a failed or cancelled one runs again.
    let job = id ? jobs.find((j) => j.id === id && j.origin === 'background' && (isActive(j) || j.status === 'done')) : null;
    if (!job) {
      const items = normalizeItems(msg.items);
      if (!items.length) return failure('EMPTY', 'There are no tracks to add.', { added: 0 });
      const title = typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim() : plural(items.length, 'track');
      job = createJob({ id, origin: 'background', title, items });
      enqueue(job);
    }
    if (job.status === 'queued') reportQueued(job);
    await job.finished;
    if (job.status === 'done') return { ok: true, added: job.done, playlistKey: job.playlistKey };
    return { ok: false, error: Object.assign({}, job.error, { added: job.done }) };
  }

  // The background gave up on a job (e.g. no progress for 10 min): make sure it never adds anything afterwards.
  async function handleRoomCancel(msg) {
    const id = msg.jobId != null ? String(msg.jobId) : null;
    const matches = id ? jobs.filter((j) => j.id === id && j.origin === 'background') : [];
    const job = matches.find(isActive) || matches.pop() || null;
    if (!job || !isActive(job)) return { ok: true, cancelled: false, added: job ? job.done : 0 };
    cancelJob(job);
    // A running job first checks whether its in-flight batch landed; answer with what was really added.
    await withTimeout(job.finished, CANCEL_SETTLE_MS + LANDED_CHECK_MS + 1000);
    return { ok: true, cancelled: job.status !== 'done', added: job.done };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // View state

  const view = {
    settings: null,
    preview: null, // { status: 'loading'|'ready'|'error', url, result?, error?, jobId? }
    library: null, // { status: 'loading'|'ready'|'error', data, error?, at }
    libraryVersion: 0,
    expanded: new Set(),
  };
  const DEFAULT_SETTINGS = { skipPreviews: true, confirmAbove: 100 };
  // Previewed link -> id of the panel's last job for it. A preview is rebuilt on a Go+ toggle (here, in the popup or
  // in another room tab), on Load and when the user comes back to a link; it must not lose its add.
  const panelJobs = new Map();
  let previewSeq = 0;
  let librarySeq = 0;
  let settingsRequest = null;
  let settingsVersion = 0;
  let settingsWrites = 0;

  const ui = {
    open: false,
    openedBy: null, // 'launcher' | 'link' (a link detected in w2g's search box)
    libraryShown: false, // the user asked for the library since the panel opened (see SHADOW_MODE)
    mode: null,
    launcherHost: null,
    launcher: null,
    status: null,
    badge: null,
    badgeState: null,
    meterFill: null,
    panelHost: null,
    panel: null,
    input: null,
    target: null,
    banner: null,
    previewBox: null,
    previewParts: null,
    shownPreview: undefined,
    shownBanner: undefined,
    skip: null,
    jobsBox: null,
    jobRows: new Map(),
    libraryBody: null,
    refresh: null,
    shownLibraryVersion: -1,
    entryButtons: [],
    reprobeTimer: 0,
  };

  function bumpLibrary() {
    view.libraryVersion++;
    scheduleRender();
  }

  async function loadLibrary(refresh) {
    const seq = ++librarySeq;
    view.library = Object.assign({}, view.library, { status: 'loading' });
    bumpLibrary();
    const res = await send(refresh ? { type: 'sc:library', refresh: true } : { type: 'sc:library' });
    if (seq !== librarySeq) return;
    const previousData = view.library && view.library.data;
    view.library = res.ok && res.library
      ? { status: 'ready', data: res.library, at: Date.now() }
      : { status: 'error', data: previousData || null, error: res.error, at: Date.now() };
    bumpLibrary();
  }

  // The user asked for their library (the launcher, "Show my SoundCloud", Refresh). A copy from the last minute is
  // shown as is.
  function showLibrary({ refresh = false } = {}) {
    ui.libraryShown = true;
    const lib = view.library;
    if (refresh || !lib || (lib.status !== 'loading' && Date.now() - lib.at > 60000)) loadLibrary(refresh);
    else bumpLibrary();
  }

  function loadSettings() {
    if (!settingsRequest) {
      const version = settingsVersion;
      settingsRequest = send({ type: 'settings:get' }).then((res) => {
        if (version === settingsVersion) applySettings(res.ok ? res.settings : null);
      });
    }
    return settingsRequest;
  }

  // Returns true when skipPreviews changed (or wasn't known yet).
  function applySettings(settings) {
    const before = view.settings;
    view.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    scheduleRender();
    return !before || before.skipPreviews !== view.settings.skipPreviews;
  }

  // The popup or another room tab changed the settings. The background reads them on every sc:expand, so the
  // checkbox and the preview have to follow.
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes || !changes.settings || destroyed) return;
    if (settingsWrites) return; // our own settings:set answers with the result
    settingsVersion++;
    if (applySettings(changes.settings.newValue)) reloadPreview();
  }

  async function setSkipPreviews(value) {
    view.settings = Object.assign({}, DEFAULT_SETTINGS, view.settings, { skipPreviews: value });
    settingsVersion++;
    settingsWrites++;
    let res;
    try {
      res = await send({ type: 'settings:set', patch: { skipPreviews: value } });
    } finally {
      settingsWrites--;
    }
    if (res.ok && res.settings && !settingsWrites) view.settings = Object.assign({}, view.settings, res.settings);
    scheduleRender();
    // The background applies the setting when sc:expand arrives, so the preview has to be rebuilt, also while it is
    // still loading (previewSeq drops the answer to the old request).
    reloadPreview();
  }

  function reloadPreview() {
    const p = view.preview;
    if (p && (p.status === 'ready' || p.status === 'loading')) loadPreview(p.url, { force: true });
  }

  // The SoundCloud login changed (background, after the oauth_token cookie changed): refresh what depended on it.
  function onLoginChanged() {
    // Only a library the user asked for earlier (see SHADOW_MODE): logged in, logged out or expired.
    if (view.library) loadLibrary(true);
    const p = view.preview;
    if (p && p.status === 'error' && p.error && LOGIN_ERRORS.has(p.error.code)) loadPreview(p.url, { force: true });
  }

  function loadFromInput() {
    const text = ui.input.value.trim();
    if (!text) return;
    const url = scUrl.extractUrl(text);
    if (!url) {
      previewSeq++;
      showPreview({ status: 'error', url: text, error: { code: 'INVALID_URL' } });
      return;
    }
    loadPreview(url, { force: true, focus: true });
  }

  // focus: the user loaded it from inside the panel, so the Add button may take the focus (paste, Enter, Enter).
  async function loadPreview(url, { force = false, focus = false } = {}) {
    const current = view.preview;
    if (!force && current && current.url === url && current.status !== 'error') return;
    const seq = ++previewSeq;
    const type = scUrl.parse(url).type;
    if (type === 'invalid' || type === 'unsupported') {
      showPreview({ status: 'error', url, error: { code: type === 'invalid' ? 'INVALID_URL' : 'UNSUPPORTED_URL' } });
      return;
    }
    showPreview({ status: 'loading', url });
    const res = await send({ type: 'sc:expand', url });
    if (seq !== previewSeq || destroyed) return;
    if (res.ok && res.result && Array.isArray(res.result.items)) {
      const result = Object.assign({}, res.result, { items: normalizeItems(res.result.items) });
      // Only the ready preview carries the job: while loading, the job's progress shows in the jobs list.
      showPreview({ status: 'ready', url, result, jobId: panelJobs.get(url) || null });
      if (focus) focusAddButton();
    } else {
      showPreview({ status: 'error', url, error: res.error || { code: 'INTERNAL' } });
    }
  }

  function showPreview(preview) {
    view.preview = preview;
    scheduleRender();
  }

  // all: re-add the whole list. Otherwise add only the tracks the link's earlier adds didn't (w2g has no bulk delete,
  // so re-adding what already landed would leave the room with duplicates to delete one by one).
  function addPreview({ all = false } = {}) {
    const p = view.preview;
    if (!p || p.status !== 'ready' || !p.result.items.length || roomBlock()) return;
    const existing = p.jobId && jobById(p.jobId);
    if (existing && isActive(existing)) return;
    const rest = all ? null : remaining(p);
    const partial = Boolean(rest && rest.items.length);
    const source = p.result.source || {};
    const job = createJob({
      origin: 'panel',
      title: source.title || 'SoundCloud',
      items: partial ? rest.items : p.result.items,
      addedBefore: partial ? rest.added : [],
    });
    p.jobId = job.id;
    panelJobs.set(p.url, job.id);
    enqueue(job);
  }

  // null while the link's adds added nothing (or one still runs); else { added: their track URLs, items: the
  // preview's tracks they didn't add, maybe none }. By URL, not by position: a Go+ toggle or a reload can change the
  // list in between.
  function remaining(p) {
    const job = p.jobId ? jobById(p.jobId) : null;
    if (!job || isActive(job)) return null;
    const added = job.addedBefore.concat(job.items.slice(0, job.done).map((item) => item.url));
    if (!added.length) return null;
    const copies = new Map(); // url -> added copies not matched yet (a list can hold a track twice)
    for (const url of added) copies.set(url, (copies.get(url) || 0) + 1);
    const items = p.result.items.filter((item) => {
      const n = copies.get(item.url) || 0;
      if (n) copies.set(item.url, n - 1);
      return !n;
    });
    return { added, items };
  }

  function openSoundCloud() {
    send({ type: 'open:soundcloud' });
  }

  // What keeps this browser from adding right now: null, or { code, title, text, tone }.
  function roomBlock() {
    if (!room.streamkey) {
      return Date.now() - startedAt < 10000
        ? { code: 'LOOKING', tone: 'info', title: 'Looking for the room…', text: '' }
        : { code: 'NO_ID', tone: 'warn', title: "Can't find this room", text: 'Reload the page, then try again.' };
    }
    if (!room.joined) {
      if (introOpen()) {
        return { code: 'NOT_JOINED', tone: 'warn', title: "Click 'Join the Room' first", text: 'w2g only lets people who joined add to the playlist.' };
      }
      // A failed check can't tell "not a member" from a network problem; the open panel re-checks every few seconds.
      return room.unreachable
        ? { code: 'UNREACHABLE', tone: 'warn', title: "Can't reach this room on w2g", text: 'Checking again every few seconds. If this stays, reload the page and join the room.' }
        : { code: 'CHECKING', tone: 'info', title: 'Checking the room…', text: '' };
    }
    if (room.locked) {
      return { code: 'MODERATED', tone: 'warn', title: 'The room owner locked the playlist', text: 'Only the owner and moderators can add tracks right now.' };
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // DOM helpers (untrusted strings only ever go through textContent and attributes)

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    cloud: [
      ['path', { d: 'M10 16.6V12A4.6 4.6 0 0 1 19.17 11.48A2.7 2.7 0 1 1 20.4 16.6H10Z' }],
      ['rect', { x: 1.2, y: 13.1, width: 1.3, height: 3.5, rx: 0.65 }],
      ['rect', { x: 3.4, y: 11.6, width: 1.3, height: 5, rx: 0.65 }],
      ['rect', { x: 5.6, y: 10.1, width: 1.3, height: 6.5, rx: 0.65 }],
      ['rect', { x: 7.8, y: 8.6, width: 1.3, height: 8, rx: 0.65 }],
    ],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    refresh: [['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }], ['path', { d: 'M20 4.5V9h-4.5' }]],
    note: [['path', { d: 'M9 17V5.5l10-2V15' }], ['circle', { cx: 6.5, cy: 17, r: 2.5 }], ['circle', { cx: 16.5, cy: 15, r: 2.5 }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    alert: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7.5v5.5' }], ['path', { d: 'M12 16.4v.1' }]],
    lock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
    user: [['circle', { cx: 12, cy: 8.5, r: 3.5 }], ['path', { d: 'M5 20a7 7 0 0 1 14 0' }]],
  };
  const FILLED_ICONS = new Set(['cloud']);

  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (cls) svg.setAttribute('class', cls);
    if (FILLED_ICONS.has(name)) {
      svg.setAttribute('fill', 'currentColor');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    for (const [tag, attrs] of ICONS[name]) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.append(el);
    }
    return svg;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), trusted(value));
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) el.append(child);
    }
    return el;
  }

  // Rendering runs after every batch of w2g DOM changes; unchanged text must not be rewritten (live regions would
  // announce it again).
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function artwork(url, cls, fallbackIcon = 'note') {
    const placeholder = () => h('span', { class: cls + ' placeholder' }, icon(fallbackIcon));
    const src = httpsUrl(url);
    if (!src) return placeholder();
    const img = h('img', { class: cls, alt: '', decoding: 'async', loading: 'lazy', referrerpolicy: 'no-referrer' });
    let retried = false;
    img.addEventListener('error', () => {
      if (retried) {
        img.replaceWith(placeholder());
        return;
      }
      // One retry: flaky networks abort image loads, and a dead artwork link fails twice anyway.
      retried = true;
      setTimeout(() => {
        img.removeAttribute('src');
        img.src = src;
      }, 1500);
    });
    img.src = src;
    return img;
  }

  function errorBox(error, { retry } = {}) {
    const code = error && error.code;
    const actions = [];
    if (OPEN_SOUNDCLOUD_FIXES.has(code)) {
      actions.push(h('button', { type: 'button', class: 'btn small', onclick: openSoundCloud }, 'Open SoundCloud'));
    }
    if (retry && RETRYABLE.has(code)) actions.push(h('button', { type: 'button', class: 'btn small', onclick: retry }, 'Try again'));
    return h('div', { class: 'error', role: 'alert' },
      icon('alert', 'error-icon'),
      h('div', { class: 'error-body' },
        h('span', { text: errorText(error) }),
        actions.length ? h('div', { class: 'error-actions' }, actions) : null));
  }

  function skippedSummary(skipped) {
    const counts = new Map();
    for (const s of skipped) {
      const reason = s && SKIP_TEXT[s.reason] ? s.reason : 'other';
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    const parts = [];
    for (const reason of Object.keys(SKIP_TEXT)) if (counts.has(reason)) parts.push(SKIP_TEXT[reason](counts.get(reason)));
    if (counts.has('other')) parts.push(`${counts.get('other')} skipped`);
    return parts.join(', ');
  }

  function jobResultText(job) {
    const where = job.playlistTitle ? `“${job.playlistTitle}”` : 'the room playlist';
    if (job.status === 'done') return `Added ${plural(job.done, 'track')} to ${where}.`;
    // When the job stopped with a batch in flight, those tracks may or may not be in the playlist.
    const unsure = job.unsure ? ` The next ${plural(job.unsure, 'track')} may have been added too, so check the playlist.` : '';
    if (job.status === 'cancelled') {
      if (job.done) return `Cancelled after ${fmt(job.done)} of ${plural(job.total, 'track')}.${unsure}`;
      return job.unsure ? `Cancelled. ${plural(job.unsure, 'track')} may have been added, so check the playlist.` : 'Cancelled. Nothing was added.';
    }
    // Job errors are written in this file, so their message is the most specific text.
    const text = (job.error && job.error.message) || errorText(job.error);
    const before = job.done ? ` ${fmt(job.done)} of ${plural(job.total, 'track')} were added to ${where} before that.` : '';
    return text + before + unsure;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Launcher

  const LAUNCHER_CSS = `
    :host { all: initial; }
    .launcher {
      position: relative; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
      width: 44px; height: 34px; margin: 0; padding: 0;
      border: 1px solid #283240; border-radius: 6px; background: #283240; color: #ff5500;
      cursor: pointer; transition: background-color .15s, border-color .15s;
      -webkit-tap-highlight-color: transparent;
    }
    .launcher:hover { background: #323e4f; border-color: #3a4759; }
    .launcher:focus-visible { outline: 2px solid #fdbd00; outline-offset: 2px; }
    .launcher[aria-expanded="true"] { border-color: #fdbd00; background: #323e4f; }
    .launcher.compact { width: 34px; height: 30px; background: transparent; border-color: transparent; }
    .launcher.floating {
      width: 52px; height: 52px; border-radius: 50%; border-color: #3a4759; background: #1f2732;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, .6), 0 4px 10px -6px rgba(0, 0, 0, .5);
    }
    .cloud { width: 26px; height: 26px; display: block; }
    .floating .cloud { width: 30px; height: 30px; }
    .meter {
      position: absolute; left: 6px; right: 6px; bottom: 3px; height: 3px; border-radius: 2px;
      background: rgba(255, 255, 255, .14); overflow: hidden; display: none;
    }
    .floating .meter { left: 12px; right: 12px; bottom: 8px; }
    .busy .meter { display: block; }
    .meter-fill { display: block; height: 100%; width: 0; background: #fdbd00; border-radius: 2px; transition: width .3s ease; }
    .badge {
      position: absolute; top: -5px; right: -5px; box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 4px;
      display: flex; align-items: center; justify-content: center; border-radius: 8px;
      font: 700 10px/1 ui-sans-serif, system-ui, sans-serif; color: rgba(0, 0, 0, .85); background: #fdbd00;
      box-shadow: 0 0 0 2px #11161d;
    }
    .badge[hidden] { display: none; }
    .badge.ok { background: #4ade80; }
    .badge.bad { background: #f87171; }
    .badge svg { width: 11px; height: 11px; }
    .spinner {
      width: 8px; height: 8px; border: 2px solid rgba(0, 0, 0, .25); border-top-color: rgba(0, 0, 0, .85);
      border-radius: 50%; animation: spin .8s linear infinite;
    }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } .meter-fill { transition: none; } }
  `;

  function buildLauncher() {
    const host = document.createElement('scw2g-launcher');
    const root = host.attachShadow({ mode: SHADOW_MODE });
    const meterFill = h('span', { class: 'meter-fill' });
    const badge = h('span', { class: 'badge', hidden: true });
    const button = h('button', {
      type: 'button',
      class: 'launcher',
      title: 'Add from SoundCloud',
      'aria-label': 'Add from SoundCloud',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      // A panel that a detected link opened hasn't been visited yet: keyboard and assistive-technology activation
      // (detail 0) takes the user there first, while a pointer click toggles it like any disclosure button.
      onclick: (e) => (ui.open && (ui.openedBy === 'launcher' || e.detail > 0) ? closePanel() : openPanel({ launcher: true })),
      onkeydown: (e) => {
        if (e.key === 'Escape' && ui.open) {
          e.preventDefault();
          closePanel();
        }
      },
    }, icon('cloud', 'cloud'), h('span', { class: 'meter' }, meterFill), badge);
    // The panel's own live regions are hidden until it opens; the launcher never is.
    const status = h('span', { class: 'sr', role: 'status' });
    root.append(h('style', { text: LAUNCHER_CSS }), button, status);
    Object.assign(ui, { launcherHost: host, launcher: button, status, badge, meterFill });
  }

  let statusTimer = 0;

  function setStatus(text) {
    clearTimeout(statusTimer);
    if (ui.status) setText(ui.status, text);
  }

  // A live region only reads out changes: clear it first, so the same text is read out again.
  function restateStatus(text) {
    setStatus('');
    statusTimer = setTimeout(() => {
      if (ui.open && !destroyed && ui.status) setText(ui.status, text);
    }, 100);
  }

  const HOST_STYLE = {
    inline: 'all: initial; display: flex; align-items: center; flex: none; margin-right: 8px;',
    compact: 'all: initial; display: flex; align-items: center; flex: none;',
    // Clear of w2g's mobile toolbar and its PWA install banner (bottom: 60px, 65px high).
    floating: 'all: initial; position: fixed; right: 16px; bottom: 140px; z-index: 1000; display: block;',
  };

  function setLauncherMode(mode) {
    if (ui.mode === mode) return;
    ui.mode = mode;
    ui.launcher.classList.toggle('compact', mode === 'compact');
    ui.launcher.classList.toggle('floating', mode === 'floating');
    ui.launcherHost.style.cssText = HOST_STYLE[mode];
    positionPanel();
  }

  const shown = (el) => Boolean(el && el.parentElement && el.getClientRects().length);

  // Desktop: right after w2g's search box (verified to survive w2g's re-renders). Mobile: in the room header next to
  // w2g's search icon, since the search box itself hides in a collapsed pane there. Otherwise a floating button.
  function placeLauncher() {
    if (!document.body) return;
    if (!ui.launcherHost) buildLauncher();
    const host = ui.launcherHost;
    const mobile = document.body.classList.contains('w2g-mobile');
    const search = document.getElementById('w2g-content-search');
    const mobileSearch = document.getElementById('mobile-open-content');
    if (!mobile && shown(search)) {
      if (host.previousElementSibling !== search) search.after(host);
      setLauncherMode('inline');
    } else if (mobile && shown(mobileSearch)) {
      if (host.nextElementSibling !== mobileSearch) mobileSearch.before(host);
      setLauncherMode('compact');
    } else if (Date.now() - startedAt > FLOATING_DELAY_MS) {
      if (host.parentNode !== document.body) document.body.append(host);
      setLauncherMode('floating');
    }
  }

  function renderLauncher() {
    const button = ui.launcher;
    if (!button) return;
    const job = jobs.find((j) => j.status === 'running') || jobs.find((j) => j.status === 'queued');
    const last = jobs.filter((j) => !isActive(j)).pop();
    const recent = !job && last && Date.now() - last.endedAt < BADGE_MS ? last.status : null;
    const badge = job ? 'busy' : recent === 'done' ? 'ok' : recent === 'failed' ? 'bad' : '';
    if (ui.badgeState !== badge) {
      ui.badgeState = badge;
      ui.badge.replaceChildren();
      ui.badge.className = 'badge ' + badge;
      if (badge === 'busy') ui.badge.append(h('span', { class: 'spinner' }));
      else if (badge === 'ok') ui.badge.append(icon('check'));
      else if (badge === 'bad') ui.badge.textContent = '!';
      ui.badge.hidden = !badge;
    }
    button.classList.toggle('busy', Boolean(job));
    ui.meterFill.style.width = job && job.total ? `${Math.round((job.done / job.total) * 100)}%` : '0%';
    const label = job
      ? `Adding “${job.title}”: ${fmt(job.done)} of ${fmt(job.total)}`
      : recent === 'failed' ? `Add from SoundCloud (adding “${last.title}” failed)` : 'Add from SoundCloud';
    if (button.title !== label) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    button.setAttribute('aria-expanded', String(ui.open));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Panel

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      position: fixed; z-index: ${PANEL_Z}; top: 56px; left: 16px; width: ${PANEL_WIDTH}px; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
      background: #19202a; color: rgba(255, 255, 255, .85);
      border: 1px solid #3a4759; border-radius: 10px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, .7), 0 0 0 1px rgba(0, 0, 0, .25);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
      -webkit-font-smoothing: antialiased;
    }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 12px 14px; border-bottom: 1px solid #2a3442; flex: none; }
    .head .cloud { width: 30px; height: 30px; color: #ff5500; flex: none; }
    .head-text { flex: 1; min-width: 0; }
    .head h2 { margin: 0; font-size: 15px; line-height: 20px; font-weight: 650; color: #fff; }
    .target { font-size: 12px; color: rgba(255, 255, 255, .55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .icon-btn {
      flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0;
      border: 0; border-radius: 6px; background: transparent; color: rgba(255, 255, 255, .65); cursor: pointer;
    }
    .icon-btn:hover { background: #283240; color: #fff; }
    .icon-btn:focus-visible { outline: 2px solid #fdbd00; outline-offset: 1px; }
    .icon-btn:disabled { cursor: default; opacity: .6; }
    .icon-btn svg { width: 18px; height: 18px; }
    .spinning svg { animation: spin 1s linear infinite; }
    .body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px;
      display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; scrollbar-color: #3a4759 transparent;
    }
    .banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; border: 1px solid; }
    .banner.warn { background: rgba(253, 189, 0, .09); border-color: rgba(253, 189, 0, .35); color: #fde68a; }
    .banner.info { background: rgba(148, 163, 184, .08); border-color: #2f3a4a; color: rgba(255, 255, 255, .7); }
    .banner svg { width: 18px; height: 18px; flex: none; margin-top: 1px; }
    .banner strong { display: block; font-weight: 650; color: inherit; }
    .banner span { display: block; font-size: 13px; opacity: .85; }
    .url-row { display: flex; gap: 8px; margin: 0; }
    .url {
      flex: 1; min-width: 0; height: 38px; padding: 0 12px; margin: 0;
      background: #11161d; color: #fff; border: 1px solid #3a4759; border-radius: 6px; font: inherit; font-size: 14px;
    }
    .url::placeholder { color: rgba(255, 255, 255, .38); }
    .url:focus { outline: none; border-color: #fdbd00; box-shadow: 0 0 0 3px rgba(253, 189, 0, .18); }
    .btn {
      flex: none; height: 38px; padding: 0 14px; margin: 0; border: 1px solid #3a4759; border-radius: 6px;
      background: #283240; color: rgba(255, 255, 255, .92); font: inherit; font-weight: 650; cursor: pointer;
      transition: background-color .15s, border-color .15s, filter .15s;
    }
    .btn:hover:not(:disabled) { background: #323e4f; }
    .btn:focus-visible { outline: 2px solid #fdbd00; outline-offset: 2px; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.primary { background: #fdbd00; border-color: #fdbd00; color: rgba(0, 0, 0, .87); }
    .btn.primary:hover:not(:disabled) { background: #fdbd00; filter: brightness(1.08); }
    .btn.primary:focus-visible { outline-color: #fff; }
    .btn.primary:disabled { background: #283240; border-color: #3a4759; color: rgba(255, 255, 255, .5); opacity: 1; }
    .btn.small { height: 30px; padding: 0 10px; font-size: 13px; }
    .btn.block { width: 100%; }
    .link { border: 0; background: none; padding: 0; color: rgba(255, 255, 255, .7); font: inherit; font-size: 13px; text-decoration: underline; cursor: pointer; }
    .link:hover { color: #fff; }
    .link:focus-visible { outline: 2px solid #fdbd00; outline-offset: 2px; border-radius: 2px; }
    .option { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: rgba(255, 255, 255, .8); cursor: pointer; user-select: none; }
    .option input { margin: 2px 0 0; width: 15px; height: 15px; accent-color: #fdbd00; cursor: pointer; flex: none; }
    .option small { display: block; font-size: 12px; color: rgba(255, 255, 255, .45); }
    .preview { background: #11161d; border: 1px solid #2a3442; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .card { display: flex; gap: 12px; align-items: flex-start; }
    .art { width: 76px; height: 76px; border-radius: 6px; object-fit: cover; flex: none; background: #283240; display: block; }
    .art.placeholder svg { width: 30px; height: 30px; }
    .meta { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .kind { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #ff7a33; }
    .title {
      color: #fff; font-weight: 650; font-size: 15px; line-height: 1.3; text-decoration: none; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
    }
    a.title:hover { text-decoration: underline; }
    a.title:focus-visible { outline: 2px solid #fdbd00; outline-offset: 2px; border-radius: 2px; }
    .sub { color: rgba(255, 255, 255, .6); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stats { color: rgba(255, 255, 255, .85); font-size: 13px; font-weight: 600; margin-top: 2px; }
    .note { margin: 0; font-size: 13px; color: rgba(255, 255, 255, .62); }
    .note.warn { color: #fcd34d; }
    .tracklist summary { cursor: pointer; font-size: 13px; color: rgba(255, 255, 255, .7); user-select: none; }
    .tracklist summary:hover { color: #fff; }
    .tracklist summary:focus-visible { outline: 2px solid #fdbd00; outline-offset: 2px; border-radius: 2px; }
    .tracks {
      margin: 8px 0 0; padding: 6px 8px 6px 34px; max-height: 180px; overflow-y: auto; background: #19202a;
      border-radius: 6px; font-size: 13px; color: rgba(255, 255, 255, .78); scrollbar-width: thin; scrollbar-color: #3a4759 transparent;
    }
    .tracks li { padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tracks li::marker { color: rgba(255, 255, 255, .35); font-variant-numeric: tabular-nums; }
    .progress { display: flex; flex-direction: column; gap: 6px; }
    .bar { height: 6px; background: #283240; border-radius: 3px; overflow: hidden; }
    .fill { height: 100%; width: 0; background: #fdbd00; border-radius: 3px; transition: width .35s ease; }
    .bar.waiting .fill { width: 28% !important; animation: slide 1.3s ease-in-out infinite; }
    .progress-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; color: rgba(255, 255, 255, .75); font-variant-numeric: tabular-nums; }
    .result { margin: 0; font-size: 13px; }
    .result.ok { color: #86efac; }
    .result.bad { color: #fca5a5; }
    .error { display: flex; gap: 10px; align-items: flex-start; color: #fecaca; font-size: 13px; }
    .error-icon { width: 18px; height: 18px; flex: none; color: #f87171; margin-top: 1px; }
    .error-actions { display: flex; gap: 8px; margin-top: 8px; }
    .jobs { display: flex; flex-direction: column; gap: 8px; }
    .job { background: #11161d; border: 1px solid #2a3442; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .job-head { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .job-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; font-weight: 600; }
    .job-from { color: rgba(255, 255, 255, .45); font-size: 12px; flex: none; }
    .library { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid #2a3442; padding-top: 10px; }
    .lib-head { display: flex; align-items: center; justify-content: space-between; }
    .lib-head h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgba(255, 255, 255, .55); }
    .who { display: flex; align-items: center; gap: 8px; font-size: 12px; color: rgba(255, 255, 255, .55); margin-bottom: 2px; }
    .who strong { color: rgba(255, 255, 255, .8); font-weight: 600; }
    .avatar { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; background: #283240; flex: none; }
    .avatar.placeholder svg { width: 12px; height: 12px; }
    .section-title { margin: 10px 0 2px; font-size: 13px; font-weight: 650; color: rgba(255, 255, 255, .78); }
    .entry {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px; margin: 0; border: 0; border-radius: 6px;
      background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .entry:hover { background: #222b37; }
    .entry:focus-visible { outline: 2px solid #fdbd00; outline-offset: -2px; background: #222b37; }
    .entry.current { background: rgba(253, 189, 0, .1); box-shadow: inset 2px 0 0 #fdbd00; }
    .thumb { width: 42px; height: 42px; border-radius: 4px; object-fit: cover; flex: none; background: #283240; display: block; }
    .thumb.placeholder svg { width: 18px; height: 18px; }
    .entry-text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
    .entry-title { color: rgba(255, 255, 255, .92); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .entry-sub { font-size: 12px; color: rgba(255, 255, 255, .5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .more { align-self: flex-start; margin: 2px 6px; }
    .again { align-self: center; }
    .login { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 4px 0; }
    .login p { margin: 0; font-size: 13px; color: rgba(255, 255, 255, .7); }
    .login strong { color: #fff; font-weight: 650; }
    .muted { margin: 0; font-size: 13px; color: rgba(255, 255, 255, .5); }
    .skeleton { background: linear-gradient(90deg, #222b37 0%, #2c3746 50%, #222b37 100%); background-size: 200% 100%; animation: shimmer 1.3s linear infinite; border-radius: 4px; }
    .line { height: 12px; margin: 4px 0; }
    .w30 { width: 30%; } .w40 { width: 40%; } .w60 { width: 60%; } .w70 { width: 70%; }
    .skeleton-row { display: flex; align-items: center; gap: 10px; padding: 6px; }
    .skeleton-row .thumb { animation: shimmer 1.3s linear infinite; }
    .skeleton-row .lines { flex: 1; }
    .art.placeholder, .thumb.placeholder, .avatar.placeholder {
      display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, .35);
    }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(360%); } }
    @media (prefers-reduced-motion: reduce) {
      .skeleton, .skeleton-row .thumb, .spinning svg, .bar.waiting .fill { animation: none; }
      .fill { transition: none; }
    }
  `;

  function buildPanel() {
    const host = document.createElement('scw2g-panel');
    host.style.cssText = 'all: initial;';
    const root = host.attachShadow({ mode: SHADOW_MODE });

    const input = h('input', {
      type: 'text',
      class: 'url',
      placeholder: 'Paste a SoundCloud link (playlist, mix, likes…)',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'SoundCloud link',
    });
    // Like w2g's own search box: a pasted link loads right away.
    input.addEventListener('input', trusted((e) => {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') loadFromInput();
    }));
    const form = h('form', { class: 'url-row', onsubmit: (e) => { e.preventDefault(); loadFromInput(); } },
      input, h('button', { type: 'submit', class: 'btn' }, 'Load'));

    const skip = h('input', { type: 'checkbox', checked: true });
    skip.addEventListener('change', trusted(() => setSkipPreviews(skip.checked)));
    const skipRow = h('label', { class: 'option' }, skip,
      h('span', {}, 'Skip Go+ previews', h('small', { text: 'Without Go+, listeners would only hear 30 seconds of them.' })));

    const refresh = h('button', {
      type: 'button', class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh your SoundCloud library',
      onclick: () => showLibrary({ refresh: true }),
    }, icon('refresh'));
    const libraryBody = h('div', { class: 'library-body' });
    const target = h('div', { class: 'target' });
    const banner = h('div', { class: 'banner', role: 'status', hidden: true });
    const previewBox = h('div', { class: 'preview', hidden: true });
    const jobsBox = h('div', { class: 'jobs', hidden: true, 'aria-live': 'polite' });

    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Add from SoundCloud', hidden: true },
      h('div', { class: 'head' },
        icon('cloud', 'cloud'),
        h('div', { class: 'head-text' }, h('h2', { text: 'SoundCloud' }), target),
        h('button', { type: 'button', class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: () => closePanel() }, icon('close'))),
      h('div', { class: 'body' },
        banner,
        form,
        skipRow,
        previewBox,
        jobsBox,
        h('section', { class: 'library', 'aria-label': 'Your SoundCloud' },
          h('div', { class: 'lib-head' }, h('h3', { text: 'Your SoundCloud' }), refresh),
          libraryBody)));

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
      // Keep w2g's page-level shortcuts from reacting to typing in the panel.
      e.stopPropagation();
    });
    panel.addEventListener('keyup', (e) => e.stopPropagation());
    panel.addEventListener('keypress', (e) => e.stopPropagation());

    root.append(h('style', { text: PANEL_CSS }), panel);
    document.body.append(host);
    Object.assign(ui, { panelHost: host, panel, input, target, banner, previewBox, jobsBox, skip, libraryBody, refresh });
  }

  function ensurePanel() {
    if (ui.panelHost && !ui.panelHost.isConnected && document.body) document.body.append(ui.panelHost);
    if (!ui.panelHost && document.body) buildPanel();
    return Boolean(ui.panelHost);
  }

  // launcher: a trusted click on the launcher, the only way in that shows the user's library and takes the focus
  // (also into a panel that a detected link opened). Otherwise (a link detected in w2g's search box) the panel shows
  // just that link's preview and the focus stays where the user is typing, so keystrokes meant for w2g can't press
  // our Add button; the launcher's status line tells screen readers that the panel opened.
  function openPanel({ url, launcher = false } = {}) {
    if (!isAlive() || !ensurePanel()) return;
    placeLauncher();
    const wasOpen = ui.open;
    ui.open = true;
    ui.panel.hidden = false;
    positionPanel();
    loadSettings();
    if (launcher) {
      ui.openedBy = 'launcher';
      setStatus('');
      showLibrary();
    } else if (!wasOpen) {
      ui.openedBy = 'link';
      setStatus(LINK_OPENED_TEXT);
    } else if (url) {
      // Another link detected while the panel is open: the paste or drop was cancelled, so say where it went.
      restateStatus(ui.openedBy === 'link' ? LINK_OPENED_TEXT : LINK_SHOWN_TEXT);
    }
    if (room.streamkey && Date.now() - room.checkedAt > 10000) probe();
    if (!ui.reprobeTimer) ui.reprobeTimer = setInterval(reprobe, REPROBE_MS);
    if (url) {
      ui.input.value = url;
      loadPreview(url);
    }
    if (launcher) ui.input.focus({ preventScroll: true });
    render();
  }

  function closePanel({ restoreFocus = true } = {}) {
    if (!ui.open) return;
    ui.open = false;
    ui.openedBy = null;
    ui.panel.hidden = true;
    setStatus('');
    // The library stays loaded, but the next opening shows it only if the user asks for it again.
    ui.libraryShown = false;
    bumpLibrary();
    clearInterval(ui.reprobeTimer);
    ui.reprobeTimer = 0;
    render();
    if (restoreFocus && ui.launcherHost && ui.launcherHost.isConnected) ui.launcher.focus({ preventScroll: true });
  }

  // While the open panel says the room can't be reached, keep checking so it clears by itself once w2g answers.
  function reprobe() {
    if (ui.open && room.streamkey && !room.joined && !introOpen() && !probing) probe();
  }

  function positionPanel() {
    if (!ui.open || !ui.panel) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(PANEL_WIDTH, vw - 16);
    let left = Math.round((vw - width) / 2);
    let top = 8;
    // A dropdown under the desktop launcher; a centered sheet on the mobile layout.
    const rect = ui.mode === 'inline' && ui.launcherHost && ui.launcherHost.isConnected
      ? ui.launcherHost.getBoundingClientRect() : null;
    if (rect && rect.width) {
      top = Math.round(rect.bottom + 8);
      left = Math.round(Math.min(Math.max(8, rect.right - width), vw - width - 8));
    }
    Object.assign(ui.panel.style, {
      left: left + 'px',
      top: top + 'px',
      width: width + 'px',
      maxHeight: Math.max(260, vh - top - 8) + 'px',
    });
  }

  function focusAddButton() {
    // Only when focus is already inside the panel (the closed shadow root shows up as its host).
    if (!ui.open || document.activeElement !== ui.panelHost) return;
    render();
    const add = ui.previewParts && ui.previewParts.add;
    // "Add again" (the link is in the room already) is no default for a quick Enter.
    if (add && !add.disabled && add.classList.contains('primary')) add.focus({ preventScroll: true });
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (destroyed) return;
    renderLauncher();
    if (!ui.panel) return;
    renderHeader();
    renderBanner();
    renderSkip();
    renderPreview();
    renderPreviewJob();
    renderJobs();
    renderLibrary();
  }

  function renderHeader() {
    setText(ui.target, room.playlistTitle
      ? `Adds to “${room.playlistTitle}”`
      : room.roomName ? `Adds to ${room.roomName}` : 'Adds to this room’s playlist');
  }

  function renderBanner() {
    const block = roomBlock();
    const key = block ? `${block.code}|${block.title}` : '';
    if (ui.shownBanner === key) return;
    ui.shownBanner = key;
    const banner = ui.banner;
    banner.replaceChildren();
    banner.hidden = !block;
    if (!block) return;
    banner.className = 'banner ' + block.tone;
    banner.append(
      icon(block.code === 'MODERATED' ? 'lock' : block.tone === 'warn' ? 'alert' : 'user'),
      h('div', {}, h('strong', { text: block.title }), block.text ? h('span', { text: block.text }) : null));
  }

  function renderSkip() {
    if (view.settings && ui.skip.checked !== Boolean(view.settings.skipPreviews)) ui.skip.checked = Boolean(view.settings.skipPreviews);
  }

  function renderPreview() {
    const p = view.preview;
    if (ui.shownPreview === p) return;
    ui.shownPreview = p;
    ui.previewParts = null;
    const box = ui.previewBox;
    box.replaceChildren();
    box.hidden = !p;
    if (!p) return;
    if (p.status === 'loading') {
      box.setAttribute('aria-busy', 'true');
      box.append(
        h('div', { class: 'card' },
          h('div', { class: 'art skeleton' }),
          h('div', { class: 'meta' }, h('div', { class: 'line skeleton w30' }), h('div', { class: 'line skeleton w70' }), h('div', { class: 'line skeleton w40' }))),
        h('p', { class: 'muted', text: 'Loading from SoundCloud…' }));
      return;
    }
    box.removeAttribute('aria-busy');
    if (p.status === 'error') {
      box.append(errorBox(p.error, { retry: () => loadPreview(p.url, { force: true }) }));
      return;
    }
    const result = p.result;
    const source = result.source || {};
    const items = result.items;
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const title = source.title || source.url || p.url;
    const link = httpsUrl(source.url) || httpsUrl(p.url);
    const stats = (items.length ? plural(items.length, 'track') : 'No playable tracks') + (skipped.length ? ` · ${fmt(skipped.length)} skipped` : '');
    box.append(h('div', { class: 'card' },
      artwork(source.artwork || (items[0] && items[0].thumb), 'art'),
      h('div', { class: 'meta' },
        h('div', { class: 'kind', text: KIND_LABEL[source.kind] || 'SoundCloud' }),
        link
          ? h('a', { class: 'title', href: link, target: '_blank', rel: 'noopener noreferrer', title, text: title })
          : h('div', { class: 'title', title, text: title }),
        source.subtitle ? h('div', { class: 'sub', title: source.subtitle, text: source.subtitle }) : null,
        h('div', { class: 'stats', text: stats }))));
    const summary = skippedSummary(skipped);
    if (summary) box.append(h('p', { class: 'note', text: summary }));
    for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
      box.append(h('p', { class: 'note warn', text: WARNING_TEXT[warning] || String(warning) }));
    }
    if (!items.length) {
      box.append(h('p', { class: 'note', text: ERROR_TEXT.EMPTY }));
      return;
    }
    if (items.length > 1) box.append(trackList(items));
    const add = h('button', { type: 'button', class: 'btn primary block add', onclick: () => addPreview() });
    // After a partial import the primary button adds only the rest; re-adding everything is this explicit choice.
    const again = h('button', { type: 'button', class: 'link again', hidden: true, onclick: () => addPreview({ all: true }) });
    const fill = h('div', { class: 'fill' });
    const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Adding tracks', 'aria-valuemin': '0' }, fill);
    const label = h('span');
    const cancel = h('button', { type: 'button', class: 'link', onclick: () => cancelJob(jobById(p.jobId)) }, 'Cancel');
    const progress = h('div', { class: 'progress', hidden: true }, bar, h('div', { class: 'progress-line' }, label, cancel));
    const resultLine = h('p', { class: 'result', role: 'status', hidden: true });
    box.append(add, again, progress, resultLine);
    ui.previewParts = { add, again, bar, fill, label, progress, result: resultLine };
  }

  function trackList(items) {
    const summary = h('summary', { text: `Show all ${fmt(items.length)} tracks` });
    const list = h('ol', { class: 'tracks' });
    const details = h('details', { class: 'tracklist' }, summary, list);
    details.addEventListener('toggle', () => {
      summary.textContent = details.open ? 'Hide tracks' : `Show all ${fmt(items.length)} tracks`;
      if (details.open && !list.childElementCount) list.append(...items.map((item) => h('li', { title: item.title, text: item.title })));
    });
    return details;
  }

  function setProgress(bar, fill, label, job) {
    const waiting = job.status === 'queued';
    bar.classList.toggle('waiting', !job.done);
    bar.setAttribute('aria-valuemax', String(job.total));
    bar.setAttribute('aria-valuenow', String(job.done));
    fill.style.width = job.total ? `${(job.done / job.total) * 100}%` : '0%';
    let text = job.done ? `Added ${fmt(job.done)} of ${fmt(job.total)}…` : `Adding ${plural(job.total, 'track')}…`;
    if (waiting) text = 'Waiting for the current add to finish…';
    if (job.cancelling) text = 'Cancelling…';
    setText(label, text);
  }

  function renderPreviewJob() {
    const parts = ui.previewParts;
    const p = view.preview;
    if (!parts || !p || p.status !== 'ready') return;
    const job = p.jobId ? jobById(p.jobId) : null;
    const count = p.result.items.length;
    const active = Boolean(job && isActive(job));
    const rest = active ? null : remaining(p);
    // Every track is in the room already: adding them again is a deliberate repeat, not the main action.
    const repeat = Boolean(rest && !rest.items.length);
    const partial = Boolean(rest && rest.items.length);
    const disabled = !count || active || Boolean(roomBlock());
    parts.add.hidden = active;
    parts.add.disabled = disabled;
    setText(parts.add, repeat ? 'Add again' : partial ? `Add the remaining ${plural(rest.items.length, 'track')}` : `Add ${plural(count, 'track')}`);
    parts.add.classList.toggle('primary', !repeat);
    parts.again.hidden = active || !partial;
    parts.again.disabled = disabled;
    setText(parts.again, `Add all ${plural(count, 'track')} again`);
    parts.progress.hidden = !active;
    if (active) setProgress(parts.bar, parts.fill, parts.label, job);
    const text = job && !active ? jobResultText(job) : '';
    setText(parts.result, text);
    parts.result.hidden = !text;
    parts.result.className = 'result ' + (job && job.status === 'done' ? 'ok' : 'bad');
  }

  function renderJobs() {
    const previewJob = view.preview && view.preview.jobId;
    const now = Date.now();
    const shown = jobs.filter((j) => j.id !== previewJob && (isActive(j) || now - j.endedAt < FINISHED_JOB_TTL_MS));
    const keep = new Set();
    for (const job of shown) {
      keep.add(job.id);
      let row = ui.jobRows.get(job.id);
      if (!row) {
        row = buildJobRow(job);
        ui.jobRows.set(job.id, row);
      }
      if (row.el.parentNode !== ui.jobsBox) ui.jobsBox.append(row.el);
      updateJobRow(row, job);
    }
    for (const [id, row] of ui.jobRows) {
      if (keep.has(id)) continue;
      row.el.remove();
      ui.jobRows.delete(id);
    }
    ui.jobsBox.hidden = !shown.length;
  }

  function buildJobRow(job) {
    const fill = h('div', { class: 'fill' });
    const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': `Adding ${job.title}`, 'aria-valuemin': '0' }, fill);
    const label = h('span');
    const cancel = h('button', { type: 'button', class: 'link', onclick: () => cancelJob(job) }, 'Cancel');
    const progress = h('div', { class: 'progress' }, bar, h('div', { class: 'progress-line' }, label, cancel));
    const result = h('p', { class: 'result', role: 'status' });
    const el = h('div', { class: 'job' },
      h('div', { class: 'job-head' },
        h('span', { class: 'job-title', title: job.title, text: job.title }),
        h('span', { class: 'job-from', text: job.origin === 'background' ? 'from soundcloud.com' : 'from this panel' })),
      progress, result);
    return { el, bar, fill, label, progress, result };
  }

  function updateJobRow(row, job) {
    const active = isActive(job);
    row.progress.hidden = !active;
    if (active) setProgress(row.bar, row.fill, row.label, job);
    row.result.hidden = active;
    setText(row.result, active ? '' : jobResultText(job));
    row.result.className = 'result ' + (job.status === 'done' ? 'ok' : 'bad');
  }

  function renderLibrary() {
    const lib = view.library;
    const loading = Boolean(lib && lib.status === 'loading');
    ui.refresh.classList.toggle('spinning', loading);
    ui.refresh.disabled = loading;
    if (ui.shownLibraryVersion !== view.libraryVersion) {
      ui.shownLibraryVersion = view.libraryVersion;
      ui.entryButtons = [];
      ui.libraryBody.replaceChildren(...libraryContent(lib));
    }
    const current = view.preview && view.preview.url;
    for (const [button, url] of ui.entryButtons) button.classList.toggle('current', url === current);
  }

  function libraryContent(lib) {
    if (!lib || !ui.libraryShown) return [libraryPrompt()];
    if (lib.status === 'loading' && !lib.data) return [skeletonRow(), skeletonRow(), skeletonRow()];
    if (!lib.data) return [errorBox(lib.error, { retry: () => loadLibrary(true) })];
    const data = lib.data;
    const out = [];
    if (lib.status === 'error') out.push(h('p', { class: 'muted', text: `Couldn't refresh: ${errorText(lib.error)}` }));
    if (!data.loggedIn) {
      out.push(loginHint(Boolean(data.expired)));
      return out;
    }
    const user = data.user || {};
    if (user.username) {
      out.push(h('div', { class: 'who' }, artwork(user.avatar, 'avatar', 'user'), h('span', {}, 'Logged in as ', h('strong', { text: user.username }))));
    }
    let sections = 0;
    for (const section of Array.isArray(data.sections) ? data.sections : []) {
      const entries = (Array.isArray(section.entries) ? section.entries : []).filter((e) => e && httpsUrl(e.url));
      if (!entries.length) continue;
      sections++;
      const sectionId = String(section.id || section.title || sections);
      const expanded = view.expanded.has(sectionId);
      const visible = expanded ? entries : entries.slice(0, SECTION_LIMIT);
      out.push(h('div', { class: 'section-title', text: section.title || 'Playlists' }));
      for (const entry of visible) out.push(entryButton(entry));
      if (entries.length > SECTION_LIMIT) {
        out.push(h('button', {
          type: 'button',
          class: 'link more',
          onclick: () => {
            if (expanded) view.expanded.delete(sectionId);
            else view.expanded.add(sectionId);
            bumpLibrary();
          },
        }, expanded ? 'Show fewer' : `Show all ${fmt(entries.length)}`));
      }
    }
    if (!sections) out.push(h('p', { class: 'muted', text: 'No playlists in your SoundCloud library yet.' }));
    return out;
  }

  function entryButton(entry) {
    const count = typeof entry.trackCount === 'number' ? plural(entry.trackCount, 'track') : null;
    const sub = [entry.subtitle, count].filter(Boolean).join(' · ');
    const title = entry.title || entry.url;
    const button = h('button', { type: 'button', class: 'entry', title },
      artwork(entry.artwork, 'thumb'),
      h('span', { class: 'entry-text' },
        h('span', { class: 'entry-title', text: title }),
        sub ? h('span', { class: 'entry-sub', text: sub }) : null));
    button.addEventListener('click', trusted(() => {
      ui.input.value = entry.url;
      ui.panel.querySelector('.body').scrollTop = 0;
      loadPreview(entry.url, { focus: true });
    }));
    ui.entryButtons.push([button, entry.url]);
    return button;
  }

  function loginHint(expired) {
    return h('div', { class: 'login' },
      h('p', {}, h('strong', { text: expired ? 'Your SoundCloud login expired.' : 'Not logged in to SoundCloud.' })),
      h('p', {
        text: expired
          ? 'Open soundcloud.com once to refresh it, then come back here.'
          : 'Log in on soundcloud.com in this browser to pick your Weekly Wave, Daily Drops, playlists and likes here.',
      }),
      h('button', { type: 'button', class: 'btn small', onclick: openSoundCloud }, 'Open SoundCloud'));
  }

  // The panel opened for a link detected in w2g's search box: the library, even one loaded earlier, shows only when
  // the user asks for it.
  function libraryPrompt() {
    return h('div', { class: 'login' },
      h('p', { text: 'Pick from your Weekly Wave, Daily Drops, playlists and likes.' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => showLibrary() }, 'Show my SoundCloud'));
  }

  function skeletonRow() {
    return h('div', { class: 'skeleton-row', 'aria-hidden': 'true' },
      h('div', { class: 'thumb skeleton' }),
      h('div', { class: 'lines' }, h('div', { class: 'line skeleton w60' }), h('div', { class: 'line skeleton w40' })));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Link detection in w2g's search box: only a real paste or drop counts. Page scripts can fake any event, and with
  // document.execCommand they make the browser itself fire trusted input events (insertText, insertTranspose, ...)
  // for text of their choice, but never a paste or a drop (see SHADOW_MODE). So typing, Enter included, stays w2g's.
  // The listeners capture on window and are added at document_start, before any page script's, so the page can't
  // swap the box's text between the user's input and our look at it.

  function searchInput(target) {
    return target && target.tagName === 'INPUT' && target.closest('#w2g-content-search') ? target : null;
  }

  // The SoundCloud link in `text` (what the user pasted or dropped), unless w2g plays it by itself: w2g's box only
  // takes a plain public track link, and only as its whole text (`boxText`). Anything else w2g turns into a keyword
  // search or the wrong item (a profile for /user/likes), so the panel takes over.
  function interceptable(text, boxText = text) {
    const url = scUrl.extractUrl(text);
    if (!url) return null;
    const type = scUrl.parse(url).type;
    if (type === 'invalid' || type === 'unsupported') return null;
    return scUrl.isW2gNativeTrack(String(boxText).trim()) ? null : url;
  }

  // w2g would search for the link and show "No results found."; the panel takes it instead, and w2g's box stays as
  // it was.
  function onPasteOrDrop(e) {
    if (!e.isTrusted || !searchInput(e.target) || !isAlive()) return;
    const data = e.clipboardData || e.dataTransfer;
    const url = interceptable(data ? data.getData('text') : '');
    if (!url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPanel({ url });
  }

  // A paste or drop that onPasteOrDrop left to w2g (a plain track link) can still make the box's text something w2g
  // can't play: the link comes from the inserted text, while w2g sees the whole box.
  function onInput(e) {
    const input = searchInput(e.target);
    if (!e.isTrusted || !input || !isAlive()) return;
    if (e.inputType !== 'insertFromPaste' && e.inputType !== 'insertFromDrop') return;
    const url = interceptable(typeof e.data === 'string' ? e.data : input.value, input.value);
    if (url) openPanel({ url });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // DOM watching and lifecycle

  let domTimer = 0;
  let lastIntro = null;
  let lastLockHint = null;

  function scheduleDomSync() {
    if (!domTimer && !destroyed) domTimer = setTimeout(syncDom, 120);
  }

  function syncDom() {
    domTimer = 0;
    if (!isAlive()) {
      destroy();
      return;
    }
    if (!document.body) return;
    if (!room.streamkey) setStreamkey(streamkeyFromShareLink());
    const name = readRoomName();
    if (name !== room.roomName) {
      room.roomName = name;
      announce();
    }
    const hint = lockHint();
    if (hint !== null && hint !== lastLockHint) {
      lastLockHint = hint;
      room.locked = hint;
    }
    if (ui.open && document.body.classList.contains('w2g-modal-open')) closePanel({ restoreFocus: false });
    const intro = introOpen();
    if (intro !== lastIntro) {
      const closed = lastIntro === true;
      lastIntro = intro;
      // A check that failed before the dialog showed up: the room isn't offline, it waits for the user to join.
      if (intro && room.unreachable) {
        room.unreachable = false;
        announce();
      }
      // w2g joins right after the dialog closes and the resource observer sees it; this covers a missed signal.
      if (closed) setTimeout(() => { if (!room.joined) probe(); }, 2500);
    }
    placeLauncher();
    if (ui.panelHost && !ui.panelHost.isConnected) document.body.append(ui.panelHost);
    positionPanel();
    scheduleRender();
  }

  function startDom() {
    if (destroyed) return;
    const observer = new MutationObserver(scheduleDomSync);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    cleanups.push(() => observer.disconnect());
    syncDom();
    // Placement retries for the floating fallback, which waits for w2g to render its search box first.
    const placementTimer = setTimeout(scheduleDomSync, FLOATING_DELAY_MS + 100);
    // Covers rooms whose join this script missed entirely (e.g. injected late with an access_key URL).
    const probeTimer = setTimeout(() => { if (room.streamkey && !room.joined && !introOpen()) probe(); }, 4000);
    cleanups.push(() => { clearTimeout(placementTimer); clearTimeout(probeTimer); });
  }

  function onPointerDown(e) {
    if (!ui.open) return;
    const path = e.composedPath();
    if (path.includes(ui.panelHost) || path.includes(ui.launcherHost)) return;
    closePanel({ restoreFocus: false });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    lifetime.abort();
    clearTimeout(announceTimer);
    clearTimeout(domTimer);
    clearInterval(ui.reprobeTimer);
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch (_) { /* ignore */ }
    }
    for (const job of jobs) {
      clearInterval(job.queuedTimer);
      job.controller.abort();
    }
    if (ui.launcherHost) ui.launcherHost.remove();
    if (ui.panelHost) ui.panelHost.remove();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) { /* context already gone */ }
    if (globalThis[INSTANCE_KEY] === instance) delete globalThis[INSTANCE_KEY];
  }

  function init() {
    try {
      chrome.runtime.onMessage.addListener(onMessage);
    } catch (_) {
      destroy(); // the extension context is already gone
      return;
    }
    // An older copy of this script, left behind by an extension update, removes its UI and stops. Page scripts can
    // dispatch this event too, so only a copy whose extension context is dead obeys it.
    document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
    on(document, TAKEOVER_EVENT, () => { if (!isAlive()) destroy(); });
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
      cleanups.push(() => chrome.storage.onChanged.removeListener(onStorageChanged));
    } catch (_) { /* no storage events: the settings are read once per page */ }

    watchResources();
    announce(true);

    on(window, 'paste', onPasteOrDrop, { capture: true });
    on(window, 'drop', onPasteOrDrop, { capture: true });
    on(window, 'input', onInput, { capture: true });
    on(document, 'pointerdown', onPointerDown, { capture: true });
    // Trusted only: a page script could otherwise keep claiming "most recently used room" or unregister the room.
    on(document, 'visibilitychange', trusted(() => { if (document.visibilityState === 'visible') activate(); }));
    on(window, 'focus', trusted(activate));
    on(window, 'resize', positionPanel);
    on(window, 'pagehide', trusted(() => { send({ type: 'room:bye' }); }));
    on(window, 'pageshow', trusted((e) => { if (e.persisted) announce(true); }));

    if (document.readyState === 'loading') on(document, 'DOMContentLoaded', startDom, { once: true });
    else startDom();
  }

  init();
})();
