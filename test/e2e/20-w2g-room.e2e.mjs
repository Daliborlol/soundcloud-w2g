// content/w2g-room.js in real Chromium on a real (throwaway) w2g room. The background is a stub
// (test/e2e/stubs/w2g-room-bg.js) that serves canned SoundCloud data built from test/fixtures (real track URLs),
// records what the room tab sends, and can send room:add / room:ping / room:cancel / sc:login-changed to the room
// tab like the real background.
//
// Rooms: one created by browser A (owner); browser B (member) and C (production build) join it.
// Screenshots go to $SCW2G_SHOTS_DIR (default test-results/w2g-room).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, W2G_API, launch, createRoom, openRoom, roomItems, buildExtensionVariant, fixture,
  sleep, waitFor, retry, gotoRetry, dismissW2gConsent,
} from './harness.mjs';

const SHOTS = process.env.SCW2G_SHOTS_DIR || path.join(ROOT, 'test-results', 'w2g-room');
const SET_URL = 'https://soundcloud.com/forss/sets/soulhack';
const TRACK_URL = 'https://soundcloud.com/forss/flickermood';
const WEEKLY_URL = 'https://soundcloud.com/discover/sets/weekly::w2g-test-user';
const DAILY_URL = 'https://soundcloud.com/discover/sets/new-for-you:987654321';
const LIKES_URL = 'https://soundcloud.com/you/likes';
const SEARCH_INPUT = '#w2g-content-search input[type=text]';
const ADD_PATTERN = '**/playlist_items/sync_update';
// The room tab repeats "queued" progress every 60 s; this run shortens it so the repeat can be observed.
const QUEUED_REPORT_TEST_MS = 3000;
const RUN = Date.now().toString(36);
// A canned 60-track list (+ 2 Go+ previews) with made-up track URLs, unique per run.
const RESUME_URL = `https://soundcloud.com/scw2g-e2e/sets/resume-${RUN}`;
const RESUME_TITLE = 'scw2g resume test';
const LINK_OPENED_TEXT = "SoundCloud panel opened for your link. The SoundCloud button next to w2g's search takes you there.";

// ------------------------------------------------------------------------------------------------------------------
// Canned background data (what background/soundcloud.js would produce for these real SoundCloud resources)

function toW2gItem(t) {
  const artist = (t.publisher_metadata && t.publisher_metadata.artist) || t.user.username;
  const title = t.title.includes(' - ') || t.title.toLowerCase().includes(artist.toLowerCase()) ? t.title : `${artist} - ${t.title}`;
  const art = t.artwork_url || t.user.avatar_url;
  const item = { url: t.permalink_url, title };
  if (art) item.thumb = art.replace(/-(large|t\d+x\d+|crop|original)\.(jpg|png)/, '-t500x500.$2');
  return item;
}

// Playlists hydrate only their first tracks; the rest come from /tracks?ids= in arbitrary order.
function hydrate(playlist, ...batches) {
  const byId = new Map();
  for (const batch of batches) for (const t of batch) byId.set(t.id, t);
  return playlist.tracks.map((t) => (t.title ? t : byId.get(t.id))).filter(Boolean);
}

/**
 * Items with made-up track URLs, unique per run, for jobs whose failure path checks the playlist's tail (w2g stores
 * any URL; real ones from earlier tests could already sit at the tail and make a lost batch look landed).
 */
function fakeItems(tag, n) {
  return Array.from({ length: n }, (_, i) => ({ url: `https://soundcloud.com/scw2g-e2e/${tag}-${RUN}-${i + 1}`, title: `${tag} ${i + 1}` }));
}

function buildStubData() {
  const soulhackPl = fixture('sc/resolve-playlist-public-soulhack.json');
  const soulhack = hydrate(soulhackPl, fixture('sc/tracks-ids-soulhack-stubs.json')).map(toW2gItem);
  const clubPl = fixture('sc/playlist-100-tracks.json');
  const club55 = hydrate(clubPl, fixture('sc/tracks-ids-batch1-50.json')).slice(0, 55).map(toW2gItem);
  const station = fixture('sc/resolve-system-playlist-track-station.json');
  const stationTracks = hydrate(station, fixture('sc/tracks-ids-station-hydration.json'));
  const previews = stationTracks.filter((t) => t.policy === 'SNIP');
  const likes = fixture('sc/user-track-likes-p1.json').collection.map((x) => x.track).filter((t) => t && t.title);
  const likedPlaylists = fixture('sc/user-playlist-likes.json').collection.map((x) => x.playlist);
  const ownPlaylist = fixture('sc/user-playlists-without-albums.json').collection[0];
  const track = fixture('sc/resolve-track-public.json');
  const resume = { items: fakeItems('resume', 60), previews: fakeItems('resume-go', 2) };
  const art = (u) => (u ? u.replace('-large.', '-t200x200.') : null);
  const source = (kind, p) => ({ kind, url: p.permalink_url, title: p.title, subtitle: p.user.username, artwork: art(p.artwork_url) });
  const entry = (p) => ({ kind: 'playlist', url: p.permalink_url, title: p.title, subtitle: p.user.username, artwork: art(p.artwork_url), trackCount: p.track_count });

  const expand = {
    [SET_URL]: { result: { source: source('playlist', soulhackPl), total: 11, items: soulhack, skipped: [], warnings: [] } },
    [clubPl.permalink_url]: { result: { source: source('playlist', clubPl), total: 55, items: club55, skipped: [], warnings: [] } },
    [TRACK_URL]: { result: { source: source('track', track), total: 1, items: [toW2gItem(track)], skipped: [], warnings: [] } },
    [WEEKLY_URL]: {
      result: {
        source: { kind: 'system-playlist', url: WEEKLY_URL, title: 'Weekly Wave', subtitle: 'Made for w2g test user', artwork: station.calculated_artwork_url },
        total: stationTracks.length + 2,
        items: stationTracks.filter((t) => t.policy !== 'SNIP').map(toW2gItem),
        skipped: [{ title: 'Blocked One', reason: 'geo_blocked' }, { title: 'Blocked Two', reason: 'geo_blocked' }]
          .concat(previews.map((t) => ({ title: t.title, reason: 'preview_only' }))),
        warnings: [],
      },
      previews: previews.map(toW2gItem),
    },
    // Only once the login is fresh (stub.loginExpired false); until then DATA.errors answers AUTH_EXPIRED.
    [DAILY_URL]: {
      result: {
        source: { kind: 'system-playlist', url: DAILY_URL, title: 'Daily Drops', subtitle: 'Made for w2g test user', artwork: null },
        total: 3, items: soulhack.slice(0, 3), skipped: [], warnings: [],
      },
    },
    [LIKES_URL]: {
      result: {
        source: { kind: 'user-likes', url: LIKES_URL, title: 'Liked tracks', subtitle: 'w2g test user', artwork: null },
        total: likes.length, items: likes.map(toW2gItem), skipped: [], warnings: [],
      },
    },
    [RESUME_URL]: {
      result: {
        source: { kind: 'playlist', url: RESUME_URL, title: RESUME_TITLE, subtitle: 'scw2g-e2e', artwork: null },
        total: 62,
        items: resume.items,
        skipped: resume.previews.map((t) => ({ title: t.title, reason: 'preview_only' })),
        warnings: [],
      },
      previews: resume.previews,
    },
  };
  const errors = {
    [DAILY_URL]: { code: 'AUTH_EXPIRED', message: 'stub: token rejected' },
  };
  const library = {
    loggedIn: true,
    user: { id: 987654321, username: 'w2g test user', permalink: 'w2g-test-user', avatar: null },
    sections: [
      {
        id: 'made-for-you', title: 'Made for you', entries: [
          { kind: 'system-playlist', url: WEEKLY_URL, title: 'Weekly Wave', subtitle: 'Made for w2g test user', artwork: station.calculated_artwork_url, trackCount: 30 },
          { kind: 'system-playlist', url: DAILY_URL, title: 'Daily Drops', subtitle: 'Made for w2g test user', artwork: null, trackCount: null },
        ],
      },
      { id: 'own', title: 'Your playlists', entries: [entry(Object.assign({}, soulhackPl, { track_count: 11 })), entry(ownPlaylist)] },
      { id: 'liked', title: 'Liked playlists', entries: likedPlaylists.map(entry) },
      { id: 'likes', title: 'Liked tracks', entries: [{ kind: 'likes', url: LIKES_URL, title: 'Liked tracks', subtitle: null, artwork: null, trackCount: null }] },
    ],
  };
  return { stub: { expand, errors, library }, soulhack, club55, clubUrl: clubPl.permalink_url, likedCount: likedPlaylists.length, resume };
}

function buildVariant(stubData, { openShadow }) {
  let content = fs.readFileSync(path.join(ROOT, 'extension/content/w2g-room.js'), 'utf8');
  const patch = (from, to, what) => {
    const next = content.replace(from, to);
    assert.notEqual(next, content, `${what} not found in w2g-room.js`);
    content = next;
  };
  // Playwright can't reach into closed shadow roots; everything else stays the production code.
  if (openShadow) patch("const SHADOW_MODE = 'closed';", "const SHADOW_MODE = 'open';", 'SHADOW_MODE constant');
  patch('const QUEUED_REPORT_MS = 60 * 1000;', `const QUEUED_REPORT_MS = ${QUEUED_REPORT_TEST_MS};`, 'QUEUED_REPORT_MS constant');
  return buildExtensionVariant({
    'background/main.js': fs.readFileSync(path.join(ROOT, 'test/e2e/stubs/w2g-room-bg.js'), 'utf8'),
    'background/stub-data.js': `export const DATA = ${JSON.stringify(stubData)};\n`,
    'content/w2g-room.js': content,
  });
}

// ------------------------------------------------------------------------------------------------------------------
// Helpers

/** Number of items in a POST to w2g's playlist API, or 0 for other writes there (w2g itself posts active_item etc.). */
function addedInPost(request) {
  if (request.method() !== 'POST' || !/\/playlist_items\/sync_update$/.test(request.url())) return 0;
  try {
    const body = request.postDataJSON();
    return body && Array.isArray(body.add_items) ? body.add_items.length : 0;
  } catch (_) {
    return 0;
  }
}

/** Runs fn(arg) in the stub service worker (fn sees `self.stub`). */
async function stub(browser, fn, arg) {
  const sw = await browser.getServiceWorker();
  return sw.evaluate(fn, arg);
}

const sendToRoom = (browser, tabId, msg) => stub(browser, ({ tabId, msg }) => self.stub.sendToRoom(tabId, msg), { tabId, msg });
const stubMessages = (browser, type) => stub(browser, (t) => self.stub.messages(t), type);
const stubTypes = (browser) => stub(browser, () => self.stub.log.map((e) => e.msg.type));

async function helloFor(browser, predicate, message) {
  return waitFor(async () => (await stub(browser, () => self.stub.rooms())).find(predicate), { timeout: 45000, message });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch((e) => console.log('screenshot failed:', e.message));
}

/** Closes w2g's modal (e.g. the invite dialog the room creator sees) and the PWA install banner. */
async function settleRoom(page) {
  await waitFor(() => page.evaluate(() => {
    if (document.body.classList.contains('w2g-modal-open')) {
      const dimmer = document.querySelector('#site-dimmer');
      if (dimmer) dimmer.click(); // w2g closes its modal on clicks on the dimmer itself
      return false;
    }
    return true;
  }), { timeout: 15000, message: 'w2g modal closed' });
  const dismiss = page.locator('#w2g-pwa-banner-android .w2g-pwa-dismiss');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});
}

/** fetch() against w2g's API from the page (with its session cookie); resolves to the parsed body. */
async function w2gApi(page, method, apiPath, body) {
  return retry(() => page.evaluate(async ({ url, method, body }) => {
    const res = await fetch(url, {
      method, credentials: 'include', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }, { url: W2G_API + apiPath, method, body }), { label: `${method} ${apiPath}` });
}

/** The room's playlists: { lists: [{ key, title, ... }], selectedPlaylist }. */
async function playlistsOf(page, streamkey) {
  const body = await w2gApi(page, 'GET', `/rooms/${streamkey}/sync_state`);
  for (const [name, value] of body.state) if (name === 'playlists') return value.payload;
  throw new Error('no playlists in sync_state');
}

const selectedPlaylist = async (page, streamkey) => (await playlistsOf(page, streamkey)).selectedPlaylist;
const itemsOf = async (page, streamkey, key) => (await w2gApi(page, 'GET', `/streams/${streamkey}/playlists/${key}/playlist_items`)) || [];

/** Selects a playlist for the whole room, like w2g's playlist dropdown does. */
async function selectPlaylist(page, streamkey, key) {
  await w2gApi(page, 'POST', `/rooms/${streamkey}/playlists/sync_update`, { active_list: key });
  await waitFor(async () => (await selectedPlaylist(page, streamkey)) === key, { timeout: 15000, message: `playlist ${key} selected` });
}

async function setModeration(page, streamkey, on) {
  await w2gApi(page, 'POST', `/rooms/${streamkey}/sync_update`, { moderated_playlist: on });
}

/**
 * Pastes text into an input with a real clipboard paste (Ctrl+V). The content script ignores synthetic events, so
 * there is no fallback: the test fails if the browser refuses the clipboard.
 */
async function paste(page, selector, text) {
  await page.click(selector);
  const copied = await page.evaluate((t) => navigator.clipboard.writeText(t).then(() => true, (e) => String(e)), text);
  assert.equal(copied, true, 'clipboard write');
  await page.keyboard.press('ControlOrMeta+V');
}

function panel(page) {
  const root = page.locator('scw2g-panel');
  return {
    root: root.locator('.panel'),
    input: root.locator('input.url'),
    preview: root.locator('.preview'),
    title: root.locator('.preview .title'),
    stats: root.locator('.preview .stats'),
    notes: root.locator('.preview .note'),
    add: root.locator('.preview .add'),
    again: root.locator('.preview .again'),
    cancel: root.locator('.preview .progress .link'),
    progressLabel: root.locator('.preview .progress-line span'),
    result: root.locator('.preview .result'),
    error: root.locator('.preview .error'),
    banner: root.locator('.banner'),
    jobRows: (text) => root.locator('.jobs .job', { hasText: text }),
    skip: root.locator('.option input[type=checkbox]'),
    entry: (text) => root.locator('.entry', { hasText: text }),
    sectionTitles: root.locator('.section-title'),
    library: root.locator('.library-body'),
    showLibrary: root.locator('.library-body .login button', { hasText: 'Show my SoundCloud' }),
    refresh: root.locator('.lib-head button'),
  };
}

const isOpen = (page) => page.locator('scw2g-panel .panel').isVisible().catch(() => false);
const textOf = (locator) => locator.textContent().catch(() => '');
/** What the launcher's (visually hidden) status line says to screen readers. */
const launcherStatus = (page) => textOf(page.locator('scw2g-launcher [role=status]'));

async function openPanel(page) {
  if (!(await isOpen(page))) await page.locator('scw2g-launcher button').click();
  await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel open' });
}

async function closePanel(page) {
  if (await isOpen(page)) {
    await panel(page).input.focus();
    await page.keyboard.press('Escape');
  }
  await waitFor(async () => !(await isOpen(page)), { timeout: 5000, message: 'panel closed' });
}

async function loadInPanel(page, url) {
  const p = panel(page);
  await openPanel(page);
  await p.input.fill(url);
  await p.input.press('Enter');
  await p.title.waitFor({ timeout: 20000 });
  await waitFor(async () => (await textOf(p.title)) && !(await p.preview.getAttribute('aria-busy')), { timeout: 20000, message: 'preview loaded' });
}

/** Where the keyboard focus is: in w2g's search box, and/or on an element inside the panel (its class). */
function focusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const host = document.querySelector('scw2g-panel');
    const inner = host && host.shadowRoot ? host.shadowRoot.activeElement : null;
    return { inSearchBox: Boolean(el && el.closest && el.closest('#w2g-content-search')), inPanel: inner ? inner.className : null };
  });
}

async function closeW2gSearch(page) {
  await page.locator('#w2g-content-pane-container button[data-event*="closePane"]').click({ timeout: 3000 }).catch(() => {});
  await page.fill(SEARCH_INPUT, '');
}

async function launcherAfterSearch(page) {
  return page.evaluate(() => {
    const host = document.querySelector('scw2g-launcher');
    return Boolean(host && host.previousElementSibling && host.previousElementSibling.id === 'w2g-content-search' && host.getClientRects().length);
  });
}

/** Room items match the sent items: same order, url and title, and the thumb wherever one was sent. */
function assertItems(actual, expected, label = 'room items') {
  const view = (items, withThumb) => items.map((it, i) => [it.url, it.title, withThumb(i) ? it.thumb : null]);
  const hasThumb = (i) => Boolean(expected[i] && expected[i].thumb);
  assert.deepEqual(view(actual, hasThumb), view(expected, hasThumb), label);
}

/** Holds the first add POST: never answered (or, with `land`, sent on to w2g first). Later POSTs pass. */
async function holdFirstAdd(page, { land = false } = {}) {
  const held = [];
  let posts = 0;
  await page.route(ADD_PATTERN, async (route) => {
    // Only our adds: w2g's own client posts to the same endpoint (e.g. active_item when the playlist advances).
    if (!addedInPost(route.request())) return route.continue();
    if (posts++) return route.continue();
    if (land) await route.fetch().catch(() => null);
    held.push(route);
  });
  return {
    held,
    posts: () => posts,
    async release() {
      await page.unroute(ADD_PATTERN);
      for (const route of held) await route.abort().catch(() => {});
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------

describe('content/w2g-room.js', { timeout: 40 * 60 * 1000 }, () => {
  const data = buildStubData();
  let variant;
  let A;
  let page;
  let sk;
  let tabA;
  let B;
  let pageB;
  let tabB;

  before(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    variant = buildVariant(data.stub, { openShadow: true });
    // CDP may reload the extension in place (Extensions.loadUnpacked), which is how a test simulates an update.
    A = await launch({ extensionDir: variant.dir, args: ['--enable-unsafe-extension-debugging'] });
    await A.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://w2g.tv' });
    ({ page, streamkey: sk } = await createRoom(A.context));
    await settleRoom(page);
  }, { timeout: 240000 });

  after(async () => {
    if (A) await A.close();
    if (B) await B.close();
    if (variant) variant.cleanup();
  });

  test('room:hello reports the streamkey, joined=true and the room name', { timeout: 120000 }, async () => {
    const hello = await helloFor(A, (r) => r.streamkey === sk && r.joined, 'joined room:hello');
    assert.equal(hello.roomName, 'Temporary Room');
    assert.match(hello.url, /^https:\/\/w2g\.tv\/[a-z]{2}\/room\//);
    tabA = hello.tabId;
    assert.ok((await stubMessages(A, 'room:hello')).every((m) => m.frameId === 0), 'room messages come from the top frame');

    // After joining, w2g rewrites the URL to ?access_key=, so a reload has to find the streamkey in w2g's traffic.
    await stub(A, () => self.stub.clear());
    assert.match(page.url(), /access_key=/);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await dismissW2gConsent(page, { timeout: 3000 });
    const join = page.locator('#intro-modal #w2g-join-button');
    await waitFor(async () => {
      if (await join.isVisible().catch(() => false)) await join.click().catch(() => {});
      const rooms = await stub(A, () => self.stub.rooms());
      return rooms.some((r) => r.tabId === tabA && r.joined);
    }, { timeout: 60000, message: 'joined room:hello after reload' });
    const [again] = (await stub(A, () => self.stub.rooms())).filter((r) => r.tabId === tabA);
    assert.equal(again.streamkey, sk);
    assert.match(again.url, /access_key=/);
    assert.ok((await stubMessages(A, 'room:bye')).some((m) => m.tabId === tabA), 'room:bye on pagehide');
    await page.locator('.w2g-playlists select option[value]:not([value=""])').first().waitFor({ state: 'attached', timeout: 30000 });
    await settleRoom(page);
  });

  test('room:active follows a room:hello when the tab really gets focus; faked events are ignored', { timeout: 90000 }, async () => {
    // Playwright emulates focus for every page; switch that off for the room page so a tab switch really blurs and
    // focuses it.
    const cdp = await A.context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    // A stand-in room page for the faked events: w2g's own page reloads itself on a pageshow with persisted:true.
    const fake = await A.context.newPage();
    try {
      await fake.route('https://w2g.tv/**', (route) => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!doctype html><body class="w2g-desktop"><div id="w2g-content-search"><input type="text"></div></body>',
      }));
      await fake.route(`${W2G_API}/**`, (route) => route.fulfill({ status: 404, body: '' }));
      await fake.goto('https://w2g.tv/en/room/?room_id=scw2gstandin1');
      await fake.bringToFront(); // the room tab loses the focus
      const standIn = await helloFor(A, (r) => r.streamkey === 'scw2gstandin1', 'room:hello from the stand-in page');
      await sleep(1100); // activations are throttled to one per second
      await stub(A, () => self.stub.clear());
      // A page script could fake these to keep its room "most recently used" (adds meant for another open room would
      // land there) or to unregister the room.
      await fake.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      });
      await sleep(1500);
      const sent = (await stub(A, () => self.stub.log)).filter((e) => e.tabId === standIn.tabId).map((e) => e.msg.type);
      assert.deepEqual(sent, [], 'faked focus, visibilitychange, pageshow and pagehide events send nothing');

      // A real switch back to the room tab.
      await stub(A, () => self.stub.clear());
      await page.bringToFront();
      const log = await waitFor(async () => {
        const types = (await stub(A, () => self.stub.log)).filter((e) => e.tabId === tabA).map((e) => e.msg.type);
        return types.includes('room:active') && types;
      }, { timeout: 5000, message: 'room:active' });
      assert.ok(log.indexOf('room:hello') !== -1 && log.indexOf('room:hello') < log.indexOf('room:active'), log.join());
    } finally {
      await fake.close().catch(() => {});
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  });

  test('room:ping answers with the room state', async () => {
    const { response } = await sendToRoom(A, tabA, { type: 'room:ping' });
    assert.deepEqual(response, { ok: true, streamkey: sk, joined: true, roomName: 'Temporary Room', unreachable: false });
  });

  test('a repeated injection is a no-op; a takeover event from the page is ignored by a live copy', { timeout: 60000 }, async () => {
    const launchers = () => page.evaluate(() => document.querySelectorAll('scw2g-launcher').length);
    await waitFor(async () => (await launchers()) === 1, { timeout: 10000, message: 'one launcher' });
    // The background re-injects the content scripts into open room tabs on install/startup.
    await stub(A, (tabId) => self.stub.inject(tabId), tabA);
    await sleep(500);
    assert.equal(await launchers(), 1, 'second injection into a live tab changes nothing');

    // Any page script can dispatch the event a newer copy uses to retire an orphaned one.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('scw2g:room-takeover')));
    await sleep(1000);
    assert.equal(await launchers(), 1, 'the live copy keeps its launcher');
    const { response } = await sendToRoom(A, tabA, { type: 'room:ping' });
    assert.deepEqual(response, { ok: true, streamkey: sk, joined: true, roomName: 'Temporary Room', unreachable: false });
  });

  test('after an extension update the orphaned copy gives way to the re-injected one', { timeout: 90000 }, async () => {
    const launchers = () => page.evaluate(() => [...document.querySelectorAll('scw2g-launcher')].map((el) => el.dataset.e2e || 'new').join());
    await page.evaluate(() => { document.querySelector('scw2g-launcher').dataset.e2e = 'old'; });
    // Reloading the unpacked extension in place, as an update does, orphans the running content script: its
    // extension context is dead. (chrome.runtime.reload() would unload an extension loaded with --load-extension.)
    const cdp = await A.context.browser().newBrowserCDPSession();
    try {
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: variant.dir });
      assert.equal(id, A.extensionId, 'reloaded in place');
    } finally {
      await cdp.detach().catch(() => {});
    }
    // The real background re-injects on install; the stub does it on request. The new copy announces itself with the
    // takeover event and the orphaned copy, whose context is dead, removes its UI. The URL only has ?access_key= by
    // now, so the new copy has to find the room in the buffered resource timing.
    await waitFor(() => stub(A, () => Boolean(self.stub)).catch(() => false), { timeout: 20000, message: 'new service worker' });
    await stub(A, (tabId) => self.stub.inject(tabId), tabA);
    await waitFor(async () => (await launchers()) === 'new', { timeout: 10000, message: 'only the new copy\'s launcher' });
    await waitFor(() => launcherAfterSearch(page), { timeout: 10000, message: 'launcher after the search box' });
    const { response } = await sendToRoom(A, tabA, { type: 'room:ping' });
    assert.deepEqual(response, { ok: true, streamkey: sk, joined: true, roomName: 'Temporary Room', unreachable: false });
    await helloFor(A, (r) => r.tabId === tabA && r.joined && r.streamkey === sk, 'room:hello from the new copy');
  });

  test('the launcher sits after w2g\'s search box and survives searches and re-renders', { timeout: 60000 }, async () => {
    await waitFor(() => launcherAfterSearch(page), { timeout: 10000, message: 'launcher after #w2g-content-search' });
    await page.screenshot({ path: path.join(SHOTS, '20-launcher.png'), clip: { x: 0, y: 0, width: 1400, height: 56 } });

    await page.fill(SEARCH_INPUT, 'big buck bunny');
    await page.press(SEARCH_INPUT, 'Enter');
    await waitFor(() => page.evaluate(() => getComputedStyle(document.querySelector('#w2g-content-pane-container')).display !== 'none'),
      { timeout: 15000, message: 'w2g search pane' });
    await sleep(2000);
    assert.ok(await launcherAfterSearch(page), 'launcher still in place after a w2g search');
    assert.equal(await isOpen(page), false, 'a plain search does not open the panel');
    await closeW2gSearch(page);

    await page.evaluate(() => document.querySelector('scw2g-launcher').remove());
    await waitFor(() => launcherAfterSearch(page), { timeout: 5000, message: 'launcher re-inserted' });
  });

  test('page scripts can\'t open the panel: faked paste, drop, input and Enter events in w2g\'s search box are ignored', { timeout: 60000 }, async () => {
    await stub(A, () => self.stub.clear());
    await page.evaluate(({ selector, url }) => {
      const input = document.querySelector(selector);
      input.value = url;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: url }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop', data: url }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const data = new DataTransfer();
      data.setData('text/plain', url);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      input.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { selector: SEARCH_INPUT, url: LIKES_URL });
    await sleep(2000);
    assert.equal(await isOpen(page), false, 'the panel stayed closed');
    assert.deepEqual((await stubTypes(A)).filter((t) => t.startsWith('sc:')), [], 'nothing was asked from SoundCloud');
    await closeW2gSearch(page);
  });

  test('a real paste of a set link opens the panel with just its preview: no library, focus stays in w2g\'s box', { timeout: 60000 }, async () => {
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    await paste(page, SEARCH_INPUT, `listen: ${SET_URL}?si=abc123&utm_source=clipboard`);
    const p = panel(page);
    await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel opened by paste' });
    await p.title.waitFor({ timeout: 20000 });
    assert.equal(await p.title.textContent(), 'Soulhack');
    assert.equal(await p.input.inputValue(), `${SET_URL}?si=abc123&utm_source=clipboard`);
    assert.equal(await page.inputValue(SEARCH_INPUT), '', 'w2g did not get the pasted set link');
    await sleep(500);
    // Page scripts can read whatever the panel renders (window.find), so a detected link doesn't pull in the library,
    assert.equal((await stubMessages(A, 'sc:library')).length, 0, 'no library request');
    assert.equal(await p.showLibrary.isVisible(), true, 'the library waits for the user');
    // ...and the focus stays where the user types, so keystrokes meant for w2g can't press the hidden Add button.
    assert.deepEqual(await focusInfo(page), { inSearchBox: true, inPanel: null });
    // Screen readers hear that the panel opened (the launcher's status line; the panel itself was hidden until now).
    assert.equal(await launcherStatus(page), LINK_OPENED_TEXT);
    await shot(page, '24-paste-set');

    // Asked for inside the panel, the library loads.
    await p.showLibrary.click();
    await p.entry('Weekly Wave').waitFor({ timeout: 15000 });
    assert.equal((await stubMessages(A, 'sc:library')).length, 1);
    await closePanel(page);
    assert.equal(await launcherStatus(page), '', 'the status line is cleared with the panel');
  });

  test('a library loaded earlier stays hidden when a pasted link opens the panel, until the user asks for it', { timeout: 60000 }, async () => {
    const p = panel(page);
    await closePanel(page);
    await openPanel(page); // the launcher: shows the library
    await p.entry('Weekly Wave').waitFor({ timeout: 15000 });
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    await paste(page, SEARCH_INPUT, SET_URL);
    await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel opened by paste' });
    await waitFor(async () => (await textOf(p.title)) === 'Soulhack', { timeout: 20000, message: 'preview' });
    assert.equal(await p.showLibrary.isVisible(), true, 'the prompt instead of the library');
    assert.equal(await p.entry('Weekly Wave').count(), 0, 'no library entries rendered');
    assert.doesNotMatch(await textOf(p.library), /w2g test user|Your playlists/, 'neither the username nor any section');
    // Asked for, the library from a moment ago shows at once.
    await p.showLibrary.click();
    await p.entry('Weekly Wave').waitFor({ timeout: 3000 });
    assert.equal((await stubMessages(A, 'sc:library')).length, 0, 'no new library request for a fresh copy');
    await closePanel(page);
  });

  test('after a detected paste the launcher takes the keyboard into the panel instead of closing it', { timeout: 60000 }, async () => {
    const p = panel(page);
    const launcher = page.locator('scw2g-launcher button');
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await paste(page, SEARCH_INPUT, SET_URL);
    await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel opened by paste' });
    assert.deepEqual(await focusInfo(page), { inSearchBox: true, inPanel: null });
    assert.equal(await launcherStatus(page), LINK_OPENED_TEXT);
    // A keyboard user goes on to the launcher (the next stop after w2g's search) and presses Enter.
    await launcher.focus();
    await page.keyboard.press('Enter');
    await waitFor(async () => (await focusInfo(page)).inPanel === 'url', { timeout: 3000, message: 'focus in the panel\'s link box' });
    assert.equal(await isOpen(page), true, 'the panel stayed open');
    await p.entry('Weekly Wave').waitFor({ timeout: 15000 }); // the launcher's way in shows the library
    assert.equal(await launcherStatus(page), '');
    assert.equal(await p.input.inputValue(), SET_URL, 'the pasted link is still there');
    // Opened through the launcher now, so the launcher closes it.
    await launcher.focus();
    await page.keyboard.press('Enter');
    await waitFor(async () => !(await isOpen(page)), { timeout: 3000, message: 'closed by the launcher' });
  });

  test('after a detected paste a mouse click on the launcher closes the panel and loads no library', { timeout: 60000 }, async () => {
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    await paste(page, SEARCH_INPUT, SET_URL);
    await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel opened by paste' });
    // The launcher shows as expanded, so a mouse user clicks it to dismiss the panel.
    await page.locator('scw2g-launcher button').click();
    await waitFor(async () => !(await isOpen(page)), { timeout: 3000, message: 'closed by the mouse click' });
    assert.deepEqual(await stubMessages(A, 'sc:library'), [], 'the library was not loaded');
  });

  test('every link detected while the panel is open is announced again', { timeout: 60000 }, async () => {
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await paste(page, SEARCH_INPUT, SET_URL);
    await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel opened by paste' });
    assert.equal(await launcherStatus(page), LINK_OPENED_TEXT);
    await page.evaluate(() => {
      const status = document.querySelector('scw2g-launcher').shadowRoot.querySelector('[role=status]');
      window.scw2gStatus = [];
      new MutationObserver(() => window.scw2gStatus.push(status.textContent))
        .observe(status, { childList: true, characterData: true, subtree: true });
    });
    // The focus is still in w2g's box (the paste was cancelled there), so the user pastes the next link right away.
    assert.equal(await page.evaluate((t) => navigator.clipboard.writeText(t).then(() => true), WEEKLY_URL), true);
    await page.keyboard.press('ControlOrMeta+V');
    await waitFor(async () => (await page.evaluate(() => window.scw2gStatus)).at(-1) === LINK_OPENED_TEXT,
      { timeout: 3000, message: 'announced again' });
    const changes = await page.evaluate(() => window.scw2gStatus);
    assert.ok(changes.includes(''), `cleared before it was said again: ${JSON.stringify(changes)}`);
    assert.equal(await panel(page).input.inputValue(), WEEKLY_URL, 'the panel shows the new link');
    await closePanel(page);
  });

  test('a real drop of a set link into w2g\'s search box opens the panel; a dropped plain track link stays w2g\'s', { timeout: 60000 }, async () => {
    const p = panel(page);
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    // Links somewhere on the page (like in w2g's chat), dragged into the search box with the mouse: trusted drag
    // and drop events, as from a real user.
    await page.evaluate(({ set, track }) => {
      for (const [id, href, top] of [['scw2g-e2e-drag-set', set, 160], ['scw2g-e2e-drag-track', track, 200]]) {
        const a = document.createElement('a');
        a.id = id;
        a.href = href;
        a.textContent = id;
        a.style.cssText = `position: fixed; left: 20px; top: ${top}px; z-index: 99999; padding: 4px; background: #fff; color: #000;`;
        document.body.append(a);
      }
    }, { set: SET_URL, track: TRACK_URL });
    try {
      await page.locator('#scw2g-e2e-drag-set').dragTo(page.locator(SEARCH_INPUT));
      await waitFor(() => isOpen(page), { timeout: 5000, message: 'panel opened by the drop' });
      await waitFor(async () => (await textOf(p.title)) === 'Soulhack', { timeout: 20000, message: 'preview' });
      assert.equal(await p.input.inputValue(), SET_URL);
      assert.equal(await page.inputValue(SEARCH_INPUT), '', 'w2g\'s box did not get the dropped set link');
      assert.equal(await launcherStatus(page), LINK_OPENED_TEXT);
      assert.equal(await p.showLibrary.isVisible(), true, 'just the preview');
      assert.equal((await stubMessages(A, 'sc:library')).length, 0, 'no library request');
      await closePanel(page);

      await page.locator('#scw2g-e2e-drag-track').dragTo(page.locator(SEARCH_INPUT));
      await waitFor(async () => (await page.inputValue(SEARCH_INPUT)) === TRACK_URL, { timeout: 5000, message: 'the track link in w2g\'s box' });
      await sleep(1000);
      assert.equal(await isOpen(page), false, 'w2g plays plain public track links itself');
    } finally {
      await page.evaluate(() => document.querySelectorAll('[id^="scw2g-e2e-drag-"]').forEach((el) => el.remove()));
    }
    await closeW2gSearch(page);
  });

  test('editing commands a page script runs in w2g\'s search box (trusted input events) don\'t open the panel', { timeout: 60000 }, async () => {
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    const run = await page.evaluate(({ selector, url }) => {
      const input = document.querySelector(selector);
      const seen = [];
      const record = (e) => seen.push([e.inputType, e.isTrusted]);
      input.addEventListener('input', record);
      try {
        // transpose swaps the two characters before the caret ('11' stays '11'), and the browser reports it as a
        // trusted input event with inputType 'insertTranspose' and no data.
        input.value = url + '?x=11';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        const transposed = document.execCommand('transpose');
        // insertText: as if the user had typed the link (that once armed Enter in this box).
        input.value = '';
        const inserted = document.execCommand('insertText', false, url);
        return { transposed, inserted, seen, value: input.value };
      } finally {
        input.removeEventListener('input', record);
      }
    }, { selector: SEARCH_INPUT, url: LIKES_URL });
    assert.deepEqual(run, { transposed: true, inserted: true, seen: [['insertTranspose', true], ['insertText', true]], value: LIKES_URL },
      'the browser fired trusted input events for both commands');
    await sleep(1500);
    assert.equal(await isOpen(page), false, 'the panel stayed closed');
    // The user's own Enter on that text goes to w2g as well.
    await page.press(SEARCH_INPUT, 'Enter');
    await sleep(1500);
    assert.equal(await isOpen(page), false, 'Enter is left to w2g');
    assert.deepEqual((await stubTypes(A)).filter((t) => t.startsWith('sc:')), [], 'nothing was asked from SoundCloud');
    await closeW2gSearch(page);
  });

  test('w2g\'s box keeps only plain public track links: list, alias, scheme-less and http links open the panel', { timeout: 120000 }, async () => {
    const p = panel(page);
    const cases = [
      ['https://soundcloud.com/forss/likes', 'https://soundcloud.com/forss/likes'], // w2g would offer the profile
      [LIKES_URL, LIKES_URL],
      ['https://soundcloud.com/discover/weekly', 'https://soundcloud.com/discover/weekly'],
      ['soundcloud.com/forss/flickermood', TRACK_URL], // w2g only recognizes text starting with https://soundcloud.com
      ['http://soundcloud.com/forss/flickermood', TRACK_URL],
    ];
    for (const [text, url] of cases) {
      await closePanel(page);
      await page.fill(SEARCH_INPUT, '');
      await paste(page, SEARCH_INPUT, text);
      await waitFor(() => isOpen(page), { timeout: 5000, message: `panel opened for ${text}` });
      assert.equal(await p.input.inputValue(), url, text);
      assert.equal(await page.inputValue(SEARCH_INPUT), '', `w2g did not get ${text}`);
    }
    await waitFor(async () => (await textOf(p.title)) === 'Flickermood', { timeout: 20000, message: 'track preview' });
    assert.equal(await p.stats.textContent(), '1 track');
    await closePanel(page);
  });

  test('a plain public track link pasted into w2g\'s search box is left to w2g', { timeout: 60000 }, async () => {
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await paste(page, SEARCH_INPUT, TRACK_URL);
    await sleep(1500);
    assert.equal(await isOpen(page), false);
    assert.equal(await page.inputValue(SEARCH_INPUT), TRACK_URL, 'the paste went into w2g\'s box');
    await closeW2gSearch(page);
  });

  test('typing a set link and pressing Enter in w2g\'s search box is left to w2g', { timeout: 60000 }, async () => {
    // Page scripts can produce the same trusted typing (document.execCommand('insertText')), so it never counts.
    await closePanel(page);
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    await page.click(SEARCH_INPUT);
    await page.keyboard.type(WEEKLY_URL);
    assert.equal(await isOpen(page), false, 'typing does not open the panel');
    await page.press(SEARCH_INPUT, 'Enter');
    await sleep(1500);
    assert.equal(await isOpen(page), false, 'neither does Enter');
    assert.deepEqual((await stubTypes(A)).filter((t) => t.startsWith('sc:')), [], 'nothing was asked from SoundCloud');
    await closeW2gSearch(page);
  });

  test('Enter on a link a page script put into w2g\'s search box is left to w2g', { timeout: 60000 }, async () => {
    await page.fill(SEARCH_INPUT, '');
    await stub(A, () => self.stub.clear());
    await page.evaluate(({ selector, url }) => { document.querySelector(selector).value = url; }, { selector: SEARCH_INPUT, url: LIKES_URL });
    await page.press(SEARCH_INPUT, 'Enter');
    await sleep(1500);
    assert.equal(await isOpen(page), false, 'not the user\'s own input: the panel stays closed');
    assert.deepEqual((await stubTypes(A)).filter((t) => t.startsWith('sc:')), []);
    await closeW2gSearch(page);
  });

  test('panel: link -> preview -> Add puts exactly the expected tracks into the room playlist', { timeout: 120000 }, async () => {
    const p = panel(page);
    const before = await roomItems(page, sk);
    await openPanel(page);
    await p.entry('Weekly Wave').waitFor({ timeout: 15000 });
    await shot(page, '21-panel-open');
    await p.input.fill(SET_URL);
    await p.input.press('Enter');
    await p.title.waitFor({ timeout: 20000 });
    assert.equal(await p.title.textContent(), 'Soulhack');
    assert.equal(await p.stats.textContent(), '11 tracks');
    assert.equal((await p.add.textContent()).trim(), 'Add 11 tracks');
    // Keyboard flow inside the panel: after loading, focus moves to the Add button, so Enter adds.
    await waitFor(async () => /\badd\b/.test((await focusInfo(page)).inPanel || ''), { timeout: 3000, message: 'Add button focused' });
    await shot(page, '22-preview');
    await page.keyboard.press('Enter');
    await p.result.waitFor({ timeout: 60000 });
    assert.equal(await p.result.textContent(), 'Added 11 tracks to “Watch2Gether Default”.');
    assert.equal((await p.add.textContent()).trim(), 'Add again');
    assert.equal(await p.again.isVisible(), false);
    await shot(page, '23-added');
    const items = await roomItems(page, sk);
    assertItems(items.slice(before.length), data.soulhack);
  });

  test('room:add from the background: progress, final response, item normalization', { timeout: 120000 }, async () => {
    await stub(A, () => self.stub.clear());
    const playlistKey = await selectedPlaylist(page, sk);
    const before = await roomItems(page, sk);
    const items = [
      data.soulhack[0],
      { url: data.soulhack[1].url, title: '   ' }, // never sent with an empty title
      { url: 'javascript:alert(1)', title: 'not a link' }, // dropped
      Object.assign({}, data.soulhack[2], { extra: 'dropped key' }),
    ];
    const { response } = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'job-small', items, title: 'Soulhack' });
    assert.deepEqual(response, { ok: true, added: 3, playlistKey });
    const progress = (await stubMessages(A, 'job:progress')).map((m) => m.msg);
    assert.deepEqual(progress, [
      { type: 'job:progress', jobId: 'job-small', phase: 'adding', done: 0, total: 3 },
      { type: 'job:progress', jobId: 'job-small', phase: 'adding', done: 3, total: 3 },
    ]);
    const added = (await roomItems(page, sk)).slice(before.length);
    assert.deepEqual(added.map((i) => [i.url, i.title]), [
      [data.soulhack[0].url, data.soulhack[0].title],
      [data.soulhack[1].url, data.soulhack[1].url],
      [data.soulhack[2].url, data.soulhack[2].title],
    ]);
    assert.equal(added[2].thumb, data.soulhack[2].thumb);

    const empty = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'job-empty', items: [], title: 'Nothing' });
    assert.equal(empty.response.ok, false);
    assert.equal(empty.response.error.code, 'EMPTY');
    assert.equal(empty.response.error.added, 0, 'error replies always say how many were added');

    // A re-sent request (same jobId, e.g. after a service worker restart) joins the running job instead of adding twice.
    const again = { type: 'room:add', jobId: 'job-twice', items: data.soulhack.slice(8, 10), title: 'Soulhack' };
    const before2 = await roomItems(page, sk);
    const [first, second] = await Promise.all([sendToRoom(A, tabA, again), sendToRoom(A, tabA, again)]);
    assert.deepEqual(first.response, { ok: true, added: 2, playlistKey });
    assert.deepEqual(second.response, first.response);
    assertItems((await roomItems(page, sk)).slice(before2.length), data.soulhack.slice(8, 10));
  });

  test('a 55-track job goes out as 50 + 5, in order, at least 3 s apart', { timeout: 180000 }, async () => {
    await stub(A, () => self.stub.clear());
    const posts = [];
    const onRequest = (req) => {
      const count = addedInPost(req);
      if (count) posts.push({ at: Date.now(), count });
    };
    page.on('request', onRequest);
    const before = await roomItems(page, sk);
    try {
      const { response } = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'job-55', items: data.club55, title: 'Club Heat' });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.added, 55);
    } finally {
      page.off('request', onRequest);
    }
    const progress = await stubMessages(A, 'job:progress');
    assert.deepEqual(progress.map((m) => m.msg.done), [0, 50, 55]);
    assert.ok(progress[2].at - progress[1].at >= 2900, `batches ${progress[2].at - progress[1].at} ms apart`);
    if (posts.length) {
      // Content-script requests are visible to Playwright in current Chromium; a retried batch would add a POST.
      assert.deepEqual(posts.map((x) => x.count).slice(-2), [50, 5]);
      assert.ok(posts.at(-1).at - posts.at(-2).at >= 2900, 'POSTs at least 3 s apart');
    }
    assertItems((await roomItems(page, sk)).slice(before.length), data.club55);
  });

  test('an opaque POST failure is verified before any retry (no duplicates, nothing lost)', { timeout: 180000 }, async () => {
    // landed: the POST reaches w2g but the answer has no CORS headers (like w2g's real error responses), so the
    // content script sees a TypeError although the items were added. lost: the POST never reaches w2g.
    const run = async (jobId, items, mode) => {
      let posts = 0;
      let landedStatus = null;
      await page.route(ADD_PATTERN, async (route) => {
        // Only our adds: w2g's own client posts to the same endpoint (e.g. active_item when the playlist advances).
        if (!addedInPost(route.request())) return route.continue();
        if (posts++) return route.continue();
        if (mode === 'lost') return route.abort('failed');
        landedStatus = (await route.fetch()).status();
        return route.fulfill({ status: 500, contentType: 'text/plain', body: 'error' });
      });
      const before = await roomItems(page, sk);
      const started = Date.now();
      try {
        const { response } = await sendToRoom(A, tabA, { type: 'room:add', jobId, items, title: jobId });
        assert.equal(response.ok, true, JSON.stringify(response));
        assert.equal(response.added, items.length);
      } finally {
        await page.unroute(ADD_PATTERN);
      }
      assert.ok(Date.now() - started >= 10500, 'waited out a possible Cloudflare 429 before checking');
      if (mode === 'landed') {
        assert.equal(landedStatus, 200, 'the intercepted POST reached w2g');
        assert.equal(posts, 1, 'no retry after the check found the batch');
      } else {
        assert.equal(posts, 2, 'exactly one retry');
      }
      assertItems((await roomItems(page, sk)).slice(before.length), items, `${mode}: items added exactly once`);
    };
    await run('job-landed', data.soulhack.slice(3, 5), 'landed');
    await run('job-lost', data.soulhack.slice(5, 7), 'lost');
  });

  test('an add POST that hangs times out after 30 s, is verified, then retried once', { timeout: 180000 }, async () => {
    const items = fakeItems('hang', 2);
    const hold = await holdFirstAdd(page);
    const before = await roomItems(page, sk);
    const started = Date.now();
    try {
      const { response } = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'job-hang', items, title: 'Hang' });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.added, 2);
    } finally {
      await hold.release();
    }
    const took = Date.now() - started;
    assert.equal(hold.held.length, 1, 'the first POST hung');
    assert.ok(took >= 30000 + 11000 - 500, `gave up on the hung POST after 30 s, then waited before checking (${took} ms)`);
    assert.equal(hold.posts(), 2, 'one retry once the check found nothing');
    assertItems((await roomItems(page, sk)).slice(before.length), items);
  });

  test('background jobs: a queued job says so at once and periodically; room:cancel stops a hung job at once and drops a queued one', { timeout: 120000 }, async () => {
    await stub(A, () => self.stub.clear());
    const [hungItems, firstItems, secondItems] = [fakeItems('bg-hung', 2), fakeItems('bg-q1', 1), fakeItems('bg-q2', 1)];
    const hold = await holdFirstAdd(page);
    const before = await roomItems(page, sk);
    const queuedReports = (id) => stub(A, (id) => self.stub.messages('job:progress')
      .filter((m) => m.msg.jobId === id && m.msg.phase === 'queued').map((m) => Object.assign({ at: m.at }, m.msg)), id);
    const withoutAt = ({ at, ...rest }) => rest;
    let q1;
    try {
      const hung = sendToRoom(A, tabA, { type: 'room:add', jobId: 'bg-hung', items: hungItems, title: 'Hung' });
      await waitFor(() => hold.held.length === 1, { timeout: 30000, message: 'the first POST hangs' });
      q1 = sendToRoom(A, tabA, { type: 'room:add', jobId: 'bg-q1', items: firstItems, title: 'Queued 1' });
      const q2 = sendToRoom(A, tabA, { type: 'room:add', jobId: 'bg-q2', items: secondItems, title: 'Queued 2' });
      await waitFor(async () => (await queuedReports('bg-q1')).length && (await queuedReports('bg-q2')).length,
        { timeout: 5000, message: 'queued reports right away' });
      assert.deepEqual(withoutAt((await queuedReports('bg-q1'))[0]), { type: 'job:progress', jobId: 'bg-q1', phase: 'queued', done: 0, total: 1, position: 1 });
      assert.deepEqual(withoutAt((await queuedReports('bg-q2'))[0]), { type: 'job:progress', jobId: 'bg-q2', phase: 'queued', done: 0, total: 1, position: 2 });
      // ...and again while still waiting, so the background's stall timer doesn't fire for a job that only waits.
      const repeated = await waitFor(async () => {
        const reports = await queuedReports('bg-q1');
        return reports.length >= 2 && reports;
      }, { timeout: QUEUED_REPORT_TEST_MS + 3000, message: 'repeated queued report' });
      assert.ok(repeated[1].at - repeated[0].at >= QUEUED_REPORT_TEST_MS - 500, 'repeated after the interval');

      const dropQueued = await sendToRoom(A, tabA, { type: 'room:cancel', jobId: 'bg-q2' });
      assert.deepEqual(dropQueued.response, { ok: true, cancelled: true, added: 0 });
      assert.deepEqual((await q2).response, { ok: false, error: { code: 'CANCELLED', message: 'Cancelled.', added: 0 } });
      const unknown = await sendToRoom(A, tabA, { type: 'room:cancel', jobId: 'bg-unknown' });
      assert.deepEqual(unknown.response, { ok: true, cancelled: false, added: 0 });

      // The hung job: its POST is aborted at once, the check finds the batch missing, nothing more is sent.
      const t0 = Date.now();
      const stopHung = await sendToRoom(A, tabA, { type: 'room:cancel', jobId: 'bg-hung' });
      assert.deepEqual(stopHung.response, { ok: true, cancelled: true, added: 0 });
      assert.ok(Date.now() - t0 < 15000, `did not wait for the hung POST (${Date.now() - t0} ms)`);
      const hungReply = (await hung).response;
      assert.equal(hungReply.ok, false, JSON.stringify(hungReply));
      assert.equal(hungReply.error.code, 'CANCELLED');
      assert.equal(hungReply.error.added, 0);
      // The job behind it runs right away.
      const q1Reply = (await q1).response;
      assert.equal(q1Reply.ok, true, JSON.stringify(q1Reply));
      assert.equal(q1Reply.added, 1);
    } finally {
      await hold.release();
      if (q1) await q1;
    }
    assertItems((await roomItems(page, sk)).slice(before.length), firstItems, 'only the job that was not cancelled added anything');
    const q1Phases = (await stubMessages(A, 'job:progress')).filter((m) => m.msg.jobId === 'bg-q1').map((m) => `${m.msg.phase}:${m.msg.done}`);
    assert.deepEqual(q1Phases.filter((x) => x !== 'queued:0'), ['adding:0', 'adding:1']);
    assert.ok(q1Phases.indexOf('adding:0') > q1Phases.lastIndexOf('queued:0'), q1Phases.join());
  });

  test('Cancel during an add POST stops at once and counts a batch that landed; "Add the remaining" adds the rest once', { timeout: 180000 }, async () => {
    const p = panel(page);
    const before = await roomItems(page, sk);
    await loadInPanel(page, data.clubUrl);
    assert.equal((await p.add.textContent()).trim(), 'Add 55 tracks');
    const hold = await holdFirstAdd(page, { land: true }); // reaches w2g, but the answer never comes back
    try {
      await p.add.click();
      await waitFor(() => hold.held.length === 1, { timeout: 30000, message: 'first POST landed and hangs' });
      const t0 = Date.now();
      await p.cancel.click();
      await waitFor(async () => (await textOf(p.progressLabel)) === 'Cancelling…', { timeout: 2000, message: 'Cancelling…' });
      await waitFor(async () => (await textOf(p.result)) === 'Cancelled after 50 of 55 tracks.', { timeout: 20000, message: 'cancel result' });
      assert.ok(Date.now() - t0 < 15000, `did not wait for the hung POST (${Date.now() - t0} ms)`);
      assert.equal(hold.posts(), 1, 'nothing was posted after the cancel');
    } finally {
      await hold.release();
    }
    // Adding everything again would duplicate the 50 that landed; that is only the explicit secondary choice.
    assert.equal((await p.add.textContent()).trim(), 'Add the remaining 5 tracks');
    assert.equal(await p.again.isVisible(), true);
    assert.equal((await p.again.textContent()).trim(), 'Add all 55 tracks again');
    await shot(page, '31-cancelled-partial');
    await p.add.click();
    await waitFor(async () => /^Added 5 tracks to /.test(await textOf(p.result)), { timeout: 60000, message: 'the rest added' });
    assert.equal((await p.add.textContent()).trim(), 'Add again');
    assert.equal(await p.again.isVisible(), false);
    assertItems((await roomItems(page, sk)).slice(before.length), data.club55, 'every track exactly once, in order');
    await closePanel(page);
  });

  test('a cancel whose in-flight batch can\'t be checked says it may have been added', { timeout: 120000 }, async () => {
    const p = panel(page);
    await loadInPanel(page, SET_URL);
    await waitFor(async () => !(await p.add.isDisabled()), { timeout: 10000, message: 'Add enabled' });
    const readPattern = `${W2G_API}/streams/${sk}/playlists/*/playlist_items*`;
    const hold = await holdFirstAdd(page);
    let failedReads = 0;
    await page.route(readPattern, (route) => {
      failedReads++;
      return route.abort('internetdisconnected');
    });
    try {
      await p.add.click();
      await waitFor(() => hold.held.length === 1, { timeout: 30000, message: 'the POST hangs' });
      await p.cancel.click();
      await waitFor(async () => (await textOf(p.result)) === 'Cancelled. 11 tracks may have been added, so check the playlist.',
        { timeout: 20000, message: 'result for an unknown outcome' });
      assert.ok(failedReads >= 1, 'tried to read the playlist');
      assert.equal(hold.posts(), 1, 'nothing was posted after the cancel');
    } finally {
      await page.unroute(readPattern);
      await hold.release();
    }
    // Nothing is known to be in the room, so the button offers the whole list again (next to the warning).
    assert.equal((await p.add.textContent()).trim(), 'Add 11 tracks');
    await closePanel(page);
  });

  test('a rebuilt preview keeps its add: a Go+ toggle mid-add re-arms nothing, "Add the remaining" survives settings, Load and other links', { timeout: 180000 }, async () => {
    const p = panel(page);
    const { items, previews } = data.resume;
    const before = await roomItems(page, sk);
    // A rebuilt preview with the running add: no Add button to press twice, the progress stays in the preview.
    const busy = async (why) => {
      assert.equal(await p.add.isVisible(), false, `Add stays hidden (${why})`);
      assert.match(await textOf(p.progressLabel), /^Adding 60 tracks/, `progress in the preview (${why})`);
      assert.equal(await p.jobRows(RESUME_TITLE).count(), 0, `no separate job row (${why})`);
    };
    const offersRest = async (n, total, why) => {
      await waitFor(async () => (await textOf(p.add)).trim() === `Add the remaining ${n} tracks`,
        { timeout: 20000, message: `"Add the remaining ${n} tracks" (${why})` });
      assert.equal(await p.again.isVisible(), true, why);
      assert.equal((await textOf(p.again)).trim(), `Add all ${total} tracks again`, why);
      assert.equal(await textOf(p.result), 'Cancelled after 50 of 60 tracks.', why);
    };
    // Loads a link through the panel's box and waits for the new preview.
    const load = async (url, title) => {
      await stub(A, () => self.stub.clear());
      await p.input.fill(url);
      await p.input.press('Enter');
      await waitFor(async () => (await stubMessages(A, 'sc:expand')).length > 0, { timeout: 10000, message: `sc:expand for ${title}` });
      await waitFor(async () => !(await p.preview.getAttribute('aria-busy')) && (await textOf(p.title)) === title,
        { timeout: 20000, message: `${title} loaded` });
    };
    try {
      await loadInPanel(page, RESUME_URL);
      await waitFor(async () => (await textOf(p.stats)) === '60 tracks · 2 skipped', { timeout: 20000, message: 'Go+ previews skipped' });
      assert.equal((await textOf(p.add)).trim(), 'Add 60 tracks');
      const hold = await holdFirstAdd(page, { land: true }); // batch 1 reaches w2g, its answer never comes back
      try {
        await p.add.click();
        await waitFor(() => hold.held.length === 1, { timeout: 30000, message: 'first batch landed, its answer hangs' });
        await p.skip.uncheck(); // in the panel
        await waitFor(async () => (await textOf(p.stats)) === '62 tracks', { timeout: 20000, message: 'previews included' });
        await busy('Go+ unticked in the panel');
        await stub(A, () => self.stub.setSettings({ skipPreviews: true })); // in the popup or another room tab
        await waitFor(async () => (await textOf(p.stats)) === '60 tracks · 2 skipped', { timeout: 20000, message: 'previews skipped again' });
        await busy('Go+ ticked elsewhere');
        assert.equal(hold.posts(), 1, 'no second add was posted');
        await p.cancel.click();
        await waitFor(async () => (await textOf(p.result)) === 'Cancelled after 50 of 60 tracks.', { timeout: 20000, message: 'cancel result' });
      } finally {
        await hold.release();
      }
      await offersRest(10, 60, 'after the cancel');
      // The two Go+ previews aren't in the room either: by URL, the rest is now 12 tracks.
      await stub(A, () => self.stub.setSettings({ skipPreviews: false }));
      await waitFor(async () => (await textOf(p.stats)) === '62 tracks', { timeout: 20000, message: 'previews included again' });
      await offersRest(12, 62, 'after a settings change');
      await load(RESUME_URL, RESUME_TITLE);
      await offersRest(12, 62, 'after Load of the same link');
      await load(SET_URL, 'Soulhack');
      await load(RESUME_URL, RESUME_TITLE);
      await offersRest(12, 62, 'after another link and back');
      await shot(page, '34-remaining-after-reload');

      await p.add.click();
      await waitFor(async () => /^Added 12 tracks to /.test(await textOf(p.result)), { timeout: 60000, message: 'the rest added' });
      assert.equal((await textOf(p.add)).trim(), 'Add again');
      assert.equal(await p.again.isVisible(), false);
      assertItems((await roomItems(page, sk)).slice(before.length), items.concat(previews), 'every track exactly once, in order');
    } finally {
      await stub(A, () => self.stub.setSettings({ skipPreviews: true }));
    }
    await waitFor(async () => (await p.skip.isChecked()) === true, { timeout: 5000, message: 'Go+ previews skipped again' });
    await closePanel(page);
  });

  test('switching the room\'s playlist mid-import stops with PLAYLIST_CHANGED; the rest then goes to the original list', { timeout: 180000 }, async () => {
    const p = panel(page);
    const { lists, selectedPlaylist: home } = await playlistsOf(page, sk);
    const homeTitle = lists.find((l) => l.key === home).title;
    let other = lists.find((l) => l.key !== home);
    if (!other) {
      await w2gApi(page, 'POST', `/rooms/${sk}/playlists/sync_update`, { new_list: 'scw2g second', personal_list: false });
      other = await waitFor(async () => (await playlistsOf(page, sk)).lists.find((l) => l.key !== home), { timeout: 15000, message: 'second list' });
    }
    await selectPlaylist(page, sk, home); // w2g may select a new list right away
    const beforeHome = await itemsOf(page, sk, home);
    const beforeOther = await itemsOf(page, sk, other.key);
    try {
      await loadInPanel(page, data.clubUrl);
      await waitFor(async () => !(await p.add.isDisabled()), { timeout: 10000, message: 'Add enabled' });
      await p.add.click();
      await waitFor(async () => /^Added 50 of 55/.test(await textOf(p.progressLabel)), { timeout: 30000, interval: 100, message: 'first batch' });
      // Someone picks another list in w2g's playlist dropdown, which switches it for the whole room.
      await w2gApi(page, 'POST', `/rooms/${sk}/playlists/sync_update`, { active_list: other.key });
      await waitFor(async () => /switched to another playlist/.test(await textOf(p.result)), { timeout: 30000, message: 'PLAYLIST_CHANGED' });
      assert.equal(await p.result.textContent(),
        `The room switched to another playlist, so adding stopped. 50 of 55 tracks were added to “${homeTitle}” before that.`);
      assert.equal((await itemsOf(page, sk, other.key)).length, beforeOther.length, 'nothing went to the other list');
      assert.equal((await p.add.textContent()).trim(), 'Add the remaining 5 tracks');
      await shot(page, '32-playlist-changed');
    } finally {
      await selectPlaylist(page, sk, home);
    }
    await waitFor(async () => !(await p.add.isDisabled()), { timeout: 10000, message: 'Add enabled' });
    await p.add.click();
    await waitFor(async () => (await textOf(p.result)) === `Added 5 tracks to “${homeTitle}”.`, { timeout: 60000, message: 'the rest added' });
    assertItems((await itemsOf(page, sk, home)).slice(beforeHome.length), data.club55, 'the whole list in the original playlist');
    await closePanel(page);
  });

  test('a sync_state outage between batches is waited out: the import completes and the room stays joined', { timeout: 180000 }, async () => {
    await stub(A, () => self.stub.clear());
    const syncPattern = `${W2G_API}/rooms/${sk}/sync_state*`;
    let outageUntil = 0;
    let aborted = 0;
    // Like a Wi-Fi roam or VPN reconnect: from the first POST on, every sync_state read fails for 8 s.
    await page.route(syncPattern, (route) => {
      if (Date.now() < outageUntil) {
        aborted++;
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    await page.route(ADD_PATTERN, (route) => {
      if (!outageUntil && addedInPost(route.request())) outageUntil = Date.now() + 8000;
      return route.continue();
    });
    const before = await roomItems(page, sk);
    const started = Date.now();
    try {
      const { response } = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'job-blip', items: data.club55, title: 'Club Heat' });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.added, 55);
    } finally {
      await page.unroute(ADD_PATTERN);
      await page.unroute(syncPattern);
    }
    assert.ok(aborted >= 3, `the check before batch 2 failed (${aborted} reads aborted)`);
    assert.ok(Date.now() - started >= 3000 + 11000, 'waited before reading again');
    const joined = (await stubMessages(A, 'room:hello')).map((m) => m.msg.joined);
    assert.ok(!joined.includes(false), `never reported as not joined (${joined.join()})`);
    assertItems((await roomItems(page, sk)).slice(before.length), data.club55);
  });

  test('after a failed check the open panel keeps checking and clears its banner once w2g answers', { timeout: 120000 }, async () => {
    const p = panel(page);
    await loadInPanel(page, SET_URL);
    await waitFor(async () => !(await p.add.isDisabled()), { timeout: 10000, message: 'Add enabled' });
    await stub(A, () => self.stub.clear());
    const syncPattern = `${W2G_API}/rooms/${sk}/sync_state*`;
    let aborted = 0;
    await page.route(syncPattern, (route) => {
      aborted++;
      return route.abort('internetdisconnected');
    });
    try {
      await p.add.click(); // the job's first check can't reach w2g
      await waitFor(async () => /^Couldn't reach this room on w2g/.test(await textOf(p.result)), { timeout: 20000, message: 'job result' });
      await waitFor(async () => /Can't reach this room on w2g/.test(await textOf(p.banner)), { timeout: 5000, message: 'connection banner' });
      assert.match(await p.banner.textContent(), /Checking again every few seconds/);
      assert.equal(await p.add.isDisabled(), true);
      await shot(page, '33-unreachable');
      const n = aborted;
      await sleep(11000);
      assert.ok(aborted - n >= 2, `kept checking while the panel is open (${aborted - n} reads in 11 s)`);
    } finally {
      await page.unroute(syncPattern);
    }
    await waitFor(async () => !(await p.banner.isVisible().catch(() => false)), { timeout: 10000, message: 'banner cleared by itself' });
    assert.equal(await p.add.isDisabled(), false);
    // room:hello goes out 50 ms after the change that already cleared the banner.
    const joined = await waitFor(async () => {
      const list = (await stubMessages(A, 'room:hello')).map((m) => m.msg.joined);
      return list.at(-1) === true && list;
    }, { timeout: 5000, message: 'room:hello with joined:true' });
    assert.deepEqual(joined.slice(-2), [false, true]);
    await closePanel(page);
  });

  test('room:add whose first check can\'t reach w2g fails with W2G_UNREACHABLE before any POST; hello and pong say unreachable until a check succeeds', { timeout: 120000 }, async () => {
    await closePanel(page); // no panel: nothing re-checks on its own
    await stub(A, () => self.stub.clear());
    const syncPattern = `${W2G_API}/rooms/${sk}/sync_state*`;
    let posts = 0;
    const onRequest = (req) => { if (addedInPost(req)) posts++; };
    page.on('request', onRequest);
    await page.route(syncPattern, (route) => route.abort('internetdisconnected'));
    try {
      const { response } = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'job-unreachable', items: fakeItems('unreachable', 2), title: 'Unreachable' });
      assert.deepEqual(response, {
        ok: false,
        error: { code: 'W2G_UNREACHABLE', message: "Couldn't reach this room on w2g. Check your connection, then try again.", added: 0 },
      });
      assert.equal(posts, 0, 'nothing was posted');
      const hello = await helloFor(A, (r) => r.tabId === tabA && r.unreachable === true, 'room:hello saying unreachable');
      assert.equal(hello.joined, false);
      // The background pings before its next add: the room tab checks again, still can't reach w2g, and says so.
      const pong = await sendToRoom(A, tabA, { type: 'room:ping' });
      assert.deepEqual(pong.response, { ok: true, streamkey: sk, joined: false, roomName: 'Temporary Room', unreachable: true });
    } finally {
      await page.unroute(syncPattern);
      page.off('request', onRequest);
    }
    // w2g answers again: the next ping's check clears the flag.
    const pong = await waitFor(async () => {
      const { response } = await sendToRoom(A, tabA, { type: 'room:ping' });
      return response && response.joined && response;
    }, { timeout: 20000, message: 'joined again' });
    assert.deepEqual(pong, { ok: true, streamkey: sk, joined: true, roomName: 'Temporary Room', unreachable: false });
    await helloFor(A, (r) => r.tabId === tabA && r.joined && r.unreachable === false, 'room:hello: joined, reachable');
  });

  test('library: sections, loading an entry, the Go+ setting, errors and the login hint', { timeout: 120000 }, async () => {
    const p = panel(page);
    await openPanel(page);
    await p.entry('Weekly Wave').waitFor({ timeout: 15000 });
    assert.deepEqual(await p.sectionTitles.allTextContents(), ['Made for you', 'Your playlists', 'Liked playlists', 'Liked tracks']);
    const more = p.library.locator('.more');
    assert.equal(await more.textContent(), `Show all ${data.likedCount}`);
    await more.click();
    await p.entry('AF006 - Remixes 2').waitFor({ timeout: 3000 });

    await p.entry('Weekly Wave').click();
    await waitFor(async () => (await textOf(p.title)) === 'Weekly Wave', { timeout: 20000, message: 'Weekly Wave preview' });
    await waitFor(async () => (await textOf(p.stats)) === '38 tracks · 10 skipped', { timeout: 20000, message: 'Weekly Wave stats' });
    assert.equal(await p.notes.first().textContent(), '2 not available in your country, 8 Go+ previews skipped');
    await shot(page, '25-weekly-wave');

    await stub(A, () => self.stub.clear());
    await p.skip.uncheck();
    await waitFor(async () => (await textOf(p.stats)) === '46 tracks · 2 skipped', { timeout: 20000, message: 'previews included' });
    assert.equal(await p.notes.first().textContent(), '2 not available in your country');
    const sets = (await stubMessages(A, 'settings:set')).map((m) => m.msg.patch);
    assert.deepEqual(sets.at(-1), { skipPreviews: false });
    await p.skip.check();
    await waitFor(async () => (await textOf(p.stats)) === '38 tracks · 10 skipped', { timeout: 20000, message: 'previews skipped again' });

    await p.entry('Daily Drops').click();
    await p.error.waitFor({ timeout: 20000 });
    assert.match(await p.error.textContent(), /Your SoundCloud login needs a refresh/);
    await shot(page, '26-error-auth-expired');
    await stub(A, () => self.stub.clear());
    await p.error.locator('button', { hasText: 'Open SoundCloud' }).click();
    await waitFor(async () => (await stubMessages(A, 'open:soundcloud')).length === 1, { timeout: 5000, message: 'open:soundcloud' });

    await p.input.fill('hello world');
    await p.input.press('Enter');
    await waitFor(async () => /doesn't look like a SoundCloud link/.test(await textOf(p.error)),
      { timeout: 5000, message: 'INVALID_URL text' });

    await stub(A, () => { self.stub.loggedIn = false; });
    await p.refresh.click();
    await p.library.locator('.login').waitFor({ timeout: 10000 });
    assert.match(await p.library.textContent(), /Not logged in to SoundCloud/);
    await shot(page, '27-logged-out');
    await stub(A, () => { self.stub.loggedIn = true; });
    await p.refresh.click();
    await p.entry('Weekly Wave').waitFor({ timeout: 10000 });
    await closePanel(page);
  });

  test('the Go+ checkbox follows settings changed elsewhere, and a toggle during a load applies to that preview', { timeout: 120000 }, async () => {
    const p = panel(page);
    await loadInPanel(page, WEEKLY_URL);
    await waitFor(async () => (await textOf(p.stats)) === '38 tracks · 10 skipped', { timeout: 20000, message: 'previews skipped' });
    assert.equal(await p.skip.isChecked(), true);

    // The toolbar popup (or another room tab) turns skipping off: checkbox and preview follow without a reload.
    await stub(A, () => self.stub.setSettings({ skipPreviews: false }));
    await waitFor(async () => (await p.skip.isChecked()) === false, { timeout: 5000, message: 'checkbox unticked' });
    await waitFor(async () => (await textOf(p.stats)) === '46 tracks · 2 skipped', { timeout: 20000, message: 'previews included' });
    await stub(A, () => self.stub.setSettings({ skipPreviews: true }));
    await waitFor(async () => (await p.skip.isChecked()) === true, { timeout: 5000, message: 'checkbox ticked' });
    await waitFor(async () => (await textOf(p.stats)) === '38 tracks · 10 skipped', { timeout: 20000, message: 'previews skipped again' });

    // Unticking while the preview loads: the request already sent used the old setting, so the preview reloads.
    await stub(A, () => { self.stub.expandDelayMs = 3000; });
    try {
      await p.input.fill(WEEKLY_URL);
      await p.input.press('Enter');
      await waitFor(async () => (await p.preview.getAttribute('aria-busy')) === 'true', { timeout: 3000, message: 'loading' });
      await p.skip.uncheck();
      await waitFor(async () => (await textOf(p.stats)) === '46 tracks · 2 skipped', { timeout: 20000, message: 'reloaded with previews' });
      await sleep(3500); // the late answer to the first request must not win
      assert.equal(await p.stats.textContent(), '46 tracks · 2 skipped');
      assert.equal(await p.skip.isChecked(), false);
      assert.equal((await stub(A, () => self.stub.getSettings())).skipPreviews, false);
    } finally {
      await stub(A, () => { self.stub.expandDelayMs = 300; });
    }
    await p.skip.check();
    await waitFor(async () => (await textOf(p.stats)) === '38 tracks · 10 skipped', { timeout: 20000, message: 'back to skipping' });
    await closePanel(page);
  });

  test('sc:login-changed reloads the library and retries a preview that needed the login', { timeout: 120000 }, async () => {
    const p = panel(page);
    await openPanel(page);
    await p.entry('Weekly Wave').waitFor({ timeout: 15000 });
    await stub(A, () => { self.stub.loggedIn = false; self.stub.loginExpired = true; });
    await p.refresh.click();
    await p.library.locator('.login').waitFor({ timeout: 10000 });
    await p.input.fill(DAILY_URL);
    await p.input.press('Enter');
    await waitFor(async () => /login needs a refresh/.test(await textOf(p.error)), { timeout: 20000, message: 'AUTH_EXPIRED' });

    // The user logs in on soundcloud.com; the background sees the cookie change and tells the room tab.
    await stub(A, () => { self.stub.loggedIn = true; self.stub.loginExpired = false; self.stub.clear(); });
    const { response } = await sendToRoom(A, tabA, { type: 'sc:login-changed' });
    assert.deepEqual(response, { ok: true });
    await p.entry('Weekly Wave').waitFor({ timeout: 10000 });
    await waitFor(async () => (await textOf(p.title)) === 'Daily Drops', { timeout: 20000, message: 'Daily Drops preview' });
    assert.ok((await stubMessages(A, 'sc:library')).some((m) => m.msg.refresh === true), 'library reloaded, bypassing the cache');
    await closePanel(page);
  });

  test('a second browser that has not joined gets NOT_JOINED', { timeout: 240000 }, async () => {
    B = await launch({ extensionDir: variant.dir, args: ['--autoplay-policy=user-gesture-required'] });
    // In this fresh profile w2g's consent manager (InMobi) can slide in at any moment and swallow clicks; a real
    // user answered it long ago. The join dialog doesn't depend on it.
    await B.context.route(/^https:\/\/cmp\.inmobi\.com\//, (route) => route.abort());
    pageB = await B.context.newPage();
    await gotoRetry(pageB, `https://w2g.tv/en/room/?room_id=${sk}`);
    // w2g's consent dialog can show up late, and the join dialog waits behind it.
    await waitFor(async () => {
      await dismissW2gConsent(pageB, { timeout: 500 });
      return pageB.locator('#intro-modal #w2g-join-button').isVisible();
    }, { timeout: 60000, interval: 500, message: 'join dialog on B' });
    const hello = await helloFor(B, (r) => r.streamkey === sk, 'room:hello from B');
    tabB = hello.tabId;
    assert.equal(hello.joined, false);

    // The join dialog explains it: not joined, and not "can't reach w2g".
    const ping = await sendToRoom(B, tabB, { type: 'room:ping' });
    assert.deepEqual(ping.response, { ok: true, streamkey: sk, joined: false, roomName: ping.response.roomName, unreachable: false });
    const add = await sendToRoom(B, tabB, { type: 'room:add', jobId: 'b-1', items: data.soulhack.slice(0, 1), title: 'x' });
    assert.equal(add.response.ok, false);
    assert.equal(add.response.error.code, 'NOT_JOINED');
    assert.equal(add.response.error.added, 0);

    // The room UI without the join dialog but without membership (e.g. an expired session): a failed check can't
    // tell that from a network problem, so the panel says it can't reach the room and keeps checking.
    await pageB.evaluate(() => {
      document.querySelector('#intro-modal').classList.add('hidden');
      document.querySelector('#site-dimmer').classList.add('hidden');
      document.body.classList.remove('w2g-modal-open');
    });
    await loadInPanel(pageB, SET_URL);
    const p = panel(pageB);
    await waitFor(async () => /Can't reach this room on w2g/.test(await textOf(p.banner)), { timeout: 10000, message: 'not-joined banner' });
    assert.equal(await p.add.isDisabled(), true);
    await shot(pageB, '28-not-joined');
    // The background hears the same: an add would get W2G_UNREACHABLE (retryable) rather than "click Join".
    const pong = await sendToRoom(B, tabB, { type: 'room:ping' });
    assert.deepEqual(pong.response, { ok: true, streamkey: sk, joined: false, roomName: pong.response.roomName, unreachable: true });

    await openRoom(pageB, sk, { nick: 'scw2g-member' });
    await helloFor(B, (r) => r.tabId === tabB && r.joined, 'B joined');
    await settleRoom(pageB);
  });

  test('a member gets MODERATED while the owner has locked the playlist', { timeout: 240000 }, async () => {
    assert.ok(pageB, 'needs the joined member from the previous test');
    const p = panel(pageB);
    await setModeration(page, sk, true);
    try {
      await waitFor(() => pageB.evaluate(() => document.body.classList.contains('mod-pl-active')), { timeout: 30000, message: 'mod-pl-active on B' });
      const add = await sendToRoom(B, tabB, { type: 'room:add', jobId: 'b-2', items: data.soulhack.slice(0, 2), title: 'Soulhack' });
      assert.equal(add.response.ok, false, JSON.stringify(add.response));
      assert.equal(add.response.error.code, 'MODERATED');
      assert.equal(add.response.error.added, 0);

      await loadInPanel(pageB, SET_URL);
      await waitFor(async () => /locked the playlist/.test(await textOf(p.banner)), { timeout: 10000, message: 'moderated banner' });
      assert.equal(await p.add.isDisabled(), true);
      await shot(pageB, '29-moderated');

      // The owner is not affected.
      const owner = await sendToRoom(A, tabA, { type: 'room:add', jobId: 'a-locked', items: data.soulhack.slice(7, 8), title: 'x' });
      assert.equal(owner.response.ok, true, JSON.stringify(owner.response));
    } finally {
      await setModeration(page, sk, false);
    }
    await waitFor(async () => !(await p.banner.isVisible().catch(() => false)), { timeout: 30000, message: 'banner gone after unlock' });
    assert.equal(await p.add.isDisabled(), false);
  });

  test('production build: closed shadow roots, launcher still works', { timeout: 240000 }, async () => {
    const prod = buildVariant(data.stub, { openShadow: false });
    const C = await launch({ extensionDir: prod.dir });
    try {
      const pageC = await C.context.newPage();
      await openRoom(pageC, sk, { nick: 'scw2g-closed' });
      await settleRoom(pageC);
      await waitFor(() => launcherAfterSearch(pageC), { timeout: 10000, message: 'launcher in production build' });
      assert.equal(await pageC.evaluate(() => document.querySelector('scw2g-launcher').shadowRoot), null);
      // A fresh profile gets w2g's consent dialog, at times only after openRoom stopped looking for it. It covers the
      // page, so the click never happens (no double toggle when retried).
      await retry(async () => {
        await dismissW2gConsent(pageC, { timeout: 2000 });
        await pageC.locator('scw2g-launcher').click({ timeout: 5000 });
      }, { tries: 4, delay: 500, label: 'click the launcher' });
      await waitFor(async () => (await stubMessages(C, 'sc:library')).length > 0, { timeout: 10000, message: 'panel opened (library requested)' });
      await sleep(800);
      await shot(pageC, '30-closed-shadow-panel');
    } finally {
      await C.close();
      prod.cleanup();
    }
  });
});
