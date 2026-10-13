// The background service worker's logic: message routing with sender checks, the room registry and its
// rooms:changed broadcast, SoundCloud requests, settings, the queue flow and content-script re-injection.
// Everything comes in through createBackground() so it can run against a fake `chrome` in unit tests;
// main.js wires the returned listeners to the real events.
import { createJobRunner } from './jobs.js';
import { reinjectContentScripts } from './inject.js';
import { createRoomRegistry, isRoomUrl } from './rooms.js';
import { createScService } from './sc-service.js';
import { createSettingsStore } from './settings.js';
import { createKeepAlive, errorPayload, failure, quietly } from './util.js';

const W2G_ORIGIN = 'https://w2g.tv';
const SOUNDCLOUD_ORIGIN = 'https://soundcloud.com';
const SOUNDCLOUD_TABS = 'https://soundcloud.com/*';
const SOUNDCLOUD_HOME = 'https://soundcloud.com/';

export const DEFAULT_TIMING = Object.freeze({
  pingTimeoutMs: 5000,
  addIdleTimeoutMs: 10 * 60 * 1000, // silence from the room tab (no progress, not even 'queued') before ROOM_STALLED
  cancelReplyMs: 15 * 1000, // room:cancel first lets an in-flight batch settle and checks whether it landed (~11 s)
  keepAliveMs: 15 * 1000,
  expandTtlMs: 2 * 60 * 1000,
  scCacheTtlMs: 5 * 60 * 1000,
  progressFlushMs: 1000,
  loginChangedMs: 1000, // a login sets several cookies: tell the room tabs once, after the last change
});

const defaultLog = {
  error: (...args) => console.error('[scw2g]', ...args),
};

// Who may send what. 'room': frame 0 of a w2g.tv room tab; 'soundcloud': any frame of a soundcloud.com tab;
// 'extension': our own pages (popup). 'old-document': a w2g.tv document that isn't its tab's main frame. In practice
// that is a room tab's previous page during a navigation to another site: Chrome delivers its pagehide room:bye
// with frameId != 0 and documentLifecycle 'pending_deletion'. Only room:bye is accepted from it, and the registry
// only acts on it when the documentId is the one that registered the tab.
const ROOM = 'room';
const OLD_DOCUMENT = 'old-document';
const SOUNDCLOUD = 'soundcloud';
const EXTENSION = 'extension';

export function createBackground({
  chrome,
  sc,
  urlTools,
  fetch = (...args) => globalThis.fetch(...args),
  now = Date.now,
  timing: timingOverrides = {},
  log = defaultLog,
}) {
  const timing = { ...DEFAULT_TIMING, ...timingOverrides };
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const keepAlive = createKeepAlive(() => chrome.runtime.getPlatformInfo(), timing.keepAliveMs);
  const settings = createSettingsStore({ storage: chrome.storage.local });
  const rooms = createRoomRegistry({ storage: chrome.storage.session, now, onChange: broadcastRooms });
  const scService = createScService({
    chrome, sc, urlTools, fetch, now, keepAlive, expandTtlMs: timing.expandTtlMs, cacheTtlMs: timing.scCacheTtlMs,
  });
  const jobs = createJobRunner({ chrome, rooms, settings, scService, keepAlive, timing });

  const routes = {
    'room:hello': { from: [ROOM], run: roomHello },
    'room:bye': { from: [ROOM, OLD_DOCUMENT], run: roomBye },
    'room:active': { from: [ROOM], run: roomActive },
    'job:progress': { from: [ROOM], run: async (msg, sender) => jobs.progress(msg, sender) },
    'sc:expand': { from: [ROOM, EXTENSION], run: scExpand },
    'sc:library': { from: [ROOM, EXTENSION], run: scLibrary },
    'sc:status': { from: [ROOM, EXTENSION], run: scStatus },
    'settings:get': { from: [ROOM, SOUNDCLOUD, EXTENSION], run: async () => ({ ok: true, settings: await settings.get() }) },
    'settings:set': { from: [ROOM, EXTENSION], run: async (msg) => ({ ok: true, settings: await settings.set(msg.patch) }) },
    'open:soundcloud': { from: [ROOM, EXTENSION], run: openSoundCloud },
    'rooms:get': { from: [ROOM, SOUNDCLOUD, EXTENSION], run: roomsGet },
    'rooms:set-target': { from: [EXTENSION], run: setTarget },
    'queue': { from: [SOUNDCLOUD, EXTENSION], run: (msg, sender, kind) => jobs.queue(msg, sender, kind) },
  };

  function originOf(url) {
    try {
      const u = new URL(url);
      // URL.origin is "null" for non-special schemes outside Chrome.
      return u.protocol === 'chrome-extension:' ? `chrome-extension://${u.host}` : u.origin;
    } catch {
      return null;
    }
  }

  function senderKind(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return null;
    const origin = sender.origin !== undefined ? sender.origin : originOf(sender.url);
    if (origin === extensionOrigin) return EXTENSION;
    if (!sender.tab || !Number.isInteger(sender.tab.id)) return null;
    if (origin === W2G_ORIGIN) return sender.frameId === 0 ? ROOM : OLD_DOCUMENT;
    if (origin === SOUNDCLOUD_ORIGIN) return SOUNDCLOUD;
    return null;
  }

  /** Resolves to the response for `msg`; never rejects. */
  async function handle(msg, sender) {
    const route = routes[msg.type];
    const kind = senderKind(sender);
    const echo = msg.type === 'queue' ? { jobId: msg.jobId ?? null } : {};
    if (!kind || !route.from.includes(kind)) {
      return { ...failure('INTERNAL', `${msg.type} is not accepted from this sender.`), ...echo };
    }
    try {
      return await route.run(msg, sender, kind);
    } catch (err) {
      const error = errorPayload(err);
      if (error.code === 'INTERNAL') log.error(`${msg.type} failed:`, err);
      return { ok: false, ...echo, error };
    }
  }

  /** chrome.runtime.onMessage listener (sendResponse + return true, see the message protocol). */
  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object' || !Object.hasOwn(routes, msg.type)) return false;
    handle(msg, sender).then((response) => {
      try {
        sendResponse(response);
      } catch {
        // The sender went away (tab closed or navigated).
      }
    });
    return true;
  }

  async function roomHello(msg, sender) {
    if (!isRoomUrl(sender.url)) return failure('INTERNAL', 'room:hello is only accepted from w2g room pages.');
    await rooms.hello(sender.tab.id, msg, sender.documentId);
    return { ok: true };
  }

  async function roomBye(msg, sender, kind) {
    await rooms.bye(sender.tab.id, { documentId: sender.documentId, mainFrame: kind === ROOM });
    return { ok: true };
  }

  async function roomActive(msg, sender) {
    await rooms.touch(sender.tab.id);
    return { ok: true };
  }

  async function roomsGet() {
    const { rooms: list, target, pinnedTabId } = await rooms.snapshot();
    return { ok: true, rooms: list, target, pinnedTabId };
  }

  async function setTarget(msg) {
    const tabId = msg.tabId ?? null;
    if (tabId !== null && !Number.isInteger(tabId)) return failure('INTERNAL', 'rooms:set-target needs { tabId: number|null }.');
    if (!(await rooms.pin(tabId))) return failure('NO_ROOM', 'That w2g room tab is no longer open.');
    return { ok: true };
  }

  async function scExpand(msg) {
    const url = scService.checkUrl(msg.url);
    const { skipPreviews } = await settings.get();
    return { ok: true, result: await scService.expand(url, { skipPreviews }) };
  }

  async function scStatus() {
    const status = await scService.getStatus();
    const response = { ok: true, loggedIn: !!(status && status.loggedIn) };
    if (status && status.username) response.username = String(status.username);
    if (status && status.expired) response.expired = true;
    return response;
  }

  async function scLibrary(msg) {
    return { ok: true, library: await scService.getLibrary({ refresh: msg.refresh === true }) };
  }

  async function openSoundCloud(msg, sender) {
    const props = { url: SOUNDCLOUD_HOME, active: true };
    if (sender.tab && Number.isInteger(sender.tab.index)) {
      Object.assign(props, { windowId: sender.tab.windowId, index: sender.tab.index + 1, openerTabId: sender.tab.id });
    }
    await chrome.tabs.create(props);
    return { ok: true };
  }

  /** Sends the current registry to every frame of every soundcloud.com tab. */
  async function broadcastRooms() {
    let tabs;
    try {
      tabs = await chrome.tabs.query({ url: SOUNDCLOUD_TABS });
    } catch {
      return;
    }
    if (!tabs.length) return;
    // Read after the query so overlapping broadcasts all carry the latest state.
    const { rooms: list, target } = await rooms.snapshot();
    const message = { type: 'rooms:changed', rooms: list, target };
    for (const tab of tabs) {
      if (!tab.discarded) quietly(() => chrome.tabs.sendMessage(tab.id, message));
    }
  }

  /** Tells frame 0 of every registered room tab that the SoundCloud login changed (the panel reloads its library). */
  async function sendLoginChanged() {
    const { rooms: list } = await rooms.snapshot();
    const message = { type: 'sc:login-changed' };
    await Promise.all(list.map((room) => quietly(() => chrome.tabs.sendMessage(room.tabId, message, { frameId: 0 }))));
  }

  let loginChangedTimer = null;

  /** chrome.cookies.onChanged listener. Returns true when the change concerned the SoundCloud login. */
  function onCookieChanged(info) {
    if (!scService.onCookieChanged(info)) return false;
    clearTimeout(loginChangedTimer);
    loginChangedTimer = setTimeout(() => {
      loginChangedTimer = null;
      sendLoginChanged().catch(logFailure);
    }, timing.loginChangedMs);
    return true;
  }

  /**
   * chrome.tabs.onUpdated listener: drops a registered tab that no longer shows a w2g room. Chrome reports the new
   * URL in changeInfo.url only for sites the extension may access; when a room tab moves to another site, the
   * 'loading' event (sent once the navigation commits) has no url, and neither has the tab.
   */
  function onTabUpdated(tabId, changeInfo, tab) {
    let url = null;
    if (changeInfo && typeof changeInfo.url === 'string') url = changeInfo.url;
    else if (changeInfo && changeInfo.status === 'loading' && tab && typeof tab === 'object') url = tab.url || '';
    if (url === null || isRoomUrl(url)) return Promise.resolve(false);
    return rooms.remove(tabId).catch(logFailure);
  }

  function logFailure(err) {
    log.error(err);
  }

  return {
    onMessage,
    onInstalled: () => reinjectContentScripts(chrome).catch(logFailure),
    onStartup: () => reinjectContentScripts(chrome).catch(logFailure),
    onTabRemoved: (tabId) => rooms.remove(tabId).catch(logFailure),
    onTabUpdated,
    onCookieChanged,
  };
}
