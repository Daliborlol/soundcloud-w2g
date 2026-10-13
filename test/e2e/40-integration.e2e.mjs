// Full-chain integration: the real background, the real content scripts and the real SoundCloud client, against
// a real w2g room and real SoundCloud pages. The only changes to the production build: the room panel's shadow
// root is opened so Playwright can reach it, and the personalized SoundCloud endpoints are mocked for a fake
// logged-in user (Weekly Wave), because the tests have no real SoundCloud account.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SC, launch, buildExtensionVariant, createRoom, openRoom, roomItems, waitForRoomItems, openSoundCloud,
  mockSoundCloudLogin, openExtensionPage, fixture, waitFor, sleep, retry, dismissSoundCloudSignIn,
} from './harness.mjs';

const TIMEOUT = 5 * 60 * 1000;
const TOKEN = 'e2e-integration-token';
const SHOTS = process.env.SCW2G_SHOTS || null;
const FAIL_SHOTS = SHOTS || path.join(ROOT, 'test-results', 'integration');
const PRIVATE_ITEM_URL = 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw&secret_token=s-8Pjrp';

/** Production code, except that both content scripts render into open shadow roots Playwright can reach. */
function buildVariant() {
  const flip = (rel, from, to) => {
    const src = fs.readFileSync(path.join(ROOT, 'extension', rel), 'utf8');
    const out = src.replace(from, to);
    assert.notEqual(out, src, `${from} not found in ${rel}`);
    return out;
  };
  return buildExtensionVariant({
    'content/w2g-room.js': flip('content/w2g-room.js', "const SHADOW_MODE = 'closed';", "const SHADOW_MODE = 'open';"),
    'content/soundcloud.js': flip('content/soundcloud.js', "const TOAST_SHADOW_MODE = 'closed';", "const TOAST_SHADOW_MODE = 'open';"),
  });
}

function loggedInHandlers() {
  const me = fixture('sc/SYNTHETIC-me.json');
  const weekly = fixture('sc/SYNTHETIC-system-playlist-weekly-wave.json');
  const daily = fixture('sc/SYNTHETIC-system-playlist-daily-drops.json');
  const pick = (s) => (/weekly/.test(s) ? weekly : /new-for-you/.test(s) ? daily : null);
  return {
    '/me': () => ({ json: me }),
    '/mixed-selections': () => ({ json: fixture('sc/SYNTHETIC-mixed-selections-logged-in.json') }),
    '/me/library/all': () => ({ json: fixture('sc/SYNTHETIC-me-library-all.json') }),
    '/me/play-history/contexts': () => ({ json: fixture('sc/SYNTHETIC-me-play-history-contexts.json') }),
    [`/users/${me.id}/playlists_without_albums`]: () => ({ json: fixture('sc/user-playlists-without-albums.json') }),
    '/resolve': (url) => {
      const target = url.searchParams.get('url') || '';
      const hit = /\/discover\/sets\//.test(target) ? pick(target) : null;
      return hit ? { json: hit } : null;
    },
    '^/system-playlists/': (url) => {
      const hit = pick(decodeURIComponent(url.pathname));
      return hit ? { json: hit } : null;
    },
  };
}

function panel(page) {
  const root = page.locator('scw2g-panel');
  return {
    root: root.locator('.panel'),
    input: root.locator('input.url'),
    title: root.locator('.preview .title').first(),
    add: root.locator('.preview .add'),
    result: root.locator('.preview .result'),
    error: root.locator('.preview .error'),
    entry: (text) => root.locator('.entry', { hasText: text }),
  };
}

/** Current preview title, or '' (short timeout so polling loops stay responsive). */
const previewTitle = (page) => panel(page).title.innerText({ timeout: 2000 }).catch(() => '');

async function openPanel(page) {
  const visible = () => page.locator('scw2g-panel .panel').isVisible().catch(() => false);
  if (!(await visible())) await page.locator('scw2g-launcher button').click();
  await waitFor(visible, { timeout: 10000, message: 'panel open' });
}

async function closePanel(page) {
  const visible = () => page.locator('scw2g-panel .panel').isVisible().catch(() => false);
  if (await visible()) {
    await panel(page).input.focus();
    await page.keyboard.press('Escape');
  }
  await waitFor(async () => !(await visible()), { timeout: 5000, message: 'panel closed' });
}

/** Reads N from the preview's "Add N tracks" button. */
async function addCount(page) {
  const text = await panel(page).add.innerText();
  const m = text.match(/Add (\d+) tracks?/);
  assert.ok(m, `unexpected add button text: ${text}`);
  return Number(m[1]);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
}

/** Closes w2g's own modal (invite dialog) and install banner so they don't cover our UI. */
async function settleRoom(page) {
  await waitFor(() => page.evaluate(() => {
    if (document.body.classList.contains('w2g-modal-open')) {
      const dimmer = document.querySelector('#site-dimmer');
      if (dimmer) dimmer.click();
      return false;
    }
    return true;
  }), { timeout: 15000, message: 'w2g modal closed' });
  const dismiss = page.locator('#w2g-pwa-banner-android .w2g-pwa-dismiss');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});
}

/** The last items of the room equal `expected` (url, title, and thumb wherever one was sent), in order. */
function assertTail(items, expected, label) {
  const tail = items.slice(-expected.length);
  const view = (list) => list.map((it, i) => [it.url, it.title, expected[i].thumb ? it.thumb : null]);
  assert.deepEqual(view(tail), view(expected), label);
}

/** Clears SoundCloud's consent banner/filter and anonymous sign-in overlay (tests run logged out). */
async function clearScOverlays(sc) {
  const reject = sc.locator('#onetrust-reject-all-handler');
  if (await reject.isVisible().catch(() => false)) await reject.click().catch(() => {});
  await dismissSoundCloudSignIn(sc);
  await sc.evaluate(() => {
    // A lingering consent filter (".onetrust-pc-dark-filter") swallows clicks even after the banner is answered.
    for (const el of document.querySelectorAll('#onetrust-consent-sdk .onetrust-pc-dark-filter, #onetrust-consent-sdk #onetrust-banner-sdk')) el.remove();
  }).catch(() => {});
}

async function toastText(page, re, { timeout = 90000 } = {}) {
  let last = '';
  await waitFor(async () => {
    const texts = await page.locator('.w2g-toasts .toast .text').allInnerTexts().catch(() => []);
    last = texts.join(' | ');
    return texts.some((t) => re.test(t));
  }, { timeout, interval: 500, message: `toast ${re} (saw: ${last})` });
}

/** Wraps a test body: on failure, screenshots every open page and dumps the frame URLs before rethrowing. */
function withDiagnostics(name, fn, getBrowser) {
  return async (t) => {
    try {
      await fn(t);
    } catch (err) {
      const browser = getBrowser();
      if (browser) {
        fs.mkdirSync(FAIL_SHOTS, { recursive: true });
        const slug = name.replace(/[^a-z0-9]+/gi, '-').slice(0, 50);
        for (const [i, p] of browser.context.pages().entries()) {
          await p.screenshot({ path: path.join(FAIL_SHOTS, `FAIL-${slug}-${i}.png`) }).catch(() => {});
          console.log(`[diagnostics] page ${i}: ${p.url()}`);
          const hosts = await p.evaluate(() => ({
            launchers: document.querySelectorAll('scw2g-launcher').length,
            panels: document.querySelectorAll('scw2g-panel').length,
            titles: [...document.querySelectorAll('scw2g-panel')].map((h) => h.shadowRoot && h.shadowRoot.querySelector('.preview .title') && h.shadowRoot.querySelector('.preview .title').textContent),
          })).catch(() => null);
          if (hosts) console.log(`[diagnostics]   hosts: ${JSON.stringify(hosts)}`);
          for (const f of p.frames()) if (f !== p.mainFrame()) console.log(`[diagnostics]   frame: ${f.url().slice(0, 160)}`);
        }
      }
      throw err;
    }
  };
}

describe('integration: real background + content scripts + w2g + SoundCloud', { timeout: 30 * 60 * 1000 }, () => {
  let variant;
  let browser;
  let room;
  let ext; // an extension page used to talk to the background like the popup does

  const expandViaBackground = async (url) => {
    const res = await ext.evaluate((u) => chrome.runtime.sendMessage({ type: 'sc:expand', url: u }), url);
    assert.ok(res && res.ok, `sc:expand ${url} failed: ${JSON.stringify(res && res.error)}`);
    return res.result;
  };

  before(async () => {
    variant = buildVariant();
    browser = await launch({ extensionDir: variant.dir });
    room = await createRoom(browser.context);
    await settleRoom(room.page);
    ext = await openExtensionPage(browser.context, browser.extensionId, 'popup/popup.html');
  });

  after(async () => {
    if (browser) await browser.close();
    if (variant) variant.cleanup();
  });

  test('Weekly Wave (mocked login): picked in the panel, every playable track lands in the room in order', { timeout: TIMEOUT }, withDiagnostics('Weekly Wave (mocked login): picked in the panel, every playable track lands in the room in order', async () => {
    const mock = await mockSoundCloudLogin(browser.context, { token: TOKEN, handlers: loggedInHandlers() });
    try {
      const page = room.page;
      await page.bringToFront();
      await openPanel(page);
      const p = panel(page);
      await p.entry('Weekly Wave').first().waitFor({ timeout: 30000 });
      await shot(page, 'int-library');
      await p.entry('Weekly Wave').first().click();
      await waitFor(async () => (await previewTitle(page)) === 'Weekly Wave', { timeout: 30000, message: 'Weekly Wave preview' });
      const n = await addCount(page);
      const expected = (await expandViaBackground('https://soundcloud.com/discover/sets/weekly::w2g-test-user')).items;
      assert.equal(n, expected.length);
      assert.ok(n >= 15, `expected most of the 30 Weekly Wave tracks to be playable, got ${n}`);

      const before = (await roomItems(page, room.streamkey)).length;
      await p.add.click();
      const items = await waitForRoomItems(page, room.streamkey, before + n);
      assert.equal(items.length, before + n);
      assertTail(items, expected, 'Weekly Wave items in order');
      await waitFor(async () => /Added/.test(await p.result.innerText().catch(() => '')), { timeout: 15000, message: 'result line' });
      await shot(page, 'int-weekly-added');

      // The personal playlist was requested with the user's token, and the token never left api-v2.
      const authed = mock.calls.filter((c) => /weekly/.test(decodeURIComponent(c.url)));
      assert.ok(authed.length > 0, 'Weekly Wave was requested');
      assert.ok(authed.every((c) => c.authorization === `OAuth ${TOKEN}`), 'Weekly Wave requests carried the OAuth token');
      await closePanel(page);
    } finally {
      await browser.context.unrouteAll({ behavior: 'ignoreErrors' });
      await browser.context.clearCookies({ name: 'oauth_token' });
    }
  }, () => browser));

  test("a set link pasted into w2g's own search box opens the panel and adds the whole set", { timeout: TIMEOUT }, withDiagnostics("a set link pasted into w2g's own search box opens the panel and adds the whole set", async (t) => {
    const page = room.page;
    await page.bringToFront();
    const expected = (await expandViaBackground(SC.set)).items;
    assert.equal(expected.length, 11);

    await settleRoom(page);
    if (!(await page.locator('#w2g-content-search input[type=text]').isVisible().catch(() => false))) {
      // w2g occasionally re-renders its top bar; a reload brings it back (and re-runs our content script).
      await openRoom(page, room.streamkey);
      await settleRoom(page);
    }
    // A real (trusted) paste: the extension ignores synthetic events and editing commands that page scripts could
    // run, and leaves typed text plus Enter to w2g, so there is no other way in.
    const search = '#w2g-content-search input[type=text]';
    await page.click(search);
    await page.fill(search, '');
    await browser.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://w2g.tv' }).catch(() => {});
    const copied = await page.evaluate((text) => navigator.clipboard.writeText(text).then(() => true, () => false), SC.set);
    if (!copied) {
      t.skip('this browser gives the test no clipboard access, so a real paste is impossible');
      return;
    }
    await page.keyboard.press('ControlOrMeta+V');
    const p = panel(page);
    await waitFor(async () => (await previewTitle(page)) === 'Soulhack', { timeout: 30000, message: 'Soulhack preview after paste' });
    assert.equal(await addCount(page), 11);

    const before = (await roomItems(page, room.streamkey)).length;
    await p.add.click();
    const items = await waitForRoomItems(page, room.streamkey, before + 11);
    assertTail(items, expected, 'Soulhack items in set order');
    await page.locator('#w2g-content-pane-container button[data-event*="closePane"]').click().catch(() => {});
    await closePanel(page);
  }, () => browser));

  test('soundcloud.com: the playlist header button queues the whole set into the room', { timeout: TIMEOUT }, withDiagnostics('soundcloud.com: the playlist header button queues the whole set into the room', async () => {
    const expected = (await expandViaBackground(SC.set)).items;
    const sc = await openSoundCloud(browser.context, SC.set);
    room.scPage = sc;
    await waitFor(() => sc.evaluate(() => document.documentElement.hasAttribute('data-w2g-room')), { timeout: 20000, message: 'room gating on' });
    const hero = sc.locator('.listenEngagement .w2g-add').first();
    await hero.waitFor({ state: 'visible', timeout: 30000 });

    const before = (await roomItems(room.page, room.streamkey)).length;
    await clearScOverlays(sc);
    await hero.click();
    await toastText(sc, /^Added 11 tracks/);
    await shot(sc, 'int-sc-set-added');
    const items = await waitForRoomItems(room.page, room.streamkey, before + 11);
    assertTail(items, expected, 'set from soundcloud.com in order');
  }, () => browser));

  test('soundcloud.com: a track row button queues just that track', { timeout: TIMEOUT }, withDiagnostics('soundcloud.com: a track row button queues just that track', async () => {
    // The set page from the previous test, or a fresh one if that test failed before opening it.
    const sc = room.scPage && !room.scPage.isClosed() ? room.scPage : await openSoundCloud(browser.context, SC.set);
    room.scPage = sc;
    const row = sc.locator('li.trackList__item', { hasText: 'Flickermood' }).first();
    const btn = row.locator('.w2g-add');
    // Row actions only show on hover; SoundCloud may also pop its sign-in overlay over anonymous sessions.
    await retry(async () => {
      await clearScOverlays(sc);
      await row.scrollIntoViewIfNeeded();
      await row.hover({ timeout: 5000 });
      await btn.waitFor({ state: 'visible', timeout: 5000 });
    }, { label: 'hover the Flickermood row' });

    const before = (await roomItems(room.page, room.streamkey)).length;
    await clearScOverlays(sc);
    await btn.click();
    await toastText(sc, /^Added 'Flickermood'/);
    const items = await waitForRoomItems(room.page, room.streamkey, before + 1);
    const last = items[items.length - 1];
    assert.equal(last.url, SC.track);
    assert.match(last.title, /Flickermood/);
    assert.match(last.thumb, /-t500x500\./);
  }, () => browser));

  test('soundcloud.com: the station page button queues the station (system playlist)', { timeout: TIMEOUT }, withDiagnostics('soundcloud.com: the station page button queues the station (system playlist)', async () => {
    const expected = (await expandViaBackground(SC.station)).items;
    assert.ok(expected.length >= 20, `station has ${expected.length} playable tracks`);
    const sc = await openSoundCloud(browser.context, SC.station, { page: room.scPage });
    const btn = sc.locator('.systemPlaylistDetails .w2g-add').first();
    await btn.waitFor({ state: 'visible', timeout: 30000 });

    const before = (await roomItems(room.page, room.streamkey)).length;
    await clearScOverlays(sc);
    await btn.click();
    await toastText(sc, new RegExp(`^Added ${expected.length} tracks`));
    const items = await waitForRoomItems(room.page, room.streamkey, before + expected.length);
    assertTail(items, expected, 'station items in order');
  }, () => browser));

  test("a private (secret link) track is added in the widget-safe form and plays in w2g's player", { timeout: TIMEOUT }, withDiagnostics("a private (secret link) track is added in the widget-safe form and plays in w2g's player", async (t) => {
    const page = room.page;
    await page.bringToFront();
    await openPanel(page);
    const p = panel(page);
    await p.input.fill(SC.privateTrack);
    await p.input.press('Enter');
    // SoundCloud's title for this (yt-dlp test) track is "Youtube - Dl Test Video '' Ä↭".
    await waitFor(async () => /Dl Test Video/i.test(await previewTitle(page)), { timeout: 30000, message: 'private track preview' });
    const before = (await roomItems(page, room.streamkey)).length;
    await p.add.click();
    const items = await waitForRoomItems(page, room.streamkey, before + 1);
    assert.equal(items[items.length - 1].url, PRIVATE_ITEM_URL);
    await closePanel(page);

    // Play it like a user: open the playlist tab and click the item. w2g's player may still hold widgets of
    // earlier items, so wait for the one that carries this track's token (and click once more if it doesn't come).
    await page.locator('#w2g-sidebar-playlist').dispatchEvent('mousedown');
    const link = page.locator(`.w2g-playlists:not(#playlist-modal) a[href="${PRIVATE_ITEM_URL}"]`).first();
    const findWidget = () => page.frames().find((f) => /^https:\/\/w\.soundcloud\.com\/player\/.*secret_token=s-8Pjrp/.test(f.url()));
    const widgetText = (w) => w.evaluate(() => document.body.innerText).catch(() => '');
    // Up to 5 plays: on networks that drop in-flight requests (this test host), the widget iframe can stay blank,
    // and w2g's player never retries it; clicking the item again recreates it.
    const aborted = new Set(); // widget assets the browser dropped with ERR_NETWORK_CHANGED
    const onFailed = (req) => {
      const failure = req.failure();
      if (failure && /ERR_NETWORK_CHANGED/.test(failure.errorText) && /^https:\/\/(w\.soundcloud\.com|widget\.sndcdn\.com)\//.test(req.url())) aborted.add(req.url());
    };
    page.on('requestfailed', onFailed);
    let widget = null;
    let text = '';
    for (let i = 0; i < 5 && !/Dl Test Video|not provided a valid|couldn't find|not available/i.test(text); i++) {
      await retry(async () => {
        await link.scrollIntoViewIfNeeded();
        await link.click();
      }, { label: 'click private item' });
      widget = await waitFor(findWidget, { timeout: 40000, message: 'SoundCloud widget frame for the private track' }).catch(() => null);
      if (!widget) continue;
      text = await waitFor(async () => {
        const t = await widgetText(widget);
        return /Dl Test Video|not provided a valid|couldn't find|not available/i.test(t) ? t : null;
      }, { timeout: 40000, message: 'widget rendered the track' }).catch(() => '');
    }
    page.off('requestfailed', onFailed);
    assert.ok(widget, 'no widget for the private track; frames: ' + JSON.stringify(page.frames().map((f) => f.url().slice(0, 140))));
    await shot(page, 'int-private-playing');
    if (!text && aborted.size) {
      // The item is right (checked above) and w2g created the widget for it; the widget's own scripts never loaded.
      t.skip(`the SoundCloud widget's scripts were aborted by network changes (ERR_NETWORK_CHANGED): ${[...aborted].slice(0, 3).join(', ')}`);
      return;
    }
    assert.match(text, /Dl Test Video/i, `widget text: ${text.slice(0, 200)}`);
  }, () => browser));

  test('popup shows the room as the target', { timeout: TIMEOUT }, withDiagnostics('popup shows the room as the target', async () => {
    const res = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'rooms:get' }));
    assert.ok(res.ok);
    assert.equal(res.rooms.length, 1);
    assert.equal(res.rooms[0].streamkey, room.streamkey);
    assert.equal(res.rooms[0].joined, true);
    assert.equal(res.target && res.target.streamkey, room.streamkey);
    await ext.reload();
    await waitFor(async () => (await ext.locator('body').innerText()).includes(room.streamkey) || (await ext.locator('body').innerText()).includes('Temporary Room'), { timeout: 10000, message: 'popup lists the room' });
    await shot(ext, 'int-popup');
  }, () => browser));
});
