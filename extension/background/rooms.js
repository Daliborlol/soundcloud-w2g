// Registry of open w2g room tabs and target-room selection.
// The state lives in chrome.storage.session (keys 'rooms' and 'targetTabId') so it survives service worker
// restarts; the background is its only writer and keeps a copy in memory while it runs. Each entry also keeps the
// documentId of the page that registered it (not part of the public RoomInfo), so room:bye can tell which
// document is leaving.
import { createLock } from './util.js';

const ROOMS_KEY = 'rooms';
const TARGET_KEY = 'targetTabId';
// The pages the w2g-room content script runs on: https://w2g.tv/*/room/* and https://w2g.tv/room/*.
const ROOM_URL_RE = /^https:\/\/w2g\.tv\/(?:[^#]*\/)?room\//;
const STREAMKEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 120;
const MAX_DOCUMENT_ID_LENGTH = 128;

export function isRoomUrl(url) {
  return ROOM_URL_RE.test(String(url || ''));
}

/** The RoomInfo fields a content-script message (room:hello, room:ping reply) may set, sanitized. */
export function roomFields(data) {
  const src = data && typeof data === 'object' ? data : {};
  const name = typeof src.roomName === 'string' ? src.roomName.trim().slice(0, MAX_NAME_LENGTH) : '';
  return {
    streamkey: typeof src.streamkey === 'string' && STREAMKEY_RE.test(src.streamkey) ? src.streamkey : null,
    joined: src.joined === true,
    roomName: name || null,
    // The room tab's last check of w2g failed while w2g's join dialog wasn't showing: likely the network, not a
    // missing join (w2g's error responses carry no CORS headers, so the content script can't tell them apart).
    unreachable: src.joined !== true && src.unreachable === true,
  };
}

/** A sender's documentId (set by the browser, Chrome 106+), or null. */
export function documentIdOf(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DOCUMENT_ID_LENGTH ? value : null;
}

/**
 * The room to add to according to the registry: the popup's explicit choice while that tab is registered; otherwise
 * the joined room with the highest lastActive; otherwise the most recent room with a streamkey; otherwise null.
 * (Before using an automatic choice, the queue flow asks the most recently active room whether it has joined.)
 */
export function selectTarget(rooms, pinnedTabId) {
  const pinned = pinnedTabId == null ? null : rooms.find((r) => r.tabId === pinnedTabId);
  if (pinned) return pinned;
  const recent = [...rooms].sort((a, b) => b.lastActive - a.lastActive);
  return recent.find((r) => r.joined) || recent.find((r) => r.streamkey) || null;
}

function restoreRooms(stored) {
  const rooms = {};
  if (!stored || typeof stored !== 'object') return rooms;
  for (const r of Object.values(stored)) {
    if (r && Number.isInteger(r.tabId)) {
      rooms[r.tabId] = { tabId: r.tabId, ...roomFields(r), lastActive: Number(r.lastActive) || 0, documentId: documentIdOf(r.documentId) };
    }
  }
  return rooms;
}

/**
 * onChange() runs after every change that was persisted (outside the internal lock, so it may read the registry).
 * All methods are safe to call concurrently; changes are applied one at a time.
 */
export function createRoomRegistry({ storage, now = Date.now, onChange = async () => {} }) {
  const lock = createLock();
  let state = null; // { rooms: { [tabId]: RoomInfo + documentId }, pinned: tabId | null }

  async function load() {
    if (!state) {
      const stored = await storage.get([ROOMS_KEY, TARGET_KEY]);
      const pinned = stored[TARGET_KEY];
      state = { rooms: restoreRooms(stored[ROOMS_KEY]), pinned: Number.isInteger(pinned) ? pinned : null };
    }
    return state;
  }

  function view() {
    const rooms = Object.values(state.rooms)
      .map(({ tabId, streamkey, joined, roomName, unreachable, lastActive }) => ({ tabId, streamkey, joined, roomName, unreachable, lastActive }))
      .sort((a, b) => b.lastActive - a.lastActive || a.tabId - b.tabId);
    const pinnedTabId = state.pinned != null && state.rooms[state.pinned] ? state.pinned : null;
    return { rooms, target: selectTarget(rooms, pinnedTabId), pinnedTabId };
  }

  // Applies edit(state) and persists the result; resolves to whether anything changed.
  async function mutate(edit) {
    const changed = await lock(async () => {
      await load();
      const before = JSON.stringify(state);
      edit(state);
      if (JSON.stringify(state) === before) return false;
      await storage.set({ [ROOMS_KEY]: state.rooms, [TARGET_KEY]: state.pinned });
      return true;
    });
    if (changed) await onChange();
    return changed;
  }

  /** { rooms: RoomInfo[] (most recently active first), target: RoomInfo|null, pinnedTabId: number|null } */
  function snapshot() {
    return lock(async () => {
      await load();
      return view();
    });
  }

  async function get(tabId) {
    const { rooms } = await snapshot();
    return rooms.find((r) => r.tabId === tabId) || null;
  }

  /**
   * room:hello: registers or replaces the tab's entry (from the document `documentId`). Only a new registration or a
   * new page counts as activity: a page re-announces itself whenever its name or join state changes, which page
   * scripts can trigger, so recency otherwise comes from room:active (sent on trusted focus/visibility only).
   */
  function hello(tabId, data, documentId = null) {
    return mutate((s) => {
      const doc = documentIdOf(documentId);
      const prev = s.rooms[tabId];
      const samePage = prev && (prev.documentId && doc ? prev.documentId === doc : true);
      s.rooms[tabId] = { tabId, ...roomFields(data), lastActive: samePage ? prev.lastActive : now(), documentId: doc };
    });
  }

  /** room:active: marks a registered tab as the most recently used one. */
  function touch(tabId) {
    return mutate((s) => {
      if (s.rooms[tabId]) s.rooms[tabId].lastActive = now();
    });
  }

  /** Updates a registered tab from a room:ping reply without counting it as user activity. */
  function refresh(tabId, data) {
    return mutate((s) => {
      if (s.rooms[tabId]) Object.assign(s.rooms[tabId], roomFields(data));
    });
  }

  // A pin outlives its entry so that reloading the pinned room tab (room:bye, then room:hello) keeps the choice;
  // tab ids are unique for the browser session, and an unregistered pin is ignored.
  function remove(tabId) {
    return mutate((s) => {
      delete s.rooms[tabId];
    });
  }

  /**
   * room:bye: removes the tab's entry if the document saying goodbye is the one that registered it. When a room tab
   * navigates to another site, Chrome delivers the pagehide bye from the old document, which is no longer the tab's
   * main frame (`mainFrame` false: non-zero frameId, documentLifecycle 'pending_deletion'); such a bye only counts
   * with a matching documentId. A late bye from an older document never removes its successor's entry.
   */
  function bye(tabId, { documentId = null, mainFrame = true } = {}) {
    const leaving = documentIdOf(documentId);
    return mutate((s) => {
      const entry = s.rooms[tabId];
      if (!entry) return;
      const sameDocument = entry.documentId && leaving ? entry.documentId === leaving : mainFrame;
      if (sameDocument) delete s.rooms[tabId];
    });
  }

  /** Pins the target to a registered tab, or back to automatic selection with null. False if the tab isn't registered. */
  async function pin(tabId) {
    let known = true;
    await mutate((s) => {
      if (tabId == null) s.pinned = null;
      else if (s.rooms[tabId]) s.pinned = tabId;
      else known = false;
    });
    return known;
  }

  return { snapshot, get, hello, touch, refresh, remove, bye, pin };
}
