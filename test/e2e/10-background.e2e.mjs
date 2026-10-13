// E2E tests for the background service worker and the toolbar popup, in a real browser.
//
// Part 1 runs the real extension: popup rendering, settings persistence, sc:status, a real sc:expand of a
//   public set, and one `queue` into a real w2g room through the real room content script (network, creates
//   one throwaway room). If background/soundcloud.js isn't usable yet, a stub stands in so the worker loads,
//   and the network checks are skipped.
// Part 2 runs the real background against stub content scripts on fake w2g/soundcloud.com pages (served with
//   context.route): registry, rooms:changed broadcast to every frame, target pinning from the popup, the queue
//   flow with progress relay, needsConfirm, NOT_JOINED/NO_ROOM, EMPTY with its skip reasons, room tabs that
//   navigate to another site, asking the most recently used room first, a service worker restart, the login
//   cookie invalidating sc:status and reaching the room tabs (sc:login-changed), the datadome cookie reaching the
//   SoundCloud client, and re-injection into exactly the frames the manifest would cover.
//
// Screenshots go to $SCW2G_ARTIFACTS (default test-results/background).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, buildExtensionVariant, openExtensionPage, createRoom, waitForRoomItems, retry, waitFor, sleep, SC, EXT_DIR, ROOT } from './harness.mjs';

const ARTIFACTS = process.env.SCW2G_ARTIFACTS || path.join(ROOT, 'test-results', 'background');
fs.mkdirSync(ARTIFACTS, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// Stubs

const STUB_SOUNDCLOUD = String.raw`
export class ScError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScError';
    this.code = code;
  }
}
export function createSoundCloudClient(options) {
  return { options };
}
export async function getStatus(client) {
  const token = await client.options.getOAuthToken();
  if (!token) return { loggedIn: false };
  if (token === 'expired-token') return { loggedIn: false, expired: true };
  return { loggedIn: true, username: 'E2E Listener' };
}
export async function listLibrary() {
  return { loggedIn: false, sections: [] };
}
export async function expand(client, url) {
  if (url.includes('needs-login')) throw new ScError('AUTH_REQUIRED', 'Log in on soundcloud.com in this browser.');
  const slug = url.split('/').pop();
  if (url.includes('all-skipped')) {
    const skipped = [{ title: 'E2E - Go+ only', reason: 'preview_only' }, { title: null, reason: 'geo_blocked' }];
    return { source: { kind: 'playlist', url, title: 'Stub ' + slug, subtitle: 'e2e', artwork: null }, total: 2, items: [], skipped, warnings: [] };
  }
  // Reports what the background passes as getDataDomeId (the soundcloud.com datadome cookie).
  if (url.includes('datadome-check')) {
    const id = await client.options.getDataDomeId();
    return { source: { kind: 'playlist', url, title: 'datadome=' + id, subtitle: null, artwork: null }, total: 0, items: [], skipped: [], warnings: [] };
  }
  const count = url.includes('/sets/big') ? 120 : 3;
  return {
    source: { kind: 'playlist', url, title: 'Stub ' + slug, subtitle: 'e2e', artwork: null },
    total: count,
    items: Array.from({ length: count }, (_, i) => ({
      url: 'https://soundcloud.com/e2e/' + slug + '-' + (i + 1),
      title: 'E2E - ' + slug + ' ' + (i + 1),
      thumb: 'https://i1.sndcdn.com/artworks-e2e-t500x500.jpg',
    })),
    skipped: [],
    warnings: [],
  };
}
export function normalizeTrack() { return null; }
export function toW2gItem() { return null; }
`;

// Room tab: announces itself from the URL (?room_id, ?joined, ?name), answers room:ping, "adds" items by
// recording them in <html data-scw2g-added> and reports progress per 50 items like the real one. It counts
// sc:login-changed messages in <html data-scw2g-login-changed>. Flags: ?pingjoined=1 announces joined:false but
// answers room:ping with joined:true (as the real script does after re-probing w2g); ?nobye=1 sends no room:bye.
const STUB_ROOM = String.raw`(() => {
  'use strict';
  if (document.documentElement) document.documentElement.dataset.scw2gRuns = String(Number(document.documentElement.dataset.scw2gRuns || 0) + 1);
  if (globalThis.__scw2gStubRoom) return;
  globalThis.__scw2gStubRoom = true;
  const q = new URLSearchParams(location.search);
  const state = { streamkey: q.get('room_id'), joined: q.get('joined') !== '0', roomName: q.get('name') || null };
  const pingState = q.get('pingjoined') === '1' ? { ...state, joined: true } : state;
  const added = [];
  let loginChanged = 0;
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});
  send({ type: 'room:hello', ...state, url: location.href });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'room:ping') {
      sendResponse({ ok: true, ...pingState });
      return false;
    }
    if (message.type === 'sc:login-changed') {
      document.documentElement.dataset.scw2gLoginChanged = String(++loginChanged);
      return false;
    }
    if (message.type !== 'room:add') return false;
    (async () => {
      for (let i = 0; i < message.items.length; i += 50) {
        added.push(...message.items.slice(i, i + 50));
        document.documentElement.dataset.scw2gAdded = JSON.stringify(added);
        await send({ type: 'job:progress', jobId: message.jobId, phase: 'adding', done: Math.min(i + 50, message.items.length), total: message.items.length });
      }
      sendResponse({ ok: true, added: message.items.length, playlistKey: 'e2e-list' });
    })();
    return true;
  });
  if (q.get('nobye') !== '1') addEventListener('pagehide', () => send({ type: 'room:bye' }));
})();`;

// soundcloud.com frames: logs rooms:changed and job:progress into <html data-scw2g-log>, and sends `queue` for
// a 'scw2g-e2e-queue' DOM event (the response lands in <html data-scw2g-results>, keyed by jobId).
const STUB_SOUNDCLOUD_CONTENT = String.raw`(() => {
  'use strict';
  document.documentElement.dataset.scw2gRuns = String(Number(document.documentElement.dataset.scw2gRuns || 0) + 1);
  if (globalThis.__scw2gStubSc) return;
  globalThis.__scw2gStubSc = true;
  const root = document.documentElement;
  const log = [];
  const results = {};
  chrome.runtime.onMessage.addListener((message) => {
    if (message && (message.type === 'rooms:changed' || message.type === 'job:progress')) {
      log.push(message);
      root.dataset.scw2gLog = JSON.stringify(log);
    }
    return false;
  });
  document.addEventListener('scw2g-e2e-queue', async (event) => {
    const request = JSON.parse(event.detail);
    results[request.jobId] = await chrome.runtime.sendMessage({ type: 'queue', ...request });
    root.dataset.scw2gResults = JSON.stringify(results);
  });
  root.dataset.scw2gLog = '[]';
  root.dataset.scw2gReady = '1';
})();`;

// Test-only entry: the real main.js plus a handle on the re-injection that onInstalled/onStartup run, and (imported
// first, so it wraps the listener main.js registers) a switch that hides tabs.onUpdated from the background:
// with globalThis.scw2gIgnoreTabUpdates = true only room:bye can tell it that a room tab navigated away.
const MAIN_WITH_HOOKS = `import './e2e-hooks.js';
import './main-real.js';
import { reinjectContentScripts } from './inject.js';
globalThis.scw2gReinject = () => reinjectContentScripts(chrome);
`;
const E2E_HOOKS = `const onUpdated = chrome.tabs.onUpdated;
const addListener = onUpdated.addListener.bind(onUpdated);
onUpdated.addListener = (listener) => addListener((...args) => (globalThis.scw2gIgnoreTabUpdates ? undefined : listener(...args)));
`;

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** { usable, reason }: whether the real background/soundcloud.js exists and exports the contract API. */
async function realSoundCloudModule() {
  const file = path.join(EXT_DIR, 'background', 'soundcloud.js');
  if (!fs.existsSync(file)) return { usable: false, reason: 'extension/background/soundcloud.js does not exist yet' };
  try {
    const mod = await import(pathToFileURL(file).href);
    const missing = ['createSoundCloudClient', 'expand', 'listLibrary', 'getStatus'].filter((name) => typeof mod[name] !== 'function');
    if (missing.length) return { usable: false, reason: `background/soundcloud.js does not export ${missing.join(', ')} yet` };
    return { usable: true, reason: null };
  } catch (err) {
    return { usable: false, reason: `background/soundcloud.js does not load: ${err.message}` };
  }
}

/** Sends a runtime message from an extension page and returns the response. */
function message(page, msg) {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

async function screenshot(page, name) {
  await page.locator('body').screenshot({ path: path.join(ARTIFACTS, name) });
}

/** Stops the extension's service worker the way chrome://serviceworker-internals' "Stop" button does. */
async function stopServiceWorker(context, extensionId) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://serviceworker-internals/');
    await page.waitForFunction((id) => document.body.innerText.includes(`Scope: chrome-extension://${id}/`), extensionId);
    // The test profile has no other service workers (the fake pages register none).
    const stop = page.locator('cr-button[data-command="stop"]');
    assert.equal(await stop.count(), 1);
    await stop.click();
    await page.waitForFunction(() => /Running Status: STOPPED/.test(document.body.innerText), null, { timeout: 15000 });
  } finally {
    await page.close();
  }
}

async function openPopup(context, extensionId) {
  const popup = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await popup.waitForSelector('#sc-status[class*="status--"]:not(.status--loading)', { timeout: 30000 });
  return popup;
}

// ---------------------------------------------------------------------------------------------------------------
// Part 1: the real extension

describe('background + popup in the real extension', () => {
  let browser;
  let variant = null;
  let scModule;

  before(async () => {
    scModule = await realSoundCloudModule();
    if (!scModule.usable) variant = buildExtensionVariant({ 'background/soundcloud.js': STUB_SOUNDCLOUD });
    browser = await launch({ extensionDir: variant ? variant.dir : EXT_DIR });
  });

  after(async () => {
    if (browser) await browser.close();
    if (variant) variant.cleanup();
  });

  test('popup: empty room list, logged-out SoundCloud status, default settings', { timeout: 60000 }, async () => {
    const popup = await openPopup(browser.context, browser.extensionId);
    await popup.waitForSelector('#rooms-empty:not([hidden])');
    assert.match(await popup.locator('#rooms-empty').innerText(), /Open a w2g\.tv room to start/);
    assert.match(await popup.locator('#rooms-empty').innerText(), /not in private windows/, 'the manifest says "incognito": "not_allowed"');
    assert.equal(await popup.locator('#rooms').isHidden(), true);

    await popup.waitForSelector('#sc-status.status--out');
    const status = await popup.locator('#sc-status').innerText();
    assert.match(status, /Not logged in/);
    assert.match(status, /Weekly Wave/);
    assert.equal(await popup.locator('#sc-status button').innerText(), 'Open SoundCloud');

    assert.equal(await popup.locator('#skip-previews').isChecked(), true);
    assert.equal(await popup.locator('#confirm-above').inputValue(), '100');
    assert.equal(await popup.evaluate(() => document.body.getBoundingClientRect().width), 340);
    await screenshot(popup, 'popup-empty.png');
    await popup.close();
  });

  test('popup: settings persist across reopening', { timeout: 60000 }, async () => {
    let popup = await openPopup(browser.context, browser.extensionId);
    await popup.waitForFunction(() => document.getElementById('confirm-above').value === '100');
    await popup.locator('#skip-previews').uncheck();
    await popup.locator('#confirm-above').fill('250');
    await popup.locator('#confirm-above').press('Tab');
    await waitFor(async () => {
      const { settings } = await message(popup, { type: 'settings:get' });
      return settings.skipPreviews === false && settings.confirmAbove === 250;
    }, { timeout: 10000, message: 'settings saved' });
    await popup.close();

    popup = await openPopup(browser.context, browser.extensionId);
    await popup.waitForFunction(() => document.getElementById('confirm-above').value === '250');
    assert.equal(await popup.locator('#skip-previews').isChecked(), false);
    await screenshot(popup, 'popup-settings-changed.png');

    // Out-of-range input is clamped by the background and shown normalized.
    await popup.locator('#confirm-above').fill('99999');
    await popup.locator('#confirm-above').press('Tab');
    await popup.waitForFunction(() => document.getElementById('confirm-above').value === '10000');
    assert.deepEqual((await message(popup, { type: 'settings:get' })).settings, { skipPreviews: false, confirmAbove: 10000 });

    await message(popup, { type: 'settings:set', patch: { skipPreviews: true, confirmAbove: 100 } });
    await popup.close();
  });

  test('sc:status through the service worker reports logged out', { timeout: 60000 }, async () => {
    const popup = await openPopup(browser.context, browser.extensionId);
    assert.deepEqual(await message(popup, { type: 'sc:status' }), { ok: true, loggedIn: false });
    assert.deepEqual(await message(popup, { type: 'rooms:get' }), { ok: true, rooms: [], target: null, pinnedTabId: null });
    await popup.close();
  });

  test('sc:expand of a public set through the real background and soundcloud.js', { timeout: 150000 }, async (t) => {
    if (!scModule.usable) {
      t.skip(`skipped: ${scModule.reason}`);
      return;
    }
    const popup = await openPopup(browser.context, browser.extensionId);
    // This host's network drops requests now and then (net::ERR_NETWORK_CHANGED); retry transient failures.
    const res = await retry(async () => {
      const r = await message(popup, { type: 'sc:expand', url: SC.set });
      if (!r || (!r.ok && ['NETWORK', 'RATE_LIMITED', 'SC_HTTP', 'BOT_CHALLENGE'].includes(r.error.code))) {
        throw new Error(r ? `${r.error.code}: ${r.error.message}` : 'no response');
      }
      return r;
    }, { tries: 4, delay: 4000, label: 'sc:expand' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const { source, total, items, skipped, warnings } = res.result;
    assert.equal(source.kind, 'playlist');
    assert.match(source.title, /soulhack/i);
    assert.equal(total, 11);
    assert.equal(items.length + skipped.length, 11);
    assert.ok(items.length >= 1);
    assert.ok(Array.isArray(warnings));
    for (const item of items) {
      assert.match(item.url, /^https:\/\/soundcloud\.com\/forss\/[^/?#]+$/);
      assert.ok(item.title && item.title.trim(), 'non-empty title');
      if (item.thumb !== undefined) assert.match(item.thumb, /^https:\/\//);
    }

    // The second request is answered from the 2-minute cache.
    const t0 = Date.now();
    const again = await message(popup, { type: 'sc:expand', url: SC.set });
    assert.deepEqual(again, res);
    assert.ok(Date.now() - t0 < 1000, 'cached');
    await popup.close();
  });

  test('queue into a real w2g room through the real room content script', { timeout: 240000 }, async (t) => {
    const roomScript = fs.readFileSync(path.join(EXT_DIR, 'content', 'w2g-room.js'), 'utf8');
    if (!scModule.usable || !roomScript.includes('room:ping')) {
      t.skip(`skipped: ${scModule.usable ? 'content/w2g-room.js does not handle room:ping yet' : scModule.reason}`);
      return;
    }
    const { page, streamkey } = await createRoom(browser.context);
    const popup = await openPopup(browser.context, browser.extensionId);
    const registered = await waitFor(async () => {
      const r = await message(popup, { type: 'rooms:get' });
      return r.target && r.target.streamkey === streamkey && r.target.joined && r;
    }, { timeout: 45000, message: 'the room tab registered as joined' });
    assert.equal(registered.rooms.length, 1);
    await popup.reload();
    await popup.waitForSelector('#rooms .room--single');
    assert.match(await popup.locator('#rooms').innerText(), new RegExp(`Joined[\\s\\S]*${streamkey}`));
    await screenshot(popup, 'popup-real-room.png');

    const res = await retry(async () => {
      const r = await message(popup, { type: 'queue', jobId: 'e2e-real', source: { url: SC.set, kind: 'playlist' } });
      if (!r.ok && ['NETWORK', 'RATE_LIMITED', 'SC_HTTP'].includes(r.error.code)) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r;
    }, { tries: 3, delay: 4000, label: 'queue' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.room.streamkey, streamkey);
    assert.ok(res.added >= 1);
    const items = await waitForRoomItems(page, streamkey, res.added);
    assert.ok(items.every((item) => item.url.startsWith('https://soundcloud.com/forss/') && item.title));
    await popup.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Part 2: real background, stub content scripts on fake pages

const FAKE_SC_PAGE = 'https://soundcloud.com/scw2g-e2e-page';
const FAKE_SC_FRAME = 'https://soundcloud.com/scw2g-e2e-frame';
const FAKE_SC_MIXED = 'https://soundcloud.com/scw2g-e2e-mixed';
const OTHER_SITE = 'https://example.com/scw2g-e2e'; // outside the host permissions: Chrome hides its URL from us
const fakeRoomUrl = (streamkey, { joined = true, name, flags = '' }) => `https://w2g.tv/en/room/?room_id=${streamkey}&joined=${joined ? 1 : 0}&name=${encodeURIComponent(name)}${flags}`;
// After joining, a real room's URL holds only ?access_key=; reloaded, it waits at the join dialog.
const FAKE_JOIN_DIALOG_URL = 'https://w2g.tv/en/room/?access_key=e2ejoindialog&joined=0';

const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>e2e</title></head><body>${body}</body></html>` });

async function serveFakePages(context) {
  await context.route(/^https:\/\/soundcloud\.com\/(scw2g-e2e-page|scw2g-e2e-frame|scw2g-e2e-mixed)?(\?.*)?$/, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/scw2g-e2e-page') return route.fulfill(html(`<h1>Fake SoundCloud</h1><iframe src="${FAKE_SC_FRAME}" width="400" height="120"></iframe>`));
    if (pathname === '/scw2g-e2e-mixed') {
      return route.fulfill(html(`<iframe src="${FAKE_SC_FRAME}"></iframe><iframe src="about:blank"></iframe><iframe src="${fakeRoomUrl('e2einnerframe', { name: 'Inner' })}"></iframe>`));
    }
    if (pathname === '/scw2g-e2e-frame') return route.fulfill(html('<p>Fake Webi frame</p>'));
    return route.fulfill(html('<p>Fake SoundCloud home</p>'));
  });
  await context.route(/^https:\/\/w2g\.tv\/en\/room\/\?(room_id|access_key)=e2e/, (route) => route.fulfill(html('<p>Fake w2g room</p>')));
  await context.route(/^https:\/\/example\.com\//, (route) => route.fulfill(html('<p>Another site</p>')));
}

describe('background with stub content scripts', () => {
  let browser;
  let variant;
  let popup;
  let scPage;
  let topFrame;
  let iframe;
  const rooms = {};

  const frameLog = async (frame) => JSON.parse((await frame.evaluate(() => document.documentElement.dataset.scw2gLog)) || '[]');
  const lastRoomsChanged = async (frame) => (await frameLog(frame)).filter((m) => m.type === 'rooms:changed').at(-1);

  /** Queues from the iframe and waits for the QueueResult. */
  async function queueFromFrame(frame, request) {
    await frame.evaluate((r) => {
      const results = JSON.parse(document.documentElement.dataset.scw2gResults || '{}');
      delete results[r.jobId];
      document.documentElement.dataset.scw2gResults = JSON.stringify(results);
      document.dispatchEvent(new CustomEvent('scw2g-e2e-queue', { detail: JSON.stringify(r) }));
    }, request);
    return waitFor(() => frame.evaluate((id) => JSON.parse(document.documentElement.dataset.scw2gResults || '{}')[id], request.jobId),
      { timeout: 30000, message: `QueueResult for ${request.jobId}` });
  }

  async function openFakeRoom(key, streamkey, options) {
    const page = await browser.context.newPage();
    await page.goto(fakeRoomUrl(streamkey, options));
    rooms[key] = page;
    return page;
  }

  const roomAdded = async (page) => JSON.parse((await page.evaluate(() => document.documentElement.dataset.scw2gAdded)) || '[]');
  const popupOptions = async () => popup.locator('#rooms .room').count();

  before(async () => {
    variant = buildExtensionVariant({
      'background/main.js': MAIN_WITH_HOOKS,
      'background/e2e-hooks.js': E2E_HOOKS,
      'background/main-real.js': fs.readFileSync(path.join(EXT_DIR, 'background', 'main.js'), 'utf8'),
      'background/soundcloud.js': STUB_SOUNDCLOUD,
      'content/w2g-room.js': STUB_ROOM,
      'content/soundcloud.js': STUB_SOUNDCLOUD_CONTENT,
    });
    browser = await launch({ extensionDir: variant.dir });
    await serveFakePages(browser.context);

    scPage = await browser.context.newPage();
    await scPage.goto(FAKE_SC_PAGE);
    topFrame = scPage.mainFrame();
    iframe = await waitFor(() => scPage.frame({ url: FAKE_SC_FRAME }), { message: 'fake Webi iframe' });
    for (const frame of [topFrame, iframe]) {
      await waitFor(() => frame.evaluate(() => document.documentElement.dataset.scw2gReady === '1'), { message: 'stub content script' });
    }
    popup = await openPopup(browser.context, browser.extensionId);
  });

  after(async () => {
    if (browser) await browser.close();
    if (variant) variant.cleanup();
  });

  test('registry: opening rooms updates the popup live and broadcasts rooms:changed to every frame', { timeout: 60000 }, async () => {
    await popup.waitForSelector('#rooms-empty:not([hidden])');

    await openFakeRoom('a', 'e2eroomaaaa', { name: 'E2E Room A' });
    await waitFor(async () => (await popupOptions()) === 1, { message: 'popup lists room A' });
    assert.equal(await popup.locator('#rooms input').count(), 0, 'nothing to choose with one room');
    assert.match(await popup.locator('#rooms .room').innerText(), /E2E Room A\s+Joined\s+w2g\.tv · e2eroomaaaa/);
    await screenshot(popup, 'popup-one-room.png');
    for (const frame of [topFrame, iframe]) {
      const msg = await waitFor(async () => {
        const last = await lastRoomsChanged(frame);
        return last && last.rooms.length === 1 && last;
      }, { message: 'rooms:changed in ' + frame.url() });
      assert.equal(msg.rooms[0].streamkey, 'e2eroomaaaa');
      assert.equal(msg.rooms[0].roomName, 'E2E Room A');
      assert.equal(msg.rooms[0].joined, true);
      assert.equal(msg.target.tabId, msg.rooms[0].tabId);
    }

    await openFakeRoom('b', 'e2eroombbbb', { joined: false, name: 'E2E Room B' });
    await waitFor(async () => (await popupOptions()) === 3, { message: 'popup lists room B' });
    const last = await waitFor(async () => {
      const m = await lastRoomsChanged(iframe);
      return m && m.rooms.length === 2 && m;
    }, { message: 'rooms:changed with two rooms' });
    assert.equal(last.target.roomName, 'E2E Room A', 'the joined room stays the target');

    const names = await popup.locator('#rooms .room__name').allInnerTexts();
    assert.deepEqual(names, ['Most recently used room', 'E2E Room B', 'E2E Room A']);
    assert.deepEqual(await popup.locator('#rooms .badge').allInnerTexts(), ['Not joined', 'Joined']);
    assert.match(await popup.locator('#rooms .room').first().innerText(), /Now: E2E Room A/);
    assert.equal(await popup.locator('#rooms input[value=""]').isChecked(), true);

    const stored = await popup.evaluate(() => chrome.storage.session.get('rooms'));
    assert.equal(Object.keys(stored.rooms).length, 2);
    await screenshot(popup, 'popup-rooms.png');
  });

  test('queue from a soundcloud.com iframe: progress goes to that frame, items to the target room', { timeout: 60000 }, async () => {
    const res = await queueFromFrame(iframe, { jobId: 'e2e-1', source: { url: 'https://soundcloud.com/forss/sets/soulhack', kind: 'playlist' } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.jobId, 'e2e-1');
    assert.equal(res.added, 3);
    assert.equal(res.title, 'Stub soulhack');
    assert.equal(res.room.roomName, 'E2E Room A');
    assert.deepEqual(res.skipped, []);

    const progress = (await frameLog(iframe)).filter((m) => m.type === 'job:progress' && m.jobId === 'e2e-1');
    assert.deepEqual(progress.map((m) => [m.phase, m.done, m.total]), [['resolving', undefined, undefined], ['adding', 0, 3], ['adding', 3, 3]]);
    assert.equal((await frameLog(topFrame)).filter((m) => m.type === 'job:progress').length, 0, 'the top frame did not queue anything');

    const added = await roomAdded(rooms.a);
    assert.deepEqual(added[0], { url: 'https://soundcloud.com/e2e/soulhack-1', title: 'E2E - soulhack 1', thumb: 'https://i1.sndcdn.com/artworks-e2e-t500x500.jpg' });
    assert.equal(added.length, 3);
    assert.deepEqual(await roomAdded(rooms.b), []);
  });

  test('queue: needsConfirm above confirmAbove, then the confirmed re-send adds everything', { timeout: 60000 }, async () => {
    const source = { url: 'https://soundcloud.com/e2e/sets/big', kind: 'playlist' };
    const first = await queueFromFrame(topFrame, { jobId: 'e2e-big', source });
    assert.deepEqual(first, { ok: true, jobId: 'e2e-big', needsConfirm: true, count: 120, title: 'Stub big', skippedCount: 0 });
    assert.equal((await roomAdded(rooms.a)).length, 3);

    const second = await queueFromFrame(topFrame, { jobId: 'e2e-big', source, confirmed: true });
    assert.equal(second.added, 120);
    assert.equal((await roomAdded(rooms.a)).length, 123);
    const done = (await frameLog(topFrame)).filter((m) => m.type === 'job:progress' && m.jobId === 'e2e-big' && m.phase === 'adding').map((m) => m.done);
    assert.deepEqual(done, [0, 50, 100, 120]);
  });

  test('popup pin: a not-joined room gives NOT_JOINED, the automatic choice works again', { timeout: 60000 }, async () => {
    await popup.locator('#rooms .room', { hasText: 'E2E Room B' }).locator('input').check();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).pinnedTabId !== null, { message: 'pinned' });
    await waitFor(async () => (await lastRoomsChanged(iframe)).target.roomName === 'E2E Room B', { message: 'broadcast of the new target' });
    await popup.waitForFunction(() => document.querySelector('#rooms .room:nth-child(2) input').checked);
    await screenshot(popup, 'popup-rooms-pinned.png');

    const pinned = await queueFromFrame(iframe, { jobId: 'e2e-pinned', source: { url: SC.track, kind: 'track' } });
    assert.equal(pinned.ok, false);
    assert.equal(pinned.error.code, 'NOT_JOINED');

    await popup.locator('#rooms input[value=""]').check();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).pinnedTabId === null, { message: 'unpinned' });
    const auto = await queueFromFrame(iframe, { jobId: 'e2e-auto', source: { url: SC.track, kind: 'track' } });
    assert.equal(auto.ok, true, JSON.stringify(auto));
    assert.equal(auto.room.roomName, 'E2E Room A');

    const failed = await queueFromFrame(iframe, { jobId: 'e2e-login', source: { url: 'https://soundcloud.com/e2e/sets/needs-login', kind: 'playlist' } });
    assert.deepEqual(failed, { ok: false, jobId: 'e2e-login', error: { code: 'AUTH_REQUIRED', message: 'Log in on soundcloud.com in this browser.' } });

    // EMPTY says what was skipped, so the toast can name Go+ (background/bg-2, integration/bg-7).
    const empty = await queueFromFrame(iframe, { jobId: 'e2e-empty', source: { url: 'https://soundcloud.com/e2e/sets/all-skipped', kind: 'playlist' } });
    assert.deepEqual(empty, {
      ok: false,
      jobId: 'e2e-empty',
      error: {
        code: 'EMPTY',
        message: 'Nothing playable to add: every track was skipped.',
        skipped: [{ title: 'E2E - Go+ only', reason: 'preview_only' }, { title: null, reason: 'geo_blocked' }],
        total: 2,
      },
    });
  });

  test('closing room tabs removes them, broadcasts, and leaves NO_ROOM', { timeout: 60000 }, async () => {
    await rooms.a.close();
    await waitFor(async () => {
      const last = await lastRoomsChanged(iframe);
      return last.rooms.length === 1 && last.rooms[0].roomName === 'E2E Room B';
    }, { message: 'rooms:changed without room A' });
    await waitFor(async () => (await popupOptions()) === 1, { message: 'popup without room A' });
    const notJoined = await queueFromFrame(iframe, { jobId: 'e2e-only-b', source: { url: SC.track, kind: 'track' } });
    assert.equal(notJoined.error.code, 'NOT_JOINED');

    await rooms.b.close();
    await waitFor(async () => {
      const last = await lastRoomsChanged(topFrame);
      return last.rooms.length === 0 && last.target === null;
    }, { message: 'rooms:changed with no rooms' });
    await popup.waitForSelector('#rooms-empty:not([hidden])');

    const res = await queueFromFrame(iframe, { jobId: 'e2e-none', source: { url: SC.track, kind: 'track' } });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NO_ROOM');
  });

  test('a room waiting at w2g\'s join dialog gives NOT_JOINED, not NO_ROOM (integration/bg-4)', { timeout: 60000 }, async () => {
    const page = await browser.context.newPage();
    await page.goto(FAKE_JOIN_DIALOG_URL);
    const registered = await waitFor(async () => {
      const r = await message(popup, { type: 'rooms:get' });
      return r.rooms.length === 1 && r;
    }, { message: 'the room at the join dialog registered' });
    assert.deepEqual([registered.rooms[0].streamkey, registered.rooms[0].joined, registered.target], [null, false, null]);
    const res = await queueFromFrame(iframe, { jobId: 'e2e-join-dialog', source: { url: SC.track, kind: 'track' } });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOT_JOINED');
    await page.close();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 0, { message: 'room removed' });
  });

  test('the most recently used room is asked first, even when it announced "not joined" (integration/bg-1)', { timeout: 60000 }, async () => {
    const older = await openFakeRoom('e', 'e2eroomeeee', { name: 'E2E Room E' });
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 1, { message: 'room E registered' });
    // Room F's hello says not joined (a stale flag); its room:ping finds it joined.
    const recent = await openFakeRoom('f', 'e2eroomffff', { joined: false, name: 'E2E Room F', flags: '&pingjoined=1' });
    const before = await waitFor(async () => {
      const r = await message(popup, { type: 'rooms:get' });
      return r.rooms.length === 2 && r;
    }, { message: 'room F registered' });
    assert.deepEqual(before.rooms.map((r) => [r.streamkey, r.joined]), [['e2eroomffff', false], ['e2eroomeeee', true]]);
    assert.equal(before.target.streamkey, 'e2eroomeeee', 'the registry alone would pick room E');

    const res = await queueFromFrame(iframe, { jobId: 'e2e-recent', source: { url: SC.track, kind: 'track' } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.room.streamkey, 'e2eroomffff');
    assert.equal(res.room.joined, true);
    assert.equal((await roomAdded(recent)).length, 3);
    assert.deepEqual(await roomAdded(older), []);

    await older.close();
    await recent.close();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 0, { message: 'rooms E and F removed' });
  });

  test('a room tab that navigates to another site is dropped: by its room:bye, by tabs.onUpdated, or at the next queue (background/bg-1)', { timeout: 90000 }, async () => {
    const worker = await browser.getServiceWorker();
    const ignoreTabUpdates = (on) => worker.evaluate((value) => { globalThis.scw2gIgnoreTabUpdates = value; }, on);
    const streamkeys = async () => (await message(popup, { type: 'rooms:get' })).rooms.map((r) => r.streamkey);
    const pages = [];
    async function openAndLeave(streamkey, flags = '') {
      const page = await browser.context.newPage();
      pages.push(page);
      await page.goto(fakeRoomUrl(streamkey, { name: streamkey, flags }));
      await waitFor(async () => (await streamkeys()).includes(streamkey), { message: `${streamkey} registered` });
      await page.goto(OTHER_SITE);
    }
    const dropped = (streamkey) => waitFor(async () => !(await streamkeys()).includes(streamkey), { timeout: 10000, message: `${streamkey} dropped` });

    try {
      // As in real use: both the room page's pagehide room:bye and tabs.onUpdated report it.
      await openAndLeave('e2eleaveboth');
      await dropped('e2eleaveboth');
      await waitFor(async () => (await lastRoomsChanged(iframe)).rooms.length === 0, { message: 'rooms:changed without it' });
      await popup.waitForSelector('#rooms-empty:not([hidden])');

      // Only room:bye. Chrome sends it from the page being replaced: frameId != 0, documentLifecycle 'pending_deletion'.
      await ignoreTabUpdates(true);
      await openAndLeave('e2eleavebye');
      await dropped('e2eleavebye');

      // Only tabs.onUpdated: its 'loading' event has no URL for a site outside the host permissions.
      await ignoreTabUpdates(false);
      await openAndLeave('e2eleaveupdate', '&nobye=1');
      await dropped('e2eleaveupdate');

      // Neither reached the worker: the next queue sees that the tab shows another site, drops the entry and adds
      // to the room that is still open, instead of failing with "reload the room tab".
      const live = await openFakeRoom('live', 'e2eroomlive', { name: 'E2E Live Room' });
      pages.push(live);
      await waitFor(async () => (await streamkeys()).includes('e2eroomlive'), { message: 'live room registered' });
      await ignoreTabUpdates(true);
      await openAndLeave('e2eleaveghost', '&nobye=1');
      await sleep(1000);
      assert.deepEqual(await streamkeys(), ['e2eleaveghost', 'e2eroomlive'], 'the stale entry is still there');
      const res = await queueFromFrame(iframe, { jobId: 'e2e-ghost', source: { url: SC.track, kind: 'track' } });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.room.streamkey, 'e2eroomlive');
      assert.equal((await roomAdded(live)).length, 3);
      assert.deepEqual(await streamkeys(), ['e2eroomlive']);
    } finally {
      await ignoreTabUpdates(false);
      for (const page of pages) await page.close();
    }
    await waitFor(async () => (await streamkeys()).length === 0, { message: 'all rooms removed' });
  });

  test('a restarted service worker still knows the room and reaches its tab', { timeout: 60000 }, async () => {
    await openFakeRoom('c', 'e2eroomcccc', { name: 'E2E Room C' });
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 1, { message: 'room C registered' });
    const worker = await browser.getServiceWorker();
    await worker.evaluate(() => { globalThis.e2eBootMarker = true; });

    await stopServiceWorker(browser.context, browser.extensionId);
    const res = await message(popup, { type: 'rooms:get' }); // starts a fresh worker
    assert.equal(res.rooms.length, 1);
    assert.equal(res.target.roomName, 'E2E Room C');
    const fresh = await browser.getServiceWorker();
    assert.equal(await fresh.evaluate(() => globalThis.e2eBootMarker === true), false, 'the worker really restarted');

    const queued = await queueFromFrame(iframe, { jobId: 'e2e-restart', source: { url: SC.track, kind: 'track' } });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    assert.equal(queued.room.roomName, 'E2E Room C');
    assert.equal((await roomAdded(rooms.c)).length, 3);

    await rooms.c.close();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 0, { message: 'room C removed' });
  });

  test('sc:status follows the oauth_token cookie (cookies.onChanged drops the cache); room tabs get sc:login-changed', { timeout: 60000 }, async () => {
    const setToken = (value) => browser.context.addCookies([{ name: 'oauth_token', value, domain: 'soundcloud.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' }]);
    const room = await openFakeRoom('login', 'e2eroomlogin', { name: 'E2E Login Room' });
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 1, { message: 'room registered' });
    const loginChanged = () => room.evaluate(() => Number(document.documentElement.dataset.scw2gLoginChanged || 0));
    assert.deepEqual(await message(popup, { type: 'sc:status' }), { ok: true, loggedIn: false });

    await setToken('e2e-token');
    await waitFor(async () => (await message(popup, { type: 'sc:status' })).loggedIn === true, { timeout: 10000, message: 'logged in status' });
    await waitFor(async () => (await loginChanged()) === 1, { timeout: 10000, message: 'sc:login-changed in the room tab' });
    await popup.reload();
    await popup.waitForSelector('#sc-status.status--in');
    assert.match(await popup.locator('#sc-status').innerText(), /Logged in as E2E Listener/);
    await screenshot(popup, 'popup-logged-in.png');

    // Replacing the cookie fires two change events (removed, then set): the room tab hears about it once.
    await setToken('expired-token');
    await waitFor(async () => (await message(popup, { type: 'sc:status' })).expired === true, { timeout: 10000, message: 'expired status' });
    await popup.reload();
    await popup.waitForSelector('#sc-status.status--expired');
    assert.match(await popup.locator('#sc-status').innerText(), /expired/);
    await screenshot(popup, 'popup-expired.png');
    await waitFor(async () => (await loginChanged()) === 2, { timeout: 10000, message: 'second sc:login-changed' });
    await sleep(1500);
    assert.equal(await loginChanged(), 2, 'one message per burst of cookie changes');

    await browser.context.clearCookies({ name: 'oauth_token' });
    await waitFor(async () => {
      const s = await message(popup, { type: 'sc:status' });
      return s.loggedIn === false && !s.expired;
    }, { timeout: 10000, message: 'logged out status' });
    await waitFor(async () => (await loginChanged()) === 3, { timeout: 10000, message: 'sc:login-changed after logout' });
    await room.close();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 0, { message: 'room removed' });
  });

  test('the SoundCloud client gets the datadome cookie of soundcloud.com (sc-client/sc-2)', { timeout: 60000 }, async () => {
    const titleOf = async (slug) => {
      const res = await message(popup, { type: 'sc:expand', url: `https://soundcloud.com/e2e/sets/${slug}` });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.result.source.title;
    };
    assert.equal(await titleOf('datadome-check-1'), 'datadome=null');
    await browser.context.addCookies([{ name: 'datadome', value: 'e2e-dd~value', domain: '.soundcloud.com', path: '/', secure: true, sameSite: 'Lax' }]);
    assert.equal(await titleOf('datadome-check-2'), 'datadome=e2e-dd~value');
    await browser.context.clearCookies({ name: 'datadome' });
    assert.equal(await titleOf('datadome-check-3'), 'datadome=null');
  });

  test('re-injection (the onInstalled/onStartup path) reaches exactly the matching frames of open tabs', { timeout: 60000 }, async () => {
    const mixed = await browser.context.newPage();
    await mixed.goto(FAKE_SC_MIXED);
    const room = await openFakeRoom('d', 'e2eroomdddd', { name: 'E2E Room D' });
    const frameOf = (page, predicate) => waitFor(() => page.frames().find((f) => predicate(f.url())), { message: 'frame' });
    const scFrame = await frameOf(mixed, (u) => u === FAKE_SC_FRAME);
    const blankFrame = await frameOf(mixed, (u) => u === 'about:blank');
    const w2gFrame = await frameOf(mixed, (u) => u.startsWith('https://w2g.tv/'));
    const runs = (frame) => frame.evaluate(() => Number(document.documentElement.dataset.scw2gRuns || 0));
    const targets = { top: mixed.mainFrame(), scFrame, blankFrame, w2gFrame, room: room.mainFrame() };
    const counts = async () => Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([k, f]) => [k, await runs(f)])));
    await waitFor(async () => (await runs(scFrame)) === 1 && (await runs(room.mainFrame())) === 1, { message: 'manifest injection' });
    assert.deepEqual(await counts(), { top: 1, scFrame: 1, blankFrame: 0, w2gFrame: 0, room: 1 });

    const worker = await browser.getServiceWorker();
    const outcomes = await worker.evaluate(() => globalThis.scw2gReinject());
    assert.deepEqual(await counts(), { top: 2, scFrame: 2, blankFrame: 0, w2gFrame: 0, room: 2 });
    assert.ok(outcomes.length >= 3 && outcomes.every((o) => o.injected), JSON.stringify(outcomes));

    await room.close();
    await mixed.close();
    await waitFor(async () => (await message(popup, { type: 'rooms:get' })).rooms.length === 0, { message: 'room D removed' });
  });

  test('popup: "Open SoundCloud" opens soundcloud.com in a new tab', { timeout: 60000 }, async () => {
    await popup.reload();
    await popup.waitForSelector('#sc-status.status--out button');
    const opened = browser.context.waitForEvent('page', { timeout: 15000 });
    await popup.locator('#sc-status button').click();
    const page = await opened;
    await page.waitForURL('https://soundcloud.com/');
    await page.close();
  });
});
