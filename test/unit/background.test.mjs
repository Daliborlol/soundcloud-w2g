// Unit tests for the background service worker (extension/background/*.js), run against a fake `chrome` and a
// fake soundcloud.js module. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('../../extension/shared/sc-url.js');
const { createBackground } = await import('../../extension/background/app.js');
const { selectTarget, isRoomUrl, roomFields } = await import('../../extension/background/rooms.js');
const { DEFAULT_SETTINGS, sanitizeSettings } = await import('../../extension/background/settings.js');
const { urlMatches, createLock, BgError, errorPayload, maxCount } = await import('../../extension/background/util.js');

const MANIFEST = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
const urlTools = globalThis.SCW2G.url;
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const SET_URL = 'https://soundcloud.com/forss/sets/soulhack';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// Fakes

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn) >>> 0, 1),
    hasListener: (fn) => listeners.includes(fn),
    dispatch: (...args) => listeners.map((fn) => fn(...args)),
  };
}

function createStorageArea(areaName, onChanged) {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const names = keys == null ? [...data.keys()] : [].concat(keys);
      const out = {};
      for (const name of names) if (data.has(name)) out[name] = structuredClone(data.get(name));
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: structuredClone(value) };
        data.set(key, structuredClone(value));
      }
      onChanged.dispatch(changes, areaName);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) data.delete(key);
    },
  };
}

/**
 * A fake `chrome` covering what the background uses. Tabs have frames; a frame with `onMessage(msg)` acts as a
 * content script whose return value (or promise) is the reply. Messages are delivered asynchronously.
 */
function createFakeChrome({ manifest = MANIFEST } = {}) {
  const tabs = new Map();
  const sent = []; // every tabs.sendMessage: { tabId, frameId, message }
  const runtimeSent = [];
  const created = [];
  const injections = [];
  const failInjection = new Set();
  const cookies = new Map();
  const cookieCalls = [];
  const counters = { platformInfo: 0 };
  const storageChanged = createEvent();

  // Like Chrome without the "tabs" permission: url/pendingUrl only for hosts in host_permissions.
  const visible = (url) => (typeof url === 'string' && urlMatches(url, manifest.host_permissions) ? url : undefined);
  const publicTab = (tab) => {
    const out = { id: tab.id, url: visible(tab.url), windowId: tab.windowId, index: tab.index, discarded: tab.discarded, status: tab.status };
    if (tab.pendingUrl) out.pendingUrl = visible(tab.pendingUrl);
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    return out;
  };

  function framesFor(tab, target) {
    const all = [...tab.frames.entries()].map(([frameId, frame]) => ({ frameId, ...frame }));
    if (target.frameIds) return all.filter((f) => target.frameIds.includes(f.frameId));
    return target.allFrames ? all : all.filter((f) => f.frameId === 0);
  }

  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
      getManifest: () => structuredClone(manifest),
      async sendMessage(message) {
        runtimeSent.push(structuredClone(message));
      },
      async getPlatformInfo() {
        counters.platformInfo++;
        return { os: 'linux' };
      },
      onMessage: createEvent(),
      onInstalled: createEvent(),
      onStartup: createEvent(),
    },
    storage: {
      onChanged: storageChanged,
      session: createStorageArea('session', storageChanged),
      local: createStorageArea('local', storageChanged),
    },
    tabs: {
      async query({ url }) {
        return [...tabs.values()].filter((t) => urlMatches(t.url, url)).map(publicTab);
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return publicTab(tab);
      },
      async create(props) {
        created.push(props);
        return { id: 9000 + created.length, ...props };
      },
      sendMessage(tabId, message, options = {}) {
        sent.push({ tabId, frameId: options.frameId, message: structuredClone(message) });
        const tab = tabs.get(tabId);
        if (!tab) return Promise.reject(new Error(`No tab with id: ${tabId}.`));
        const frames = options.frameId === undefined ? [...tab.frames.entries()] : [[options.frameId, tab.frames.get(options.frameId)]];
        const receivers = frames.filter(([, frame]) => frame && frame.onMessage);
        if (!receivers.length) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              const replies = receivers.map(([frameId, frame]) => frame.onMessage(structuredClone(message), { tabId, frameId }));
              Promise.resolve(replies[0]).then(resolve, reject);
            } catch (err) {
              reject(err);
            }
          });
        });
      },
      onRemoved: createEvent(),
      onUpdated: createEvent(),
    },
    scripting: {
      async executeScript({ target, files, func, world }) {
        injections.push({ api: 'executeScript', target: structuredClone(target), files, probe: typeof func === 'function', world });
        const tab = tabs.get(target.tabId);
        if (!tab) throw new Error(`No tab with id: ${target.tabId}`);
        if (failInjection.has(target.tabId)) throw new Error('Cannot access contents of the page.');
        // The only func the background injects is the location.href probe.
        return framesFor(tab, target).map((f) => ({ frameId: f.frameId, result: func ? f.url : undefined }));
      },
      async insertCSS({ target, files }) {
        injections.push({ api: 'insertCSS', target: structuredClone(target), files });
        if (failInjection.has(target.tabId)) throw new Error('Cannot access contents of the page.');
      },
    },
    cookies: {
      async get(details) {
        cookieCalls.push(details);
        return cookies.get(details.name) || null;
      },
      onChanged: createEvent(),
    },
  };

  return {
    chrome, sent, runtimeSent, created, injections, failInjection, cookies, cookieCalls, counters,
    addTab({ id, url, frames, discarded = false, windowId = 1, index = tabs.size, pendingUrl }) {
      const frameMap = new Map(Object.entries(frames || { 0: {} }).map(([frameId, frame]) => [Number(frameId), { url, ...frame }]));
      tabs.set(id, { id, url, pendingUrl, discarded, windowId, index, status: 'complete', frames: frameMap });
    },
    removeTab: (id) => tabs.delete(id),
    /**
     * Commits a navigation of tab `id` to `url` (the old page and its content script are gone) and returns the
     * arguments Chrome passes to tabs.onUpdated: changeInfo.url and tab.url only for a host the extension may access.
     */
    navigate(id, url) {
      const tab = tabs.get(id);
      Object.assign(tab, { url, pendingUrl: undefined, status: 'loading', frames: new Map([[0, { url }]]) });
      const changeInfo = visible(url) ? { status: 'loading', url } : { status: 'loading' };
      return [id, changeInfo, publicTab(tab)];
    },
    sentTo: (tabId, type) => sent.filter((s) => s.tabId === tabId && (!type || s.message.type === type)),
  };
}

function expandResult(url, count, { title = 'Soulhack', skipped = [], warnings = [] } = {}) {
  return {
    source: { kind: 'playlist', url, title, subtitle: 'Forss', artwork: null },
    total: count + skipped.length,
    items: Array.from({ length: count }, (_, i) => ({
      url: `https://soundcloud.com/forss/track-${i + 1}`,
      title: `Forss - Track ${i + 1}`,
      thumb: `https://i1.sndcdn.com/artworks-${i + 1}-t500x500.jpg`,
    })),
    skipped,
    warnings,
  };
}

/** Stands in for background/soundcloud.js; *Impl functions can be replaced per test. */
function createFakeSc() {
  class ScError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'ScError';
      this.code = code;
    }
  }
  const sc = {
    ScError,
    clients: [],
    expandCalls: [],
    statusCalls: 0,
    libraryCalls: 0,
    expandImpl: async (url) => expandResult(url, 3),
    statusImpl: async () => ({ loggedIn: false }),
    libraryImpl: async () => ({ loggedIn: false, sections: [] }),
    createSoundCloudClient(options) {
      const client = { options };
      sc.clients.push(client);
      return client;
    },
    async expand(client, url, options) {
      sc.expandCalls.push({ client, url, options });
      return sc.expandImpl(url, options);
    },
    async getStatus(client) {
      sc.statusCalls++;
      return sc.statusImpl(client);
    },
    async listLibrary(client) {
      sc.libraryCalls++;
      return sc.libraryImpl(client);
    },
  };
  return sc;
}

function setup({ timing = {}, fake = createFakeChrome(), sc = createFakeSc(), start = 1_000_000 } = {}) {
  let time = start;
  const clock = { now: () => time, advance: (ms) => { time += ms; } };
  const errors = [];
  const bg = createBackground({
    chrome: fake.chrome,
    sc,
    urlTools,
    fetch: async () => {
      throw new Error('unit tests make no network requests');
    },
    now: clock.now,
    timing: { pingTimeoutMs: 100, addIdleTimeoutMs: 2000, cancelReplyMs: 100, keepAliveMs: 15, progressFlushMs: 200, loginChangedMs: 20, ...timing },
    log: { error: (...args) => errors.push(args) },
  });

  /** Sends a message the way chrome.runtime.onMessage would deliver it; resolves to the response. */
  function send(message, sender) {
    return new Promise((resolve) => {
      let responses = 0;
      const willRespond = bg.onMessage(message, sender, (response) => {
        responses++;
        assert.equal(responses, 1, 'sendResponse must be called exactly once');
        resolve(response);
      });
      if (willRespond !== true) resolve(undefined);
    });
  }

  return { fake, sc, clock, bg, send, errors };
}

const roomUrl = (streamkey) => `https://w2g.tv/en/room/?room_id=${streamkey}`;

/** A room tab's content script. `documentId` names the page (a reload or navigation gets a new one). */
function roomSender(tabId, { url = roomUrl(`sk${tabId}`), frameId = 0, id = EXT_ID, documentId = `doc-${tabId}`, documentLifecycle = 'active' } = {}) {
  const sender = { id, url, origin: new URL(url).origin, frameId, documentId, documentLifecycle, frameType: 'outermost_frame', tab: { id: tabId, url, windowId: 1, index: 0 } };
  if (documentId === null) delete sender.documentId;
  return sender;
}

/** The old page of a room tab that navigates to another site: Chrome sends its pagehide room:bye like this. */
function leavingRoomSender(tabId, { documentId = `doc-${tabId}`, frameId = 5 } = {}) {
  const sender = { ...roomSender(tabId, { documentId, frameId, documentLifecycle: 'pending_deletion' }) };
  delete sender.frameType;
  return sender;
}

function scSender(tabId, { frameId = 0, url = 'https://soundcloud.com/discover', origin } = {}) {
  return { id: EXT_ID, url, origin: origin ?? new URL(url).origin, frameId, documentId: `doc-sc-${tabId}-${frameId}`, documentLifecycle: 'active', tab: { id: tabId, url: 'https://soundcloud.com/discover', windowId: 1, index: 3 } };
}

const popupSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html`, origin: `chrome-extension://${EXT_ID}` };

/** Adds a w2g room tab whose content script answers room:ping (or `respond`), and registers it with room:hello. */
async function openRoom(env, tabId, { streamkey = `sk${tabId}`, joined = true, roomName = `Room ${tabId}`, respond, documentId } = {}) {
  const url = roomUrl(streamkey ?? 'x');
  const inbox = [];
  const reply = respond || ((msg) => (msg.type === 'room:ping' ? { ok: true, streamkey, joined, roomName } : undefined));
  env.fake.addTab({ id: tabId, url, frames: { 0: { url, onMessage: (msg) => { inbox.push(msg); return reply(msg); } } } });
  assert.deepEqual(await env.send({ type: 'room:hello', streamkey, joined, roomName, url }, roomSender(tabId, { url, documentId })), { ok: true });
  return inbox;
}

/** Adds a soundcloud.com tab; returns { [frameId]: messages received }. */
function openSoundCloudTab(env, tabId, frameUrls = { 0: 'https://soundcloud.com/discover' }) {
  const inbox = {};
  const frames = {};
  for (const [frameId, url] of Object.entries(frameUrls)) {
    inbox[frameId] = [];
    frames[frameId] = { url, onMessage: (msg) => { inbox[frameId].push(msg); } };
  }
  env.fake.addTab({ id: tabId, url: frameUrls[0], frames });
  return inbox;
}

/** A room content script that reports progress per 50 items and then confirms the add. */
function addingRoom(env, tabId, { streamkey = `sk${tabId}`, roomName = `Room ${tabId}`, delayMs = 0 } = {}) {
  return async (msg) => {
    if (msg.type === 'room:ping') return { ok: true, streamkey, joined: true, roomName };
    if (msg.type !== 'room:add') return undefined;
    for (let done = 0; done < msg.items.length;) {
      done = Math.min(done + 50, msg.items.length);
      if (delayMs) await sleep(delayMs);
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done, total: msg.items.length }, roomSender(tabId, { url: roomUrl(streamkey) }));
    }
    return { ok: true, added: msg.items.length, playlistKey: 'pl-key' };
  };
}

function storedRooms(env) {
  return env.fake.chrome.storage.session.data.get('rooms') || {};
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

test('settings: defaults, merge, clamping and invalid values', async () => {
  const env = setup();
  assert.deepEqual(await env.send({ type: 'settings:get' }, popupSender), { ok: true, settings: { skipPreviews: true, confirmAbove: 100 } });
  assert.deepEqual(DEFAULT_SETTINGS, { skipPreviews: true, confirmAbove: 100 });

  let res = await env.send({ type: 'settings:set', patch: { skipPreviews: false } }, popupSender);
  assert.deepEqual(res, { ok: true, settings: { skipPreviews: false, confirmAbove: 100 } });
  assert.deepEqual(env.fake.chrome.storage.local.data.get('settings'), { skipPreviews: false, confirmAbove: 100 });

  const cases = [
    [{ confirmAbove: '250' }, 250],
    [{ confirmAbove: 12.6 }, 13],
    [{ confirmAbove: -5 }, 0],
    [{ confirmAbove: 1e9 }, 10000],
    [{ confirmAbove: 'lots' }, 10000],
    [{ confirmAbove: null }, 10000],
    [{ confirmAbove: Number.NaN }, 10000],
  ];
  for (const [patch, expected] of cases) {
    res = await env.send({ type: 'settings:set', patch }, popupSender);
    assert.equal(res.settings.confirmAbove, expected, JSON.stringify(patch));
  }
  res = await env.send({ type: 'settings:set', patch: { skipPreviews: 'yes', evil: '<b>' } }, popupSender);
  assert.deepEqual(res.settings, { skipPreviews: false, confirmAbove: 10000 });
  assert.deepEqual(Object.keys(env.fake.chrome.storage.local.data.get('settings')).sort(), ['confirmAbove', 'skipPreviews']);

  res = await env.send({ type: 'settings:set', patch: 'nope' }, popupSender);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INTERNAL');

  // Corrupt stored values fall back to the defaults.
  await env.fake.chrome.storage.local.set({ settings: { skipPreviews: 1, confirmAbove: 'x' } });
  assert.deepEqual((await env.send({ type: 'settings:get' }, popupSender)).settings, DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(undefined), {});
});

test('settings: readable from soundcloud.com frames and room tabs, writable only by rooms and extension pages', async () => {
  const env = setup();
  assert.equal((await env.send({ type: 'settings:get' }, scSender(21, { frameId: 4 }))).ok, true);
  const denied = await env.send({ type: 'settings:set', patch: { skipPreviews: false } }, scSender(21));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'INTERNAL');
  assert.equal(env.fake.chrome.storage.local.data.has('settings'), false);
  const fromRoom = await env.send({ type: 'settings:set', patch: { skipPreviews: false } }, roomSender(11));
  assert.deepEqual(fromRoom, { ok: true, settings: { skipPreviews: false, confirmAbove: 100 } });
});

test('settings: concurrent patches are all applied', async () => {
  const env = setup();
  await Promise.all([
    env.send({ type: 'settings:set', patch: { skipPreviews: false } }, popupSender),
    env.send({ type: 'settings:set', patch: { confirmAbove: 7 } }, popupSender),
  ]);
  assert.deepEqual(env.fake.chrome.storage.local.data.get('settings'), { skipPreviews: false, confirmAbove: 7 });
});

// ---------------------------------------------------------------------------------------------------------------
// Room registry

test('registry: room:hello adds and updates, room:active bumps lastActive, room:bye removes', async () => {
  const env = setup();
  await openRoom(env, 11, { streamkey: 'abc123', joined: false, roomName: '  Temporary Room  ' });
  assert.deepEqual(storedRooms(env), { 11: { tabId: 11, streamkey: 'abc123', joined: false, roomName: 'Temporary Room', unreachable: false, lastActive: 1_000_000, documentId: 'doc-11' } });

  // A page re-announcing itself (join state or name changed, which page scripts can trigger) isn't user activity.
  env.clock.advance(5000);
  await env.send({ type: 'room:hello', streamkey: 'abc123', joined: true, roomName: 'Temporary Room' }, roomSender(11, { url: roomUrl('abc123') }));
  assert.equal(storedRooms(env)[11].joined, true);
  assert.equal(storedRooms(env)[11].lastActive, 1_000_000);

  env.clock.advance(1000);
  assert.deepEqual(await env.send({ type: 'room:active' }, roomSender(11)), { ok: true });
  assert.equal(storedRooms(env)[11].lastActive, 1_006_000);

  // The documentId stays inside the background.
  const res = await env.send({ type: 'rooms:get' }, scSender(21));
  assert.deepEqual(res, {
    ok: true,
    rooms: [{ tabId: 11, streamkey: 'abc123', joined: true, roomName: 'Temporary Room', unreachable: false, lastActive: 1_006_000 }],
    target: { tabId: 11, streamkey: 'abc123', joined: true, roomName: 'Temporary Room', unreachable: false, lastActive: 1_006_000 },
    pinnedTabId: null,
  });

  // A new page in the tab registers afresh (a reload's pagehide bye usually removed the old entry first).
  env.clock.advance(1000);
  await env.send({ type: 'room:hello', streamkey: 'abc123', joined: true, roomName: 'Temporary Room' }, roomSender(11, { url: roomUrl('abc123'), documentId: 'doc-11b' }));
  assert.deepEqual([storedRooms(env)[11].lastActive, storedRooms(env)[11].documentId], [1_007_000, 'doc-11b']);

  assert.deepEqual(await env.send({ type: 'room:bye' }, roomSender(11, { documentId: 'doc-11b' })), { ok: true });
  assert.deepEqual(storedRooms(env), {});
  assert.deepEqual(await env.send({ type: 'room:active' }, roomSender(11)), { ok: true });
  assert.deepEqual(storedRooms(env), {});
});

test('registry: a background room tab that re-announces itself doesn\'t become the most recently used room (contracts-4)', async () => {
  const env = setup();
  await openRoom(env, 11, { roomName: 'A' });
  env.clock.advance(1000);
  await openRoom(env, 12, { roomName: 'B' });
  env.clock.advance(1000);
  await env.send({ type: 'room:active' }, roomSender(12));
  // Room A's page changes its name or join state (e.g. a script edits the name element): it announces again.
  env.clock.advance(1000);
  await env.send({ type: 'room:hello', streamkey: 'sk11', joined: true, roomName: 'A renamed' }, roomSender(11));
  const res = await env.send({ type: 'rooms:get' }, scSender(21));
  assert.deepEqual(res.rooms.map((r) => [r.tabId, r.roomName]), [[12, 'B'], [11, 'A renamed']]);
  assert.equal(res.target.tabId, 12);
});

test('registry: untrusted room fields are sanitized', () => {
  assert.deepEqual(roomFields({ streamkey: '<img src=x>', joined: 'yes', roomName: 42, unreachable: 'yes' }), { streamkey: null, joined: false, roomName: null, unreachable: false });
  assert.equal(roomFields({ roomName: 'x'.repeat(500) }).roomName.length, 120);
  assert.deepEqual(roomFields(null), { streamkey: null, joined: false, roomName: null, unreachable: false });
  assert.deepEqual(roomFields({ streamkey: 'v3pszu7utqxc93m60h', joined: true, roomName: ' Room ' }), { streamkey: 'v3pszu7utqxc93m60h', joined: true, roomName: 'Room', unreachable: false });
  assert.equal(roomFields({ joined: false, unreachable: true }).unreachable, true);
  assert.equal(roomFields({ joined: true, unreachable: true }).unreachable, false, 'a joined room is reachable');
});

test('registry: room:bye only counts from the page that registered, also from a page being replaced (background/bg-1)', async () => {
  const env = setup();
  const scInbox = openSoundCloudTab(env, 21);
  await openRoom(env, 11, { documentId: 'DOC-A' });

  // A late bye from the page before (e.g. its pagehide arrives after the reloaded page's hello) changes nothing.
  assert.deepEqual(await env.send({ type: 'room:bye' }, roomSender(11, { documentId: 'DOC-OLD' })), { ok: true });
  // Neither does a bye from another w2g document of that tab that isn't its main frame.
  await env.send({ type: 'room:bye' }, leavingRoomSender(11, { documentId: 'DOC-OTHER' }));
  await env.send({ type: 'room:bye' }, leavingRoomSender(11, { documentId: null }));
  assert.deepEqual(Object.keys(storedRooms(env)), ['11']);
  // Nor one from another tab.
  await env.send({ type: 'room:bye' }, leavingRoomSender(12, { documentId: 'DOC-A' }));
  assert.deepEqual(Object.keys(storedRooms(env)), ['11']);

  // The user navigates the room tab to another site: Chrome sends the room page's pagehide bye from the
  // document being replaced (frameId != 0, documentLifecycle 'pending_deletion'), with the same documentId.
  assert.deepEqual(await env.send({ type: 'room:bye' }, leavingRoomSender(11, { documentId: 'DOC-A', frameId: 7 })), { ok: true });
  assert.deepEqual(storedRooms(env), {});
  await flush();
  assert.deepEqual(scInbox[0].at(-1), { type: 'rooms:changed', rooms: [], target: null });

  // Without a documentId on either side, a bye from the tab's main frame still counts (and only from there).
  await openRoom(env, 12, { documentId: null });
  await env.send({ type: 'room:bye' }, leavingRoomSender(12, { documentId: 'DOC-X' }));
  assert.deepEqual(Object.keys(storedRooms(env)), ['12']);
  await env.send({ type: 'room:bye' }, roomSender(12, { documentId: 'DOC-X' }));
  assert.deepEqual(storedRooms(env), {});
  await openRoom(env, 13, { documentId: 'DOC-C' });
  await env.send({ type: 'room:bye' }, roomSender(13, { documentId: null }));
  assert.deepEqual(storedRooms(env), {});

  // The documentId survives a service worker restart.
  await openRoom(env, 14, { documentId: 'DOC-D' });
  const restarted = setup({ fake: env.fake });
  await restarted.send({ type: 'room:bye' }, leavingRoomSender(14, { documentId: 'DOC-OLD' }));
  assert.equal((await restarted.send({ type: 'rooms:get' }, popupSender)).rooms.length, 1);
  await restarted.send({ type: 'room:bye' }, leavingRoomSender(14, { documentId: 'DOC-D' }));
  assert.equal((await restarted.send({ type: 'rooms:get' }, popupSender)).rooms.length, 0);
});

test('registry: tabs.onRemoved and navigation away from the room remove entries', async () => {
  const env = setup();
  await openRoom(env, 11);
  await openRoom(env, 12);

  await env.bg.onTabRemoved(11);
  assert.deepEqual(Object.keys(storedRooms(env)), ['12']);

  // Still in the room (w2g rewrites ?room_id= to ?access_key= after joining), or no URL change at all.
  await env.bg.onTabUpdated(12, { url: 'https://w2g.tv/en/room/?access_key=baldbe3qryjsqtxygno87e' });
  await env.bg.onTabUpdated(12, { status: 'complete' });
  await env.bg.onTabUpdated(12, { url: 'https://w2g.tv/de/room/mobile/?access_key=x' });
  assert.deepEqual(Object.keys(storedRooms(env)), ['12']);

  await env.bg.onTabUpdated(12, { url: 'https://w2g.tv/en/' });
  assert.deepEqual(storedRooms(env), {});
});

test('registry: a room tab that starts loading a page whose URL the extension cannot see is removed (background/bg-1)', async () => {
  const env = setup();
  const scInbox = openSoundCloudTab(env, 21);
  await openRoom(env, 11);
  await openRoom(env, 12);
  const roomTab = (id) => ({ id, url: roomUrl(`sk${id}`), status: 'loading', windowId: 1, index: 0 });

  // Reloading the room, or events that say nothing about the page, keep the entry.
  await env.bg.onTabUpdated(12, { status: 'loading' }, roomTab(12));
  await env.bg.onTabUpdated(12, { status: 'loading' }, { ...roomTab(12), pendingUrl: roomUrl('sk12') });
  await env.bg.onTabUpdated(12, { title: 'w2g' }, { id: 12, status: 'complete' });
  await env.bg.onTabUpdated(12, { status: 'loading' });
  await env.bg.onTabUpdated(12, { discarded: true }, { id: 12, status: 'unloaded' });
  assert.deepEqual(Object.keys(storedRooms(env)).sort(), ['11', '12']);

  // Navigating to another site: the 'loading' event has no url, and neither has the tab.
  const args = env.fake.navigate(12, 'https://www.youtube.com/');
  assert.deepEqual(args[1], { status: 'loading' });
  assert.equal(args[2].url, undefined);
  await env.bg.onTabUpdated(...args);
  assert.deepEqual(Object.keys(storedRooms(env)), ['11']);
  await flush();
  assert.deepEqual(scInbox[0].at(-1).rooms.map((r) => r.tabId), [11], 'the soundcloud.com tabs learn about it');

  // A non-room w2g page the extension can see.
  await env.bg.onTabUpdated(...env.fake.navigate(11, 'https://w2g.tv/en/'));
  assert.deepEqual(storedRooms(env), {});

  // Unregistered tabs loading other sites change nothing (and broadcast nothing).
  const before = env.fake.sent.length;
  env.fake.addTab({ id: 30, url: 'https://example.com/' });
  await env.bg.onTabUpdated(...env.fake.navigate(30, 'https://example.org/'));
  await flush();
  assert.equal(env.fake.sent.length, before);
});

test('registry: survives a service worker restart through chrome.storage.session', async () => {
  const env = setup();
  await openRoom(env, 11);
  await env.send({ type: 'rooms:set-target', tabId: 11 }, popupSender);

  const restarted = setup({ fake: env.fake });
  const res = await restarted.send({ type: 'rooms:get' }, popupSender);
  assert.deepEqual(res.rooms.map((r) => r.tabId), [11]);
  assert.equal(res.pinnedTabId, 11);
  assert.equal(res.target.tabId, 11);
});

test('registry: concurrent hellos from several tabs are all kept', async () => {
  const env = setup();
  const senders = [11, 12, 13, 14].map((id) => env.send({ type: 'room:hello', streamkey: `sk${id}`, joined: true, roomName: null }, roomSender(id)));
  await Promise.all(senders);
  assert.deepEqual(Object.keys(storedRooms(env)).sort(), ['11', '12', '13', '14']);
});

test('isRoomUrl matches the w2g-room content script pages', () => {
  for (const url of ['https://w2g.tv/en/room/?room_id=abc', 'https://w2g.tv/room/?r=abc', 'https://w2g.tv/de/room/mobile/?access_key=x']) {
    assert.equal(isRoomUrl(url), true, url);
    assert.equal(urlMatches(url, MANIFEST.content_scripts[0].matches), true, url);
  }
  for (const url of ['https://w2g.tv/en/', 'https://w2g.tv/rooms/abc', 'https://evil.example/en/room/', 'http://w2g.tv/en/room/', null]) {
    assert.equal(isRoomUrl(url), false, String(url));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Target selection

test('selectTarget: pinned room, then joined by recency, then any room with a streamkey', () => {
  const room = (tabId, joined, lastActive, streamkey = `sk${tabId}`) => ({ tabId, streamkey, joined, roomName: null, lastActive });
  assert.equal(selectTarget([], null), null);
  assert.equal(selectTarget([room(1, false, 10, null)], null), null);
  assert.equal(selectTarget([room(1, false, 10)], null).tabId, 1);
  assert.equal(selectTarget([room(1, true, 5), room(2, false, 50)], null).tabId, 1);
  assert.equal(selectTarget([room(1, true, 5), room(2, true, 9), room(3, false, 50)], null).tabId, 2);
  assert.equal(selectTarget([room(1, false, 5), room(2, false, 9, null)], null).tabId, 1);
  assert.equal(selectTarget([room(1, true, 50), room(2, false, 9)], 2).tabId, 2, 'pinned wins even when not joined');
  assert.equal(selectTarget([room(1, true, 50)], 7).tabId, 1, 'a pinned tab that is gone is ignored');
});

test('rooms:set-target pins a room from the popup until the tab closes, also across reloads', async () => {
  const env = setup();
  await openRoom(env, 11);
  env.clock.advance(1000);
  await openRoom(env, 12, { joined: false });
  env.clock.advance(1000);
  await openRoom(env, 13);

  let res = await env.send({ type: 'rooms:get' }, popupSender);
  assert.deepEqual(res.rooms.map((r) => r.tabId), [13, 12, 11]);
  assert.equal(res.target.tabId, 13);

  assert.deepEqual(await env.send({ type: 'rooms:set-target', tabId: 12 }, popupSender), { ok: true });
  res = await env.send({ type: 'rooms:get' }, popupSender);
  assert.equal(res.target.tabId, 12);
  assert.equal(res.pinnedTabId, 12);
  assert.equal(env.fake.chrome.storage.session.data.get('targetTabId'), 12);

  // Activity in another room doesn't override an explicit choice.
  env.clock.advance(1000);
  await env.send({ type: 'room:active' }, roomSender(11));
  assert.equal((await env.send({ type: 'rooms:get' }, popupSender)).target.tabId, 12);

  // Reloading the pinned tab (room:bye, then room:hello) keeps the choice.
  await env.send({ type: 'room:bye' }, roomSender(12));
  res = await env.send({ type: 'rooms:get' }, popupSender);
  assert.equal(res.target.tabId, 11);
  assert.equal(res.pinnedTabId, null);
  await env.send({ type: 'room:hello', streamkey: 'sk12', joined: true, roomName: 'Room 12' }, roomSender(12));
  assert.equal((await env.send({ type: 'rooms:get' }, popupSender)).pinnedTabId, 12);

  await env.bg.onTabRemoved(12);
  res = await env.send({ type: 'rooms:get' }, popupSender);
  assert.equal(res.target.tabId, 11);
  assert.equal(res.pinnedTabId, null);

  await env.send({ type: 'rooms:set-target', tabId: 13 }, popupSender);
  assert.deepEqual(await env.send({ type: 'rooms:set-target', tabId: null }, popupSender), { ok: true });
  assert.equal((await env.send({ type: 'rooms:get' }, popupSender)).target.tabId, 11);

  const gone = await env.send({ type: 'rooms:set-target', tabId: 99 }, popupSender);
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'NO_ROOM');
  const bad = await env.send({ type: 'rooms:set-target', tabId: 'x' }, popupSender);
  assert.equal(bad.error.code, 'INTERNAL');
  const fromContent = await env.send({ type: 'rooms:set-target', tabId: 13 }, scSender(21));
  assert.equal(fromContent.ok, false);
  assert.equal((await env.send({ type: 'rooms:get' }, popupSender)).pinnedTabId, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Broadcast

test('rooms:changed goes to all frames of every soundcloud.com tab on each registry change', async () => {
  const env = setup();
  const sc1 = openSoundCloudTab(env, 21, { 0: 'https://soundcloud.com/discover', 7: 'https://soundcloud.com/n/forss/flickermood' });
  env.fake.addTab({ id: 22, url: 'https://soundcloud.com/forss' }); // no content script: sendMessage rejects
  env.fake.addTab({ id: 23, url: 'https://soundcloud.com/x', discarded: true });
  env.fake.addTab({ id: 30, url: 'https://example.com/' });

  await openRoom(env, 11, { roomName: 'Temporary Room' });
  await flush();
  const broadcasts = env.fake.sent.filter((s) => s.message.type === 'rooms:changed');
  assert.deepEqual(broadcasts.map((s) => s.tabId).sort(), [21, 22]);
  assert.ok(broadcasts.every((s) => s.frameId === undefined), 'no frameId: every frame gets it');
  const room = { tabId: 11, streamkey: 'sk11', joined: true, roomName: 'Temporary Room', unreachable: false, lastActive: 1_000_000 };
  assert.deepEqual(sc1[0], [{ type: 'rooms:changed', rooms: [room], target: room }]);
  assert.deepEqual(sc1[7], sc1[0]);

  // No change, no broadcast.
  await env.send({ type: 'room:active' }, roomSender(11));
  await flush();
  assert.equal(sc1[0].length, 1);

  await env.send({ type: 'room:bye' }, roomSender(11));
  await flush();
  assert.deepEqual(sc1[0][1], { type: 'rooms:changed', rooms: [], target: null });
  assert.deepEqual(sc1[7][1], sc1[0][1]);

  // Pinning changes the target, so it is broadcast too.
  await openRoom(env, 12);
  env.clock.advance(10);
  await openRoom(env, 13);
  await env.send({ type: 'rooms:set-target', tabId: 12 }, popupSender);
  await flush();
  assert.equal(sc1[0].at(-1).target.tabId, 12);
});

// ---------------------------------------------------------------------------------------------------------------
// Sender validation and the onMessage contract

test('sender validation', async () => {
  const env = setup();
  const reject = async (message, sender, label) => {
    const res = await env.send(message, sender);
    assert.equal(res.ok, false, label);
    assert.equal(res.error.code, 'INTERNAL', label);
    return res;
  };
  const hello = { type: 'room:hello', streamkey: 'sk1', joined: true, roomName: 'R' };
  await reject(hello, roomSender(11, { frameId: 3 }), 'w2g subframe');
  // A page being replaced (or any w2g.tv document that isn't the main frame) may only say goodbye.
  await reject(hello, leavingRoomSender(11), 'pending_deletion document');
  await reject({ type: 'room:active' }, leavingRoomSender(11), 'room:active from a pending_deletion document');
  await reject({ type: 'job:progress', jobId: 'x', done: 1, total: 2 }, leavingRoomSender(11), 'progress from a pending_deletion document');
  await reject({ type: 'room:bye' }, scSender(21), 'room:bye from soundcloud.com');
  await reject(hello, roomSender(11, { url: 'https://w2g.tv/en/' }), 'w2g page that is not a room');
  await reject(hello, scSender(21), 'soundcloud.com frame');
  await reject(hello, roomSender(11, { id: 'otherextensionidotherextensionid' }), 'another extension');
  await reject(hello, { ...roomSender(11), tab: undefined }, 'no tab');
  await reject(hello, popupSender, 'extension page');
  assert.deepEqual(storedRooms(env), {});

  const queue = { type: 'queue', jobId: 'j1', source: { url: SET_URL, kind: 'playlist' } };
  const fromRoom = await reject(queue, roomSender(11), 'queue from a w2g room');
  assert.equal(fromRoom.jobId, 'j1');
  await reject(queue, scSender(21, { url: 'https://soundcloud.com/x', origin: 'null' }), 'sandboxed frame');
  await reject({ type: 'sc:expand', url: SET_URL }, scSender(21), 'sc:expand from soundcloud.com');
  await reject({ type: 'job:progress', jobId: 'x', done: 1, total: 2 }, scSender(21), 'progress from soundcloud.com');
  await reject({ type: 'rooms:get' }, { ...popupSender, id: 'otherextensionidotherextensionid' }, 'rooms:get from another extension');
  assert.equal(env.sc.expandCalls.length, 0);

  // Allowed: queue from any soundcloud.com frame, rooms:get from content scripts.
  assert.equal((await env.send(queue, scSender(21, { frameId: 9, url: 'https://soundcloud.com/n/a/b' }))).error.code, 'NO_ROOM');
  assert.equal((await env.send({ type: 'rooms:get' }, scSender(21, { frameId: 9 }))).ok, true);
});

test('onMessage: returns true and responds once for known types, ignores everything else', async () => {
  const env = setup();
  let called = false;
  assert.equal(env.bg.onMessage({ type: 'nope' }, popupSender, () => { called = true; }), false);
  assert.equal(env.bg.onMessage(null, popupSender, () => { called = true; }), false);
  assert.equal(env.bg.onMessage('rooms:get', popupSender, () => { called = true; }), false);
  assert.equal(env.bg.onMessage({ type: 'toString' }, popupSender, () => { called = true; }), false);
  await flush();
  assert.equal(called, false);
  assert.deepEqual(await env.send({ type: 'rooms:get' }, popupSender), { ok: true, rooms: [], target: null, pinnedTabId: null });
});

// ---------------------------------------------------------------------------------------------------------------
// Queue

test('queue: happy path relays progress to the origin frame in order and ends with the QueueResult', async () => {
  const env = setup();
  const roomInbox = await openRoom(env, 11, { roomName: 'Temporary Room', respond: addingRoom(env, 11, { roomName: 'Temporary Room' }) });
  const scInbox = openSoundCloudTab(env, 21, { 0: 'https://soundcloud.com/discover', 7: 'https://soundcloud.com/n/forss/flickermood' });
  env.sc.expandImpl = async (url) => expandResult(url, 120, { skipped: [{ title: 'Gone', reason: 'unavailable' }], warnings: ['private_tracks'] });
  await env.send({ type: 'settings:set', patch: { confirmAbove: 500 } }, popupSender);
  scInbox[0].length = 0;
  scInbox[7].length = 0;

  const res = await env.send({ type: 'queue', jobId: 'job-1', source: { url: `${SET_URL}?si=abc`, kind: 'playlist' } },
    scSender(21, { frameId: 7, url: 'https://soundcloud.com/n/forss/flickermood' }));

  assert.deepEqual(res, {
    ok: true,
    jobId: 'job-1',
    added: 120,
    title: 'Soulhack',
    skipped: [{ title: 'Gone', reason: 'unavailable' }],
    warnings: ['private_tracks'],
    room: { tabId: 11, streamkey: 'sk11', joined: true, roomName: 'Temporary Room', unreachable: false, lastActive: 1_000_000 },
  });
  assert.deepEqual(scInbox[7], [
    { type: 'job:progress', jobId: 'job-1', phase: 'resolving' },
    { type: 'job:progress', jobId: 'job-1', phase: 'adding', done: 0, total: 120, title: 'Soulhack' },
    { type: 'job:progress', jobId: 'job-1', phase: 'adding', done: 50, total: 120, title: 'Soulhack' },
    { type: 'job:progress', jobId: 'job-1', phase: 'adding', done: 100, total: 120, title: 'Soulhack' },
    { type: 'job:progress', jobId: 'job-1', phase: 'adding', done: 120, total: 120, title: 'Soulhack' },
  ]);
  assert.deepEqual(scInbox[0], [], 'only the frame that queued gets progress');
  assert.ok(env.fake.sentTo(21, 'job:progress').every((s) => s.frameId === 7));

  assert.deepEqual(roomInbox.map((m) => m.type), ['room:ping', 'room:add']);
  const add = roomInbox[1];
  assert.equal(add.title, 'Soulhack');
  assert.equal(add.items.length, 120);
  assert.deepEqual(add.items[0], { url: 'https://soundcloud.com/forss/track-1', title: 'Forss - Track 1', thumb: 'https://i1.sndcdn.com/artworks-1-t500x500.jpg' });
  assert.equal(typeof add.jobId, 'string');
  assert.ok(env.fake.sentTo(11).every((s) => s.frameId === 0), 'room messages go to frame 0');

  assert.equal(env.sc.expandCalls.length, 1);
  assert.equal(env.sc.expandCalls[0].url, `${SET_URL}?si=abc`);
  assert.deepEqual(env.sc.expandCalls[0].options, { skipPreviews: true, maxTracks: 1000 });
});

test('queue: needsConfirm above settings.confirmAbove, then the confirmed re-send reuses the expansion', async () => {
  const env = setup();
  const roomInbox = await openRoom(env, 11, { respond: addingRoom(env, 11) });
  const scInbox = openSoundCloudTab(env, 21);
  env.sc.expandImpl = async (url) => expandResult(url, 150, { skipped: [{ title: 'x', reason: 'geo_blocked' }, { title: null, reason: 'unavailable' }] });
  const source = { url: SET_URL, kind: 'playlist' };

  const first = await env.send({ type: 'queue', jobId: 'j1', source }, scSender(21));
  assert.deepEqual(first, { ok: true, jobId: 'j1', needsConfirm: true, count: 150, title: 'Soulhack', skippedCount: 2 });
  assert.equal(roomInbox.filter((m) => m.type === 'room:add').length, 0);

  env.clock.advance(60 * 1000);
  const second = await env.send({ type: 'queue', jobId: 'j1', source, confirmed: true }, scSender(21));
  assert.equal(second.ok, true);
  assert.equal(second.added, 150);
  assert.equal(env.sc.expandCalls.length, 1, 'the confirmed re-send used the cached expansion');
  assert.equal(roomInbox.filter((m) => m.type === 'room:add').length, 1);
  assert.deepEqual(scInbox[0].filter((m) => m.type === 'job:progress').map((m) => m.phase), ['resolving', 'resolving', 'adding', 'adding', 'adding', 'adding']);

  // The cache expires after 2 minutes.
  env.clock.advance(2 * 60 * 1000);
  await env.send({ type: 'queue', jobId: 'j2', source }, scSender(21));
  assert.equal(env.sc.expandCalls.length, 2);

  // A higher threshold adds right away.
  await env.send({ type: 'settings:set', patch: { confirmAbove: 150 } }, popupSender);
  const direct = await env.send({ type: 'queue', jobId: 'j3', source }, scSender(21));
  assert.equal(direct.added, 150);
});

test('queue: NO_ROOM without a room tab', async () => {
  const env = setup();
  const res = await env.send({ type: 'queue', jobId: 7, source: { url: SET_URL, kind: 'playlist' } }, scSender(21));
  assert.equal(res.ok, false);
  assert.equal(res.jobId, 7);
  assert.equal(res.error.code, 'NO_ROOM');
  assert.match(res.error.message, /w2g/);
  assert.equal(env.sc.expandCalls.length, 0);
});

test('queue: invalid, unsupported and missing input', async () => {
  const env = setup();
  await openRoom(env, 11);
  const q = (source, jobId = 'j') => env.send({ type: 'queue', jobId, source }, scSender(21));
  assert.equal((await q({ url: 'https://example.com/forss/sets/soulhack' })).error.code, 'INVALID_URL');
  assert.equal((await q({ url: 'https://soundcloud.com/search?q=x' })).error.code, 'UNSUPPORTED_URL');
  assert.equal((await q(undefined)).error.code, 'INVALID_URL');
  const noJob = await env.send({ type: 'queue', source: { url: SET_URL } }, scSender(21));
  assert.deepEqual(noJob, { ok: false, jobId: null, error: { code: 'INTERNAL', message: 'queue needs a jobId.' } });
  assert.equal(env.sc.expandCalls.length, 0);
  assert.equal(env.fake.sentTo(11, 'room:ping').length, 0);
});

test('queue: NOT_JOINED when the room tab reports it has not joined', async () => {
  const env = setup();
  let joined = true;
  await openRoom(env, 11, { respond: (msg) => (msg.type === 'room:ping' ? { ok: true, streamkey: 'sk11', joined, roomName: 'Room 11' } : undefined) });
  joined = false; // e.g. the w2g session expired since room:hello
  const res = await env.send({ type: 'queue', jobId: 'j', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'NOT_JOINED');
  assert.equal(storedRooms(env)[11].joined, false, 'the ping reply refreshed the registry');
  assert.equal(env.sc.expandCalls.length, 0);
});

test('queue: W2G_UNREACHABLE, not NOT_JOINED, when the room tab can\'t reach w2g (background-1)', async () => {
  const env = setup();
  let pong = { ok: true, streamkey: 'sk11', joined: true, roomName: 'Room 11' };
  await openRoom(env, 11, { respond: (msg) => (msg.type === 'room:ping' ? pong : undefined) });
  // The room tab's check of w2g failed without w2g's join dialog showing (a network blip, not a missing join).
  pong = { ok: true, streamkey: 'sk11', joined: false, unreachable: true, roomName: 'Room 11' };
  const res = await env.send({ type: 'queue', jobId: 'j', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'W2G_UNREACHABLE');
  assert.match(res.error.message, /can't reach w2g/);
  assert.deepEqual([storedRooms(env)[11].joined, storedRooms(env)[11].unreachable], [false, true]);
  assert.equal(env.sc.expandCalls.length, 0);

  // Once w2g answers again, the room is used as usual.
  pong = { ok: true, streamkey: 'sk11', joined: true, roomName: 'Room 11' };
  const rooms = await env.send({ type: 'rooms:get' }, scSender(21));
  assert.equal(rooms.rooms[0].unreachable, true);
  const again = await env.send({ type: 'queue', jobId: 'j2', source: { url: SET_URL } }, scSender(21));
  assert.notEqual(again.error && again.error.code, 'W2G_UNREACHABLE');
  assert.deepEqual([storedRooms(env)[11].joined, storedRooms(env)[11].unreachable], [true, false]);
});

test('queue: ROOM_UNREACHABLE when the room tab does not answer room:ping', async () => {
  const env = setup();
  await openRoom(env, 11);
  // The content script is gone (e.g. extension updated, re-injection failed) but the tab still shows the room.
  env.fake.addTab({ id: 11, url: roomUrl('sk11'), frames: { 0: {} } });
  let res = await env.send({ type: 'queue', jobId: 'j', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'ROOM_UNREACHABLE');
  assert.deepEqual(Object.keys(storedRooms(env)), ['11'], 'kept: reloading the tab fixes it');

  // A content script that never answers.
  env.fake.addTab({ id: 11, url: roomUrl('sk11'), frames: { 0: { onMessage: () => new Promise(() => {}) } } });
  const t0 = Date.now();
  res = await env.send({ type: 'queue', jobId: 'j2', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'ROOM_UNREACHABLE');
  assert.ok(Date.now() - t0 < 1500, 'gave up after the ping timeout');
  assert.equal(env.sc.expandCalls.length, 0);
});

test('queue: a stale entry for a closed tab is dropped and the next room is used', async () => {
  const env = setup();
  await openRoom(env, 12, { respond: addingRoom(env, 12) });
  env.clock.advance(1000);
  await openRoom(env, 11);
  env.fake.removeTab(11); // closed while the worker missed tabs.onRemoved
  const res = await env.send({ type: 'queue', jobId: 'j', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.ok, true);
  assert.equal(res.room.tabId, 12);
  assert.deepEqual(Object.keys(storedRooms(env)), ['12']);
});

test('queue: an entry whose tab now shows another site is dropped, also when pinned (background/bg-1)', async () => {
  const env = setup();
  await openRoom(env, 12, { respond: addingRoom(env, 12) });
  env.clock.advance(1000);
  await openRoom(env, 11);
  // Tab 11 went to another site and no event reached the registry: chrome.tabs.get shows no url.
  env.fake.navigate(11, 'https://www.youtube.com/');
  assert.equal((await env.fake.chrome.tabs.get(11)).url, undefined);
  let res = await env.send({ type: 'queue', jobId: 'j1', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.room.tabId, 12);
  assert.deepEqual(Object.keys(storedRooms(env)), ['12']);

  // The same for a pinned room: the pin is dropped with it.
  env.clock.advance(1000);
  await openRoom(env, 13);
  await env.send({ type: 'rooms:set-target', tabId: 13 }, popupSender);
  env.fake.navigate(13, 'https://example.com/');
  res = await env.send({ type: 'queue', jobId: 'j2', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.room.tabId, 12);
  const after = await env.send({ type: 'rooms:get' }, popupSender);
  assert.deepEqual([after.rooms.map((r) => r.tabId), after.pinnedTabId], [[12], null]);

  // A tab that is loading a room page (pendingUrl) still counts as a room: reloading it will help.
  await openRoom(env, 14);
  env.fake.addTab({ id: 14, url: 'https://example.com/', pendingUrl: roomUrl('sk14') });
  await env.send({ type: 'rooms:set-target', tabId: 14 }, popupSender);
  res = await env.send({ type: 'queue', jobId: 'j3', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'ROOM_UNREACHABLE');
  assert.deepEqual(Object.keys(storedRooms(env)).sort(), ['12', '14']);
});

test('queue: the most recently active room is asked first even when its entry says not joined (integration/bg-1)', async () => {
  const env = setup();
  const b = await openRoom(env, 12, { respond: addingRoom(env, 12) });
  env.clock.advance(1000);
  // Room A (used last) announced joined:false after a failed w2g read; its room:ping re-probes and finds it joined.
  let aJoined = true;
  const a = await openRoom(env, 11, {
    joined: false,
    respond: async (msg) => (msg.type === 'room:ping'
      ? { ok: true, streamkey: 'sk11', joined: aJoined, roomName: 'Room 11' }
      : addingRoom(env, 11)(msg)),
  });
  assert.equal((await env.send({ type: 'rooms:get' }, popupSender)).target.tabId, 12, 'the registry alone would pick B');

  let res = await env.send({ type: 'queue', jobId: 'a1', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.room.tabId, 11);
  assert.equal(res.room.joined, true);
  assert.deepEqual(a.map((m) => m.type), ['room:ping', 'room:add']);
  assert.deepEqual(b, [], 'room B got nothing');
  assert.equal(storedRooms(env)[11].joined, true, 'the pong refreshed the registry');

  // If A really hasn't joined, the registry's choice (B) is used, and the reply says so (room).
  env.clock.advance(1000);
  await env.send({ type: 'room:hello', streamkey: 'sk11', joined: false, roomName: 'Room 11' }, roomSender(11));
  aJoined = false;
  a.length = 0;
  res = await env.send({ type: 'queue', jobId: 'a2', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.room.tabId, 12);
  assert.deepEqual(a.map((m) => m.type), ['room:ping']);
  assert.deepEqual(b.map((m) => m.type), ['room:ping', 'room:add']);

  // A pinned room is never swapped for another one.
  await env.send({ type: 'rooms:set-target', tabId: 11 }, popupSender);
  b.length = 0;
  res = await env.send({ type: 'queue', jobId: 'a3', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'NOT_JOINED');
  assert.deepEqual(b, []);
});

test('queue: NOT_JOINED, not NO_ROOM, while the open rooms have not joined (integration/bg-4)', async () => {
  const env = setup();
  // A reloaded room waiting at w2g's join dialog: no streamkey yet, not joined.
  const inbox = await openRoom(env, 11, { streamkey: null, joined: false, roomName: null });
  const snapshot = await env.send({ type: 'rooms:get' }, scSender(21));
  assert.deepEqual([snapshot.rooms.length, snapshot.target], [1, null]);
  let res = await env.send({ type: 'queue', jobId: 'j1', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'NOT_JOINED');
  assert.deepEqual(inbox.map((m) => m.type), ['room:ping'], 'asked the room first');

  // Two rooms, neither joined.
  env.clock.advance(1000);
  await openRoom(env, 12, { joined: false });
  res = await env.send({ type: 'queue', jobId: 'j2', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'NOT_JOINED');

  // A not-joined room that doesn't answer at all is reported as unreachable.
  await env.bg.onTabRemoved(12);
  env.fake.addTab({ id: 11, url: roomUrl('x'), frames: { 0: {} } });
  res = await env.send({ type: 'queue', jobId: 'j3', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'ROOM_UNREACHABLE');

  await env.bg.onTabRemoved(11);
  res = await env.send({ type: 'queue', jobId: 'j4', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'NO_ROOM');
  assert.equal(env.sc.expandCalls.length, 0);
});

test('queue: ROOM_UNREACHABLE when the room tab closes or goes silent during room:add', async () => {
  const env = setup({ timing: { addIdleTimeoutMs: 150 } });
  let onAdd = () => Promise.reject(new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'));
  await openRoom(env, 11, { respond: (msg) => (msg.type === 'room:ping' ? { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' } : onAdd(msg)) });
  const scInbox = openSoundCloudTab(env, 21);

  let res = await env.send({ type: 'queue', jobId: 'closed', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.ok, false);
  assert.equal(res.jobId, 'closed');
  assert.equal(res.error.code, 'ROOM_UNREACHABLE');
  assert.match(res.error.message, /closed or reloaded/);
  assert.deepEqual(scInbox[0].filter((m) => m.type === 'job:progress').map((m) => m.phase), ['resolving', 'adding']);

  onAdd = () => undefined; // answered without a reply
  res = await env.send({ type: 'queue', jobId: 'silent-reply', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'ROOM_UNREACHABLE');

  onAdd = () => new Promise(() => {}); // never answers and never reports progress
  res = await env.send({ type: 'queue', jobId: 'stalled', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'ROOM_STALLED');
  assert.match(res.error.message, /stopped reporting progress/);
  assert.equal('added' in res.error, false, 'nothing known about added tracks');
});

test('queue: a stalled job is cancelled in the room tab and reported as ROOM_STALLED with what was added (background/bg-3)', async () => {
  const env = setup({ timing: { addIdleTimeoutMs: 150 } });
  const scInbox = openSoundCloudTab(env, 21);
  let cancelReply = { ok: true, cancelled: true, added: 50 };
  const roomInbox = await openRoom(env, 11, {
    respond: async (msg) => {
      if (msg.type === 'room:ping') return { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' };
      if (msg.type === 'room:cancel') return cancelReply;
      // room:add: one batch, then silence (a hung tab, or w2g requests that never return)
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 50, total: 120 }, roomSender(11));
      return new Promise(() => {});
    },
  });
  env.sc.expandImpl = async (url) => expandResult(url, 120);
  let res = await env.send({ type: 'queue', jobId: 'big', source: { url: SET_URL }, confirmed: true }, scSender(21));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'ROOM_STALLED');
  assert.equal(res.error.added, 50);
  const add = roomInbox.find((m) => m.type === 'room:add');
  const cancels = env.fake.sentTo(11, 'room:cancel');
  assert.deepEqual(cancels.map((c) => [c.frameId, c.message]), [[0, { type: 'room:cancel', jobId: add.jobId }]]);
  assert.deepEqual(scInbox[0].filter((m) => m.type === 'job:progress').map((m) => [m.phase, m.done]), [['resolving', undefined], ['adding', 0], ['adding', 50]]);

  // The cancel reply can know more than the last progress message; a tab that doesn't answer it still gets an answer.
  cancelReply = { ok: true, cancelled: true, added: 100 };
  res = await env.send({ type: 'queue', jobId: 'big2', source: { url: SET_URL }, confirmed: true }, scSender(21));
  assert.equal(res.error.added, 100);
  cancelReply = new Promise(() => {});
  const t0 = Date.now();
  res = await env.send({ type: 'queue', jobId: 'big3', source: { url: SET_URL }, confirmed: true }, scSender(21));
  assert.deepEqual([res.error.code, res.error.added], ['ROOM_STALLED', 50]);
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the cancel reply beyond its timeout');
});

test('queue: after a stall, the room tab\'s own answer decides: finished is a success, our cancel stays ROOM_STALLED (contracts-3)', async () => {
  const env = setup({ timing: { addIdleTimeoutMs: 150 } });
  openSoundCloudTab(env, 21);
  let mode = 'finished';
  let resolveAdd = null;
  await openRoom(env, 11, {
    respond: async (msg) => {
      if (msg.type === 'room:ping') return { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' };
      if (msg.type === 'room:cancel') {
        // The room tab settles the job before it answers: here the last batch turned out to have landed.
        if (mode === 'finished') return { ok: true, cancelled: false, added: 120 };
        // Our cancel stopped the job: the room:add reply (CANCELLED) can come before the cancel reply.
        if (mode === 'cancelled') {
          resolveAdd({ ok: false, error: { code: 'CANCELLED', message: 'Cancelled.', added: 70 } });
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true, cancelled: true, added: 70 };
        }
        // The job ended on its own while the cancel was on its way.
        resolveAdd({ ok: true, added: 120, playlistKey: 'k' });
        return new Promise(() => {});
      }
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 50, total: 120 }, roomSender(11));
      return new Promise((r) => { resolveAdd = r; });
    },
  });
  env.sc.expandImpl = async (url) => expandResult(url, 120);
  let res = await env.send({ type: 'queue', jobId: 'f', source: { url: SET_URL }, confirmed: true }, scSender(21));
  assert.deepEqual([res.ok, res.added], [true, 120], 'a job that finished after all is a success');

  mode = 'cancelled';
  res = await env.send({ type: 'queue', jobId: 'c', source: { url: SET_URL }, confirmed: true }, scSender(21));
  assert.deepEqual([res.ok, res.error.code, res.error.added], [false, 'ROOM_STALLED', 70], 'not CANCELLED: the user cancelled nothing');

  mode = 'done-meanwhile';
  res = await env.send({ type: 'queue', jobId: 'd', source: { url: SET_URL }, confirmed: true }, scSender(21));
  assert.deepEqual([res.ok, res.added], [true, 120], 'the room:add reply that arrives during the cancel wait counts');
});

test('queue: "queued" progress keeps a waiting job alive and is relayed to the frame (background/bg-3, integration/bg-10)', async () => {
  const env = setup({ timing: { addIdleTimeoutMs: 150 } });
  const scInbox = openSoundCloudTab(env, 21, { 0: 'https://soundcloud.com/discover', 4: 'https://soundcloud.com/n/forss/flickermood' });
  await openRoom(env, 11, {
    respond: async (msg) => {
      if (msg.type === 'room:ping') return { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' };
      const from = roomSender(11);
      // Waits behind another job for longer than the stall timeout, with a heartbeat well within it.
      for (let i = 0; i < 6; i++) {
        await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'queued', done: 0, total: 3, position: 2 - Math.min(i, 1) }, from);
        await sleep(60);
      }
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 0, total: 3 }, from);
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'queued', done: 0, total: 3, position: 1 }, from); // a late heartbeat
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 3, total: 3 }, from);
      return { ok: true, added: 3, playlistKey: 'pl' };
    },
  });
  const res = await env.send({ type: 'queue', jobId: 'waiting', source: { url: SET_URL } }, scSender(21, { frameId: 4 }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.added, 3);
  assert.equal(env.fake.sentTo(11, 'room:cancel').length, 0);
  const progress = scInbox[4].filter((m) => m.type === 'job:progress');
  assert.deepEqual(progress[2], { type: 'job:progress', jobId: 'waiting', phase: 'queued', total: 3, title: 'Soulhack', position: 2 });
  assert.deepEqual(progress.map((m) => [m.phase, m.done ?? null, m.position ?? null]), [
    ['resolving', null, null], ['adding', 0, null],
    ['queued', null, 2], ['queued', null, 1], ['queued', null, 1], ['queued', null, 1], ['queued', null, 1], ['queued', null, 1],
    ['adding', 0, null], ['adding', 3, null],
  ]);
  assert.deepEqual(scInbox[0].filter((m) => m.type === 'job:progress'), [], 'only the frame that queued');
});

test('queue: failures after a partial add carry `added` (integration/bg-3)', async () => {
  const env = setup();
  let fail = () => ({ ok: false, error: { code: 'NOT_JOINED', message: 'This browser has not joined the room.', added: 50 } });
  await openRoom(env, 11, {
    respond: async (msg) => {
      if (msg.type === 'room:ping') return { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' };
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 0, total: 72 }, roomSender(11));
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 50, total: 72 }, roomSender(11));
      return fail();
    },
  });
  const source = { url: SET_URL };
  env.sc.expandImpl = async (url) => expandResult(url, 72);
  const queue = (jobId) => env.send({ type: 'queue', jobId, source }, scSender(21));

  let res = await queue('a');
  assert.deepEqual(res, { ok: false, jobId: 'a', error: { code: 'NOT_JOINED', message: 'This browser has not joined the room.', added: 50 } });
  // The room tab's count wins when it knows more; the last reported progress when the reply has none or less.
  fail = () => ({ ok: false, error: { code: 'PLAYLIST_CHANGED', message: 'The room playlist changed.', added: 60 } });
  assert.equal((await queue('b')).error.added, 60);
  fail = () => ({ ok: false, error: { code: 'W2G_FAILED', message: 'w2g refused.', added: 10 } });
  assert.equal((await queue('c')).error.added, 50);
  fail = () => ({ ok: false, error: { code: 'W2G_FAILED', message: 'w2g refused.', added: 'lots' } });
  assert.deepEqual((await queue('d')).error, { code: 'W2G_FAILED', message: 'w2g refused.', added: 50 });
  // The tab closes after the first batch.
  fail = () => Promise.reject(new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'));
  res = await queue('e');
  assert.deepEqual(res.error, { code: 'ROOM_UNREACHABLE', message: 'The w2g room tab was closed or reloaded before the tracks were added.', added: 50 });
  fail = () => undefined;
  assert.deepEqual([(await queue('f')).error.code, (await queue('g')).error.added], ['ROOM_UNREACHABLE', 50]);
});

test('queue: errors from the room tab pass through', async () => {
  const env = setup();
  await openRoom(env, 11, {
    respond: (msg) => (msg.type === 'room:ping'
      ? { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' }
      : { ok: false, error: { code: 'MODERATED', message: 'The room owner locked the playlist.' } }),
  });
  const res = await env.send({ type: 'queue', jobId: 'j', source: { url: SET_URL } }, scSender(21));
  assert.deepEqual(res, { ok: false, jobId: 'j', error: { code: 'MODERATED', message: 'The room owner locked the playlist.' } });
});

test('queue: expand errors pass through with their code and message', async () => {
  const env = setup();
  const roomInbox = await openRoom(env, 11);
  const scInbox = openSoundCloudTab(env, 21);
  env.sc.expandImpl = async () => {
    throw new env.sc.ScError('AUTH_REQUIRED', 'Log in on soundcloud.com in this browser to add Weekly Wave.');
  };
  let res = await env.send({ type: 'queue', jobId: 'ww', source: { url: 'https://soundcloud.com/discover/sets/weekly::someone', kind: 'system-playlist' } }, scSender(21));
  assert.deepEqual(res, { ok: false, jobId: 'ww', error: { code: 'AUTH_REQUIRED', message: 'Log in on soundcloud.com in this browser to add Weekly Wave.' } });
  assert.equal(roomInbox.filter((m) => m.type === 'room:add').length, 0);
  assert.deepEqual(scInbox[0].filter((m) => m.type === 'job:progress').map((m) => m.phase), ['resolving']);

  // Errors are not cached; uncoded errors become INTERNAL.
  env.sc.expandImpl = async () => {
    throw new TypeError('Cannot read properties of undefined');
  };
  res = await env.send({ type: 'queue', jobId: 'bug', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'INTERNAL');
  assert.equal(env.sc.expandCalls.length, 2);

  env.sc.expandImpl = async (url) => expandResult(url, 0, { skipped: [{ title: 'a', reason: 'geo_blocked' }] });
  res = await env.send({ type: 'queue', jobId: 'empty', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.error.code, 'EMPTY');
});

test('queue: EMPTY says what was skipped and why (background/bg-2, integration/bg-7)', async () => {
  const env = setup();
  const roomInbox = await openRoom(env, 11);
  // A single Go+ track with "Skip Go+ tracks" on, as background/soundcloud.js reports it.
  env.sc.expandImpl = async (url) => ({
    source: { kind: 'track', url, title: 'Ralome', subtitle: 'Plaid', artwork: null },
    total: 1,
    items: [],
    skipped: [{ title: 'Plaid - Ralome', reason: 'preview_only', id: 123 }],
    warnings: [],
  });
  let res = await env.send({ type: 'queue', jobId: 'go', source: { url: 'https://soundcloud.com/plaid/ralome', kind: 'track' } }, scSender(21));
  assert.deepEqual(res, {
    ok: false,
    jobId: 'go',
    error: { code: 'EMPTY', message: 'Nothing playable to add: every track was skipped.', skipped: [{ title: 'Plaid - Ralome', reason: 'preview_only' }], total: 1 },
  });
  assert.equal(roomInbox.filter((m) => m.type === 'room:add').length, 0);

  env.sc.expandImpl = async (url) => ({ ...expandResult(url, 0), total: undefined, skipped: [{ title: null, reason: 'geo_blocked' }, null, { reason: 'unavailable' }] });
  res = await env.send({ type: 'queue', jobId: 'mixed', source: { url: SET_URL } }, scSender(21));
  assert.deepEqual(res.error.skipped, [{ title: null, reason: 'geo_blocked' }, { title: null, reason: 'unavailable' }]);
  assert.equal(res.error.total, 3, 'falls back to the number of skipped entries');
});

test('BgError and errorPayload carry only well-formed details', () => {
  const err = new BgError('EMPTY', 'none', { skipped: [{ title: 'x', reason: 'not_streamable', extra: 1 }], total: 4.7, added: -1, captchaUrl: 'https://x' });
  assert.deepEqual(errorPayload(err), { code: 'EMPTY', message: 'none', skipped: [{ title: 'x', reason: 'not_streamable' }], total: 4 });
  assert.deepEqual(errorPayload(new BgError('ROOM_STALLED', 'stalled', { added: 12 })), { code: 'ROOM_STALLED', message: 'stalled', added: 12 });
  for (const added of [Number.NaN, Infinity, '12', null, undefined]) {
    assert.deepEqual(errorPayload(new BgError('W2G_FAILED', 'x', { added })), { code: 'W2G_FAILED', message: 'x' }, String(added));
  }
  // Errors from soundcloud.js keep their code and message; their other fields (status, captchaUrl) stay inside.
  const sc = Object.assign(new Error('Check'), { code: 'BOT_CHALLENGE', status: 403, captchaUrl: 'https://geo.captcha-delivery.com/x', skipped: 'no' });
  assert.deepEqual(errorPayload(sc), { code: 'BOT_CHALLENGE', message: 'Check' });
  assert.deepEqual(errorPayload(new TypeError('Failed to fetch')), { code: 'NETWORK', message: 'Failed to fetch' });
  assert.deepEqual(errorPayload(new Error('bug')), { code: 'INTERNAL', message: 'bug' });
  assert.equal(maxCount(undefined, 5, 7.9, -2, 'x'), 7);
  assert.equal(maxCount(null, undefined), undefined);
});

test('queue: progress from another tab is not relayed, and a running jobId cannot be queued twice', async () => {
  const env = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await openRoom(env, 12);
  env.clock.advance(1000);
  await openRoom(env, 11, {
    respond: async (msg) => {
      if (msg.type === 'room:ping') return { ok: true, streamkey: 'sk11', joined: true, roomName: 'R' };
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 3, total: 3 }, roomSender(12));
      await gate;
      await env.send({ type: 'job:progress', jobId: msg.jobId, phase: 'adding', done: 99, total: 3 }, roomSender(11));
      return { ok: true, added: 3 };
    },
  });
  const scInbox = openSoundCloudTab(env, 21);
  const running = env.send({ type: 'queue', jobId: 'same', source: { url: SET_URL } }, scSender(21));
  await sleep(20);
  const dup = await env.send({ type: 'queue', jobId: 'same', source: { url: SET_URL } }, scSender(21));
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'INTERNAL');
  // The same jobId from another frame is a different job.
  const otherFrame = env.send({ type: 'queue', jobId: 'same', source: { url: SET_URL } }, scSender(21, { frameId: 5 }));
  release();
  assert.equal((await running).added, 3);
  assert.equal((await otherFrame).ok, true);
  const progress = scInbox[0].filter((m) => m.type === 'job:progress');
  assert.deepEqual(progress.map((m) => [m.phase, m.done, m.total]), [['resolving', undefined, undefined], ['adding', 0, 3], ['adding', 3, 3]]);
});

test('queue: from an extension page, progress goes through runtime.sendMessage', async () => {
  const env = setup();
  await openRoom(env, 11, { respond: addingRoom(env, 11) });
  const res = await env.send({ type: 'queue', jobId: 'p1', source: { url: SET_URL } }, popupSender);
  assert.equal(res.added, 3);
  assert.deepEqual(env.fake.runtimeSent.map((m) => [m.jobId, m.phase, m.done]), [['p1', 'resolving', undefined], ['p1', 'adding', 0], ['p1', 'adding', 3]]);
});

test('keep-alive: an extension API is called regularly while a job runs, and not after', async () => {
  const env = setup({ timing: { keepAliveMs: 10 } });
  await openRoom(env, 11, { respond: addingRoom(env, 11, { delayMs: 120 }) });
  const res = await env.send({ type: 'queue', jobId: 'long', source: { url: SET_URL } }, scSender(21));
  assert.equal(res.ok, true);
  const during = env.fake.counters.platformInfo;
  assert.ok(during >= 4, `expected several keep-alive calls, got ${during}`);
  await sleep(60);
  assert.equal(env.fake.counters.platformInfo, during);
});

// ---------------------------------------------------------------------------------------------------------------
// SoundCloud requests

test('sc:expand: uses settings.skipPreviews, caches per URL and setting for 2 minutes', async () => {
  const env = setup();
  const sender = roomSender(11);
  let res = await env.send({ type: 'sc:expand', url: SET_URL }, sender);
  assert.deepEqual(res, { ok: true, result: expandResult(SET_URL, 3) });
  await env.send({ type: 'sc:expand', url: SET_URL }, popupSender);
  assert.equal(env.sc.expandCalls.length, 1);

  await env.send({ type: 'settings:set', patch: { skipPreviews: false } }, popupSender);
  await env.send({ type: 'sc:expand', url: SET_URL }, sender);
  assert.equal(env.sc.expandCalls.length, 2);
  assert.deepEqual(env.sc.expandCalls[1].options, { skipPreviews: false, maxTracks: 1000 });

  env.clock.advance(2 * 60 * 1000);
  await env.send({ type: 'sc:expand', url: SET_URL }, sender);
  assert.equal(env.sc.expandCalls.length, 3);

  res = await env.send({ type: 'sc:expand', url: 'https://example.com/x' }, sender);
  assert.equal(res.error.code, 'INVALID_URL');
  res = await env.send({ type: 'sc:expand', url: 'https://soundcloud.com/forss/sets' }, sender);
  assert.equal(res.ok, true, 'user sets pages are left to expand() (it decides UNSUPPORTED_URL)');
  res = await env.send({ type: 'sc:expand', url: 'https://soundcloud.com/upload' }, sender);
  assert.equal(res.error.code, 'UNSUPPORTED_URL');

  env.sc.expandImpl = async () => {
    throw new env.sc.ScError('NOT_FOUND', 'This playlist is private or was deleted.');
  };
  res = await env.send({ type: 'sc:expand', url: 'https://soundcloud.com/forss/sets/gone' }, sender);
  assert.deepEqual(res, { ok: false, error: { code: 'NOT_FOUND', message: 'This playlist is private or was deleted.' } });
});

test('sc:expand: identical requests share one fetch and expansions run one at a time', async () => {
  const env = setup();
  let active = 0;
  let maxActive = 0;
  env.sc.expandImpl = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(20);
    active--;
    return expandResult(url, 1);
  };
  const urls = [SET_URL, SET_URL, 'https://soundcloud.com/forss/flickermood', 'https://soundcloud.com/forss/likes'];
  const results = await Promise.all(urls.map((url) => env.send({ type: 'sc:expand', url }, roomSender(11))));
  assert.ok(results.every((r) => r.ok));
  assert.equal(env.sc.expandCalls.length, 3);
  assert.equal(maxActive, 1);
});

test('sc:status and sc:library: cached for 5 minutes, invalidated by oauth_token cookie changes', async () => {
  const env = setup();
  env.sc.statusImpl = async () => ({ loggedIn: true, username: 'dj <b>x</b>' });
  const library = { loggedIn: true, user: { id: 1, username: 'dj', permalink: 'dj', avatar: null }, sections: [] };
  env.sc.libraryImpl = async () => library;

  const [a, b] = await Promise.all([env.send({ type: 'sc:status' }, popupSender), env.send({ type: 'sc:status' }, popupSender)]);
  assert.deepEqual(a, { ok: true, loggedIn: true, username: 'dj <b>x</b>' });
  assert.deepEqual(b, a);
  assert.equal(env.sc.statusCalls, 1, 'concurrent requests share one call');
  env.clock.advance(4 * 60 * 1000);
  await env.send({ type: 'sc:status' }, popupSender);
  assert.equal(env.sc.statusCalls, 1);
  env.clock.advance(60 * 1000);
  await env.send({ type: 'sc:status' }, popupSender);
  assert.equal(env.sc.statusCalls, 2, 'expired after 5 minutes');

  assert.deepEqual(await env.send({ type: 'sc:library' }, roomSender(11)), { ok: true, library });
  await env.send({ type: 'sc:library' }, roomSender(11));
  assert.equal(env.sc.libraryCalls, 1);
  await env.send({ type: 'sc:library', refresh: true }, roomSender(11));
  assert.equal(env.sc.libraryCalls, 2);

  // Unrelated cookies change nothing.
  assert.equal(env.bg.onCookieChanged({ removed: false, cause: 'explicit', cookie: { name: 'sc_anonymous_id', domain: '.soundcloud.com' } }), false);
  assert.equal(env.bg.onCookieChanged({ removed: false, cause: 'explicit', cookie: { name: 'oauth_token', domain: 'evilsoundcloud.com' } }), false);
  await env.send({ type: 'sc:status' }, popupSender);
  await env.send({ type: 'sc:library' }, roomSender(11));
  assert.equal(env.sc.statusCalls, 2);
  assert.equal(env.sc.libraryCalls, 2);

  // Logout: the next request asks SoundCloud again.
  env.sc.statusImpl = async () => ({ loggedIn: false });
  assert.equal(env.bg.onCookieChanged({ removed: true, cause: 'explicit', cookie: { name: 'oauth_token', domain: 'soundcloud.com' } }), true);
  assert.deepEqual(await env.send({ type: 'sc:status' }, popupSender), { ok: true, loggedIn: false });
  await env.send({ type: 'sc:library' }, roomSender(11));
  assert.equal(env.sc.statusCalls, 3);
  assert.equal(env.sc.libraryCalls, 3);

  env.sc.statusImpl = async () => ({ loggedIn: false, expired: true });
  env.bg.onCookieChanged({ removed: false, cause: 'explicit', cookie: { name: 'oauth_token', domain: '.soundcloud.com' } });
  assert.deepEqual(await env.send({ type: 'sc:status' }, popupSender), { ok: true, loggedIn: false, expired: true });
});

test('sc:status: a login change during a request is not cached, failures are not cached', async () => {
  const env = setup();
  let resolveSlow;
  env.sc.statusImpl = () => new Promise((resolve) => { resolveSlow = resolve; });
  const slow = env.send({ type: 'sc:status' }, popupSender);
  await sleep(5);
  env.bg.onCookieChanged({ removed: false, cookie: { name: 'oauth_token', domain: 'soundcloud.com' } });
  env.sc.statusImpl = async () => ({ loggedIn: true, username: 'new' });
  const fresh = await env.send({ type: 'sc:status' }, popupSender);
  assert.equal(fresh.username, 'new', 'did not join the request started before the login');
  resolveSlow({ loggedIn: false });
  assert.equal((await slow).loggedIn, false);
  assert.equal((await env.send({ type: 'sc:status' }, popupSender)).username, 'new');

  env.bg.onCookieChanged({ removed: true, cookie: { name: 'oauth_token', domain: 'soundcloud.com' } });
  env.sc.statusImpl = async () => {
    throw new env.sc.ScError('NETWORK', 'SoundCloud did not answer.');
  };
  assert.deepEqual(await env.send({ type: 'sc:status' }, popupSender), { ok: false, error: { code: 'NETWORK', message: 'SoundCloud did not answer.' } });
  env.sc.statusImpl = async () => ({ loggedIn: false });
  assert.deepEqual(await env.send({ type: 'sc:status' }, popupSender), { ok: true, loggedIn: false });
});

test('SoundCloud client: created lazily, shared, recreated after a login change; token from the cookie, storage in storage.local', async () => {
  const env = setup();
  await openRoom(env, 11);
  assert.equal(env.sc.clients.length, 0, 'not created before it is needed');
  await env.send({ type: 'sc:status' }, popupSender);
  await env.send({ type: 'sc:expand', url: SET_URL }, roomSender(11));
  await env.send({ type: 'sc:library' }, roomSender(11));
  assert.equal(env.sc.clients.length, 1);
  assert.ok(env.sc.expandCalls.every((c) => c.client === env.sc.clients[0]));

  const { options } = env.sc.clients[0];
  assert.equal(typeof options.fetch, 'function');
  assert.equal(await options.getOAuthToken(), null);
  env.fake.cookies.set('oauth_token', { name: 'oauth_token', value: '2-123-456-abc', domain: 'soundcloud.com' });
  assert.equal(await options.getOAuthToken(), '2-123-456-abc');
  assert.deepEqual(env.fake.cookieCalls.at(-1), { url: 'https://soundcloud.com/', name: 'oauth_token' });

  assert.equal(await options.storage.get('clientId'), null);
  await options.storage.set('clientId', 'O4KAW11rMMnH5modEfDHOdzmnuvsck9X');
  assert.equal(env.fake.chrome.storage.local.data.get('clientId'), 'O4KAW11rMMnH5modEfDHOdzmnuvsck9X');
  assert.equal(await options.storage.get('clientId'), 'O4KAW11rMMnH5modEfDHOdzmnuvsck9X');

  env.bg.onCookieChanged({ removed: false, cookie: { name: 'oauth_token', domain: 'soundcloud.com' } });
  await env.send({ type: 'sc:status' }, popupSender);
  assert.equal(env.sc.clients.length, 2);
});

test('SoundCloud client: getDataDomeId reads the datadome cookie of soundcloud.com, fresh every time (sc-client/sc-2)', async () => {
  const env = setup();
  await env.send({ type: 'sc:status' }, popupSender);
  const { options } = env.sc.clients[0];
  assert.equal(typeof options.getDataDomeId, 'function');
  assert.equal(await options.getDataDomeId(), null);
  assert.deepEqual(env.fake.cookieCalls.at(-1), { url: 'https://soundcloud.com/', name: 'datadome' });
  env.fake.cookies.set('datadome', { name: 'datadome', value: 'dd~first', domain: '.soundcloud.com' });
  assert.equal(await options.getDataDomeId(), 'dd~first');
  env.fake.cookies.set('datadome', { name: 'datadome', value: 'dd~solved', domain: '.soundcloud.com' });
  assert.equal(await options.getDataDomeId(), 'dd~solved', 'a check solved on soundcloud.com takes effect at once');
  env.fake.chrome.cookies.get = async () => {
    throw new Error('No host permissions for cookies at url');
  };
  assert.equal(await options.getDataDomeId(), null);
  assert.equal(await options.getOAuthToken(), null);
});

test('sc:login-changed goes to frame 0 of every room tab once per burst of login cookie changes', async () => {
  const env = setup({ timing: { loginChangedMs: 40 } });
  await openRoom(env, 11);
  await openRoom(env, 12);
  const scInbox = openSoundCloudTab(env, 21);
  const loginMessages = () => env.fake.sent.filter((s) => s.message.type === 'sc:login-changed');

  // Logging in replaces the token cookie: several change events in a row.
  const token = { name: 'oauth_token', domain: '.soundcloud.com' };
  assert.equal(env.bg.onCookieChanged({ removed: true, cause: 'overwrite', cookie: token }), true);
  assert.equal(env.bg.onCookieChanged({ removed: false, cause: 'explicit', cookie: token }), true);
  await sleep(20);
  env.bg.onCookieChanged({ removed: false, cause: 'explicit', cookie: token });
  await sleep(20);
  assert.deepEqual(loginMessages(), [], 'debounced');
  await sleep(60);
  assert.deepEqual(loginMessages().map((s) => [s.tabId, s.frameId, s.message]).sort(), [
    [11, 0, { type: 'sc:login-changed' }],
    [12, 0, { type: 'sc:login-changed' }],
  ]);
  assert.deepEqual(scInbox[0].filter((m) => m.type === 'sc:login-changed'), [], 'only room tabs');

  // Other cookies don't count; a room tab that is gone doesn't break the rest.
  env.bg.onCookieChanged({ removed: false, cookie: { name: 'datadome', domain: '.soundcloud.com' } });
  env.bg.onCookieChanged({ removed: false, cookie: { name: 'oauth_token', domain: 'w2g.tv' } });
  await sleep(80);
  assert.equal(loginMessages().length, 2);
  env.fake.removeTab(11);
  env.bg.onCookieChanged({ removed: true, cookie: token });
  await sleep(80);
  assert.deepEqual(loginMessages().slice(2).map((s) => s.tabId).sort(), [11, 12]);
  assert.deepEqual(env.errors, []);
});

test('sc:status from a soundcloud.com frame is refused, from a room tab allowed', async () => {
  const env = setup();
  assert.equal((await env.send({ type: 'sc:status' }, scSender(21))).ok, false);
  assert.equal((await env.send({ type: 'sc:status' }, roomSender(11))).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------
// Other handlers

test('open:soundcloud opens soundcloud.com next to the sender tab', async () => {
  const env = setup();
  assert.deepEqual(await env.send({ type: 'open:soundcloud' }, { ...roomSender(11), tab: { id: 11, index: 4, windowId: 2, url: roomUrl('sk11') } }), { ok: true });
  assert.deepEqual(env.fake.created[0], { url: 'https://soundcloud.com/', active: true, windowId: 2, index: 5, openerTabId: 11 });
  assert.deepEqual(await env.send({ type: 'open:soundcloud' }, popupSender), { ok: true });
  assert.deepEqual(env.fake.created[1], { url: 'https://soundcloud.com/', active: true });
  assert.equal((await env.send({ type: 'open:soundcloud' }, scSender(21))).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------
// Re-injection

test('re-injection on install/startup: manifest files into matching frames of open tabs, failures skipped', async () => {
  const env = setup();
  const { fake } = env;
  fake.addTab({ id: 1, url: 'https://w2g.tv/en/room/?access_key=abc' });
  fake.addTab({
    id: 2,
    url: 'https://soundcloud.com/discover',
    frames: { 0: {}, 4: { url: 'https://soundcloud.com/n/forss/flickermood?webi_embed_id=x' }, 9: { url: 'about:blank' }, 12: { url: 'https://w2g.tv/en/room/?r=x' } },
  });
  fake.addTab({ id: 3, url: 'https://soundcloud.com/forss' });
  fake.failInjection.add(3);
  fake.addTab({ id: 4, url: 'https://soundcloud.com/stream', discarded: true });
  fake.addTab({ id: 5, url: 'https://w2g.tv/en/' });
  fake.addTab({ id: 6, url: 'https://example.com/' });

  const outcomes = await env.bg.onInstalled({ reason: 'update', previousVersion: '0.9.0' });
  const byTab = Object.fromEntries(outcomes.map((o) => [o.tabId, o]));
  assert.deepEqual(Object.keys(byTab).sort(), ['1', '2', '3', '4']);
  assert.equal(byTab[1].injected, true);
  assert.deepEqual(byTab[2], { tabId: 2, frameIds: [0, 4], injected: true });
  assert.equal(byTab[3].injected, false);
  assert.equal(byTab[4].reason, 'discarded');

  const fileCalls = fake.injections.filter((c) => !c.probe);
  assert.deepEqual(fileCalls, [
    { api: 'executeScript', target: { tabId: 1, frameIds: [0] }, files: ['shared/sc-url.js', 'content/w2g-room.js'], probe: false, world: undefined },
    { api: 'insertCSS', target: { tabId: 2, frameIds: [0, 4] }, files: ['content/soundcloud.css'] },
    { api: 'executeScript', target: { tabId: 2, frameIds: [0, 4] }, files: ['shared/sc-url.js', 'content/soundcloud.js'], probe: false, world: undefined },
  ]);
  const probes = fake.injections.filter((c) => c.probe);
  assert.deepEqual(probes.map((p) => p.target), [{ tabId: 1, allFrames: false }, { tabId: 2, allFrames: true }, { tabId: 3, allFrames: true }]);

  fake.injections.length = 0;
  await env.bg.onStartup();
  assert.equal(fake.injections.filter((c) => !c.probe).length, 3);
});

test('re-injection: a failing tabs.query skips only its entry; MAIN-world entries keep their world', async () => {
  const manifest = structuredClone(MANIFEST);
  manifest.content_scripts.unshift({ matches: ['https://soundcloud.com/*'], js: ['broken.js'] });
  manifest.content_scripts.push({ matches: ['https://soundcloud.com/*'], js: ['main-world.js'], world: 'MAIN' });
  const fake = createFakeChrome({ manifest });
  const originalQuery = fake.chrome.tabs.query;
  let queries = 0;
  fake.chrome.tabs.query = async (query) => {
    if (queries++ === 0) throw new Error('boom');
    return originalQuery(query);
  };
  const env = setup({ fake });
  fake.addTab({ id: 2, url: 'https://soundcloud.com/discover' });
  const outcomes = await env.bg.onInstalled({ reason: 'install' });
  assert.deepEqual(outcomes.map((o) => [o.tabId, o.injected]), [[2, true], [2, true]]);
  const files = fake.injections.filter((c) => c.api === 'executeScript' && !c.probe);
  assert.deepEqual(files.map((c) => [c.files.at(-1), c.world]), [['content/soundcloud.js', undefined], ['main-world.js', 'MAIN']]);
  assert.equal(fake.injections.some((c) => (c.files || []).includes('broken.js')), false);
});

test('createLock runs tasks in order even after a failure', async () => {
  const lock = createLock();
  const order = [];
  const a = lock(async () => { await sleep(10); order.push('a'); throw new Error('a failed'); });
  const b = lock(async () => { order.push('b'); return 'b'; });
  await assert.rejects(a, /a failed/);
  assert.equal(await b, 'b');
  assert.deepEqual(order, ['a', 'b']);
});

// ---------------------------------------------------------------------------------------------------------------
// main.js wiring (needs the real background/soundcloud.js, which is written separately)

test('main.js registers every listener synchronously at startup', async (t) => {
  const scPath = new URL('../../extension/background/soundcloud.js', import.meta.url);
  if (!fs.existsSync(scPath)) {
    t.skip('extension/background/soundcloud.js does not exist yet');
    return;
  }
  const fake = createFakeChrome();
  const previous = globalThis.chrome;
  globalThis.chrome = fake.chrome;
  try {
    try {
      await import('../../extension/background/main.js');
    } catch (err) {
      t.skip(`main.js could not be imported in Node: ${err.message}`);
      return;
    }
    const events = {
      'runtime.onMessage': fake.chrome.runtime.onMessage,
      'runtime.onInstalled': fake.chrome.runtime.onInstalled,
      'runtime.onStartup': fake.chrome.runtime.onStartup,
      'tabs.onRemoved': fake.chrome.tabs.onRemoved,
      'tabs.onUpdated': fake.chrome.tabs.onUpdated,
      'cookies.onChanged': fake.chrome.cookies.onChanged,
    };
    for (const [name, event] of Object.entries(events)) assert.equal(event.listeners.length, 1, name);

    // Smoke test through the registered listener.
    const [listener] = fake.chrome.runtime.onMessage.listeners;
    const res = await new Promise((resolve) => assert.equal(listener({ type: 'rooms:get' }, popupSender, resolve), true));
    assert.deepEqual(res, { ok: true, rooms: [], target: null, pinnedTabId: null });
  } finally {
    globalThis.chrome = previous;
  }
});
