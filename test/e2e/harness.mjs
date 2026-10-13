// End-to-end test helpers: launch Chromium (or Brave) with the unpacked extension, create and join
// throwaway w2g rooms, read a room's playlist, and mock personalized SoundCloud API responses.
//
// Env:
//   BROWSER=brave      use the installed Brave instead of Playwright's Chromium
//   BRAVE_PATH=...     Brave executable (default /opt/brave-bin/brave)
//   HEADED=1           show the browser window
//
// Note: networks with frequent interface changes (e.g. Docker creating veth devices) make Chromium abort
// in-flight requests with net::ERR_NETWORK_CHANGED, so navigation and API helpers here retry.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXT_DIR = path.join(ROOT, 'extension');
export const FIXTURES = path.join(ROOT, 'test/fixtures');
const BRAVE_PATH = process.env.BRAVE_PATH || '/opt/brave-bin/brave';

export const W2G_API = 'https://w2g-api.w2g.tv';

// Public SoundCloud test data (verified 2026-10-13).
export const SC = {
  track: 'https://soundcloud.com/forss/flickermood',          // id 293
  track2: 'https://soundcloud.com/forss/city-ports',          // id 290
  set: 'https://soundcloud.com/forss/sets/soulhack',          // id 18, 11 tracks (5 hydrated + 6 stubs)
  station: 'https://soundcloud.com/discover/sets/track-stations:293', // system playlist, ~46 stubs, anonymous
  privateTrack: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
  user: 'https://soundcloud.com/forss',
  likes: 'https://soundcloud.com/forss/likes',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 30000, interval = 250, message = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${message}` + (last instanceof Error ? `: ${last.message}` : ''));
}

export async function retry(fn, { tries = 4, delay = 1500, label = 'operation' } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) { err = e; await sleep(delay); }
  }
  throw new Error(`${label} failed after ${tries} tries: ${err && err.message}`);
}

/**
 * Launches a fresh persistent profile with the extension loaded.
 * Returns { context, extensionId, getServiceWorker(), close() }.
 */
export async function launch({ browser = process.env.BROWSER || 'chromium', extensionDir = EXT_DIR, headless = !process.env.HEADED, args = [] } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scw2g-e2e-'));
  const opts = {
    headless,
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, ...args],
  };
  if (browser === 'brave') opts.executablePath = BRAVE_PATH;
  else opts.channel = 'chromium';
  const context = await chromium.launchPersistentContext(userDataDir, opts);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(sw.url()).host;
  return {
    context,
    extensionId,
    browser,
    userDataDir,
    /** The current service worker (it may have been restarted since launch). */
    async getServiceWorker() {
      const live = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`));
      if (live) return live;
      return context.waitForEvent('serviceworker', { timeout: 20000 });
    },
    async close() {
      await context.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function gotoRetry(page, url, { tries = 4, waitUntil = 'domcontentloaded' } = {}) {
  return retry(async () => page.goto(url, { waitUntil, timeout: 60000 }), { tries, label: `goto ${url}` });
}

/** w2g's InMobi consent dialog ("AGREE"). */
export async function dismissW2gConsent(page, { timeout = 5000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const btn = page.locator('button:has-text("AGREE")').first();
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); return true; }
    await sleep(300);
  }
  return false;
}

/** SoundCloud's OneTrust banner and the sign-in prompts it shows anonymous visitors. */
export async function dismissSoundCloudOverlays(page, { timeout = 6000 } = {}) {
  const t0 = Date.now();
  let did = false;
  while (Date.now() - t0 < timeout) {
    const reject = page.locator('#onetrust-reject-all-handler');
    if (await reject.isVisible().catch(() => false)) { await reject.click().catch(() => {}); did = true; }
    const close = page.locator('.modal.auth-modal .modal__closeButton');
    if (await close.isVisible().catch(() => false)) { await close.click().catch(() => {}); did = true; }
    if (await dismissSoundCloudSignIn(page)) did = true;
    if (did) return true;
    await sleep(300);
  }
  return did;
}

/**
 * Removes SoundCloud's newer sign-in overlay (an iframe to secure.soundcloud.com/web-auth inside
 * .webAuthContainerWrapper), which pops up for anonymous visitors after some interactions and swallows pointer
 * events. Logged-in users never see it, so tests may simply remove it. Returns true if one was removed.
 */
export async function dismissSoundCloudSignIn(page) {
  return page.evaluate(() => {
    const wrappers = document.querySelectorAll('.webAuthContainerWrapper');
    wrappers.forEach((w) => w.remove());
    return wrappers.length > 0;
  }).catch(() => false);
}

/**
 * Hides SoundCloud's sign-in prompts for anonymous visitors (that overlay and the older .modal.auth-modal) for good
 * in every soundcloud.com document of the context: they can also pop up in the middle of a test (e.g. after
 * anonymous playback), long after the page was opened and cleaned up.
 */
export async function hideSoundCloudSignIn(context) {
  await context.addInitScript(() => {
    if (location.hostname !== 'soundcloud.com') return;
    const style = document.createElement('style');
    style.textContent = '.webAuthContainerWrapper, .modal.auth-modal { display: none !important; }';
    // Init scripts run before the parser has created <html>.
    if (document.documentElement) {
      document.documentElement.append(style);
      return;
    }
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      document.documentElement.append(style);
    }).observe(document, { childList: true });
  });
}

/** Opens a room page and makes sure this browser session has joined it (clicks "Join the Room" if asked). */
export async function openRoom(page, streamkey, { nick = 'scw2g-e2e', tries = 4 } = {}) {
  const url = `https://w2g.tv/en/room/?room_id=${streamkey}`;
  for (let i = 0; i < tries; i++) {
    const synced = page.waitForResponse((r) => r.url().startsWith(`${W2G_API}/rooms/${streamkey}/sync_state`) && r.status() === 200, { timeout: 45000 }).catch(() => null);
    try {
      if (i === 0) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      else await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) { /* retried below */ }
    await dismissW2gConsent(page, { timeout: 3000 });
    for (let k = 0; k < 30; k++) {
      const join = page.locator('#intro-modal #w2g-join-button');
      if (await join.isVisible().catch(() => false)) {
        await page.fill('#intro-nickname', nick).catch(() => {});
        await join.click().catch(() => {});
        break;
      }
      const joined = await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/sync_state/.test(e.name))).catch(() => false);
      if (joined) break;
      await sleep(500);
    }
    if (!(await synced)) continue;
    const ok = await page.waitForSelector('.w2g-playlists select option[value]:not([value=""])', { state: 'attached', timeout: 20000 }).catch(() => null);
    if (ok) return page;
  }
  throw new Error(`could not open/join room ${streamkey}`);
}

/** Creates a throwaway anonymous room (the same API call w2g's "Create your room" button makes) and joins it. */
export async function createRoom(context, { nick = 'scw2g-e2e' } = {}) {
  const page = await context.newPage();
  await gotoRetry(page, 'https://w2g.tv/en/');
  await dismissW2gConsent(page);
  const streamkey = await retry(async () => page.evaluate(async (api) => {
    const r = await fetch(api + '/rooms/create.json', {
      method: 'POST', credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!r.ok) throw new Error('create.json HTTP ' + r.status);
    return (await r.json()).streamkey;
  }, W2G_API), { label: 'create room' });
  await openRoom(page, streamkey, { nick });
  return { page, streamkey };
}

/** The selected playlist of a room as [{id,url,title,thumb,...}], read through w2g's API from a joined page. */
export async function roomItems(page, streamkey) {
  return retry(async () => page.evaluate(async ({ api, sk }) => {
    const get = async (u) => {
      const r = await fetch(u, { credentials: 'include', cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u);
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    };
    const st = await get(`${api}/rooms/${sk}/sync_state`);
    let key = null;
    for (const [name, v] of st.state || []) if (name === 'playlists') key = v.payload.selectedPlaylist;
    if (!key) throw new Error('no selected playlist');
    return (await get(`${api}/streams/${sk}/playlists/${key}/playlist_items`)) || [];
  }, { api: W2G_API, sk: streamkey }), { label: 'read room items' });
}

/** Waits until the room playlist has at least `count` items; returns them. */
export async function waitForRoomItems(page, streamkey, count, { timeout = 90000 } = {}) {
  let items = [];
  await waitFor(async () => {
    items = await roomItems(page, streamkey);
    return items.length >= count;
  }, { timeout, interval: 1500, message: `${count} room items` });
  return items;
}

const consentBlocked = new WeakSet();

/**
 * Opens a SoundCloud page and clears consent/sign-in overlays. The consent manager (OneTrust, loaded from
 * cdn.cookielaw.org) is blocked for the whole context: in a fresh test profile its banner can fade in seconds after
 * load and swallow clicks, while a real user has answered it long ago.
 */
export async function openSoundCloud(context, url, { page } = {}) {
  if (!consentBlocked.has(context)) {
    consentBlocked.add(context);
    await context.route(/^https:\/\/(cdn\.cookielaw\.org|geolocation\.onetrust\.com)\//, (route) => route.abort());
    await hideSoundCloudSignIn(context);
  }
  const p = page || await context.newPage();
  // On a network that drops in-flight requests, SoundCloud's app can fail to boot: its service worker then shows an
  // offline page (button.reload-button), or the page falls back to "Sorry! Something went wrong". Load it again.
  await retry(async () => {
    await gotoRetry(p, url);
    const state = await p.waitForFunction(() => {
      if (document.querySelector('button.reload-button') || /Sorry! Something went wrong/.test((document.body && document.body.innerText) || '')) return 'failed';
      return document.querySelector('.playControls') ? 'app' : false;
    }, null, { timeout: 45000, polling: 500 }).then((h) => h.jsonValue(), () => 'timeout');
    if (state !== 'app') throw new Error(`SoundCloud did not boot (${state})`);
  }, { tries: 3, label: `open ${url}` });
  await dismissSoundCloudOverlays(p);
  return p;
}

/** Opens an extension page (e.g. popup/popup.html) in a normal tab. */
export async function openExtensionPage(context, extensionId, rel) {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/${rel}`);
  return p;
}

export function fixture(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
}

/**
 * Copies extension/ to a temp dir and overwrites files, e.g. to run the real content scripts against a stub
 * background: buildExtensionVariant({ 'background/main.js': stubSource }).
 * Returns { dir, cleanup() }; pass `dir` as launch({ extensionDir }).
 */
export function buildExtensionVariant(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scw2g-ext-'));
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  for (const [rel, content] of Object.entries(overrides)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Simulates a logged-in SoundCloud user: sets an oauth_token cookie (read by the extension through
 * chrome.cookies) and answers selected api-v2 paths from `handlers`; everything else goes to the real API.
 * handlers: { [pathnameOrRegExpSource]: (url: URL, request) => ({ status?, json }) | null }
 * Returns { calls } where calls lists {url, authorization} of every api-v2 request seen.
 */
export async function mockSoundCloudLogin(context, { token = 'e2e-fake-token', handlers = {} } = {}) {
  await context.addCookies([{ name: 'oauth_token', value: token, domain: 'soundcloud.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' }]);
  const calls = [];
  const entries = Object.entries(handlers).map(([k, fn]) => [k.startsWith('^') ? new RegExp(k) : k, fn]);
  await context.route('https://api-v2.soundcloud.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push({ url: req.url(), authorization: req.headers()['authorization'] || null });
    for (const [key, fn] of entries) {
      const hit = key instanceof RegExp ? key.test(url.pathname) : key === url.pathname;
      if (!hit) continue;
      const out = await fn(url, req);
      if (out) {
        return route.fulfill({ status: out.status || 200, contentType: 'application/json', body: JSON.stringify(out.json ?? {}) });
      }
    }
    // A fake token makes the real API answer 401 even on public endpoints: strip it before passing through.
    const headers = { ...req.headers() };
    delete headers.authorization;
    return route.continue({ headers });
  });
  return { calls };
}
