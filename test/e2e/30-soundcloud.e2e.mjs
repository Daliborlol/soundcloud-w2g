// E2E tests for the soundcloud.com content script (content/soundcloud.js + soundcloud.css). The background is
// replaced by a stub (stubs/soundcloud-bg.js) that scripts the room registry and the replies to 'queue', so these
// tests need neither w2g nor SoundCloud's API.
//
// Four suites, each with its own browser:
//   1. Real SoundCloud pages. The toasts' shadow root is opened (TOAST_SHADOW_MODE) so Playwright can read them.
//   2. The unmodified production script on synthetic soundcloud.com pages: closed toast root, trusted input only,
//      no room name or streamkey in the page, localized Webi track headers.
//   3. Synthetic pages, readable toasts: the background stops or the extension reloads in the middle of a job.
//   4. Synthetic pages, readable toasts: the toast actions that add tracks ignore clicks the user couldn't see
//      (the toast made transparent or covered by a page script, or not on screen for 500 ms yet).
//
// Optional: SCW2G_SHOTS=<dir> saves screenshots of every context and toast state into <dir>;
// SCW2G_DEBUG=1 logs the steps with timestamps.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launch, buildExtensionVariant, gotoRetry, waitFor, sleep, SC, ROOT, hideSoundCloudSignIn } from './harness.mjs';

const STUB = fs.readFileSync(path.join(ROOT, 'test/e2e/stubs/soundcloud-bg.js'), 'utf8');
const SHOTS = process.env.SCW2G_SHOTS || '';
const DEBUG = Boolean(process.env.SCW2G_DEBUG);
const ROOM = { tabId: 4242, streamkey: 'stubroomkey123', joined: true, roomName: 'Temporary Room', lastActive: 1 };
const OTHER_ROOM = { ...ROOM, tabId: 4243, streamkey: 'mgdrhxkxkb05e3ktsq', lastActive: 2 };
const TIMEOUT = 240000;
const CHECK_PLAYLIST = "Check the room's playlist before trying again.";
const STILL_ADDING = "The room tab may still be adding the rest. Check the room's playlist in a minute before adding it again.";

let variant;
let browser;
let page;

// --- helpers ------------------------------------------------------------------------------------------------

const STARTED = Date.now();
function debug(...args) {
  if (DEBUG) console.log(`[${((Date.now() - STARTED) / 1000).toFixed(1)}s]`, ...args);
}

/** The production content script, except that its toasts render into an open shadow root Playwright can read. */
function readableToasts() {
  const src = fs.readFileSync(path.join(ROOT, 'extension/content/soundcloud.js'), 'utf8');
  const out = src.replace("const TOAST_SHADOW_MODE = 'closed';", "const TOAST_SHADOW_MODE = 'open';");
  assert.notEqual(out, src, 'TOAST_SHADOW_MODE line not found in content/soundcloud.js');
  return out;
}

/**
 * Runs fn inside the stub service worker, where `stub` is the control object. A stopped worker only answers once
 * something wakes it (Playwright keeps its old handle), so don't wait forever.
 */
async function bg(fn, arg) {
  const sw = await browser.getServiceWorker();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the stub background did not answer within 30 s')), 30000);
  });
  try {
    return await Promise.race([sw.evaluate(fn, arg), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const queued = () => bg(() => stub.messages('queue'));

const withRoom = () => bg((room) => stub.setRooms([room]), ROOM);

/** What the content script must send for a link found in SoundCloud's DOM: the query (?in=...) dropped. */
function canonical(href) {
  const u = new URL(href, 'https://soundcloud.com');
  const kind = /^\/discover\/sets\//.test(u.pathname) ? 'system-playlist'
    : /^\/[^/]+\/sets\/[^/]+/.test(u.pathname) ? 'playlist' : 'track';
  return { kind, url: 'https://soundcloud.com' + u.pathname.replace(/\/$/, '') };
}

/**
 * hideSoundCloudSignIn() only hides SoundCloud's anonymous sign-in modal: it stays open, the next click anywhere
 * closes it, and closing it starts playback. Close it with a click beside the page's content and undo that
 * playback, so that it isn't blamed on a test's own click.
 */
async function closeHiddenSignIn() {
  const modal = page.locator('.modal.auth-modal');
  if (!(await modal.count())) return;
  const wasPlaying = (await playerState()).playing;
  await page.mouse.click(5, 450);
  await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  if (wasPlaying) return;
  await page.waitForSelector('.playControls__play.playing', { timeout: 3000 }).catch(() => {});
  await pause();
}

/** SoundCloud's sign-in modal and cookie banner come and go during the first seconds; wait until calm. */
async function settle(ms = 8000) {
  await closeHiddenSignIn();
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < ms && quiet < 3) {
    let acted = false;
    for (const sel of ['#onetrust-reject-all-handler', '.modal.auth-modal .modal__closeButton']) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        acted = true;
      }
    }
    quiet = acted ? 0 : quiet + 1;
    await sleep(400);
  }
}

/** Navigates and waits for `ready`; retries because a network change can leave SoundCloud's offline page. */
async function open(url, ready) {
  for (let attempt = 1; ; attempt++) {
    try {
      debug('open', url, 'attempt', attempt);
      await gotoRetry(page, url);
      // SoundCloud's service worker answers failed navigations with an offline page (button.reload-button).
      await page.waitForSelector(`${ready}, button.reload-button`, { state: 'attached', timeout: 30000 });
      if (await page.locator('button.reload-button').count()) throw new Error('SoundCloud offline page');
      break;
    } catch (err) {
      debug('open failed', err.message.split('\n')[0]);
      if (attempt >= 4) throw err;
      await sleep(1000);
    }
  }
  await settle();
  debug('opened', url);
}

async function ensure(url, ready) {
  if (page.url().split('?')[0] !== url) await open(url, ready);
  else await page.waitForSelector(ready, { state: 'attached', timeout: 30000 });
}

const playerState = () => page.evaluate(() => ({
  playing: Boolean(document.querySelector('.playControls__play.playing')),
  track: (document.querySelector('a.playbackSoundBadge__titleLink') || { getAttribute: () => null }).getAttribute('href'),
}));

/** Anonymous SoundCloud starts playing when its sign-in modal is closed; start each check from silence. */
async function pause() {
  const button = page.locator('.playControls__play.playing');
  if (await button.isVisible().catch(() => false)) {
    await button.click().catch(() => {});
    await page.waitForSelector('.playControls__play.playing', { state: 'detached', timeout: 5000 }).catch(() => {});
  }
}

/**
 * Clicks an "Add to w2g" control and returns the single resulting queue message. Asserts the click neither
 * navigated nor changed playback (rows start playback and tiles navigate on bubbling clicks).
 */
async function clickAndCapture(locator, { onClicked, real = true } = {}) {
  debug('click', String(locator));
  if (real) await settle(1500);
  const before = (await queued()).length;
  const url = page.url();
  const player = real ? await playerState() : null;
  await locator.click();
  if (onClicked) await onClicked();
  await waitFor(async () => (await queued()).length > before, { timeout: 10000, message: 'a queue message' });
  await sleep(700); // time for a leaked click to start playback or navigate
  const after = await queued();
  assert.equal(after.length, before + 1, 'exactly one queue message per click');
  assert.equal(page.url(), url, 'the click must not navigate');
  if (real) assert.deepEqual(await playerState(), player, 'the click must not start or stop playback');
  const entry = after[before];
  assert.match(entry.msg.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(entry.msg.confirmed, undefined);
  return entry;
}

async function expectQueued(locator, source, options) {
  const entry = await clickAndCapture(locator, options);
  assert.deepEqual(entry.msg.source, source);
  assert.equal(entry.frameId, 0);
  return entry;
}

/** Every mount holds at most one of our buttons, and no playlist badge got two toolbars. */
function audit(target = page) {
  return target.evaluate(() => {
    const perMount = new Map();
    for (const b of document.querySelectorAll('.w2g-add')) {
      const mount = b.parentElement.classList.contains('w2g-node') ? b.parentElement.parentElement : b.parentElement;
      perMount.set(mount, (perMount.get(mount) || 0) + 1);
    }
    const groups = [...document.querySelectorAll('.soundBadge__additional')].map((m) => m.querySelectorAll(':scope > .soundBadge__actions').length);
    return {
      buttons: document.querySelectorAll('.w2g-add').length,
      maxPerMount: Math.max(0, ...perMount.values()),
      maxGroups: Math.max(0, ...groups),
      menuEntries: Math.max(0, ...[...document.querySelectorAll('.moreActions__group')].map((g) => g.querySelectorAll('.w2g-add-menu').length)),
      toastHosts: document.querySelectorAll('.w2g-toasts').length,
    };
  });
}

async function assertNoDuplicates(target = page) {
  const a = await audit(target);
  assert.ok(a.buttons > 0, 'buttons were injected');
  assert.equal(a.maxPerMount, 1, 'one button per mount');
  assert.ok(a.maxGroups <= 1, 'one toolbar per badge');
  assert.ok(a.menuEntries <= 1, 'one entry per menu');
  assert.ok(a.toastHosts <= 1, 'one toast host');
  return a;
}

const displayOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display, sel);

const rowByTitle = (title) => page.locator('.trackItem', { has: page.locator('a.trackItem__trackTitle', { hasText: title }) }).first();

const toasts = (target = page) => target.locator('.w2g-toasts .toast:not(.leaving)');

async function toastText(toast, expected, { detail } = {}) {
  await waitFor(async () => (await toast.locator('.text').innerText()) === expected, {
    timeout: 10000,
    message: `toast text "${expected}" (got "${await toast.locator('.text').innerText().catch(() => '?')}")`,
  });
  if (detail !== undefined) assert.equal(await toast.locator('.detail').innerText(), detail);
}

const actionsOf = (toast) => toast.locator('.action').allInnerTexts();

/**
 * Clicks a toast action like a user does: "Add" and "Try again" ignore clicks until they have been on screen for
 * 500 ms, and the pointer rests on the button for a moment first (hovering must not hide it from that check).
 */
async function clickAction(toast, label) {
  const button = toast.locator('.action', { hasText: label });
  await button.waitFor({ state: 'visible', timeout: 10000 });
  await sleep(600);
  await button.hover();
  await sleep(250);
  await button.click();
}

/** Closes a toast with a real click and waits until that toast is gone (others may auto-hide meanwhile). */
async function closeToast(toast) {
  await toast.evaluate((t) => { t.dataset.closing = 'test'; });
  await toast.locator('.close').click();
  await waitFor(async () => (await page.locator('.w2g-toasts .toast[data-closing]:not(.leaving)').count()) === 0, { timeout: 3000, message: 'toast closed' });
}

/** Closes every toast left over from earlier steps (real clicks), so a test can count its own. */
async function clearToasts() {
  for (let i = 0; i < 10 && (await toasts().count()); i++) {
    await toasts().first().locator('.close').click({ timeout: 2000 }).catch(() => {}); // it may auto-hide meanwhile
  }
  assert.equal(await toasts().count(), 0, 'no leftover toasts');
}

/** The detail line is shown in full (not cut off by its line clamp). */
const detailFits = (toast) => toast.locator('.detail').evaluate((d) => d.scrollHeight <= d.clientHeight + 1);

async function heldJob(count = 1) {
  const ids = await waitFor(async () => {
    const held = await bg(() => stub.heldJobs());
    return held.length >= count && held;
  }, { timeout: 10000, message: 'held queue jobs' });
  return ids[ids.length - 1];
}

/** What the page looks like to the content script, for failure messages. */
const pageState = () => page.evaluate(() => JSON.stringify({
  url: location.href,
  room: document.documentElement.hasAttribute('data-w2g-room'),
  buttons: document.querySelectorAll('.w2g-add').length,
  rows: [...document.querySelectorAll('.trackItem')].slice(0, 12).map((r) => `${(r.querySelector('a.trackItem__trackTitle') || {}).textContent}:${r.querySelectorAll('.w2g-add').length}`),
})).catch((err) => `(no page state: ${err.message})`);

/** Waits until a button can be clicked again after its brief "sent" state. */
async function ready(button) {
  await button.waitFor({ state: 'attached', timeout: 10000 }).catch(async (err) => {
    throw new Error(`${err.message.split('\n')[0]}; page: ${await pageState()}`);
  });
  await waitFor(async () => !(await button.evaluate((b) => b.classList.contains('w2g-sent'))), { timeout: 5000, message: 'button ready' });
}

async function shot(name, target) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(250); // let enter animations finish
  const file = path.join(SHOTS, `${name}.png`);
  if (!target) {
    await page.screenshot({ path: file });
    return;
  }
  const box = await target.boundingBox().catch(() => null);
  if (!box) return;
  const pad = 16;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({ path: file, clip: { x, y, width: box.width + 2 * pad, height: box.height + 2 * pad } });
}

/** SoundCloud renders the theme named by its sc_theme cookie (overwritten here with SoundCloud's attributes). */
async function setTheme(theme) {
  await browser.context.addCookies([{ name: 'sc_theme', value: theme, domain: '.soundcloud.com', path: '/', secure: false, sameSite: 'Lax' }]);
  await page.evaluate((t) => localStorage.setItem('V2::local::theme', JSON.stringify({ theme: t })), theme);
}

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// --- synthetic soundcloud.com pages -------------------------------------------------------------------------

const SYNTHETIC_SET = '/forss/sets/soulhack';
const SYNTHETIC_ROWS = [['Flickermood', '/forss/flickermood'], ['City Ports', '/forss/city-ports']];

/** A classic set page reduced to what the content script looks at: the hero and two track rows with More buttons. */
function setPage() {
  const rows = SYNTHETIC_ROWS.map(([title, href], i) => `
    <li class="trackList__item"><div class="trackItem">
      <a class="trackItem__trackTitle" href="${href}?in=forss/sets/soulhack">${title}</a>
      <div class="trackItem__actions"><div class="sc-button-group">
        <button class="sc-button-like sc-button">Like</button>
        <button class="sc-button-more sc-button" aria-owns="dropdown-button-${i + 1}">More</button>
      </div></div>
    </div></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Soulhack</title></head>
<body class="theme-dark" style="margin:0;min-height:100vh;background:#121212;color:#fff;font:14px sans-serif">
<div class="fullHero__title"><h1><a class="soundTitle__title" href="${SYNTHETIC_SET}">Soulhack</a></h1></div>
<div class="listenEngagement"><div class="listenEngagement__actions"><div class="sc-button-group">
  <button class="sc-button-like sc-button">Like</button>
</div></div></div>
<ul class="trackList__list">${rows}</ul>
</body></html>`;
}

/** Opens a row's More menu the way SoundCloud does: a .dropdownMenu portaled to <body> (page main world). */
function openRowMenu(index) {
  return page.evaluate((i) => {
    const menu = document.createElement('div');
    menu.className = 'dropdownMenu';
    menu.id = `dropdown-button-${i}`;
    menu.innerHTML = '<div class="moreActions"><div class="moreActions__group">' +
      '<button class="sc-button-addtoset sc-button">Add to playlist</button>' +
      '<a class="sc-button-report sc-button" href="/pages/report-content?content_urn=soundcloud%3Atracks%3A293&amp;content_permalink_url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood">Report</a>' +
      '</div></div>';
    document.body.appendChild(menu);
  }, index);
}

// Webi's logged-in track header, as rendered by its current build (assets.web.soundcloud.cloud, 2026-10): a
// <section> labelled in the browser's language, whose footer Stack holds outlined MUI IconButtons; the last one is
// the DesktopMenu More button (id desktop-menu-button-<useId>, aria-haspopup). Comment menus use variant="ghost".
const WEBI_LABELS = {
  fr: { header: 'En-tête du titre', share: 'Partager', copy: 'Copier le lien', repost: 'Republier', add: 'Ajouter à la playlist', more: "Plus d'actions", comments: 'Commentaires' },
  es: { header: 'Encabezado de pista', share: 'Compartir', copy: 'Copiar enlace', repost: 'Volver a publicar', add: 'Añadir a lista', more: 'Más acciones', comments: 'Comentarios' },
};
const MUI_ICON_BUTTON = 'MuiButtonBase-root MuiIconButton-root MuiIconButton-colorContrast MuiIconButton-sizeMedium css-1ib2x7q';

function webiPage(lang, { onlyMore = false } = {}) {
  const l = WEBI_LABELS[lang];
  const button = (label, extra = '') => `<button class="${MUI_ICON_BUTTON}" variant="outlined" tabindex="0" type="button" aria-label="${label}"${extra}><svg width="24" height="24"></svg></button>`;
  const actions = onlyMore ? [] : [button(l.share), button(l.copy), button(l.repost), button(l.add)];
  actions.push(button(l.more, ' id="desktop-menu-button-«r5»" aria-haspopup="true"'));
  return `<!doctype html><html lang="${lang}" class="mui-theme-dark"><head><meta charset="utf-8"><title>Flickermood</title>
<style>.MuiStack-root{display:flex;gap:8px;align-items:center} .MuiIconButton-root{width:40px;height:40px;border-radius:50%;border:1px solid #777;background:none;color:#fff}</style></head>
<body style="margin:0;background:#121212;color:#fff;font:14px sans-serif">
<section aria-label="${l.header}" class="MuiStack-root css-14nvvb1">
  <h1>Flickermood</h1>
  <div class="MuiStack-root css-1kf6k2i"><div class="MuiStack-root css-1ah3n5l">${actions.join('')}</div></div>
</section>
<section aria-label="${l.comments}" class="MuiStack-root">
  <div class="MuiStack-root"><span>Nice track</span><button class="MuiButtonBase-root MuiIconButton-root css-ghost" variant="ghost" type="button" id="desktop-menu-button-«r9»" aria-haspopup="true" aria-label="${l.more}"></button></div>
</section>
</body></html>`;
}

/** Launches a browser in which every soundcloud.com document is synthetic: Webi pages under /n/, else setPage(). */
async function launchSynthetic(contentScript) {
  const overrides = { 'background/main.js': STUB };
  if (contentScript) overrides['content/soundcloud.js'] = contentScript;
  variant = buildExtensionVariant(overrides);
  browser = await launch({ extensionDir: variant.dir });
  await browser.context.route('https://soundcloud.com/**', (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    const url = new URL(req.url());
    const html = url.pathname.startsWith('/n/')
      ? webiPage(url.searchParams.get('lang') || 'fr', { onlyMore: url.searchParams.has('only-more') })
      : setPage();
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  page = await browser.context.newPage();
}

async function openSynthetic(url = 'https://soundcloud.com' + SYNTHETIC_SET) {
  await page.goto(url);
  await page.waitForSelector('.w2g-add', { state: 'attached', timeout: 15000 });
}

// --- 1. real SoundCloud pages -------------------------------------------------------------------------------

describe('soundcloud.com content script', { timeout: 30 * 60000 }, () => {
  before(async () => {
    variant = buildExtensionVariant({ 'background/main.js': STUB, 'content/soundcloud.js': readableToasts() });
    browser = await launch({ extensionDir: variant.dir });
    // A real user answered SoundCloud's consent banner (OneTrust) long ago. In a fresh profile it shows up even with
    // a pre-set OptanonAlertBoxClosed cookie and swallows clicks, so it isn't loaded at all (like openSoundCloud()).
    await browser.context.route(/^https:\/\/(cdn\.cookielaw\.org|geolocation\.onetrust\.com)\//, (route) => route.abort());
    await browser.context.addCookies([{ name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.soundcloud.com', path: '/', secure: true, sameSite: 'Lax' }]);
    await hideSoundCloudSignIn(browser.context);
    page = await browser.context.newPage();
  });

  after(async () => {
    await browser?.close();
    variant?.cleanup();
  });

  test('buttons stay hidden until a w2g room tab is registered and follow rooms:changed', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await bg(() => stub.setRooms([], null));
    await open(SC.set, '.listenEngagement .w2g-add');
    await page.waitForSelector('.trackItem .w2g-add', { state: 'attached' });
    const hero = page.locator('.listenEngagement .w2g-add');
    const [hello] = await waitFor(() => bg(() => stub.messages('rooms:get')).then((m) => m.length && m), { message: 'rooms:get at start' });
    assert.equal(hello.frameId, 0);
    assert.equal(hello.url, SC.set);
    await sleep(500);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-w2g-room')), false);
    assert.equal(await hero.isVisible(), false);
    assert.equal(await displayOf('.trackItem .w2g-add'), 'none');
    await shot('gating-no-room', page.locator('.listenEngagement__actions'));

    await bg((room) => stub.setRooms([room]), ROOM);
    await hero.waitFor({ state: 'visible', timeout: 5000 });
    assert.notEqual(await displayOf('.trackItem .w2g-add'), 'none');
    // The page's own scripts can read these attributes: they never name the room.
    assert.equal(await hero.getAttribute('title'), 'Add to w2g');
    assert.equal(await hero.getAttribute('aria-label'), 'Add to w2g');
    await shot('gating-room', page.locator('.listenEngagement__actions'));

    await bg(() => stub.setRooms([], null));
    await hero.waitFor({ state: 'hidden', timeout: 5000 });

    // A missed broadcast is caught up when the tab becomes visible again.
    await bg((room) => stub.setRooms([room], room, { broadcast: false }), ROOM);
    await sleep(300);
    assert.equal(await hero.isVisible(), false);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await hero.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('Temporary Room')), false, 'no room name in the page');
  });

  test('set page: the hero and the track rows queue canonical URLs without playing or navigating', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await ensure(SC.set, '.trackItem .w2g-add');
    await pause();
    await expectQueued(page.locator('.listenEngagement .w2g-add'), { kind: 'playlist', url: SC.set });

    const row = rowByTitle('Flickermood');
    assert.match(await row.locator('a.trackItem__trackTitle').getAttribute('href'), /\?in=forss\/sets\/soulhack$/);
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await shot('set-row-hover', row);
    await expectQueued(row.locator('.w2g-add'), { kind: 'track', url: SC.track });

    const row2 = rowByTitle('City Ports');
    await row2.hover();
    const entry = await clickAndCapture(row2.locator('.w2g-add'), {
      onClicked: async () => {
        assert.equal(await row2.locator('.w2g-add').evaluate((b) => b.classList.contains('w2g-sent')), true, 'immediate feedback');
        await shot('set-row-sent', row2);
      },
    });
    assert.deepEqual(entry.msg.source, { kind: 'track', url: SC.track2 });

    const perRow = await page.evaluate(() => [...document.querySelectorAll('.trackItem')]
      .filter((r) => r.querySelector('.trackItem__actions'))
      .map((r) => r.querySelectorAll('.w2g-add').length));
    assert.ok(perRow.length >= 10, `rows rendered: ${perRow.length}`);
    assert.ok(perRow.every((n) => n === 1), `one button per row: ${perRow}`);
    await shot('set-page');
  });

  test('More menu: the "Add to w2g" entry queues the track with its URN and closes the menu', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await ensure(SC.set, '.trackItem .w2g-add');
    await pause();
    const row = rowByTitle('Funk for Nerds');
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await row.locator('.sc-button-more').click();
    // The entry is already there in the first frame that shows the menu.
    const firstFrame = await page.waitForFunction(() => {
      const group = document.querySelector('body > .dropdownMenu .moreActions__group');
      return group ? { entry: Boolean(group.querySelector('.w2g-add-menu')) } : false;
    }, null, { polling: 'raf', timeout: 10000 });
    assert.deepEqual(await firstFrame.jsonValue(), { entry: true });
    const menu = page.locator('body > .dropdownMenu').filter({ has: page.locator('.w2g-add-menu') });
    const entry = menu.locator('.w2g-add-menu');
    await entry.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await entry.innerText()).trim(), 'Add to w2g');
    assert.equal(await entry.getAttribute('title'), 'Add to w2g');
    assert.equal(await entry.evaluate((e) => e.previousElementSibling.classList.contains('sc-button-addtoset')), true, 'after "Add to Playlist"');
    await shot('menu-row', menu);
    const msg = await clickAndCapture(entry);
    const href = await row.locator('a.trackItem__trackTitle').getAttribute('href');
    assert.equal(msg.msg.source.kind, 'track');
    assert.equal(msg.msg.source.url, canonical(href).url);
    assert.match(msg.msg.source.urn, /^soundcloud:tracks:\d+$/);
    await menu.waitFor({ state: 'detached', timeout: 5000 });
    assert.equal((await audit()).menuEntries, 0);
  });

  test('bottom player and Next up queue: buttons queue their track, leave playback alone, and toasts stay beside the open queue', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await ensure(SC.set, '.trackItem .w2g-add');
    if (!(await playerState()).playing) {
      const row = rowByTitle('Soulhack');
      await row.hover();
      await row.locator('.sc-button-play').click();
    }
    const button = page.locator('.playControls .playbackSoundBadge .w2g-add');
    await button.waitFor({ state: 'visible', timeout: 20000 });
    await settle(3000); // anonymous playback may open the sign-in modal
    const href = await page.locator('a.playbackSoundBadge__titleLink').getAttribute('href');
    await shot('player', page.locator('.playbackSoundBadge'));
    await expectQueued(button, canonical(href));
    assert.equal(canonical(href).kind, 'track');
    const host = () => page.evaluate(() => document.querySelector('.w2g-toasts').style.cssText);
    assert.match(await host(), /right: 16px; bottom: 64px/);

    await page.locator('.playbackSoundBadge__showQueue').click();
    const item = page.locator('.queue .queueItemView').filter({ has: page.locator('.w2g-add') }).first();
    await item.waitFor({ state: 'visible', timeout: 10000 });
    await item.hover();
    await shot('queue-item', item);
    const itemHref = await item.locator('.queueItemView__title a').getAttribute('href');
    await expectQueued(item.locator('.w2g-add'), canonical(itemHref));
    const box = await item.locator('.queueItemView__actions').boundingBox();
    const itemBox = await item.boundingBox();
    assert.ok(box.x >= itemBox.x && box.x + box.width <= itemBox.x + itemBox.width + 1, 'queue actions fit the row');

    // The toast must not cover the Next up rows the user is working in (sc-5).
    const panel = await page.locator('.playControls .queue').boundingBox();
    const toastBox = await toasts().last().boundingBox();
    assert.ok(toastBox, 'the toast is shown');
    assert.ok(!overlap(toastBox, panel), `toast ${JSON.stringify(toastBox)} must not overlap the queue ${JSON.stringify(panel)}`);
    assert.ok(toastBox.x + toastBox.width <= panel.x, 'the stack sits left of the queue');
    await shot('queue-toast', null);

    await page.locator('.playbackSoundBadge__showQueue').click();
    await waitFor(async () => /right: 16px; bottom: 64px/.test(await host()), { timeout: 5000, message: 'stack back in the corner' });
    await pause();
  });

  test('track page: hero, related-track badges and playlist badges', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await open(SC.track, '.listenEngagement .w2g-add');
    await pause();
    await shot('track-hero', page.locator('.listenEngagement__actions'));
    await expectQueued(page.locator('.listenEngagement .w2g-add'), { kind: 'track', url: SC.track });

    // The hero's More menu resolves to the page (track 293).
    await page.locator('.listenEngagement .sc-button-more').click();
    const heroEntry = page.locator('body > .dropdownMenu .w2g-add-menu');
    await heroEntry.waitFor({ state: 'visible', timeout: 10000 });
    await shot('menu-hero', page.locator('body > .dropdownMenu').filter({ has: heroEntry }));
    const heroMsg = await clickAndCapture(heroEntry);
    assert.deepEqual(heroMsg.msg.source, { kind: 'track', url: SC.track, urn: 'soundcloud:tracks:293' });

    const badge = page.locator('.relatedSoundsModule .soundBadge').filter({ has: page.locator('.w2g-add') }).first();
    await badge.scrollIntoViewIfNeeded();
    await badge.hover();
    await shot('badge-track', badge);
    const href = await badge.locator('a.soundTitle__title').getAttribute('href');
    await expectQueued(badge.locator('.w2g-add'), canonical(href));

    const playlist = page.locator('.soundBadge.playlist').filter({ has: page.locator('.w2g-group') }).first();
    await playlist.scrollIntoViewIfNeeded();
    await playlist.hover();
    await shot('badge-playlist', playlist);
    const plHref = await playlist.locator('a.soundTitle__title').getAttribute('href');
    assert.equal(canonical(plHref).kind, 'playlist');
    await expectQueued(playlist.locator('.w2g-add'), canonical(plHref));
    await assertNoDuplicates();
  });

  test('profile: track and playlist cards', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await open(SC.user, '.sound .w2g-add');
    await pause();
    const cards = page.locator('.soundList__item .sound').filter({ has: page.locator('.sound__soundActions .w2g-add') });
    const trackCard = cards.filter({ hasNot: page.locator('a.soundTitle__title[href*="/sets/"]') }).first();
    await trackCard.scrollIntoViewIfNeeded();
    await shot('card-track', trackCard.locator('.sound__soundActions'));
    const href = await trackCard.locator('a.soundTitle__title').getAttribute('href');
    await expectQueued(trackCard.locator('.sound__soundActions .w2g-add'), canonical(href));

    const playlistCard = cards.filter({ has: page.locator('a.soundTitle__title[href*="/sets/"]') }).first();
    await playlistCard.scrollIntoViewIfNeeded();
    await shot('card-playlist', playlistCard);
    const plHref = await playlistCard.locator('a.soundTitle__title').getAttribute('href');
    assert.equal(canonical(plHref).kind, 'playlist');
    await expectQueued(playlistCard.locator('.sound__soundActions .w2g-add'), canonical(plHref));
    await assertNoDuplicates();

    // SoundCloud's narrowest layout has no room in track cards (the More menu keeps the entry); playlist
    // cards have no stats to cover and keep their button.
    const displayIn = (card) => card.locator('.sound__soundActions .w2g-add').evaluate((b) => getComputedStyle(b).display);
    await page.setViewportSize({ width: 1024, height: 900 });
    try {
      await waitFor(async () => (await displayIn(trackCard)) === 'none', { timeout: 5000, message: 'hidden in narrow track cards' });
      assert.notEqual(await displayIn(playlistCard), 'none');
      await trackCard.scrollIntoViewIfNeeded();
      await shot('card-track-1024', trackCard.locator('.sound__footer'));
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  });

  test('system playlist page: labeled hero button and track rows', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await open(SC.station, '.systemPlaylistDetails .w2g-add');
    await pause();
    const hero = page.locator('.systemPlaylistDetails__controls .w2g-add');
    assert.equal((await hero.innerText()).trim(), 'Add to w2g');
    await shot('system-hero', page.locator('.systemPlaylistDetails__controls'));
    await expectQueued(hero, { kind: 'system-playlist', url: SC.station });

    await page.waitForSelector('.systemPlaylistTrackList__item .trackItem .w2g-add', { state: 'attached' });
    const row = page.locator('.systemPlaylistTrackList__item .trackItem').filter({ has: page.locator('.w2g-add') }).first();
    const href = await row.locator('a.trackItem__trackTitle').getAttribute('href');
    assert.match(href, /\?in_system_playlist=/);
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await shot('system-row', row);
    await expectQueued(row.locator('.w2g-add'), canonical(href));
    await assertNoDuplicates();
  });

  test('discover: tile buttons queue what the tile links to without navigating', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await open('https://soundcloud.com/discover', '.playableTile .w2g-add');
    await pause();
    // Carousels only lay out their first slides; pick, per kind, the first tile inside the viewport width.
    const candidates = await page.evaluate(() => [...document.querySelectorAll('.playableTile')].map((tile, index) => {
      const link = tile.querySelector('a.playableTile__mainHeading');
      const rect = tile.getBoundingClientRect();
      const usable = tile.querySelector('.playableTile__actionWrapper .w2g-add') && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
      return usable && link ? { index, href: link.getAttribute('href') } : null;
    }).filter(Boolean));
    const kinds = new Set();
    for (const kind of ['playlist', 'system-playlist', 'track']) {
      const pick = candidates.find((c) => canonical(c.href).kind === kind);
      if (!pick) continue;
      const tile = page.locator('.playableTile').nth(pick.index);
      await tile.scrollIntoViewIfNeeded();
      await tile.locator('.playableTile__artwork').hover();
      await shot(`tile-${kind}`, tile);
      await expectQueued(tile.locator('.playableTile__actionWrapper .w2g-add'), canonical(pick.href));
      kinds.add(kind);
    }
    assert.ok(kinds.size >= 1, 'at least one tile was tested');
    assert.ok(kinds.has('playlist') || kinds.has('system-playlist'), `tile kinds tested: ${[...kinds]}`);
    await assertNoDuplicates();
  });

  test('SPA navigation keeps one button per mount and page-level buttons follow the URL', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await open(SC.set, '.listenEngagement .w2g-add');
    await pause();
    await page.evaluate(() => { window.scw2gNoReload = true; });

    await page.locator('.fullHero__title a[href="/forss"]').first().click();
    await page.waitForURL('https://soundcloud.com/forss', { timeout: 20000 });
    await page.waitForSelector('.sound .w2g-add', { state: 'attached', timeout: 20000 });
    await sleep(800);
    await assertNoDuplicates();

    await page.goBack();
    await page.waitForURL(SC.set, { timeout: 20000 });
    await page.waitForSelector('.listenEngagement .w2g-add', { state: 'attached', timeout: 20000 });
    await sleep(800);
    await assertNoDuplicates();
    await expectQueued(page.locator('.listenEngagement .w2g-add'), { kind: 'playlist', url: SC.set });

    await rowByTitle('Flickermood').locator('a.trackItem__trackTitle').click();
    await page.waitForURL(/\/forss\/flickermood\?in=/, { timeout: 20000 });
    await page.waitForFunction(() => /Flickermood/.test((document.querySelector('.fullHero__title .soundTitle__title') || {}).textContent || ''), null, { timeout: 20000 });
    await page.waitForSelector('.listenEngagement .w2g-add', { state: 'attached', timeout: 20000 });
    await sleep(800);
    await assertNoDuplicates();
    await expectQueued(page.locator('.listenEngagement .w2g-add'), { kind: 'track', url: SC.track });
    assert.equal(await page.evaluate(() => window.scw2gNoReload), true, 'all navigations stayed inside the SPA');
  });

  test('a second injection of the content script is a no-op', { timeout: TIMEOUT }, async () => {
    await withRoom();
    await open(SC.set, '.trackItem .w2g-add');
    await pause();
    const gets = (await bg(() => stub.messages('rooms:get'))).length;
    const injected = await bg(() => stub.inject());
    assert.ok(injected >= 1, 're-injected into the open SoundCloud tab');
    await page.mouse.wheel(0, 1500); // more rows and mutations for any second observer to react to
    await sleep(1500);
    await assertNoDuplicates();
    assert.equal((await bg(() => stub.messages('rooms:get'))).length, gets, 'the second copy did not start');
    await page.mouse.wheel(0, -3000);
    await expectQueued(page.locator('.listenEngagement .w2g-add'), { kind: 'playlist', url: SC.set });
    await waitFor(async () => (await toasts().count()) === 1, { timeout: 5000, message: 'one toast for one click' });
  });

  test('toast: progress for a playlist, then the result with skipped tracks, then auto-hide', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const toast = toasts().last();
    await toastText(toast, "Adding 'Soulhack' to w2g…");
    assert.equal(await toast.getAttribute('role'), 'status');
    await shot('toast-pending', toast);
    const jobId = await heldJob();

    await bg((id) => stub.progress(id, { phase: 'resolving', title: 'Soulhack (Deluxe)' }), jobId);
    await toastText(toast, "Adding 'Soulhack (Deluxe)' to w2g…");
    await bg((id) => stub.progress(id, { phase: 'adding', done: 12, total: 34 }), jobId);
    await toastText(toast, 'Adding 34 tracks… 12/34', { detail: 'Soulhack (Deluxe)' });
    await waitFor(async () => (await toast.locator('.fill').evaluate((f) => f.style.width)) === '35%', { message: 'progress bar' });
    await shot('toast-progress', toast);

    await bg((id) => stub.release(id, {
      added: 32,
      title: 'Soulhack',
      skipped: [{ title: 'A', reason: 'geo_blocked' }, { title: 'B', reason: 'geo_blocked' }],
    }), jobId);
    await toastText(toast, 'Added 32 tracks to Temporary Room', { detail: 'Soulhack · 2 skipped (not available in your country)' });
    await shot('toast-success', toast);
    await toast.waitFor({ state: 'detached', timeout: 9000 });

    // A single track names the track; mixed skip reasons and warnings are spelled out.
    const row = rowByTitle('Flickermood');
    await row.hover();
    await bg(() => stub.enqueue({ result: { added: 1, title: 'Flickermood' } }));
    await row.locator('.w2g-add').click();
    await toastText(toasts().last(), "Added 'Flickermood' to Temporary Room");
    await ready(hero);
    await bg(() => stub.enqueue({ result: {
      added: 997,
      title: 'Huge',
      skipped: [{ reason: 'preview_only' }, { reason: 'preview_only' }, { reason: 'not_embeddable' }],
      warnings: ['truncated'],
    } }));
    await hero.click();
    await toastText(toasts().last(), 'Added 997 tracks to Temporary Room', {
      detail: 'Huge · 3 skipped (2 Go+ preview only, 1 embedding disabled)\nOnly the first 1,000 tracks were added.',
    });
    await shot('toast-success-details', toasts().last());
  });

  test('toast: a job waiting in the room tab says so; stalls and playlist switches report what was added and offer no retry', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');

    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    let jobId = await heldJob();
    let toast = toasts().last();
    await bg((id) => stub.progress(id, { phase: 'adding', done: 0, total: 120, title: 'Soulhack' }), jobId);
    await toastText(toast, 'Adding 120 tracks… 0/120');
    await bg((id) => stub.progress(id, { phase: 'queued', done: 0, total: 120, title: 'Soulhack', position: 2 }), jobId);
    await toastText(toast, "Waiting for the room's current add to finish… (position 2)", { detail: 'Soulhack · 120 tracks' });
    assert.equal(await toast.locator('.bar').isVisible(), false);
    await shot('toast-queued', toast);
    await bg((id) => stub.progress(id, { phase: 'adding', done: 50, total: 120 }), jobId);
    await toastText(toast, 'Adding 120 tracks… 50/120', { detail: 'Soulhack' });
    await bg((id) => stub.release(id, { error: { code: 'ROOM_STALLED', message: 'stalled', added: 50 } }), jobId);
    await toastText(toast, 'The w2g room tab stopped responding', {
      detail: "50 tracks were added before this happened. Check the room's playlist, then reload the room tab.",
    });
    assert.deepEqual(await actionsOf(toast), []);
    await shot('toast-stalled', toast);
    await closeToast(toast);

    // Stalled while still waiting: nothing was added, and the room tab was told to drop the job.
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    jobId = await heldJob();
    toast = toasts().last();
    await bg((id) => stub.progress(id, { phase: 'queued', done: 0, total: 1, title: 'Soulhack', position: 1 }), jobId);
    await toastText(toast, "Waiting for the room's current add to finish… (position 1)", { detail: 'Soulhack' });
    await bg((id) => stub.release(id, { error: { code: 'ROOM_STALLED', message: 'stalled', added: 0 } }), jobId);
    await toastText(toast, 'The w2g room tab stopped responding', { detail: "Adding was stopped. Check the room's playlist, then reload the room tab." });
    assert.deepEqual(await actionsOf(toast), []);
    await closeToast(toast);

    // The room's own count can be ahead of the last progress message.
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    jobId = await heldJob();
    toast = toasts().last();
    await bg((id) => stub.progress(id, { phase: 'adding', done: 50, total: 120, title: 'Soulhack' }), jobId);
    await toastText(toast, 'Adding 120 tracks… 50/120');
    await bg((id) => stub.release(id, { error: { code: 'PLAYLIST_CHANGED', message: 'switched', added: 100 } }), jobId);
    await toastText(toast, "Someone switched the room's playlist", { detail: `100 tracks were added before this happened. ${CHECK_PLAYLIST}` });
    assert.deepEqual(await actionsOf(toast), []);
    await shot('toast-playlist-changed', toast);
    await closeToast(toast);
  });

  test('toast: a big playlist asks first; Add re-sends with confirmed:true and the same jobId, Cancel sends nothing', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');
    await ready(hero);
    await bg(() => stub.enqueue(
      { result: { needsConfirm: true, count: 496, title: 'Stereodose LSD', skippedCount: 3 } },
      { progress: [{ phase: 'adding', done: 250, total: 493 }], stepMs: 1200, result: { added: 493, title: 'Stereodose LSD', skipped: [] } },
      { result: { needsConfirm: true, count: 120, title: 'Another set', skippedCount: 0 } },
    ));
    await hero.click();
    const toast = toasts().last();
    await toastText(toast, 'Add 496 tracks to w2g?', { detail: "Stereodose LSD\n3 tracks can't be played and will be skipped." });
    assert.deepEqual(await actionsOf(toast), ['Add', 'Cancel']);
    await shot('toast-confirm', toast);
    // On a real SoundCloud page, the toast counts as visible (IntersectionObserver v2) and "Add" reacts.
    await clickAction(toast, 'Add');
    await toastText(toast, 'Adding 493 tracks… 250/493', { detail: 'Stereodose LSD' });
    await toastText(toast, 'Added 493 tracks to Temporary Room');
    const [first, second] = await queued();
    assert.equal(first.msg.confirmed, undefined);
    assert.equal(second.msg.confirmed, true);
    assert.equal(second.msg.jobId, first.msg.jobId);
    assert.deepEqual(second.msg.source, first.msg.source);

    await ready(hero);
    await hero.click();
    const toast2 = toasts().filter({ hasText: 'Add 120 tracks to w2g?' });
    await toastText(toast2, 'Add 120 tracks to w2g?', { detail: 'Another set' });
    await toast2.locator('.action', { hasText: 'Cancel' }).click();
    await waitFor(async () => (await toast2.count()) === 0, { timeout: 3000, message: 'toast closed' });
    await sleep(800);
    assert.equal((await queued()).length, 3, 'Cancel sends nothing');
  });

  test('toast: its buttons ignore clicks that a page script fakes', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');
    await ready(hero);
    await bg(() => stub.enqueue({ result: { needsConfirm: true, count: 300, title: 'Big set', skippedCount: 0 } }));
    await hero.click();
    const toast = toasts().filter({ hasText: 'Add 300 tracks to w2g?' });
    await toastText(toast, 'Add 300 tracks to w2g?');
    // This test build opens the shadow root, so the page's main world can reach the buttons; they must not react.
    await page.evaluate(() => {
      const last = [...document.querySelector('.w2g-toasts').shadowRoot.querySelectorAll('.toast')].pop();
      last.querySelector('.action.primary').click();
      last.querySelector('.close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await sleep(800);
    assert.equal((await queued()).length, 1, 'a scripted "Add" sends nothing');
    assert.equal(await toast.count(), 1, 'a scripted close does not close');
    assert.deepEqual(await actionsOf(toast), ['Add', 'Cancel'], 'still asking');
    await toast.locator('.action', { hasText: 'Cancel' }).click();
    await waitFor(async () => (await toast.count()) === 0, { timeout: 3000, message: 'toast closed' });
  });

  test('toast: errors stay until closed, and "Try again" starts a new job', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');
    await ready(hero);
    await bg(() => stub.enqueue(
      { result: { error: { code: 'NOT_JOINED', message: 'room tab not joined' } } },
      { result: { added: 11, title: 'Soulhack' } },
    ));
    await hero.click();
    const toast = toasts().last();
    await toastText(toast, "You haven't joined the w2g room", { detail: 'Open the room tab, click "Join the Room", then try again.' });
    assert.equal(await toast.getAttribute('role'), 'alert');
    await shot('toast-error', toast);
    await sleep(6500);
    assert.equal(await toast.isVisible(), true, 'errors do not auto-hide');
    await toast.locator('.action', { hasText: 'Try again' }).click();
    await toastText(toast, 'Added 11 tracks to Temporary Room');
    const [first, second] = await queued();
    assert.notEqual(second.msg.jobId, first.msg.jobId);
    assert.deepEqual(second.msg.source, first.msg.source);
    await closeToast(toast);
  });

  test('toast: every error code gets a friendly message', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');
    const expected = {
      NO_ROOM: ['No w2g room is open', ['Try again']],
      NOT_JOINED: ["You haven't joined the w2g room", ['Try again']],
      W2G_UNREACHABLE: ["Couldn't reach w2g", ['Try again']],
      MODERATED: ["The room's playlist is locked", []],
      ROOM_UNREACHABLE: ["The w2g room tab isn't responding", ['Try again']],
      ROOM_STALLED: ['The w2g room tab stopped responding', []],
      PLAYLIST_CHANGED: ["Someone switched the room's playlist", []],
      AUTH_REQUIRED: ["Log in to SoundCloud to add 'Soulhack'", []],
      AUTH_EXPIRED: ['Your SoundCloud login has expired', ['Try again']],
      BOT_CHALLENGE: ['SoundCloud wants to check that you are human', ['Try again']],
      RATE_LIMITED: ['Too many requests', []],
      NETWORK: ["Couldn't reach SoundCloud", ['Try again']],
      SC_HTTP: ['SoundCloud returned an error', ['Try again']],
      EMPTY: ["Nothing to add from 'Soulhack'", []],
      NOT_FOUND: ["SoundCloud can't find 'Soulhack'", []],
      INVALID_URL: ["'Soulhack' can't be added to w2g", []],
      UNSUPPORTED_URL: ["'Soulhack' can't be added to w2g", []],
      W2G_FAILED: ["w2g didn't accept the tracks", []],
      CANCELLED: ['Cancelled', []],
      CONTEXT_INVALIDATED: ['SoundCloud for w2g was updated', ['Reload page']],
      CONNECTION_LOST: ['Lost the connection to SoundCloud for w2g', ['Try again']],
      INTERNAL: ['Something went wrong', ['Try again']],
      SOMETHING_NEW: ['Something went wrong', ['Try again']],
    };
    for (const [code, [text, actions]] of Object.entries(expected)) {
      await ready(hero);
      await bg((c) => stub.enqueue({ result: { error: { code: c, message: `stub ${c}`, added: 0 } } }), code);
      await hero.click();
      const toast = toasts().last();
      await toastText(toast, text);
      assert.equal(await toast.getAttribute('role'), 'alert', code);
      assert.ok((await toast.locator('.detail').innerText()).length > 0 || code === 'CANCELLED', `${code} has a hint`);
      assert.deepEqual(await actionsOf(toast), actions, `${code} actions`);
      if (code === 'NOT_FOUND') await shot('toast-error-not-found', toast);
      await closeToast(toast);
    }

    // A failure after tracks were added must not offer a retry that would add them twice.
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const jobId = await heldJob();
    await bg((id) => stub.progress(id, { phase: 'adding', done: 50, total: 120, title: 'Soulhack' }), jobId);
    await toastText(toasts().last(), 'Adding 120 tracks… 50/120');
    await bg((id) => stub.release(id, { error: { code: 'ROOM_UNREACHABLE' } }), jobId);
    const toast = toasts().last();
    await toastText(toast, "The w2g room tab isn't responding", { detail: `50 tracks were added before this happened. ${CHECK_PLAYLIST}` });
    assert.deepEqual(await actionsOf(toast), []);
    await shot('toast-error-partial', toast);
    await closeToast(toast);
  });

  test('toast: progress is still counted while the toast is closed, so a later failure never offers a retry', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    await clearToasts();
    const hero = page.locator('.listenEngagement .w2g-add');

    // Closed before the first batch was reported; 50 of 120 land; then the room tab is reloaded.
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const jobId = await heldJob();
    await bg((id) => stub.progress(id, { phase: 'resolving' }), jobId);
    await closeToast(toasts().last());
    await bg((id) => stub.progress(id, { phase: 'adding', done: 0, total: 120, title: 'Soulhack' }), jobId);
    await bg((id) => stub.progress(id, { phase: 'adding', done: 50, total: 120 }), jobId);
    await sleep(300);
    assert.equal(await toasts().count(), 0, 'progress does not reopen a closed toast');
    await bg((id) => stub.release(id, { error: { code: 'ROOM_UNREACHABLE', message: 'gone' } }), jobId);
    let toast = toasts().last();
    await toastText(toast, "The w2g room tab isn't responding", { detail: `50 tracks were added before this happened. ${CHECK_PLAYLIST}` });
    assert.deepEqual(await actionsOf(toast), []);
    await closeToast(toast);

    // Only the background knows the count (no progress reached this frame).
    await ready(hero);
    await bg(() => stub.enqueue({ result: { error: { code: 'NOT_JOINED', message: 'mid-job', added: 1 } } }));
    await hero.click();
    toast = toasts().last();
    await toastText(toast, "You haven't joined the w2g room", { detail: `1 track was added before this happened. ${CHECK_PLAYLIST}` });
    assert.deepEqual(await actionsOf(toast), []);
    await closeToast(toast);
  });

  test('toast: after the room tab got the job, "Try again" only where its reply proves nothing was added', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    await clearToasts();
    const hero = page.locator('.listenEngagement .w2g-add');
    // The room tab raises NOT_JOINED, NETWORK and W2G_UNREACHABLE only at its check before the next POST, with an
    // exact `added`. Other failures can cut a job off without saying how far it got.
    const expected = {
      NOT_JOINED: ['Open the room tab, click "Join the Room", then try again.', ['Try again']],
      NETWORK: ['Check your connection, then try again.', ['Try again']],
      W2G_UNREACHABLE: ["The room tab can't reach w2g right now. Check your connection, then try again.", ['Try again']],
      ROOM_UNREACHABLE: [`Some tracks may already be in the room. ${CHECK_PLAYLIST}`, []],
      INTERNAL: [`Some tracks may already be in the room. ${CHECK_PLAYLIST}`, []],
    };
    for (const [code, [detail, actions]] of Object.entries(expected)) {
      await ready(hero);
      await bg(() => stub.enqueue({ hold: true }));
      await hero.click();
      const jobId = await heldJob();
      const toast = toasts().last();
      await bg((id) => stub.progress(id, { phase: 'adding', done: 0, total: 120, title: 'Soulhack' }), jobId);
      await toastText(toast, 'Adding 120 tracks… 0/120');
      await bg(([id, c]) => stub.release(id, { error: { code: c, message: 'blip', added: 0 } }), [jobId, code]);
      await waitFor(async () => (await toast.getAttribute('data-state')) === 'error', { timeout: 5000, message: `${code} error` });
      assert.equal(await toast.locator('.detail').innerText(), detail, code);
      assert.deepEqual(await actionsOf(toast), actions, `${code} actions`);
      if (code !== 'W2G_UNREACHABLE') {
        await closeToast(toast);
        continue;
      }
      await shot('toast-w2g-unreachable', toast);
      // The retry is a new job with the same source.
      await bg(() => stub.enqueue({ result: { added: 120, title: 'Soulhack' } }));
      await clickAction(toast, 'Try again');
      await toastText(toast, 'Added 120 tracks to Temporary Room');
      const sent = await queued();
      assert.notEqual(sent.at(-1).msg.jobId, sent.at(-2).msg.jobId);
      assert.deepEqual(sent.at(-1).msg.source, sent.at(-2).msg.source);
      await closeToast(toast);
    }

    // A retry starts from scratch: when it fails before the room tab had it, it gets the same "Try again" as a fresh
    // click (the failed attempt's progress doesn't count for it).
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const jobId = await heldJob();
    const toast = toasts().last();
    await bg((id) => stub.progress(id, { phase: 'adding', done: 0, total: 120, title: 'Soulhack' }), jobId);
    await bg((id) => stub.release(id, { error: { code: 'W2G_UNREACHABLE', message: 'blip', added: 0 } }), jobId);
    await waitFor(async () => (await toast.getAttribute('data-state')) === 'error', { timeout: 5000, message: 'W2G_UNREACHABLE error' });
    await bg(() => stub.enqueue({ result: { error: { code: 'ROOM_UNREACHABLE', message: 'not responding' } } }));
    await clickAction(toast, 'Try again');
    await toastText(toast, "The w2g room tab isn't responding", { detail: 'Reload the room tab, then try again.' });
    assert.deepEqual(await actionsOf(toast), ['Try again']);
    await closeToast(toast);
  });

  test('toast: EMPTY says what was skipped and points Go+ tracks to the setting', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const hero = page.locator('.listenEngagement .w2g-add');
    const goPlus = (n) => Array.from({ length: n }, (_, i) => ({ title: `Go+ ${i}`, reason: 'preview_only' }));
    const cases = [
      [{ skipped: goPlus(1), total: 1 }, 'It\'s a Go+ track: w2g would only play a 30-second preview. To add it anyway, turn off "Skip Go+ previews" in the extension popup.'],
      [{ skipped: goPlus(12), total: 12 }, 'All 12 are Go+ tracks: w2g would only play 30-second previews. To add them anyway, turn off "Skip Go+ previews" in the extension popup.'],
      [{ skipped: [...goPlus(2), { title: 'X', reason: 'geo_blocked' }], total: 3 }, 'None of the tracks can be played in w2g.\n3 skipped (2 Go+ preview only, 1 not available in your country)'],
      [{}, 'None of the tracks can be played in w2g.'],
    ];
    for (const [details, detail] of cases) {
      await ready(hero);
      await bg((d) => stub.enqueue({ result: { error: { code: 'EMPTY', message: 'Nothing playable to add: every track was skipped.', ...d } } }), details);
      await hero.click();
      const toast = toasts().last();
      await toastText(toast, "Nothing to add from 'Soulhack'", { detail });
      assert.equal(await detailFits(toast), true, `the whole hint is visible: ${detail}`);
      assert.deepEqual(await actionsOf(toast), []);
      if (details.total === 1) await shot('toast-empty-go-plus', toast);
      await closeToast(toast);
    }
  });

  test('a click on something that is still being added shows its toast again instead of adding it twice', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    await clearToasts();
    const hero = page.locator('.listenEngagement .w2g-add');
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const jobId = await heldJob();
    await bg((id) => stub.progress(id, { phase: 'adding', done: 5, total: 11, title: 'Soulhack' }), jobId);
    const toast = toasts().last();
    await toastText(toast, 'Adding 11 tracks… 5/11');

    await ready(hero);
    await hero.click();
    await sleep(800);
    assert.equal((await queued()).length, 1, 'no second queue message');
    assert.equal(await toasts().count(), 1, 'no second toast');
    assert.equal(await toast.evaluate((t) => t.classList.contains('nudge')), true, 'the running toast is highlighted');

    // A closed toast comes back with the current state.
    await closeToast(toast);
    await bg((id) => stub.progress(id, { phase: 'adding', done: 8, total: 11 }), jobId);
    await hero.click();
    await toastText(toasts().last(), 'Adding 11 tracks… 8/11', { detail: 'Soulhack' });
    assert.equal((await queued()).length, 1, 'still one queue message');

    await bg((id) => stub.release(id, { added: 11, title: 'Soulhack' }), jobId);
    await toastText(toasts().last(), 'Added 11 tracks to Temporary Room');
    // Once it finished, adding it again is a new job.
    await ready(hero);
    await hero.click();
    await waitFor(async () => (await queued()).length === 2, { timeout: 5000, message: 'a new queue message' });
  });

  test('with two rooms open, the success toast says which one got the tracks', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await bg(([a, b]) => stub.setRooms([b, a], b), [ROOM, OTHER_ROOM]);
    await ensure(SC.set, '.listenEngagement .w2g-add');
    const row = rowByTitle('Flickermood');
    await row.hover();
    assert.equal(await row.locator('.w2g-add').getAttribute('title'), 'Add to w2g');
    await bg(() => stub.enqueue({ result: { added: 1, title: 'Flickermood' } }, { result: { added: 1, title: 'Flickermood' } }));
    await row.locator('.w2g-add').click();
    // Only the start of the streamkey (the popup shows it in full): the whole key is the room's invite key.
    await toastText(toasts().last(), "Added 'Flickermood' to Temporary Room (mgdr…)");
    await shot('toast-two-rooms', toasts().last());

    await withRoom();
    await ready(row.locator('.w2g-add'));
    await row.hover();
    await row.locator('.w2g-add').click();
    await waitFor(async () => (await toasts().locator('.text').allInnerTexts()).includes("Added 'Flickermood' to Temporary Room"), { timeout: 10000, message: 'one-room toast' });
    await clearToasts();
  });

  test('toast: concurrent jobs stack and finish independently', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await ensure(SC.set, '.listenEngagement .w2g-add');
    await clearToasts();
    const hero = page.locator('.listenEngagement .w2g-add');
    await ready(hero);
    await bg(() => stub.enqueue({ hold: true }, { hold: true }, { result: { error: { code: 'MODERATED' } } }));
    await hero.click();
    const first = await heldJob(1);
    const row = rowByTitle('Flickermood');
    await row.hover();
    await ready(row.locator('.w2g-add')); // the previous test clicked it a moment ago
    await row.locator('.w2g-add').click();
    const second = await heldJob(2);
    const row2 = rowByTitle('City Ports');
    await row2.hover();
    await ready(row2.locator('.w2g-add'));
    await row2.locator('.w2g-add').click();
    await waitFor(async () => (await toasts().count()) === 3, { timeout: 5000, message: 'three toasts' });
    await bg((id) => stub.progress(id, { phase: 'adding', done: 5, total: 11 }), first);
    await toastText(toasts().nth(0), 'Adding 11 tracks… 5/11');
    await toastText(toasts().nth(1), "Adding 'Flickermood' to w2g…");
    await toastText(toasts().nth(2), "The room's playlist is locked");
    await page.mouse.move(10, 10);
    await shot('toast-stack', page.locator('.w2g-toasts'));
    await bg((id) => stub.release(id, { added: 1, title: 'Flickermood' }), second);
    await toastText(toasts().nth(1), "Added 'Flickermood' to Temporary Room");
    await bg((id) => stub.release(id, { added: 11, title: 'Soulhack' }), first);
    await toastText(toasts().nth(0), 'Added 11 tracks to Temporary Room');
    await waitFor(async () => (await toasts().count()) === 1, { timeout: 9000, message: 'successes auto-hide, the error stays' });
    await toasts().first().locator('.close').click();
  });

  test('light theme: buttons and toasts follow SoundCloud\'s theme', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await setTheme('light');
    try {
      await open(SC.set, '.listenEngagement .w2g-add');
      assert.equal(await page.evaluate(() => document.body.classList.contains('theme-light')), true);
      await pause();
      await shot('light-hero', page.locator('.listenEngagement__actions'));
      const row = rowByTitle('Flickermood');
      await row.hover();
      await shot('light-row', row);

      const hero = page.locator('.listenEngagement .w2g-add');
      await bg(() => stub.enqueue(
        { hold: true },
        { result: { needsConfirm: true, count: 250, title: 'Big light set', skippedCount: 0 } },
        { result: { error: { code: 'ROOM_UNREACHABLE' } } },
        { result: { added: 11, title: 'Soulhack', skipped: [{ reason: 'geo_blocked' }] } },
      ));
      await hero.click();
      const jobId = await heldJob();
      await bg((id) => stub.progress(id, { phase: 'adding', done: 3, total: 11 }), jobId);
      // One toast per state, each from a different source (a second click on the hero would only re-show its toast).
      const titles = ['Flickermood', 'City Ports', 'Funk for Nerds'];
      for (let i = 0; i < titles.length; i++) {
        const r = rowByTitle(titles[i]);
        await r.hover();
        await r.locator('.w2g-add').click();
        await waitFor(async () => (await toasts().count()) === i + 2, { timeout: 5000, message: `${i + 2} toasts` });
      }
      await toastText(toasts().nth(3), 'Added 11 tracks to Temporary Room');
      const colors = await toasts().first().evaluate((t) => ({ bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t).color }));
      assert.deepEqual(colors, { bg: 'rgb(255, 255, 255)', fg: 'rgb(18, 18, 18)' });
      await page.mouse.move(10, 10);
      await shot('light-toasts', page.locator('.w2g-toasts'));
      await bg((id) => stub.release(id, { added: 11, title: 'Soulhack' }), jobId);
    } finally {
      await setTheme('dark');
    }
  });

  test('Webi iframe (/n/...): the button sits next to Copy link and queues from the iframe', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await open(SC.track, '.listenEngagement .w2g-add');
    await pause();
    const frame = page.frameLocator('#scw2g-webi');
    // Logged-in track pages render this iframe; anonymously it shows "track not found" with the same action row.
    for (let attempt = 1; ; attempt++) {
      await page.evaluate(() => {
        document.getElementById('scw2g-webi')?.remove();
        const el = document.createElement('iframe');
        el.id = 'scw2g-webi';
        el.src = '/n/forss/flickermood?crossfade=true&theme=dark';
        el.style.cssText = 'position: fixed; left: 0; top: 0; width: 1300px; height: 820px; border: 0; z-index: 99999;';
        document.body.appendChild(el);
      });
      try {
        await frame.locator('button[aria-label="Copy link"]').first().waitFor({ state: 'attached', timeout: 30000 });
        break;
      } catch (err) {
        // A network change mid-load leaves SoundCloud's offline page ("Not available while you're offline").
        debug('webi frame not ready:', await frame.locator('body').innerText({ timeout: 2000 }).catch(() => '?'));
        if (attempt >= 3) throw err;
      }
    }
    const button = frame.locator('button.w2g-add').first();
    await button.waitFor({ state: 'visible', timeout: 15000 });
    const placement = await button.evaluate((b) => ({
      prev: b.previousElementSibling && b.previousElementSibling.getAttribute('aria-label'),
      next: b.nextElementSibling && b.nextElementSibling.getAttribute('aria-label'),
      title: b.title,
      disabled: b.disabled || b.classList.contains('Mui-disabled'),
    }));
    assert.equal(placement.next, 'More actions');
    assert.equal(placement.title, 'Add to w2g');
    assert.equal(placement.disabled, false);
    const webiFrame = page.frames().find((f) => f.url().includes('/n/forss/flickermood'));
    await assertNoDuplicates(webiFrame);
    await shot('webi-row', frame.locator('button[aria-label="Copy link"]').first().locator('..'));

    const entry = await clickAndCapture(button);
    assert.deepEqual(entry.msg.source, { kind: 'track', url: SC.track });
    assert.notEqual(entry.frameId, 0, 'sent from the iframe');
    assert.match(entry.url, /\/n\/forss\/flickermood/);

    const toast = toasts(frame).last();
    await toastText(toast, "Added 'Stub track' to Temporary Room");
    const colors = await toast.evaluate((t) => ({ bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t).color }));
    assert.deepEqual(colors, { bg: 'rgb(18, 18, 18)', fg: 'rgb(255, 255, 255)' }, 'Webi dark palette');
    await shot('webi-toast');
  });
});

// --- 2. the production script on synthetic pages ------------------------------------------------------------

describe('soundcloud.com content script as shipped (synthetic pages)', { timeout: 10 * 60000 }, () => {
  before(async () => {
    await launchSynthetic(null); // the unmodified content script: closed toast shadow root
  });

  after(async () => {
    await browser?.close();
    variant?.cleanup();
  });

  test('page scripts can neither click the buttons nor read the toasts, and the page never names the room', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await bg((room) => stub.setRooms([{ ...room, roomName: "Sam's movie night" }]), ROOM);
    await openSynthetic();
    const hero = page.locator('.listenEngagement .w2g-add');
    await hero.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await hero.getAttribute('title'), 'Add to w2g');
    assert.equal(await hero.getAttribute('aria-label'), 'Add to w2g');

    // click() and dispatched events from the page's main world are untrusted: nothing happens.
    await page.evaluate(() => {
      document.querySelector('.listenEngagement .w2g-add').click();
      document.querySelector('.trackItem .w2g-add').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await openRowMenu(1);
    const entry = page.locator('#dropdown-button-1 .w2g-add-menu');
    await entry.waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await entry.getAttribute('title'), 'Add to w2g');
    await page.evaluate(() => document.querySelector('#dropdown-button-1 .w2g-add-menu').click());
    await sleep(800);
    assert.equal((await queued()).length, 0, 'no queue message from scripted clicks');
    assert.equal(await page.locator('.w2g-toasts').count(), 0, 'no toast either');
    assert.equal(await hero.evaluate((b) => b.classList.contains('w2g-sent')), false);

    // Real input works: a mouse click on the menu entry, and the keyboard on the hero button.
    const fromMenu = await clickAndCapture(entry, { real: false });
    assert.deepEqual(fromMenu.msg.source, { kind: 'track', url: SC.track, urn: 'soundcloud:tracks:293' });
    await ready(hero);
    const before = (await queued()).length;
    await hero.focus();
    await page.keyboard.press('Enter');
    await waitFor(async () => (await queued()).length === before + 1, { timeout: 5000, message: 'queue from the keyboard' });
    assert.deepEqual((await queued()).pop().msg.source, { kind: 'playlist', url: 'https://soundcloud.com' + SYNTHETIC_SET });

    // The toasts render, but their shadow root is closed to the page.
    const host = await page.evaluate(() => {
      const h = document.querySelector('.w2g-toasts');
      const r = h.getBoundingClientRect();
      return { closed: h.shadowRoot === null, width: r.width, height: r.height };
    });
    assert.equal(host.closed, true, 'closed shadow root');
    assert.ok(host.width > 0 && host.height > 0, `the toasts are visible: ${JSON.stringify(host)}`);
    await sleep(500); // the success toasts name the room inside the closed root only
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('movie night')), false, 'no room name in the page');
  });

  test('page scripts can read toast text with window.find, so with two rooms open it shows only the start of the streamkey', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await bg(([a, b]) => stub.setRooms([b, a], b), [ROOM, OTHER_ROOM]);
    await openSynthetic();
    const hero = page.locator('.listenEngagement .w2g-add');
    await hero.waitFor({ state: 'visible', timeout: 10000 });
    await bg(() => stub.enqueue({ result: { added: 11, title: 'Soulhack' } }));
    await hero.click();
    const find = (text) => page.evaluate((t) => {
      getSelection().removeAllRanges();
      return window.find(t, false, false, true);
    }, text);
    // The closed shadow root doesn't hide rendered text from the page's main world.
    await waitFor(() => find('Added 11 tracks to Temporary Room (mgdr'), { timeout: 5000, message: 'the toast text, found with window.find' });
    assert.equal(await find(OTHER_ROOM.streamkey), false, 'the full streamkey (the invite key) is not in the page');
    assert.equal(await find(OTHER_ROOM.streamkey.slice(0, 5)), false, 'only its first 4 characters are');
  });

  for (const [lang, onlyMore] of [['fr', false], ['es', false], ['es', true]]) {
    test(`Webi track header in ${lang}${onlyMore ? ' with only a More button' : ''}: the button goes before More`, { timeout: TIMEOUT }, async () => {
      await bg(() => stub.reset());
      await withRoom();
      const l = WEBI_LABELS[lang];
      await openSynthetic(`https://soundcloud.com/n/forss/flickermood?lang=${lang}${onlyMore ? '&only-more' : ''}`);
      const placed = await page.evaluate((header) => {
        const buttons = [...document.querySelectorAll('.w2g-add')];
        const b = buttons[0];
        return {
          count: buttons.length,
          inHeader: Boolean(b.closest(`section[aria-label="${header}"]`)),
          next: b.nextElementSibling && b.nextElementSibling.id,
          prev: b.previousElementSibling && b.previousElementSibling.getAttribute('aria-label'),
          variant: b.getAttribute('variant'),
          classes: b.className,
          title: b.title,
        };
      }, l.header);
      assert.equal(placed.count, 1, 'one button, none in the comments');
      assert.equal(placed.inHeader, true);
      assert.equal(placed.next, 'desktop-menu-button-«r5»');
      assert.equal(placed.prev, onlyMore ? null : l.add);
      assert.equal(placed.variant, 'outlined');
      assert.match(placed.classes, /MuiIconButton-root .*css-1ib2x7q/);
      assert.equal(placed.title, 'Add to w2g');
      await expectQueued(page.locator('.w2g-add'), { kind: 'track', url: SC.track }, { real: false });
    });
  }
});

// --- 3. the background or the extension goes away mid-job ----------------------------------------------------

describe('soundcloud.com content script when its extension goes away (synthetic pages)', { timeout: 10 * 60000 }, () => {
  before(async () => {
    await launchSynthetic(readableToasts());
  });

  after(async () => {
    await browser?.close();
    variant?.cleanup();
  });

  /** chrome://extensions' reload arrow. Under Playwright the reloaded extension then stays disabled. */
  async function reloadExtension() {
    await bg(() => { setTimeout(() => chrome.runtime.reload(), 50); return true; }).catch(() => {});
  }

  /** Turns the reloaded extension back on (a real reload or update does this by itself) and waits for the stub. */
  async function reenableExtension() {
    const manager = await browser.context.newPage();
    try {
      await manager.goto('chrome://extensions/');
      const isOff = (id) => new Promise((resolve) => chrome.management.get(id, (info) => resolve(Boolean(info) && info.enabled === false)));
      await waitFor(() => manager.evaluate(isOff, browser.extensionId), { timeout: 10000, message: 'the reload disabled the extension' });
      await manager.evaluate((id) => new Promise((resolve) => chrome.management.setEnabled(id, true, resolve)), browser.extensionId);
    } finally {
      await manager.close();
    }
    await waitFor(() => bg(() => typeof stub === 'object').catch(() => false), { timeout: 20000, message: 'restarted stub background' });
    await page.bringToFront();
  }

  /** Stops the extension's service worker the way Chrome does when it idles out or crashes. */
  async function stopWorker() {
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
  }

  test('the toast stays beside an open Next up panel, above it when there is no room, and returns to the corner', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await page.evaluate(() => {
      const bar = document.createElement('div');
      bar.className = 'playControls';
      bar.innerHTML = '<div class="playControls__queue"><div class="queue m-visible" style="position: fixed; right: 100px; bottom: 48px; width: 480px; height: 500px"></div></div>';
      document.body.appendChild(bar);
    });
    const hero = page.locator('.listenEngagement .w2g-add');
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const toast = toasts().last();
    await toastText(toast, "Adding 'Soulhack' to w2g…");
    const panelBox = () => page.locator('.queue').boundingBox();
    assert.ok(!overlap(await toast.boundingBox(), await panelBox()), 'beside the panel');
    assert.ok((await toast.boundingBox()).x + (await toast.boundingBox()).width <= (await panelBox()).x);

    // Too narrow to sit beside it: above it.
    await page.evaluate(() => { document.querySelector('.queue').style.right = `${innerWidth - 600}px`; });
    await page.evaluate(() => document.querySelector('.queue').classList.toggle('m-visible')); // closed...
    await page.evaluate(() => document.querySelector('.queue').classList.toggle('m-visible')); // ...and open again
    await waitFor(async () => !overlap(await toast.boundingBox(), await panelBox()), { timeout: 3000, message: 'not over the panel' });
    assert.ok((await toast.boundingBox()).y + (await toast.boundingBox()).height <= (await panelBox()).y, 'above the panel');

    await page.evaluate(() => document.querySelector('.queue').classList.remove('m-visible'));
    await waitFor(() => page.evaluate(() => /right: 16px; bottom: 64px/.test(document.querySelector('.w2g-toasts').style.cssText)), { timeout: 3000, message: 'back in the corner' });
    await page.evaluate(() => document.querySelector('.playControls').remove());
    await bg((id) => stub.release(id, { added: 11, title: 'Soulhack' }), await heldJob());
    await toastText(toast, 'Added 11 tracks to Temporary Room');
    await closeToast(toast);
  });

  test('a stopped background mid-job: the room tab may still be adding, so no retry; before the room tab had the job, a retry', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    const hero = page.locator('.listenEngagement .w2g-add');

    // The room tab doesn't need the background to finish a job it has: what it reported so far is a lower bound.
    for (const [done, detail] of [[0, STILL_ADDING], [50, `At least 50 tracks were added so far. ${STILL_ADDING}`]]) {
      await ready(hero);
      await bg(() => stub.enqueue({ hold: true }));
      await hero.click();
      const jobId = await heldJob();
      await bg(([id, d]) => stub.progress(id, { phase: 'adding', done: d, total: 120, title: 'Soulhack' }), [jobId, done]);
      const toast = toasts().last();
      await toastText(toast, `Adding 120 tracks… ${done}/120`);
      await stopWorker();
      await toastText(toast, 'Lost track of this add', { detail });
      assert.deepEqual(await actionsOf(toast), []);
      if (done) await shot('toast-connection-lost-started', toast);
      await closeToast(toast);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // rooms:get wakes the worker
      await waitFor(() => bg(() => typeof stub === 'object').catch(() => false), { timeout: 20000, message: 'restarted stub background' });
    }

    // Not started yet (still resolving): nothing can have reached the room, so a retry is fine.
    await bg(() => stub.enqueue({ hold: true }));
    const row = page.locator('.trackItem').first().locator('.w2g-add');
    await row.click();
    await heldJob();
    const toast2 = toasts().last();
    await toastText(toast2, "Adding 'Flickermood' to w2g…");
    const before = (await queued()).length;
    await stopWorker();
    await toastText(toast2, 'Lost the connection to SoundCloud for w2g');
    assert.deepEqual(await actionsOf(toast2), ['Try again']);
    await clickAction(toast2, 'Try again'); // also wakes the worker
    await toastText(toast2, "Added 'Stub track' to Temporary Room");
    assert.equal((await queued()).length, before + 1);
  });

  test('an extension reload mid-job: the old toast says tracks may be in the room, and the new copy adopts it', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    const hero = page.locator('.listenEngagement .w2g-add');
    await bg(() => stub.enqueue({ hold: true }));
    await hero.click();
    const jobId = await heldJob();
    await bg((id) => stub.progress(id, { phase: 'adding', done: 50, total: 120, title: 'Soulhack' }), jobId);
    const old = toasts().last();
    await toastText(old, 'Adding 120 tracks… 50/120');

    await reloadExtension();
    await toastText(old, 'SoundCloud for w2g stopped while adding', {
      detail: "50 tracks were added before this happened. Check the room's playlist, then reload this page.",
    });
    assert.deepEqual(await actionsOf(old), ['Reload page']);
    await shot('toast-context-invalidated', old);
    // The orphaned copy removes its buttons (they can't work anymore) but keeps its toasts.
    await waitFor(async () => (await page.locator('.w2g-add').count()) === 0, { timeout: 5000, message: 'orphaned buttons removed' });
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-w2g-room')), false);

    // The extension comes back and re-injects its content script, as the background does after an update.
    await reenableExtension();
    await bg(() => stub.inject());
    await withRoom();
    await bg(() => stub.enqueue({ result: { added: 11, title: 'Soulhack' } }));
    await hero.waitFor({ state: 'visible', timeout: 10000 });
    await hero.click();
    const fresh = toasts().filter({ hasText: 'Added 11 tracks to Temporary Room' });
    await waitFor(async () => (await fresh.count()) === 1, {
      timeout: 10000,
      message: `the new copy's toast (toasts: ${await toasts().locator('.text').allInnerTexts().catch(() => '?')})`,
    });

    // One positioned stack: the orphan's host now lives inside the new one, and the toasts don't overlap.
    const layout = await page.evaluate(() => ({
      top: document.querySelectorAll('body > .w2g-toasts').length,
      nested: document.querySelectorAll('body > .w2g-toasts > .w2g-toasts').length,
    }));
    assert.deepEqual(layout, { top: 1, nested: 1 });
    const oldToast = toasts().filter({ hasText: 'stopped while adding' });
    const [a, b] = [await oldToast.boundingBox(), await fresh.boundingBox()];
    assert.ok(a && b && !overlap(a, b), `old ${JSON.stringify(a)} and new ${JSON.stringify(b)} toasts must not overlap`);
    assert.ok(a.y + a.height <= b.y, 'the old toast sits above the new one');
    await shot('toast-adopted', page.locator('body > .w2g-toasts'));
    await closeToast(oldToast);
  });
});

// --- 4. toast actions that add tracks count only clicks the user could see -----------------------------------

describe('soundcloud.com toasts: "Add" and "Try again" ignore clicks the user could not see (synthetic pages)', { timeout: 10 * 60000 }, () => {
  before(async () => {
    await launchSynthetic(readableToasts());
  });

  after(async () => {
    await browser?.close();
    variant?.cleanup();
  });

  const BIG_SET = { result: { needsConfirm: true, count: 300, title: 'Big set', skippedCount: 0 } };
  const BIG_SET_ADDED = { result: { added: 300, title: 'Big set' } };
  const UNREACHABLE = { result: { error: { code: 'W2G_UNREACHABLE', message: 'stub', added: 0 } } };

  async function center(locator) {
    const box = await locator.boundingBox();
    assert.ok(box, `no box for ${locator}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** A real mouse click on whatever is at the button's spot. The pointer rests there first, as a user's does. */
  async function mouseClick(locator, restMs = 300) {
    const { x, y } = await center(locator);
    await page.mouse.move(x, y);
    await sleep(restMs);
    await page.mouse.down();
    await page.mouse.up();
  }

  /**
   * Records, from the page's main world, every click on a toast button (this build's shadow root is open, so
   * composedPath() shows it): proof that an ignored click did land on the button, as trusted input. Also records
   * when an "Add to w2g" button was clicked: its toast can't have shown up before that.
   */
  async function recordClicks() {
    await page.evaluate(() => {
      window.scw2gClicks = [];
      window.scw2gStarts = [];
      document.addEventListener('click', (event) => {
        const button = event.composedPath().find((node) => node instanceof HTMLButtonElement);
        if (!button) return;
        if (button.classList.contains('w2g-add')) window.scw2gStarts.push(event.timeStamp);
        else if (button.getRootNode() !== document) window.scw2gClicks.push({ label: button.textContent, trusted: event.isTrusted, at: event.timeStamp });
      }, true);
    });
  }

  const toastClicks = () => page.evaluate(() => window.scw2gClicks.map(({ label, trusted }) => ({ label, trusted })));

  /** Clicks a toast action with the real mouse in the first frame that shows it. */
  async function clickWhenShown(label) {
    const handle = await page.waitForFunction((l) => {
      const root = document.querySelector('.w2g-toasts')?.shadowRoot;
      if (!root) return null;
      const button = [...root.querySelectorAll('.toast:not(.leaving) .action')].find((b) => b.textContent === l);
      if (!button) return null;
      const r = button.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, label, { polling: 'raf', timeout: 10000 });
    const { x, y } = await handle.jsonValue();
    await page.mouse.click(x, y);
  }

  /** Milliseconds from the last "Add to w2g" click (the toast can't have shown up earlier) to the last toast click. */
  const sinceStart = () => page.evaluate(() => window.scw2gClicks.at(-1).at - window.scw2gStarts.at(-1));

  async function startBigSet() {
    await page.locator('.listenEngagement .w2g-add').click();
    const toast = toasts().last();
    await toastText(toast, 'Add 300 tracks to w2g?');
    return toast;
  }

  test('a page script makes the toast transparent: a click on "Add" does nothing until the toast is visible again', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await recordClicks();
    await bg(([big, added]) => stub.enqueue(big, added, big, added), [BIG_SET, BIG_SET_ADDED]);
    let toast = await startBigSet();
    let add = toast.locator('.action', { hasText: 'Add' });
    await sleep(700); // long enough to count, had it stayed visible

    // Made transparent while shown: the click still lands on "Add", as trusted input, and is ignored.
    await page.evaluate(() => { document.querySelector('.w2g-toasts').style.opacity = '0'; });
    await sleep(300); // IntersectionObserver v2 notices within about 100 ms
    await mouseClick(add);
    await sleep(500);
    assert.deepEqual(await toastClicks(), [{ label: 'Add', trusted: true }], 'the click reached "Add"');
    assert.equal((await queued()).length, 1, 'nothing was confirmed');
    assert.deepEqual(await actionsOf(toast), ['Add', 'Cancel'], 'still asking');

    // Visible again: after 500 ms on screen the same click counts.
    await page.evaluate(() => { document.querySelector('.w2g-toasts').style.opacity = ''; });
    await sleep(700);
    await mouseClick(add);
    await toastText(toast, 'Added 300 tracks to Temporary Room');
    let sent = await queued();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].msg.confirmed, true);
    assert.equal(sent[1].msg.jobId, sent[0].msg.jobId);
    await closeToast(toast);

    // Transparent from the start (a page stylesheet that beats the host's inline style): never visible, never counts.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'hide-toasts';
      style.textContent = '.w2g-toasts { opacity: 0 !important; }';
      document.head.appendChild(style);
    });
    await ready(page.locator('.listenEngagement .w2g-add'));
    toast = await startBigSet();
    add = toast.locator('.action', { hasText: 'Add' });
    await sleep(1000);
    await mouseClick(add);
    await sleep(500);
    assert.deepEqual((await toastClicks()).at(-1), { label: 'Add', trusted: true }, 'the click reached "Add"');
    assert.equal((await queued()).length, 3, 'nothing was confirmed');
    await page.evaluate(() => document.getElementById('hide-toasts').remove());
    await sleep(700);
    await mouseClick(add);
    await toastText(toast, 'Added 300 tracks to Temporary Room');
    sent = await queued();
    assert.equal(sent.length, 4);
    assert.equal(sent[3].msg.confirmed, true);
  });

  test('a page script covers the toast with a pointer-events:none decoy: a click through it on "Add" does nothing', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await recordClicks();
    await bg(([big, added]) => stub.enqueue(big, added), [BIG_SET, BIG_SET_ADDED]);
    const toast = await startBigSet();
    const add = toast.locator('.action', { hasText: 'Add' });
    await sleep(700);

    await page.evaluate(() => {
      const r = document.querySelector('.w2g-toasts').getBoundingClientRect();
      const decoy = document.createElement('div');
      decoy.id = 'decoy';
      decoy.textContent = 'Play';
      decoy.style.cssText = `position: fixed; left: ${r.left}px; top: ${r.top}px; width: ${r.width}px; height: ${r.height}px; ` +
        'z-index: 2147483647; pointer-events: none; display: grid; place-items: center; background: #f50; color: #fff; font: 600 20px sans-serif;';
      document.body.appendChild(decoy);
    });
    await sleep(300);
    await shot('toast-under-decoy');
    await mouseClick(add);
    await sleep(500);
    assert.deepEqual(await toastClicks(), [{ label: 'Add', trusted: true }], 'the click went through the decoy to "Add"');
    assert.equal((await queued()).length, 1, 'nothing was confirmed');
    assert.deepEqual(await actionsOf(toast), ['Add', 'Cancel'], 'still asking');

    await page.evaluate(() => document.getElementById('decoy').remove());
    await sleep(700);
    await mouseClick(add);
    await toastText(toast, 'Added 300 tracks to Temporary Room');
    assert.equal((await queued())[1].msg.confirmed, true);
  });

  test('page styles can\'t recolor the toast, and a shrunk, masked or moved toast ignores clicks on "Add"', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await recordClicks();
    await bg(([big, added]) => stub.enqueue(big, added), [BIG_SET, BIG_SET_ADDED]);
    // Custom and inherited properties reach into a shadow tree; a registered property can even stop inheritance.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'recolor';
      style.textContent = `
        @property --w2g-surface { syntax: '<color>'; inherits: false; initial-value: transparent; }
        .w2g-toasts {
          --w2g-surface: transparent; --w2g-text: transparent; --w2g-btn-bg: transparent; --w2g-btn-fg: transparent;
          --surface-color: transparent; --primary-color: transparent; --button-primary-background-color: transparent;
          color: transparent; -webkit-text-fill-color: transparent; font-family: scw2g-nothing;
        }`;
      document.head.appendChild(style);
    });
    const toast = await startBigSet();
    const add = toast.locator('.action', { hasText: 'Add' });
    const colors = await add.evaluate((button) => {
      const of = (el) => getComputedStyle(el);
      const t = of(button.closest('.toast'));
      const b = of(button);
      return { toast: t.backgroundColor, text: t.color, textFill: t.webkitTextFillColor, add: b.backgroundColor, addText: b.color };
    });
    for (const [what, color] of Object.entries(colors)) assert.doesNotMatch(color, /rgba\(0, 0, 0, 0\)|transparent/, `${what}: ${color}`);

    const host = (css) => page.evaluate((text) => { document.querySelector('.w2g-toasts').style.cssText += text; }, css);
    const tries = [
      ['zoom', 'zoom: 0.4;'],
      ['mask', '-webkit-mask-image: linear-gradient(transparent, transparent); mask-image: linear-gradient(transparent, transparent);'],
      ['moved up', 'top: 8px;'],
      ['translated', 'translate: -300px -200px;'],
    ];
    for (const [what, css] of tries) {
      const saved = await page.evaluate(() => document.querySelector('.w2g-toasts').style.cssText);
      await sleep(700); // it was visible long enough before
      await host(css);
      await sleep(300);
      await mouseClick(add);
      await sleep(500);
      assert.deepEqual((await toastClicks()).at(-1), { label: 'Add', trusted: true }, `${what}: the click reached "Add"`);
      assert.equal((await queued()).length, 1, `${what}: nothing was confirmed`);
      await page.evaluate((text) => { document.querySelector('.w2g-toasts').style.cssText = text; }, saved);
    }

    // Untouched again (the recoloring stylesheet is still there, but has no effect): the click counts.
    await sleep(700);
    await mouseClick(add);
    await toastText(toast, 'Added 300 tracks to Temporary Room');
    const sent = await queued();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].msg.confirmed, true);
    await page.evaluate(() => document.getElementById('recolor').remove());
  });

  test('a click on "Add" or "Try again" within 500 ms of it showing up is ignored, a later one counts; Cancel and Dismiss react at once', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await recordClicks();
    const hero = page.locator('.listenEngagement .w2g-add');
    await bg(([big, added]) => stub.enqueue(big, added), [BIG_SET, BIG_SET_ADDED]);
    await hero.click();
    await clickWhenShown('Add');
    const early = await sinceStart();
    assert.ok(early < 500, `the early click came ${Math.round(early)} ms after the toast showed up`);
    let toast = toasts().last();
    await sleep(400);
    assert.deepEqual(await toastClicks(), [{ label: 'Add', trusted: true }], 'the click reached "Add"');
    assert.equal((await queued()).length, 1, 'the early click was ignored');
    assert.deepEqual(await actionsOf(toast), ['Add', 'Cancel'], 'still asking');
    await sleep(300);
    await mouseClick(toast.locator('.action', { hasText: 'Add' }));
    await toastText(toast, 'Added 300 tracks to Temporary Room');
    assert.equal((await queued())[1].msg.confirmed, true);
    await closeToast(toast);

    await ready(hero);
    await bg(([unreachable]) => stub.enqueue(unreachable, { result: { added: 11, title: 'Soulhack' } }), [UNREACHABLE]);
    await hero.click();
    await clickWhenShown('Try again');
    assert.ok((await sinceStart()) < 500, 'the early click came within 500 ms');
    toast = toasts().last();
    await sleep(400);
    assert.deepEqual((await toastClicks()).at(-1), { label: 'Try again', trusted: true });
    assert.equal((await queued()).length, 3, 'the early click was ignored');
    await toastText(toast, "Couldn't reach w2g", { detail: "The room tab can't reach w2g right now. Check your connection, then try again." });
    await sleep(300);
    await mouseClick(toast.locator('.action', { hasText: 'Try again' }));
    await toastText(toast, 'Added 11 tracks to Temporary Room');
    assert.equal((await queued()).length, 4);
    await closeToast(toast);

    // Saying no is never gated.
    await ready(hero);
    await bg(([big]) => stub.enqueue(big, big), [BIG_SET]);
    await hero.click();
    await clickWhenShown('Cancel');
    await waitFor(async () => (await toasts().count()) === 0, { timeout: 3000, message: 'Cancel closed the toast' });
    await ready(hero);
    await hero.click();
    await clickWhenShown('Add'); // ignored, so the question stays until it is dismissed
    toast = toasts().last();
    await toast.locator('.close').click();
    await waitFor(async () => (await toasts().count()) === 0, { timeout: 3000, message: 'Dismiss closed the toast' });
    await sleep(500);
    assert.equal((await queued()).length, 6, 'neither question was confirmed');
  });

  test('"Add" on an older toast still reacts while newer toasts stack below it', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await bg(([big, added]) => stub.enqueue(big, { hold: true }, { hold: true }, added), [BIG_SET, BIG_SET_ADDED]);
    await startBigSet();
    const confirm = toasts().first();
    for (const row of await page.locator('.trackItem .w2g-add').all()) await row.click();
    await waitFor(async () => (await toasts().count()) === 3, { timeout: 5000, message: 'three toasts' });
    await heldJob(2);
    await page.mouse.move(10, 10);
    await shot('toast-stack-confirm', page.locator('.w2g-toasts'));
    await sleep(700);
    // A newer toast's shadow must not count as covering the buttons of the one above it.
    await mouseClick(confirm.locator('.action', { hasText: 'Add' }));
    await toastText(confirm, 'Added 300 tracks to Temporary Room');
    assert.equal((await queued()).at(-1).msg.confirmed, true);
  });

  test('"Try again" in a toast inside SoundCloud\'s same-origin track iframe reacts once it has been visible', { timeout: TIMEOUT }, async () => {
    await bg(() => stub.reset());
    await withRoom();
    await openSynthetic();
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'webi';
      frame.src = '/n/forss/flickermood?lang=fr';
      frame.style.cssText = 'position: fixed; left: 0; top: 0; width: 1000px; height: 700px; border: 0; z-index: 10;';
      document.body.appendChild(frame);
    });
    const frame = page.frameLocator('#webi');
    const button = frame.locator('button.w2g-add');
    await button.waitFor({ state: 'visible', timeout: 15000 });
    await bg(([unreachable]) => stub.enqueue(unreachable, { result: { added: 1, title: 'Flickermood' } }), [UNREACHABLE]);
    await button.click();
    const toast = toasts(frame).last();
    await toastText(toast, "Couldn't reach w2g");
    await sleep(700);
    await mouseClick(toast.locator('.action', { hasText: 'Try again' }));
    await toastText(toast, "Added 'Flickermood' to Temporary Room");
    const sent = await queued();
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1].frameId, 0, 'sent from the iframe');
  });
});
