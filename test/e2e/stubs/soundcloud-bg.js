// Stub background for test/e2e/30-soundcloud.e2e.mjs. It replaces background/main.js through
// buildExtensionVariant() so the real soundcloud.com content script runs without w2g or SoundCloud's API.
// Tests drive it from Playwright: (await b.getServiceWorker()).evaluate(() => stub.<fn>(...)).
//
// It answers rooms:get and settings:get, records every message it receives, and answers 'queue' with
// scripted behaviours, consumed in order (a default success when none is queued):
//   { progress?: [{ phase, done?, total?, title?, position? }], stepMs?, delayMs?, hold?: true, result? }
// `result` is a partial QueueResult; jobId and, for successes, room (the current target) are filled in. With
// hold: true the reply stays open until stub.release(jobId, result); stub.progress(jobId, payload) sends
// job:progress meanwhile. Payloads and error details pass through unchanged, so every protocol revision 2 shape
// can be scripted, e.g.
//   stub.progress(id, { phase: 'queued', done: 0, total: 120, title: 'Set', position: 2 })
//   stub.release(id, { error: { code: 'ROOM_STALLED', message: '…', added: 50 } })
//   { result: { error: { code: 'EMPTY', message: '…', skipped: [{ title, reason: 'preview_only' }], total: 1 } } }

const STATE_KEY = 'scw2gStub';
const SETTINGS = { skipPreviews: true, confirmAbove: 100 };

const state = { rooms: [], target: null, behaviors: [], log: [] };
const origins = new Map(); // jobId -> { tabId, frameId } of the frame that sent 'queue'
const held = new Map(); // jobId -> { resolve, msg }

// The registry survives a service-worker restart like the real one (chrome.storage.session).
const ready = chrome.storage.session.get(STATE_KEY)
  .then((stored) => { if (stored[STATE_KEY]) Object.assign(state, stored[STATE_KEY]); })
  .catch(() => {});

function persist() {
  return chrome.storage.session.set({ [STATE_KEY]: state }).catch(() => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extension API calls keep the worker alive while a test idles between steps.
setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);

function sendProgress(jobId, payload) {
  const origin = origins.get(jobId);
  if (!origin) return Promise.resolve(false);
  return chrome.tabs.sendMessage(origin.tabId, { type: 'job:progress', jobId, ...payload }, { frameId: origin.frameId })
    .then(() => true, () => false);
}

function complete(msg, result = {}) {
  if (result.ok === false || result.error) {
    return { ok: false, jobId: msg.jobId, error: { code: 'INTERNAL', message: '', ...result.error } };
  }
  if (result.needsConfirm) {
    return { ok: true, jobId: msg.jobId, needsConfirm: true, count: 0, title: null, skippedCount: 0, ...result };
  }
  return { ok: true, jobId: msg.jobId, added: 1, title: 'Stub track', skipped: [], warnings: [], room: state.target, ...result };
}

async function runQueue(msg, sender) {
  origins.set(msg.jobId, { tabId: sender.tab.id, frameId: sender.frameId });
  const behavior = state.behaviors.shift() || {};
  await persist();
  for (const payload of behavior.progress || []) {
    await sendProgress(msg.jobId, payload);
    await sleep(behavior.stepMs ?? 50);
  }
  if (behavior.delayMs) await sleep(behavior.delayMs);
  if (behavior.hold) return new Promise((resolve) => held.set(msg.jobId, { resolve, msg }));
  return complete(msg, behavior.result);
}

async function handle(msg, sender) {
  await ready;
  state.log.push({
    type: msg && msg.type,
    msg,
    tabId: sender.tab ? sender.tab.id : null,
    frameId: sender.frameId,
    url: sender.url,
    at: Date.now(),
  });
  await persist();
  switch (msg && msg.type) {
    case 'rooms:get':
      return { ok: true, rooms: state.rooms, target: state.target };
    case 'settings:get':
      return { ok: true, settings: SETTINGS };
    case 'queue':
      return runQueue(msg, sender);
    default:
      return { ok: false, error: { code: 'INTERNAL', message: `stub: unexpected message ${msg && msg.type}` } };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  return true;
});

globalThis.stub = {
  /** Sets the registry and (by default) broadcasts rooms:changed to every frame of every SoundCloud tab. */
  async setRooms(rooms, target = rooms[0] || null, { broadcast = true } = {}) {
    await ready;
    state.rooms = rooms;
    state.target = target;
    await persist();
    return broadcast ? this.broadcast() : 0;
  },

  async broadcast() {
    const tabs = await chrome.tabs.query({ url: 'https://soundcloud.com/*' });
    const msg = { type: 'rooms:changed', rooms: state.rooms, target: state.target };
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
    return tabs.length;
  },

  async enqueue(...behaviors) {
    await ready;
    state.behaviors.push(...behaviors);
    await persist();
  },

  async reset() {
    await ready;
    state.behaviors = [];
    state.log = [];
    for (const { resolve, msg } of held.values()) resolve(complete(msg, { error: { code: 'CANCELLED' } }));
    held.clear();
    await persist();
  },

  async messages(type) {
    await ready;
    return state.log.filter((e) => !type || e.type === type);
  },

  heldJobs() {
    return [...held.keys()];
  },

  progress(jobId, payload) {
    return sendProgress(jobId, payload);
  },

  release(jobId, result) {
    const entry = held.get(jobId);
    if (!entry) return false;
    held.delete(jobId);
    entry.resolve(complete(entry.msg, result));
    return true;
  },

  /** Re-injects the soundcloud.com content scripts into all frames of open SoundCloud tabs, like the real
   *  background does on install/update. */
  async inject() {
    const cs = chrome.runtime.getManifest().content_scripts.find((c) => c.matches.includes('https://soundcloud.com/*'));
    const tabs = await chrome.tabs.query({ url: 'https://soundcloud.com/*' });
    for (const tab of tabs) {
      const target = { tabId: tab.id, allFrames: true };
      if (cs.css) await chrome.scripting.insertCSS({ target, files: cs.css });
      await chrome.scripting.executeScript({ target, files: cs.js });
    }
    return tabs.length;
  },
};
