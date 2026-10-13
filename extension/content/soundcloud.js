/*
 * soundcloud.com content script. It runs in every frame because logged-in track pages render in a
 * same-origin iframe under /n/<user>/<track> (SoundCloud's MUI "Webi" UI).
 *
 * - Injects native-looking "Add to w2g" buttons next to tracks and playlists and an entry into SoundCloud's
 *   More menus. They are always injected but only shown (soundcloud.css) while the background reports an
 *   open w2g room tab, mirrored as <html data-w2g-room>.
 * - A click sends {type:'queue', jobId, source} to the background and follows the job in a toast:
 *   progress, result, errors, and a confirmation step for big playlists.
 * - URLs are resolved at click time: SoundCloud reuses nodes across SPA navigations and player track changes.
 * - soundcloud.com runs many third-party scripts in its top frame. Only trusted (real user) input starts or
 *   confirms a job, and the injected controls' attributes never name the room. The toasts live in a closed shadow
 *   root, but page scripts can still probe their rendered text with window.find, so toasts never carry secrets
 *   (with several rooms open they show only the first 4 characters of a room's streamkey, its invite key).
 *   Toast actions that add tracks also check that the user could see them (see the toast UI).
 */
(() => {
  'use strict';

  const GUARD = '__scw2gSoundCloud';
  const TAKEOVER_EVENT = 'scw2g:soundcloud-takeover';

  // Re-injection with allFrames also reaches SoundCloud's about:blank helper frames: nothing to do there.
  if (location.protocol !== 'https:' || location.hostname !== 'soundcloud.com') return;

  const previous = globalThis[GUARD];
  if (previous && previous.alive()) return; // injected twice (manifest + background re-injection)
  if (previous) previous.teardown(); // a copy orphaned by an extension update

  const scUrl = globalThis.SCW2G && globalThis.SCW2G.url;
  if (!scUrl || !document.documentElement) return;

  const BUTTON = 'w2g-add';
  const MENU_ENTRY = 'w2g-add-menu';
  const GROUP = 'w2g-group';
  const NODE = 'w2g-node'; // every element we insert into SoundCloud's DOM; the observer ignores them
  const TOASTS = 'w2g-toasts';
  const SENT = 'w2g-sent';
  const ROOM_ATTR = 'data-w2g-room';
  const LABEL = 'Add to w2g';
  const SENT_MS = 1500;
  const SUCCESS_HIDE_MS = 5000;
  const SCAN_DELAY_MS = 100;
  const MAX_TOASTS = 5;
  const TOAST_WIDTH = 360;
  const CONTEXT_CHECK_MS = 1000;
  // How long a toast action that adds tracks must have been visible before a click on it counts.
  const VISIBLE_MS = 500;
  // A closed root keeps page scripts out of the toasts' nodes and buttons. It doesn't hide their rendered text,
  // which window.find matches, so toasts must never carry secrets. The e2e tests replace this exact line to make
  // the toasts readable.
  const TOAST_SHADOW_MODE = 'closed';

  const ICON = '<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M1.75 2h12.5c.41 0 .75.34.75.75v7.5c0 .41-.34.75-.75.75H1.75A.75.75 0 011 10.25v-7.5c0-.41.34-.75.75-.75zm.75 1.5v6h11v-6h-11zM5 13h6v1.5H5V13z"/>' +
    '<path fill="currentColor" d="M7.25 4.25h1.5v1.5h1.5v1.5h-1.5v1.5h-1.5v-1.5h-1.5v-1.5h1.5z"/></svg>';
  const ICON_SENT = '<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M1.75 2h12.5c.41 0 .75.34.75.75v7.5c0 .41-.34.75-.75.75H1.75A.75.75 0 011 10.25v-7.5c0-.41.34-.75.75-.75zm.75 1.5v6h11v-6h-11zM5 13h6v1.5H5V13z"/>' +
    '<path fill="currentColor" d="M10.22 3.97l1.06 1.06L7 9.31 4.72 7.03l1.06-1.06L7 7.19z"/></svg>';
  // Webi draws 24px outline icons with a 1.5px stroke.
  const ICON_WEBI = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M3.75 4.5h16.5v11.25H3.75zM8.25 19.5h7.5M12 7.5v5.25M9.375 10.125h5.25"/></svg>';
  const ICON_WEBI_SENT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M3.75 4.5h16.5v11.25H3.75zM8.25 19.5h7.5M8.625 10.125l2.25 2.25 4.5-4.5"/></svg>';

  // Class lists copied from SoundCloud's own neighbouring buttons in each context.
  const VARIANTS = {
    small: { cls: 'sc-button-secondary sc-button sc-button-small sc-button-icon sc-button-responsive' },
    medium: { cls: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive' },
    labeled: { cls: 'sc-button-secondary sc-button sc-button-medium sc-button-responsive', labeled: true },
    tile: { cls: 'playableTile__actionButton sc-button sc-button-small sc-button-icon sc-button-responsive' },
    player: { cls: 'sc-button-secondary sc-mr-1x sc-button sc-button-small sc-button-icon sc-button-responsive' },
    queue: { cls: 'sc-button sc-button-medium sc-button-icon' },
    menu: { cls: 'sc-button moreActions__button sc-button-medium sc-button-tertiary', labeled: true, entry: true },
  };

  // item: the entity container; mount: where the button goes; link: anchor naming the entity (null: the page
  // itself); title: element holding a display title (scoped to the item, or to the document for page rules).
  const RULES = [
    { item: '.trackItem', mount: '.trackItem__actions .sc-button-group', link: 'a.trackItem__trackTitle', title: 'a.trackItem__trackTitle', variant: 'small' },
    // Cards of tracks with a custom background have no title link; their stats links (/user/track/likes) still name the track.
    { item: '.sound', mount: '.sound__soundActions .sc-button-group', link: 'a.soundTitle__title', fallbackLink: 'a.sc-ministats[href]', title: 'a.soundTitle__title', variant: 'medium' },
    { item: '.soundBadge', mount: '.soundBadge__actions .sc-button-group', link: 'a.soundTitle__title', title: 'a.soundTitle__title', variant: 'small' },
    // Playlist badges in sidebars have no actions at all: build a toolbar whose native class makes it hover-only.
    { item: '.soundBadge', mount: '.soundBadge__additional', link: 'a.soundTitle__title', title: 'a.soundTitle__title', variant: 'small', skipIf: '.soundBadge__actions', buildGroup: true },
    { item: '.playableTile', mount: '.playableTile__actionWrapper', link: 'a.playableTile__mainHeading, a.playableTile__artworkLink', title: 'a.playableTile__mainHeading', variant: 'tile' },
    { item: '.listenEngagement', mount: '.listenEngagement__actions .sc-button-group', link: null, title: '.fullHero__title .soundTitle__title', variant: 'medium' },
    { item: '.systemPlaylistDetails', mount: '.systemPlaylistDetails__controls', link: null, title: '.fullHero__titleTextTitle', variant: 'labeled', wrap: 'systemPlaylistDetails__button', before: '.systemPlaylistDetails__description' },
    { item: '.playbackSoundBadge', mount: '.playbackSoundBadge__actions', link: 'a.playbackSoundBadge__titleLink', title: 'a.playbackSoundBadge__titleLink', variant: 'player', before: '.playbackSoundBadge__showQueue' },
    { item: '.queueItemView', mount: '.queueItemView__actions', link: '.queueItemView__title a', title: '.queueItemView__title a', variant: 'queue' },
  ];
  const ITEM_SELECTOR = [...new Set(RULES.map((r) => r.item))].join(', ');
  // Webi's headings name the artist in some states, so its title comes from the background's answer.
  const WEBI_RULE = { link: null, title: null };

  const root = document.documentElement;
  const jobs = new Map(); // jobId -> job, for jobs started in this frame
  const inFlight = new Map(); // source url -> its unfinished job in this frame
  const icons = new WeakMap(); // button -> { slot, normal, sent }
  let rooms = []; // RoomInfo[] the background last reported
  let roomsSeq = 0;
  let scanTimer = 0;
  let stopped = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A non-negative integer from an untrusted number field (0 when missing or invalid). */
  function count(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Extension messaging

  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function failure(code, message) {
    return { ok: false, error: { code, message: message || '' } };
  }

  // Never throws: a missing answer or a dead extension context becomes an error result.
  async function call(message) {
    if (!contextAlive()) return failure('CONTEXT_INVALIDATED');
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (res && typeof res === 'object') return res;
      return failure('INTERNAL', 'The extension did not answer.');
    } catch (err) {
      // An extension reload or update rejects pending calls a moment before it invalidates this context.
      for (let waited = 0; waited < CONTEXT_CHECK_MS && contextAlive(); waited += 50) await sleep(50);
      if (!contextAlive()) return failure('CONTEXT_INVALIDATED');
      const text = String((err && err.message) || err || '');
      // The background went away while it held the request (e.g. its worker was stopped): it may have started
      // the job, so this is not a plain internal error.
      if (/message (channel|port) closed/i.test(text)) return failure('CONNECTION_LOST', text);
      return failure('INTERNAL', text);
    }
  }

  function onMessage(msg, sender) {
    if (!msg || typeof msg !== 'object' || !sender || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'rooms:changed') {
      roomsSeq++; // an older rooms:get answer still in flight must not override this
      applyRooms(msg);
    } else if (msg.type === 'job:progress') {
      onProgress(msg);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Room gating

  async function refreshRooms() {
    const seq = ++roomsSeq;
    const res = await call({ type: 'rooms:get' });
    if (stopped || seq !== roomsSeq) return;
    if (!res.ok && res.error.code === 'CONTEXT_INVALIDATED') {
      teardown();
      return;
    }
    applyRooms(res.ok ? res : null);
  }

  // The attribute only says that some room is open (the CSS needs it); room names never go into the page's DOM.
  function applyRooms(data) {
    rooms = data && Array.isArray(data.rooms) ? data.rooms.filter((r) => r && typeof r === 'object') : [];
    if (rooms.length) root.setAttribute(ROOM_ATTR, '');
    else root.removeAttribute(ROOM_ATTR);
  }

  function setLabel(el) {
    el.title = LABEL;
    el.setAttribute('aria-label', LABEL);
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') refreshRooms();
  }

  function onPageShow(event) {
    if (event.persisted) refreshRooms(); // restored from the back/forward cache: broadcasts were missed
  }

  function onResize() {
    toasts.place();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Resolving what a button stands for

  function cleanTitle(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > 120 ? s.slice(0, 119) + '…' : s;
  }

  function hrefFor(rule, item) {
    if (!rule.link) return location.href;
    const a = item.querySelector(rule.link) || (rule.fallbackLink && item.querySelector(rule.fallbackLink));
    return a ? a.getAttribute('href') : null;
  }

  function titleFor(rule, item) {
    const scope = rule.link ? item : document;
    const el = rule.title && scope.querySelector(rule.title);
    return el ? cleanTitle(el.getAttribute('title') || el.textContent) : null;
  }

  // -> { kind, url } | null
  function sourceFor(rule, item) {
    const href = hrefFor(rule, item);
    return href ? scUrl.classifyHref(href, location.href) : null;
  }

  function resolve(rule, item) {
    return { source: sourceFor(rule, item), title: titleFor(rule, item) };
  }

  // Track menus carry the track's URN in their Report link (content_urn=soundcloud:tracks:<id>).
  function urnFromMenu(menu, source) {
    const report = menu.querySelector('a.sc-button-report[href], a[href*="report-content"]');
    if (!report) return null;
    try {
      const q = new URL(report.getAttribute('href'), location.href).searchParams;
      const urn = q.get('content_urn');
      const same = scUrl.classifyHref(q.get('content_permalink_url'));
      return urn && /^soundcloud:(tracks|playlists):\d+$/.test(urn) && same && same.url === source.url ? urn : null;
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Buttons

  function createButton(variantName) {
    const variant = VARIANTS[variantName];
    const button = document.createElement('button');
    button.type = 'button'; // SoundCloud's row and tile click handlers ignore clicks inside a, button, input, label
    button.className = `${variant.entry ? MENU_ENTRY : BUTTON} ${NODE} ${variant.cls}`;
    setLabel(button);
    const slot = document.createElement('div');
    slot.innerHTML = ICON;
    const label = document.createElement('span');
    label.className = variant.labeled ? 'sc-button-label' : 'sc-button-label sc-visuallyhidden';
    label.textContent = LABEL;
    button.append(slot, label);
    icons.set(button, { slot, normal: ICON, sent: ICON_SENT });
    return button;
  }

  function wrapButton(rule, button) {
    if (rule.wrap) {
      const wrapper = document.createElement('div');
      wrapper.className = `${rule.wrap} ${NODE}`;
      wrapper.appendChild(button);
      return wrapper;
    }
    if (rule.buildGroup) {
      const actions = document.createElement('div');
      actions.className = `soundBadge__actions ${GROUP} ${NODE}`;
      const toolbar = document.createElement('div');
      toolbar.className = 'soundActions sc-button-toolbar soundActions__small';
      const group = document.createElement('div');
      group.className = 'sc-button-group sc-button-group-small';
      group.appendChild(button);
      toolbar.appendChild(group);
      actions.appendChild(toolbar);
      return actions;
    }
    return button;
  }

  // Immediate feedback: a check mark for a moment; also swallows accidental double clicks.
  function flashSent(button) {
    const icon = icons.get(button);
    button.classList.add(SENT);
    if (icon) icon.slot.innerHTML = icon.sent;
    setTimeout(() => {
      button.classList.remove(SENT);
      if (icon) icon.slot.innerHTML = icon.normal;
    }, SENT_MS);
  }

  function bindClick(button, getTarget) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation(); // rows and tiles start playback or navigate on bubbling clicks
      // Only real user input: a page script calling click() must not be able to add to the user's room.
      if (!event.isTrusted || button.classList.contains(SENT)) return;
      const { source, title } = getTarget();
      const running = source && inFlight.get(source.url);
      if (running) {
        reshowJob(running);
        return;
      }
      flashSent(button);
      startJob(source, title);
    });
  }

  function injectRule(rule) {
    for (const mount of document.querySelectorAll(rule.mount)) {
      if (mount.querySelector(`:scope > .${BUTTON}, :scope > * > .${BUTTON}, :scope > .${GROUP}`)) continue;
      if (rule.skipIf && mount.querySelector(rule.skipIf)) continue;
      const item = mount.closest(rule.item);
      if (!item || !sourceFor(rule, item)) continue; // e.g. tiles of users
      const button = createButton(rule.variant);
      bindClick(button, () => resolve(rule, item));
      const before = mount.querySelector(`:scope > ${rule.before || '.sc-button-more'}`);
      mount.insertBefore(wrapButton(rule, button), before);
    }
  }

  // More menus are portaled to <body> as div.dropdownMenu#<opener's aria-owns> and rebuilt on every open.
  function injectMenus() {
    for (const group of document.querySelectorAll('body > .dropdownMenu .moreActions__group')) {
      if (group.querySelector(`:scope > .${MENU_ENTRY}`)) continue;
      const menu = group.closest('.dropdownMenu');
      const opener = menu.id ? document.querySelector(`[aria-owns="${CSS.escape(menu.id)}"]`) : null;
      if (!opener || !opener.classList.contains('sc-button-more')) continue;
      const item = opener.closest(ITEM_SELECTOR);
      const rule = item && RULES.find((r) => item.matches(r.item));
      if (!rule || !sourceFor(rule, item)) continue;
      const entry = createButton('menu');
      bindClick(entry, () => {
        const resolved = resolve(rule, item);
        const urn = resolved.source && urnFromMenu(menu, resolved.source);
        if (urn) resolved.source.urn = urn;
        closeMenu(menu);
        return resolved;
      });
      // Next to SoundCloud's own "Add to …" entries, else before Report, else last.
      const sibling = group.querySelector(':scope > .sc-button-addtoset') || group.querySelector(':scope > .addToNextUp');
      group.insertBefore(entry, sibling ? sibling.nextSibling : group.querySelector(':scope > .sc-button-report'));
    }
  }

  function closeMenu(menu) {
    // SoundCloud closes its dropdowns on Escape; a synthetic click on <body> does not close them.
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  }

  // Webi (Next.js + MUI): generated class names change between builds and the labels follow the browser's
  // language, so the main anchor is structural. The track header (a <section> with a translated aria-label) has
  // the page's only outlined DesktopMenu button, its More button; comment menus are "ghost", related tracks
  // "small". The English "Copy link" row is a second path, which also covers the anonymous "not found" render.
  // The new button copies the live classes of a neighbouring outlined button.
  function webiTargets() {
    const targets = new Map(); // mount -> { reference, before }
    const moreSelector = ':scope > button[aria-label="More actions"], :scope > button[aria-label="More menu"], :scope > button[id^="desktop-menu-button-"]';
    for (const copy of document.querySelectorAll('button[aria-label="Copy link"]')) {
      const mount = copy.parentElement;
      if (mount) targets.set(mount, { reference: copy, before: mount.querySelector(moreSelector) });
    }
    for (const more of document.querySelectorAll('section[aria-label] button[id^="desktop-menu-button-"][aria-haspopup="true"][variant="outlined"]')) {
      const mount = more.parentElement;
      if (!mount || targets.has(mount)) continue;
      const prev = more.previousElementSibling;
      targets.set(mount, { reference: prev && prev.matches('button[variant="outlined"]') ? prev : more, before: more });
    }
    return targets;
  }

  function injectWebi() {
    if (!sourceFor(WEBI_RULE, null)) return;
    for (const [mount, { reference, before }] of webiTargets()) {
      if (mount.querySelector(`:scope > .${BUTTON}`)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      const live = reference.className.split(/\s+/).filter((c) => c && c !== 'Mui-disabled' && c !== 'Mui-focusVisible');
      button.className = [BUTTON, NODE, ...live].join(' ');
      const variant = reference.getAttribute('variant');
      if (variant) button.setAttribute('variant', variant);
      setLabel(button);
      button.innerHTML = ICON_WEBI;
      icons.set(button, { slot: button, normal: ICON_WEBI, sent: ICON_WEBI_SENT });
      bindClick(button, () => resolve(WEBI_RULE, null));
      mount.insertBefore(button, before && before.parentElement === mount ? before : null);
    }
  }

  function scan() {
    if (location.pathname.startsWith('/n/')) {
      injectWebi();
      return;
    }
    for (const rule of RULES) injectRule(rule);
    injectMenus();
  }

  function runScan() {
    scanTimer = 0;
    if (stopped) return;
    if (!contextAlive()) {
      teardown();
      return;
    }
    try {
      scan();
    } catch (err) {
      console.warn('[scw2g] scan failed', err);
    }
  }

  // Trailing throttle: the first relevant mutation schedules one scan that covers the whole burst.
  const observer = new MutationObserver((records) => {
    let changed = false;
    let menuOpened = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.classList.contains(NODE)) continue;
        changed = true;
        if (record.target === document.body && node.classList.contains('dropdownMenu')) menuOpened = true;
      }
    }
    if (menuOpened) {
      try {
        injectMenus(); // the user is looking at the menu: fill it before the next paint
      } catch (err) {
        console.warn('[scw2g] menu injection failed', err);
      }
    }
    if (changed && !scanTimer) scanTimer = setTimeout(runScan, SCAN_DELAY_MS);
  });

  // ---------------------------------------------------------------------------------------------------------
  // Jobs
  //
  // job.phase: 'pending' (sent, resolving) | 'queued' (waiting in the room tab) | 'adding'. job.started is set once
  // the room tab has the job ('adding' or 'queued' progress): from then on a retry could add tracks twice.
  // Progress is recorded even while the toast is closed, because a later failure must still know about it.

  function newJobId() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function startJob(source, title) {
    const job = {
      id: newJobId(), source, title, confirmed: false, awaitingConfirm: false, count: 0, skippedCount: 0,
      phase: 'pending', total: 0, position: 0, added: 0, started: false, dismissed: false,
    };
    job.toast = toasts.create(() => dismissJob(job));
    if (!source) {
      finishJob(job, failure('UNSUPPORTED_URL'));
      return;
    }
    jobs.set(job.id, job);
    inFlight.set(source.url, job);
    renderJob(job);
    sendQueue(job);
  }

  async function sendQueue(job) {
    const message = { type: 'queue', jobId: job.id, source: job.source };
    if (job.confirmed) message.confirmed = true;
    const res = await call(message);
    if (res.ok && res.needsConfirm) {
      if (res.title) job.title = cleanTitle(res.title);
      job.count = count(res.count);
      job.skippedCount = count(res.skippedCount);
      job.awaitingConfirm = true;
      if (job.dismissed) forgetJob(job); // closed while resolving: nothing was added, treat as cancelled
      else renderJob(job);
      return;
    }
    finishJob(job, res);
    if (!contextAlive()) teardown(); // this copy's buttons can't work anymore; its toasts stay
  }

  function forgetJob(job) {
    jobs.delete(job.id);
    if (job.source && inFlight.get(job.source.url) === job) inFlight.delete(job.source.url);
  }

  function finishJob(job, res) {
    forgetJob(job);
    if (res.ok) {
      if (!job.dismissed) showSuccess(job, res);
      return;
    }
    if (job.dismissed) { // the toast was closed while the job ran, but a failure still needs to be seen
      job.dismissed = false;
      job.toast = toasts.create(() => dismissJob(job));
    }
    showError(job, res.error || {});
  }

  function dismissJob(job) {
    job.dismissed = true;
    if (job.awaitingConfirm) { // closing the question means no
      job.awaitingConfirm = false;
      forgetJob(job);
    }
  }

  // Another click on something this frame is still adding: show its toast again instead of adding it twice.
  function reshowJob(job) {
    if (job.dismissed) {
      job.dismissed = false;
      job.toast = toasts.create(() => dismissJob(job));
      renderJob(job);
    } else {
      job.toast.nudge();
    }
  }

  function onProgress(msg) {
    const job = jobs.get(msg.jobId);
    if (!job) return;
    if (typeof msg.title === 'string' && msg.title) job.title = cleanTitle(msg.title);
    if (count(msg.total)) job.total = count(msg.total);
    if (msg.phase === 'adding' || msg.phase === 'queued') {
      job.started = true;
      job.phase = msg.phase;
    }
    if (msg.phase === 'adding') job.added = Math.max(job.added, count(msg.done));
    if (msg.phase === 'queued') job.position = count(msg.position);
    if (job.awaitingConfirm || job.dismissed) return;
    renderJob(job);
  }

  function confirmJob(job) {
    if (!job.awaitingConfirm) return;
    job.awaitingConfirm = false;
    job.confirmed = true;
    renderJob(job);
    sendQueue(job);
  }

  function cancelJob(job) {
    job.awaitingConfirm = false; // an "Add" click while the toast fades out must not confirm
    forgetJob(job);
    job.toast.close();
  }

  function retryJob(job) {
    const running = inFlight.get(job.source.url);
    if (running) { // the same thing was started again from a button meanwhile
      job.toast.close();
      reshowJob(running);
      return;
    }
    job.id = newJobId();
    // A new attempt: nothing of it has reached a room tab yet (a stale `started` would hide a safe retry again).
    Object.assign(job, { phase: 'pending', total: 0, position: 0, added: 0, started: false });
    jobs.set(job.id, job);
    inFlight.set(job.source.url, job);
    renderJob(job);
    sendQueue(job);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Toast texts

  const SKIP_REASONS = {
    geo_blocked: 'not available in your country',
    preview_only: 'Go+ preview only',
    not_embeddable: 'embedding disabled',
    not_streamable: 'not streamable',
    processing: 'still processing',
    unavailable: 'unavailable',
  };

  const WARNINGS = {
    truncated: 'Only the first 1,000 tracks were added.',
    private_tracks: 'Includes private tracks shared by secret link.',
  };

  const CHECK_PLAYLIST = "Check the room's playlist before trying again.";

  // headline(quotedTitle | null), hint, retry: "Try again" makes sense for this code (it is only offered while
  // nothing can have reached the room yet), check: what to do after a partial add (default CHECK_PLAYLIST).
  const ERRORS = {
    NO_ROOM: { headline: () => 'No w2g room is open', hint: 'Open a w2g room in this browser, then try again.', retry: true },
    NOT_JOINED: { headline: () => "You haven't joined the w2g room", hint: 'Open the room tab, click "Join the Room", then try again.', retry: true },
    W2G_UNREACHABLE: { headline: () => "Couldn't reach w2g", hint: "The room tab can't reach w2g right now. Check your connection, then try again.", retry: true },
    MODERATED: { headline: () => "The room's playlist is locked", hint: 'Only the room owner and moderators can add to it right now.' },
    ROOM_UNREACHABLE: { headline: () => "The w2g room tab isn't responding", hint: 'Reload the room tab, then try again.', retry: true },
    ROOM_STALLED: {
      headline: () => 'The w2g room tab stopped responding',
      hint: "Adding was stopped. Check the room's playlist, then reload the room tab.",
      check: "Check the room's playlist, then reload the room tab.",
    },
    PLAYLIST_CHANGED: {
      headline: () => "Someone switched the room's playlist",
      hint: "Adding stopped, so nothing went to the wrong list. Check the room's playlist.",
    },
    AUTH_REQUIRED: { headline: (t) => `Log in to SoundCloud to add ${t || 'this'}`, hint: 'Personal playlists like Weekly Wave need your SoundCloud login in this browser.' },
    AUTH_EXPIRED: { headline: () => 'Your SoundCloud login has expired', hint: 'Reload soundcloud.com to refresh it, then try again.', retry: true },
    BOT_CHALLENGE: { headline: () => 'SoundCloud wants to check that you are human', hint: 'Reload this page, complete the check if asked, then try again.', retry: true },
    RATE_LIMITED: { headline: () => 'Too many requests', hint: 'SoundCloud or w2g is limiting requests. Wait a minute, then try again.' },
    NETWORK: { headline: () => "Couldn't reach SoundCloud", hint: 'Check your connection, then try again.', retry: true },
    SC_HTTP: { headline: () => 'SoundCloud returned an error', hint: 'Try again in a moment.', retry: true },
    EMPTY: { headline: (t) => (t ? `Nothing to add from ${t}` : 'Nothing to add'), hint: 'None of the tracks can be played in w2g.' },
    NOT_FOUND: { headline: (t) => `SoundCloud can't find ${t || 'this'}`, hint: "It may have been deleted or made private, or it's someone else's personal playlist." },
    INVALID_URL: { headline: (t) => `${t || 'This'} can't be added to w2g`, hint: "It isn't a SoundCloud track or playlist link." },
    UNSUPPORTED_URL: { headline: (t) => `${t || 'This'} can't be added to w2g`, hint: 'Only tracks, playlists, albums and stations can be added.' },
    W2G_FAILED: { headline: () => "w2g didn't accept the tracks", hint: "Some may have been added. Check the room's playlist before trying again." },
    CANCELLED: { headline: () => 'Cancelled', hint: null },
    // Client-only: this frame lost its extension (reload, update, uninstall) or the background mid-request.
    CONTEXT_INVALIDATED: {
      headline: () => 'SoundCloud for w2g was updated',
      hint: 'Reload this page to keep adding to w2g.',
      check: "Check the room's playlist, then reload this page.",
    },
    CONNECTION_LOST: { headline: () => 'Lost the connection to SoundCloud for w2g', hint: 'Try again. If it keeps happening, reload this page.', retry: true },
    INTERNAL: { headline: () => 'Something went wrong', hint: 'Try again. If it keeps happening, reload this page.', retry: true },
  };

  // Failures that can cut a job off after the room tab got it, without saying how far it got.
  const UNSURE = new Set(['ROOM_UNREACHABLE', 'INTERNAL', 'CONNECTION_LOST', 'CONTEXT_INVALIDATED']);
  // After the room tab got the job, these come only from its check before the next POST, and its reply's `added`
  // is exact: with 0 added nothing was posted, so a retry can't add anything twice.
  const BEFORE_POST = new Set(['NOT_JOINED', 'NETWORK', 'W2G_UNREACHABLE']);

  function fmt(n) {
    return Number(n).toLocaleString('en-US');
  }

  function tracks(n) {
    return `${fmt(n)} ${n === 1 ? 'track' : 'tracks'}`;
  }

  function quoted(title) {
    return title ? `'${title}'` : null;
  }

  // With several rooms open (temporary rooms are all called "Temporary Room"), add the start of the streamkey the
  // popup shows, so a fallback to another room can't go unnoticed. Only the start: the streamkey is the room's
  // invite key, and page scripts can read toast text.
  function roomLabel(room) {
    const name = room && typeof room.roomName === 'string' ? room.roomName.trim() : '';
    const key = room && typeof room.streamkey === 'string' ? room.streamkey.trim() : '';
    if (rooms.length > 1 && key) {
      const tag = `${key.slice(0, 4)}…`;
      return name ? `${name} (${tag})` : `room ${tag}`;
    }
    return name || 'your w2g room';
  }

  function skippedSummary(skipped) {
    if (!Array.isArray(skipped) || !skipped.length) return null;
    const byReason = new Map();
    for (const s of skipped) {
      const reason = SKIP_REASONS[s && s.reason] || SKIP_REASONS.unavailable;
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
    if (byReason.size === 1) return `${fmt(skipped.length)} skipped (${[...byReason.keys()][0]})`;
    const parts = [...byReason].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${fmt(n)} ${reason}`);
    return `${fmt(skipped.length)} skipped (${parts.join(', ')})`;
  }

  // Why nothing could be added. Go+ tracks are only skipped because of a setting, so say which one.
  function emptyHint(skipped, hint) {
    const list = Array.isArray(skipped) ? skipped.filter((s) => s && typeof s === 'object') : [];
    if (list.length && list.every((s) => s.reason === 'preview_only')) {
      return list.length === 1
        ? `It's a Go+ track: w2g would only play a 30-second preview. To add it anyway, turn off "Skip Go+ previews" in the extension popup.`
        : `All ${fmt(list.length)} are Go+ tracks: w2g would only play 30-second previews. To add them anyway, turn off "Skip Go+ previews" in the extension popup.`;
    }
    return [hint, skippedSummary(list)].filter(Boolean).join('\n');
  }

  function renderJob(job) {
    if (job.awaitingConfirm) showConfirm(job);
    else if (job.phase === 'queued') showQueued(job);
    else if (job.phase === 'adding' && job.total > 1) showProgress(job);
    else showPending(job);
  }

  function showPending(job) {
    const title = quoted(job.title);
    const text = job.confirmed && job.count > 1
      ? `Adding ${tracks(job.count)} to w2g…`
      : title ? `Adding ${title} to w2g…` : 'Adding to w2g…';
    job.toast.update({ state: 'busy', text, detail: job.confirmed && job.count > 1 ? job.title : null });
  }

  function showQueued(job) {
    const position = job.position ? ` (position ${fmt(job.position)})` : '';
    job.toast.update({
      state: 'busy',
      text: `Waiting for the room's current add to finish…${position}`,
      detail: [job.title, job.total > 1 ? tracks(job.total) : null].filter(Boolean).join(' · '),
    });
  }

  function showProgress(job) {
    const done = Math.min(job.added, job.total);
    job.toast.update({
      state: 'busy',
      text: `Adding ${tracks(job.total)}… ${fmt(done)}/${fmt(job.total)}`,
      detail: job.title,
      progress: done / job.total,
    });
  }

  function showConfirm(job) {
    const detail = [job.title, job.skippedCount ? `${tracks(job.skippedCount)} can't be played and will be skipped.` : null];
    job.toast.update({
      state: 'confirm',
      text: `Add ${tracks(job.count)} to w2g?`,
      detail: detail.filter(Boolean).join('\n'),
      actions: [
        { label: 'Add', primary: true, adds: true, onClick: () => confirmJob(job) },
        { label: 'Cancel', onClick: () => cancelJob(job) },
      ],
    });
  }

  function showSuccess(job, res) {
    const added = count(res.added);
    const title = cleanTitle(res.title) || job.title;
    const room = roomLabel(res.room);
    const single = added === 1 && job.source.kind === 'track';
    const text = single && title ? `Added ${quoted(title)} to ${room}` : `Added ${tracks(added)} to ${room}`;
    const detail = [single ? null : title, skippedSummary(res.skipped)].filter(Boolean).join(' · ');
    const warnings = (Array.isArray(res.warnings) ? res.warnings : []).map((w) => WARNINGS[w]).filter(Boolean);
    job.toast.update({
      state: 'success',
      text,
      detail: [detail, ...warnings].filter(Boolean).join('\n'),
      autoHide: SUCCESS_HIDE_MS,
    });
  }

  function showError(job, error) {
    const code = ERRORS[error.code] ? error.code : 'INTERNAL';
    const spec = ERRORS[code];
    // The room tab's count (passed on by the background) can be ahead of the last progress message seen here.
    const added = Math.max(job.added, count(error.added));
    let text = spec.headline(quoted(job.title));
    let detail = spec.hint;
    if (code === 'EMPTY') detail = emptyHint(error.skipped, spec.hint);
    if (code === 'INTERNAL' && error.message) detail = `${spec.hint}\n${error.message}`;
    if (job.started && code === 'CONTEXT_INVALIDATED') text = 'SoundCloud for w2g stopped while adding';
    const check = spec.check || CHECK_PLAYLIST;
    if (job.started && code === 'CONNECTION_LOST') {
      // Only the background went away. The room tab doesn't need it to finish the job.
      text = 'Lost track of this add';
      const sofar = added > 0 ? `At least ${tracks(added)} ${added === 1 ? 'was' : 'were'} added so far. ` : '';
      detail = `${sofar}The room tab may still be adding the rest. Check the room's playlist in a minute before adding it again.`;
    } else if (added > 0) {
      detail = `${tracks(added)} ${added === 1 ? 'was' : 'were'} added before this happened. ${check}`;
    } else if (job.started && UNSURE.has(code)) {
      detail = `${job.source && job.source.kind === 'track' ? 'The track' : 'Some tracks'} may already be in the room. ${check}`;
    }
    const actions = [];
    // A retry is a new job for the room tab: only safe while nothing can have reached the room.
    if (spec.retry && added === 0 && job.source && (!job.started || BEFORE_POST.has(code))) {
      actions.push({ label: 'Try again', adds: true, onClick: () => retryJob(job) });
    }
    if (code === 'CONTEXT_INVALIDATED') actions.push({ label: 'Reload page', primary: true, onClick: () => location.reload() });
    job.toast.update({ state: 'error', text, detail, actions });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Toast UI: a closed shadow root on a host in <body>.
  //
  // Page styles must not decide what a toast looks like: custom properties and inherited properties cross the shadow
  // boundary (a page rule or a registered @property could make every color transparent while IntersectionObserver v2
  // still reports the toast as visible). Hence literal colors in two palettes picked from the page's theme in JS,
  // `all: initial` on the stack, and only generic font families (a page @font-face can't redefine those).
  //
  // IntersectionObserver v2 (the visibility gate below) counts a toast action as hidden while it, the toast or an
  // ancestor has opacity < 1, a filter or a non-translation transform, or while anything paints over it, even a
  // shadow. Hence such effects only in the enter and leave animations, hover colors mixed instead of faded, and a
  // shadow that reaches 15px above a toast (1.5 * blur - y-offset): with the 8px gap it stays clear of the buttons
  // of the toast above, which end 13px above that toast's bottom edge.

  const ACCENT = '#f50';
  const ERROR_COLOR = '#d61348';
  const SHADOW = '0 6px 14px rgba(0, 0, 0, 0.28)';
  const PALETTES = {
    dark: { surface: '#121212', text: '#fff', rgb: '255, 255, 255', muted: '#999', btn: '#fff', btnFg: '#121212', btn2: '#303030', btn2Fg: '#fff' },
    light: { surface: '#fff', text: '#121212', rgb: '18, 18, 18', muted: '#666', btn: '#121212', btnFg: '#fff', btn2: '#f3f3f3', btn2Fg: '#121212' },
  };

  function paletteCss(name, p) {
    const s = `.stack.${name}`;
    const mix = (color) => `color-mix(in srgb, ${color} 85%, ${p.surface})`;
    return `
    ${s} .toast { background: ${p.surface}; color: ${p.text}; border-color: rgba(${p.rgb}, 0.14); }
    ${s} .spinner { border-color: rgba(${p.rgb}, 0.18); border-top-color: ${ACCENT}; }
    ${s} .detail, ${s} .close { color: ${p.muted}; }
    ${s} .close:hover { color: ${p.text}; }
    ${s} .bar { background: rgba(${p.rgb}, 0.14); }
    ${s} .action { background: ${p.btn2}; color: ${p.btn2Fg}; }
    ${s} .action:hover { background: ${mix(p.btn2)}; color: ${mix(p.btn2Fg)}; }
    ${s} .action.primary { background: ${p.btn}; color: ${p.btnFg}; }
    ${s} .action.primary:hover { background: ${mix(p.btn)}; color: ${mix(p.btnFg)}; }`;
  }

  const TOAST_CSS = `
    .stack {
      all: initial;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none;
      font-family: system-ui, sans-serif; font-size: 14px; line-height: 20px; font-weight: 400;
      text-align: left; white-space: normal; visibility: visible;
    }
    .toast {
      pointer-events: auto;
      position: relative; box-sizing: border-box; display: flex; align-items: flex-start; gap: 12px;
      width: ${TOAST_WIDTH}px; max-width: calc(100vw - 32px); padding: 12px 8px 12px 14px;
      border: 1px solid; border-radius: 4px;
      box-shadow: ${SHADOW};
      animation: toast-in 160ms ease-out;
    }
    .toast.leaving { opacity: 0; transform: translateY(6px); transition: opacity 150ms, transform 150ms; }
    .toast.nudge { animation: toast-nudge 700ms ease-out; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } }
    @keyframes toast-nudge { 25%, 75% { border-color: ${ACCENT}; box-shadow: 0 0 0 2px ${ACCENT}, ${SHADOW}; } }
    .icon { flex: none; width: 20px; height: 20px; display: grid; place-items: center; color: ${ACCENT}; }
    .toast[data-state="error"] .icon { color: ${ERROR_COLOR}; }
    .icon svg { display: block; }
    .spinner {
      box-sizing: border-box; width: 16px; height: 16px; border-radius: 50%; border: 2px solid;
      animation: spin 800ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .body { flex: 1 1 auto; min-width: 0; }
    .text {
      font-weight: 600; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
    }
    .detail {
      margin-top: 2px; font-size: 12px; line-height: 16px;
      white-space: pre-line; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden;
    }
    .bar { margin-top: 8px; height: 2px; border-radius: 1px; overflow: hidden; }
    .fill { height: 100%; width: 0; background: ${ACCENT}; transition: width 250ms ease-out; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    .action { font: inherit; font-weight: 600; padding: 4px 12px; border: 0; border-radius: 4px; cursor: pointer; }
    .close {
      flex: none; width: 24px; height: 24px; margin: -2px 0 0; padding: 0; border: 0; border-radius: 4px; cursor: pointer;
      display: grid; place-items: center; background: transparent;
    }
    .action:focus-visible, .close:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) {
      .toast, .toast.nudge { animation: none; }
      .toast.nudge { outline: 2px solid ${ACCENT}; }
      .toast.leaving, .fill { transition: none; }
      .spinner { animation-duration: 2s; }
    }
    ${paletteCss('dark', PALETTES.dark)}
    ${paletteCss('light', PALETTES.light)}
  `;

  const TOAST_ICONS = {
    busy: '<span class="spinner"></span>',
    confirm: ICON,
    success: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor"/><path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="#fff" stroke-width="1.8"/></svg>',
    error: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1.2" fill="#fff"/></svg>',
  };
  const ICON_CLOSE = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.94 8l-4.47 4.47 1.06 1.06L8 9.06l4.47 4.47 1.06-1.06L9.06 8l4.47-4.47-1.06-1.06L8 6.94 3.53 2.47 2.47 3.53 6.94 8z"/></svg>';

  // 'dark' or 'light', following SoundCloud's theme. The page can only pick one of our two literal palettes.
  function themePalette() {
    const body = document.body;
    if (body.classList.contains('theme-dark') || body.classList.contains('theme-light')) return body.classList.contains('theme-light') ? 'light' : 'dark';
    const html = document.documentElement.classList;
    if (html.contains('mui-theme-dark') || html.contains('mui-theme-light')) return html.contains('mui-theme-dark') ? 'dark' : 'light';
    const theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'dark' || theme === 'light') return theme;
    const rgba = getComputedStyle(body).backgroundColor.match(/[\d.]+/g);
    if (rgba && rgba.length >= 3 && (rgba.length < 4 || Number(rgba[3]) > 0)) {
      return 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2] > 128 ? 'light' : 'dark';
    }
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  const toasts = (() => {
    let host = null;
    let stack = null;
    let watchedPanel = null;
    // The Next up panel opens and closes by a class change only (no childList mutation).
    const panelObserver = new MutationObserver(() => {
      place();
      setTimeout(place, 400); // after its slide-in transition
    });

    // Page scripts can restyle the light-DOM host or cover it (opacity 0, an overlay with pointer-events:none, moved
    // under the cursor), so a trusted click doesn't prove the user saw what they clicked. Actions that add tracks
    // therefore only react once IntersectionObserver v2 has reported them visible (unobscured, undistorted, not
    // clipped) for VISIBLE_MS without a break, and while nothing IO v2 doesn't check (zoom, masks, clip paths,
    // blending, a moved host) is applied from outside (pageTampered). Engines without IO v2 (not Chromium) get no
    // gate: it fails open.
    const visibleSince = new WeakMap(); // action button -> entry.time since which it has been visible
    const visibility = (() => {
      if (typeof IntersectionObserverEntry !== 'function' || !('isVisible' in IntersectionObserverEntry.prototype)) return null;
      try {
        return new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isVisible || entry.intersectionRatio < 0.99) visibleSince.delete(entry.target);
            else if (!visibleSince.has(entry.target)) visibleSince.set(entry.target, entry.time);
          }
        }, { trackVisibility: true, delay: 100, threshold: [0, 0.99, 1] });
      } catch (_) {
        return null;
      }
    })();

    // Effects on the host or above it that change what the user sees without IO v2 noticing: the stack moved away
    // from where place() put it (IO v2 allows translations), zoom, masks, clip paths, blending.
    function pageTampered() {
      if (!host || !stack || host.parentNode !== document.body || getComputedStyle(host).position !== 'fixed') return true;
      const root = document.documentElement;
      const hostBox = host.getBoundingClientRect();
      const stackBox = stack.getBoundingClientRect();
      const off = (a, b) => !(Math.abs(a - b) <= 1);
      if (off(hostBox.right, root.clientWidth - parseFloat(host.style.right)) || off(hostBox.bottom, root.clientHeight - parseFloat(host.style.bottom))
        || off(stackBox.right, hostBox.right) || off(stackBox.bottom, hostBox.bottom)) return true;
      for (let node = host; node instanceof Element; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.visibility !== 'visible' || cs.mixBlendMode !== 'normal' || cs.clipPath !== 'none' || cs.transform !== 'none'
          || cs.translate !== 'none' || cs.scale !== 'none' || cs.rotate !== 'none' || (cs.zoom && Number(cs.zoom) !== 1)
          || (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) return true;
      }
      return false;
    }

    function watch(button) {
      if (visibility) visibility.observe(button);
    }

    function unwatch(scope) {
      for (const button of scope.querySelectorAll('.action')) {
        visibleSince.delete(button);
        if (visibility) visibility.unobserve(button);
      }
    }

    // Event timestamps and entry.time share the document's performance.now() timeline.
    function seenLongEnough(button, event) {
      if (!visibility) return true;
      const since = visibleSince.get(button);
      if (since === undefined || event.timeStamp - since < VISIBLE_MS || pageTampered()) return false;
      const r = button.getBoundingClientRect(); // at its real size (no zoom) and fully on screen
      return r.width >= 24 && r.height >= 16 && r.left >= 0 && r.top >= 0
        && r.right <= document.documentElement.clientWidth && r.bottom <= document.documentElement.clientHeight;
    }

    function ensureStack() {
      if (!host) {
        host = document.createElement('div');
        host.className = `${NODE} ${TOASTS}`;
        host.style.cssText = 'position: fixed; right: 16px; bottom: 64px; z-index: 1002;'; // above the 48px player bar (z 1001)
        const shadow = host.attachShadow({ mode: TOAST_SHADOW_MODE }); // kept in this closure only
        const style = document.createElement('style');
        style.textContent = TOAST_CSS;
        stack = document.createElement('div');
        stack.className = 'stack';
        stack.setAttribute('aria-live', 'polite');
        stack.appendChild(document.createElement('slot')); // adopted stacks of orphaned copies, oldest on top
        shadow.append(style, stack);
      }
      const palette = themePalette();
      stack.classList.toggle('dark', palette === 'dark');
      stack.classList.toggle('light', palette === 'light');
      if (!host.isConnected) document.body.appendChild(host);
      adoptOrphans();
      place();
      return stack;
    }

    // A copy orphaned by an extension update leaves its toast stack behind (its last jobs report there how they
    // ended). Show that stack inside this one instead of drawing a second stack over it.
    function adoptOrphans() {
      if (stopped) return;
      const orphans = [...document.querySelectorAll(`body > .${TOASTS}`)].filter((other) => other !== host && !other.contains(host));
      for (const other of orphans) other.removeAttribute('style');
      if (orphans.length) host.prepend(...orphans);
    }

    // SoundCloud's Next up panel opens above the player bar in the same corner: keep the stack beside it, or
    // above it when the window is too narrow (and in the corner when there is no room above either, so the
    // toasts never end up off-screen).
    function place() {
      if (!host) return;
      const panel = document.querySelector('.playControls .queue');
      if (panel !== watchedPanel) {
        panelObserver.disconnect();
        if (panel) panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
        watchedPanel = panel;
      }
      let right = 16;
      let bottom = 64;
      const r = panel && panel.classList.contains('m-visible') ? panel.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) {
        if (r.left >= TOAST_WIDTH + 32) right = document.documentElement.clientWidth - r.left + 16;
        else if (r.top >= 160) bottom = document.documentElement.clientHeight - r.top + 8;
      }
      host.style.right = `${Math.round(right)}px`;
      host.style.bottom = `${Math.round(bottom)}px`;
    }

    function create(onDismiss) {
      const list = ensureStack();
      const el = document.createElement('div');
      el.className = 'toast';
      const icon = document.createElement('div');
      icon.className = 'icon';
      const body = document.createElement('div');
      body.className = 'body';
      const text = document.createElement('div');
      text.className = 'text';
      const detail = document.createElement('div');
      detail.className = 'detail';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'fill';
      bar.appendChild(fill);
      const actions = document.createElement('div');
      actions.className = 'actions';
      body.append(text, detail, bar, actions);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.title = 'Dismiss';
      close.setAttribute('aria-label', 'Dismiss');
      close.innerHTML = ICON_CLOSE;
      el.append(icon, body, close);

      let hideAfter = 0;
      let hideTimer = 0;
      let hovered = false;
      let closed = false;

      function remove() {
        clearTimeout(hideTimer);
        if (closed) return;
        closed = true;
        unwatch(el); // also ignores clicks while it fades out
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 160);
      }

      function armHide() {
        clearTimeout(hideTimer);
        if (hideAfter && !hovered) hideTimer = setTimeout(remove, hideAfter);
      }

      close.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        remove();
        onDismiss();
      });
      el.addEventListener('mouseenter', () => { hovered = true; clearTimeout(hideTimer); });
      el.addEventListener('mouseleave', () => { hovered = false; armHide(); });

      list.appendChild(el);
      trim(list);

      return {
        update({ state, text: primary, detail: secondary = null, progress = null, actions: buttons = [], autoHide = 0 }) {
          if (closed) return;
          ensureStack();
          el.dataset.state = state;
          el.setAttribute('role', state === 'error' ? 'alert' : 'status');
          icon.innerHTML = TOAST_ICONS[state] || '';
          text.textContent = primary;
          detail.textContent = secondary || '';
          detail.hidden = !secondary;
          bar.hidden = progress == null;
          fill.style.width = `${Math.round((progress || 0) * 100)}%`;
          unwatch(actions);
          actions.replaceChildren(...buttons.map((b) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = b.primary ? 'action primary' : 'action';
            button.textContent = b.label;
            button.addEventListener('click', (event) => {
              if (!event.isTrusted || (b.adds && !seenLongEnough(button, event))) return;
              b.onClick();
            });
            if (b.adds) watch(button);
            return button;
          }));
          actions.hidden = !buttons.length;
          hideAfter = autoHide;
          armHide();
        },
        /** Draws attention to a toast that is already shown. */
        nudge() {
          if (closed) return;
          el.classList.remove('nudge');
          void el.offsetWidth; // restart the animation
          el.classList.add('nudge');
        },
        close: remove,
      };
    }

    // Keep the stack short: drop the oldest finished toasts first.
    function trim(list) {
      const live = [...list.querySelectorAll(':scope > .toast:not(.leaving)')];
      let excess = live.length - MAX_TOASTS;
      for (const t of live) {
        if (excess <= 0) break;
        if (t.dataset.state === 'success' || t.dataset.state === 'error') {
          unwatch(t);
          t.remove();
          excess--;
        }
      }
    }

    return { create, place };
  })();

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle

  function onTakeover() {
    if (!contextAlive()) teardown();
  }

  function teardown() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clearTimeout(scanTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('resize', onResize);
    document.removeEventListener(TAKEOVER_EVENT, onTakeover);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) { /* the extension context is already gone */ }
    // Toast stacks stay: their pending jobs report the lost connection themselves, and a new copy adopts them.
    for (const node of document.querySelectorAll(`.${NODE}`)) if (!node.classList.contains(TOASTS)) node.remove();
    root.removeAttribute(ROOM_ATTR);
    if (globalThis[GUARD] === instance) delete globalThis[GUARD];
  }

  const instance = { alive: () => !stopped && contextAlive(), teardown };
  globalThis[GUARD] = instance;

  function start() {
    try {
      // A copy orphaned by an extension update may live in another isolated world; let it clean up.
      document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
      document.addEventListener(TAKEOVER_EVENT, onTakeover);
      chrome.runtime.onMessage.addListener(onMessage);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('resize', onResize, { passive: true });
      observer.observe(document.body, { childList: true, subtree: true });
      scan();
      refreshRooms();
    } catch (err) {
      console.warn('[scw2g] could not start', err);
      teardown(); // also releases the guard, so a later injection can try again
    }
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
