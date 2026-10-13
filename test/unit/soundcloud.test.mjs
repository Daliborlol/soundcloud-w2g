// Offline tests for background/soundcloud.js. A mock fetch serves the captured api-v2 fixtures in
// test/fixtures/sc and behaves like the real API: /tracks answers in arbitrary order, drops unknown ids and
// rejects more than 50 ids, a bad client_id or token gets 401, next_href carries no client_id. It can also play
// DataDome: challenge every api-v2 request (403 { url }) that doesn't carry an accepted X-Datadome-ClientId.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ScError, createSoundCloudClient, expand, listLibrary, getStatus, normalizeTrack, toW2gItem,
} from '../../extension/background/soundcloud.js';

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sc');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));
const HOME_HTML = fs.readFileSync(path.join(FX, 'soundcloud-home-excerpt.html'), 'utf8');

const API_HOST = 'api-v2.soundcloud.com';
const CID_HYDRATION = 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k';
const CID_BUNDLE = 'O4KAW11rMMnH5modEfDHOdzmnuvsck9X';
const CID_JWT = 'JwtClaimClientId0000000000000001';
const CID_STALE = 'StaleClientId0000000000000000000';
const TOKEN = '2-000000-987654321-SYNTHETICtoken';
const DEAD_TOKEN = '2-000000-987654321-DEADtoken';
const ME_ID = 987654321;
// Shape of a real datadome cookie value; CAPTCHA_URL is what DataDome puts into its 403 { url } answer.
const DD_COOKIE = 'Ab3~dEf_gHi~JKlmNO_pqrS0tuvWXyz~12345';
const CAPTCHA_URL = 'https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMA&cid=x&referer=y';

const makeJwt = (claims) => {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const JWT_VALID = makeJwt({ sub: String(ME_ID), client_id: CID_JWT, exp: nowSec() + 3600 });
const JWT_EXPIRED = makeJwt({ sub: String(ME_ID), client_id: CID_JWT, exp: nowSec() - 60 });

// ----------------------------------------------------------------------------------------------- fixture data

const stub = (t) => ({ id: t.id, kind: 'track', monetization_model: t.monetization_model, policy: t.policy });

// Every public hydrated track found in the real fixtures, by id.
const POOL = new Map();
(function walk(x) {
  if (Array.isArray(x)) x.forEach(walk);
  else if (x && typeof x === 'object') {
    if (x.kind === 'track' && typeof x.permalink_url === 'string' && x.sharing !== 'private') POOL.set(x.id, x);
    Object.values(x).forEach(walk);
  }
})(fs.readdirSync(FX).filter((f) => f.endsWith('.json') && !f.startsWith('SYNTHETIC') && f !== 'index.json').map(fixture));

const PRIVATE_SET = fixture('playlist-private-secret.json');
const PRIVATE_SET_TRACKS = new Map(fixture('tracks-ids-private-with-playlist-context.json').map((t) => [t.id, t]));
// The real private set is short enough to come fully hydrated; stub all but the first track to exercise hydration.
const PRIVATE_SET_STUBBED = { ...PRIVATE_SET, tracks: [PRIVATE_SET.tracks[0], ...PRIVATE_SET.tracks.slice(1).map(stub)] };
const PRIVATE_TRACK = fixture('resolve-track-private-secret.json');

const SOULHACK = fixture('resolve-playlist-public-soulhack.json');
const BIG_SET = fixture('playlist-100-tracks.json');
const STATION = fixture('resolve-system-playlist-track-station.json');
const WEEKLY = fixture('SYNTHETIC-system-playlist-weekly-wave.json');
const DAILY = fixture('SYNTHETIC-system-playlist-daily-drops.json');
// SYNTHETIC "Your 2025 Playback", shaped like Weekly Wave. Real urn/permalink formats (KittyTune's
// YearlyPlaybackTest): soundcloud:system-playlists:your-playback:<user id>:<year>, your-playback::<user>:<year>.
const PLAYBACK = {
  ...WEEKLY,
  id: `soundcloud:system-playlists:your-playback:${ME_ID}:2025`,
  urn: `soundcloud:system-playlists:your-playback:${ME_ID}:2025`,
  permalink: 'your-playback::w2g-test-user:2025',
  permalink_url: 'https://soundcloud.com/discover/sets/your-playback::w2g-test-user:2025',
  title: 'Your 2025 Playback',
  short_title: 'Your 2025 Playback',
  tracking_feature_name: 'your-playback',
  tracks: WEEKLY.tracks.slice(0, 12),
};
const LIKES_P1 = fixture('user-track-likes-p1.json');
const LIKES_P2 = fixture('user-track-likes-p2.json');
const EMPTY_PAGE = fixture('user-likes-last-page-empty.json');
const PROBLEMS = fixture('tracks-problem-cases.json'); // [SNIP, BLOCK, streamable:false, embeddable_by:me, normal]
const T293 = PROBLEMS[4];

const clone = (id, patch) => ({
  ...T293, id, urn: 'soundcloud:tracks:' + id, permalink: 'clone-' + id, permalink_url: 'https://soundcloud.com/forss/clone-' + id, ...patch,
});
const CLONES = [
  clone(9000001, { title: 'Not Embeddable', embeddable_by: 'none' }),
  clone(9000002, { title: 'Still Processing', state: 'processing' }),
  clone(9000003, { title: 'Go Plus Only', monetization_model: 'SUB_HIGH_TIER' }),
];
for (const t of CLONES) POOL.set(t.id, t);
const PROBLEM_SET = {
  ...SOULHACK, id: 777, permalink_url: 'https://soundcloud.com/test/sets/problems', title: 'Problems', track_count: 9,
  tracks: [...PROBLEMS, ...CLONES.map(stub), { id: 9999999, kind: 'track', policy: 'ALLOW', monetization_model: 'NOT_APPLICABLE' }],
};

const HUGE_FIRST_ID = 8000001;
const HUGE_SET = {
  ...SOULHACK, id: 888, permalink_url: 'https://soundcloud.com/test/sets/huge', title: 'Huge', track_count: 1100,
  tracks: Array.from({ length: 1100 }, (_, i) => stub({ id: HUGE_FIRST_ID + i, policy: 'ALLOW', monetization_model: 'NOT_APPLICABLE' })),
};
const generatedTrack = (id) => clone(id, { title: 'Generated ' + id });

const REPOSTS = {
  collection: [
    { type: 'track-repost', created_at: '2020-01-01T00:00:00Z', track: POOL.get(293), user: {} },
    { type: 'playlist-repost', created_at: '2020-01-02T00:00:00Z', playlist: { ...SOULHACK, tracks: undefined }, user: {} },
    { type: 'track-repost', created_at: '2020-01-03T00:00:00Z', track: POOL.get(290), user: {} },
  ],
  next_href: null,
};

const offsetOf = (href) => new URL(href).searchParams.get('offset');

// ----------------------------------------------------------------------------------------------- mock api

const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const empty = (status, headers = {}) => new Response(null, { status, headers });

// Deterministic but scrambled order, like the real /tracks endpoint.
const reversedId = (t) => String(t.id).split('').reverse().join('');
const scramble = (arr) => [...arr].sort((a, b) => reversedId(a).localeCompare(reversedId(b)));

function createMockSoundCloud({
  html = HOME_HTML,
  bundles = {},
  validClientIds = [CID_HYDRATION, CID_BUNDLE, CID_JWT],
  validTokens = [TOKEN, JWT_VALID],
  shortLinks = {
    'https://on.soundcloud.com/9zRpu': 'https://soundcloud.com/forss/flickermood?si=abc123&utm_source=clipboard&utm_medium=text',
  },
  wrapShelfItems = false,
  // { passed: Set<string> }: DataDome flags this network and only lets api-v2 requests through whose
  // X-Datadome-ClientId is in `passed` (a session that solved the check on soundcloud.com).
  dataDome = null,
  clock = () => Date.now(),
} = {}) {
  const calls = [];
  const violations = [];
  const failures = [];
  const challenged = new Set(); // URLs just answered with 403: the only requests the client may repeat with its DataDome id
  const okIds = new Set(validClientIds);
  const okTokens = new Set(validTokens);

  async function fetch(input, init = {}) {
    const u = new URL(String(input));
    const headers = new Headers(init.headers || {});
    const authorization = headers.get('authorization');
    const datadome = headers.get('x-datadome-clientid');
    const call = {
      host: u.hostname, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams),
      auth: authorization, datadome, credentials: init.credentials, at: clock(), url: u.href,
    };
    calls.push(call);
    if (u.hostname !== API_HOST && authorization) violations.push('token sent to ' + u.hostname);
    // soundcloud.com deletes the login cookies when it gets a token it doesn't accept: no cookies, anywhere.
    if (init.credentials !== 'omit') violations.push(`request to ${u.hostname} without credentials:omit`);
    if (datadome && (u.hostname !== API_HOST || !challenged.delete(u.href))) {
      violations.push('DataDome id sent without a challenge: ' + u.href);
    }
    if (init.method && init.method !== 'GET') violations.push('non-GET request ' + init.method);
    const res = await respond(call, u, authorization);
    if (res.status === 403 && !datadome) challenged.add(u.href);
    return res;
  }

  async function respond(call, u, authorization) {
    for (const f of failures) {
      if (f.times > 0 && f.match(call)) {
        f.times--;
        return f.respond(call);
      }
    }
    if (u.hostname === 'soundcloud.com' && u.pathname === '/') {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (u.hostname === 'a-v2.sndcdn.com') return u.href in bundles ? new Response(bundles[u.href], { status: 200 }) : empty(404);
    if (u.hostname === 'on.soundcloud.com') {
      const target = shortLinks[u.href];
      const res = target ? new Response('<html></html>', { status: 200 }) : new Response('not found', { status: 404 });
      Object.defineProperty(res, 'url', { value: target || u.href });
      return res;
    }
    if (u.hostname !== API_HOST) return empty(404);

    if (dataDome && !dataDome.passed.has(call.datadome)) return json(403, { url: CAPTCHA_URL });
    if (!okIds.has(u.searchParams.get('client_id'))) return empty(401);
    if (authorization && !(authorization.startsWith('OAuth ') && okTokens.has(authorization.slice(6)))) return empty(401);
    return api(call, Boolean(authorization), u.searchParams);
  }

  function api({ path: p }, authed, q) {
    if (p === '/resolve') {
      const target = q.get('url');
      const personal = {
        'https://soundcloud.com/discover/sets/weekly::w2g-test-user': WEEKLY,
        'https://soundcloud.com/discover/sets/weekly': WEEKLY,
        'https://soundcloud.com/discover/sets/new-for-you:987654321': DAILY,
        'https://soundcloud.com/discover/sets/your-playback::w2g-test-user:2025': PLAYBACK,
        'https://soundcloud.com/discover/sets/your-playback:2025': PLAYBACK,
      };
      if (personal[target]) return authed ? json(200, personal[target]) : json(404, {});
      const map = {
        'https://soundcloud.com/forss/flickermood': fixture('resolve-track-public.json'),
        'https://soundcloud.com/forss/sets/soulhack': SOULHACK,
        'https://soundcloud.com/discover/sets/track-stations:293': STATION,
        'https://soundcloud.com/stations/track/forss/flickermood': fixture('resolve-legacy-station.json'),
        'https://soundcloud.com/forss': fixture('resolve-user.json'),
        'https://soundcloud.com/soundcloud': { kind: 'user', id: 193, username: 'SoundCloud', permalink: 'soundcloud' },
        'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp': PRIVATE_TRACK,
        'https://soundcloud.com/svart-records/sets/timo-kaukolampi-station-to-station-to-station/s-ziYey': PRIVATE_SET_STUBBED,
        'https://soundcloud.com/test/sets/problems': PROBLEM_SET,
        'https://soundcloud.com/test/sets/huge': HUGE_SET,
      };
      return map[target] ? json(200, map[target]) : json(404, {});
    }
    if (p === '/tracks') {
      const ids = (q.get('ids') || '').split(',');
      if (!q.get('ids') || ids.length > 50 || ids.some((x) => !/^\d+$/.test(x))) return json(400, {});
      const withContext = q.get('playlistId') === String(PRIVATE_SET.id) && q.get('playlistSecretToken') === PRIVATE_SET.secret_token;
      const found = [...new Set(ids)].map(Number).map((id) => POOL.get(id)
        || (withContext && PRIVATE_SET_TRACKS.get(id))
        || (id >= HUGE_FIRST_ID && id < HUGE_FIRST_ID + 1100 ? generatedTrack(id) : null)).filter(Boolean);
      return json(200, scramble(found));
    }
    if (p === '/tracks/123998367') return q.get('secret_token') === 's-8Pjrp' ? json(200, PRIVATE_TRACK) : json(404, {});
    if (/^\/tracks\/\d+$/.test(p)) return POOL.has(Number(p.slice(8))) ? json(200, POOL.get(Number(p.slice(8)))) : json(404, {});
    if (p === '/playlists/729308781') return json(200, BIG_SET);
    if (p === '/playlists/922213810') return q.get('secret_token') === 's-ziYey' ? json(200, PRIVATE_SET_STUBBED) : json(404, {});
    if (p === '/users/183') return json(200, fixture('user-full.json'));
    if (p === '/system-playlists/soundcloud:system-playlists:track-stations:293') return json(200, STATION);
    if (p === '/users/183/track_likes') {
      const offset = q.get('offset');
      if (!offset) return json(200, LIKES_P1);
      if (offset === offsetOf(LIKES_P1.next_href)) return json(200, LIKES_P2);
      if (offset === offsetOf(LIKES_P2.next_href)) return json(200, EMPTY_PAGE);
      return json(400, {});
    }
    if (p === '/users/183/tracks') return json(200, q.get('offset') ? EMPTY_PAGE : fixture('user-tracks-p1.json'));
    if (p === '/users/183/toptracks') return json(200, fixture('user-toptracks.json'));
    if (p === '/stream/users/183/reposts') return json(200, REPOSTS);
    if (p === '/me') return authed ? json(200, fixture('SYNTHETIC-me.json')) : empty(401);
    if (p === `/users/${ME_ID}/track_likes`) return json(200, { ...LIKES_P1, next_href: null });
    if (p === '/me/library/all') return authed ? json(200, fixture('SYNTHETIC-me-library-all.json')) : empty(401);
    if (p === '/me/play-history/contexts') return authed ? json(200, fixture('SYNTHETIC-me-play-history-contexts.json')) : empty(401);
    if (p === `/users/${ME_ID}/playlists_without_albums`) return json(200, fixture('user-playlists-without-albums.json'));
    if (p === '/mixed-selections') {
      const data = fixture(authed ? 'SYNTHETIC-mixed-selections-logged-in.json' : 'mixed-selections-anonymous.json');
      if (wrapShelfItems) {
        const first = data.collection[0];
        first.items.collection = first.items.collection.map((item) => ({ item }));
      }
      return json(200, data);
    }
    return json(404, {});
  }

  return {
    fetch,
    calls,
    violations,
    apiCalls: () => calls.filter((c) => c.host === API_HOST),
    pageLoads: () => calls.filter((c) => c.host === 'soundcloud.com'),
    /** Answers the next `times` requests matching `match(call)` with `respond(call)` (may throw). */
    fail(match, respond, times = 1) {
      failures.push({ match, respond, times });
    },
  };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); } };
}

// Every client gets a datadome cookie by default, so the mock's violation check proves it is only sent after a
// challenge. dataDomeReads lists what each read of the cookie returned.
function setup({
  token = null, dataDomeId = DD_COOKIE, storage = memoryStorage(), mock: mockOptions = {}, ...clientOptions
} = {}) {
  const mock = createMockSoundCloud(mockOptions);
  const sleeps = [];
  const logs = [];
  const dataDomeReads = [];
  const client = createSoundCloudClient({
    fetch: mock.fetch,
    getOAuthToken: async () => (typeof token === 'function' ? token() : token),
    getDataDomeId: async () => {
      const value = typeof dataDomeId === 'function' ? dataDomeId() : dataDomeId;
      dataDomeReads.push(value);
      return value;
    },
    storage,
    sleep: async (ms) => { sleeps.push(ms); },
    log: (level, ...args) => logs.push([level, ...args]),
    minIntervalMs: 0,
    ...clientOptions,
  });
  return { mock, client, sleeps, logs, storage, dataDomeReads };
}

// A virtual clock: sleep() resolves in timestamp order once everything else is idle, so parallel work interleaves
// the way it would with real timers.
function virtualTime(start = 1_000_000) {
  let t = start;
  const timers = [];
  const idle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => { timers.push({ at: t + Math.max(0, ms), resolve }); }),
    async run(promise) {
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      for (let idleRounds = 0; idleRounds < 1000; idleRounds++) {
        await idle();
        if (settled) return promise;
        if (!timers.length) continue;
        idleRounds = 0;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      throw new Error('virtual time: the promise never settled');
    },
  };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ScError, `expected ScError, got ${err && err.stack}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

const tracksCalls = (mock) => mock.apiCalls().filter((c) => c.path === '/tracks');
const urlOf = (id) => normalizeTrack(POOL.get(id)).url;
const expectedItems = (rawTracks, opts) => rawTracks
  .map((t) => normalizeTrack(POOL.get(t.id) || t, opts)).filter((t) => t.playable).map((t) => t.url);

// ----------------------------------------------------------------------------------------------- client_id

describe('client_id', () => {
  test('is read from the page hydration, cached in storage and reused', async () => {
    const { mock, client, storage } = setup();
    await expand(client, 'https://soundcloud.com/forss/flickermood');
    await expand(client, 'https://soundcloud.com/forss/sets/soulhack');
    assert.equal(mock.pageLoads().length, 1);
    assert.equal(mock.pageLoads()[0].credentials, 'omit');
    assert.ok(mock.apiCalls().every((c) => c.query.client_id === CID_HYDRATION));
    assert.equal(storage.map.get('scClientId'), CID_HYDRATION);

    const second = setup({ storage });
    await expand(second.client, 'https://soundcloud.com/forss/flickermood');
    assert.equal(second.mock.pageLoads().length, 0, 'a cached client_id needs no page load');
    assert.deepEqual(mock.violations, []);
  });

  test('falls back to the page scripts, last one first', async () => {
    const html = HOME_HTML.replace(/,\{"hydratable":"apiClient"[^\]]*\}\}/, '');
    assert.ok(!html.includes('apiClient'));
    const bundles = {
      'https://a-v2.sndcdn.com/assets/55-98833eb1.js': 'var x={client_application_id:46941,client_is_expiring:!1};',
      'https://a-v2.sndcdn.com/assets/56-b922d60a.js': `n.exports={api_host:"x",client_id:"${CID_BUNDLE}",client_is_expiring:!1}`,
    };
    const { mock, client } = setup({ token: TOKEN, mock: { html, bundles } });
    const result = await expand(client, 'https://soundcloud.com/forss/flickermood');
    assert.equal(result.items.length, 1);
    const scripts = mock.calls.filter((c) => c.host === 'a-v2.sndcdn.com');
    assert.deepEqual(scripts.map((c) => c.path), ['/assets/55-98833eb1.js', '/assets/56-b922d60a.js']);
    assert.ok(scripts.every((c) => c.credentials === 'omit' && c.auth === null), 'scripts are fetched without cookies');
    assert.equal(mock.apiCalls()[0].query.client_id, CID_BUNDLE);
    assert.deepEqual(mock.violations, []);
  });

  test('the page is loaded without cookies even when there is a login', async () => {
    // soundcloud.com deletes the login cookies when a request carries a token it doesn't accept.
    for (const token of [TOKEN, JWT_VALID, JWT_EXPIRED, DEAD_TOKEN]) {
      const { mock, client } = setup({ token });
      await expand(client, 'https://soundcloud.com/forss/flickermood');
      assert.equal(mock.pageLoads().length, 1);
      assert.equal(mock.pageLoads()[0].credentials, 'omit');
      assert.equal(mock.pageLoads()[0].auth, null);
      assert.deepEqual(mock.violations, []);
    }
  });

  test('a rejected client_id is rediscovered once, then the request is retried', async () => {
    const { mock, client, storage } = setup({ storage: memoryStorage({ scClientId: CID_STALE }) });
    const result = await expand(client, 'https://soundcloud.com/forss/flickermood');
    assert.equal(result.items.length, 1);
    assert.deepEqual(mock.apiCalls().map((c) => c.query.client_id), [CID_STALE, CID_HYDRATION]);
    assert.equal(mock.pageLoads().length, 1);
    assert.equal(storage.map.get('scClientId'), CID_HYDRATION);
  });

  test('gives up when the rediscovered client_id is rejected too', async () => {
    const { mock, client } = setup({ storage: memoryStorage({ scClientId: CID_STALE }), mock: { validClientIds: [] } });
    await rejectsWith(expand(client, 'https://soundcloud.com/forss/flickermood'), 'SC_HTTP');
    assert.equal(mock.pageLoads().length, 1);
    assert.equal(mock.apiCalls().length, 2);
  });

  test('a fresh client_id is not rediscovered again right away', async () => {
    const { mock, client } = setup({ mock: { validClientIds: [] } });
    await rejectsWith(expand(client, 'https://soundcloud.com/forss/flickermood'), 'SC_HTTP');
    assert.equal(mock.pageLoads().length, 1, 'the id was discovered just now, so a 401 is not the id going stale');
  });

  test('a DataDome block of the page is a BOT_CHALLENGE', async () => {
    const { mock, client } = setup();
    mock.fail((c) => c.host === 'soundcloud.com', () => new Response('<html>blocked</html>', { status: 403 }));
    await rejectsWith(expand(client, 'https://soundcloud.com/forss/flickermood'), 'BOT_CHALLENGE');
  });
});

// ----------------------------------------------------------------------------------------------- expand()

describe('expand', () => {
  test('track', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/forss/flickermood?si=abc&utm_source=clipboard');
    assert.deepEqual(result, {
      source: {
        kind: 'track', url: 'https://soundcloud.com/forss/flickermood', title: 'Flickermood', subtitle: 'Forss',
        artwork: 'https://i1.sndcdn.com/artworks-000067273316-smsiqx-t500x500.jpg',
      },
      total: 1,
      items: [{
        url: 'https://soundcloud.com/forss/flickermood',
        title: 'Forss - Flickermood',
        thumb: 'https://i1.sndcdn.com/artworks-000067273316-smsiqx-t500x500.jpg',
      }],
      skipped: [],
      warnings: [],
    });
    assert.deepEqual(mock.apiCalls().map((c) => [c.path, c.query.url]), [['/resolve', 'https://soundcloud.com/forss/flickermood']]);
  });

  test('public set: hydrates the stubs in one request and keeps the set order', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/forss/sets/soulhack');
    assert.equal(result.source.kind, 'playlist');
    assert.equal(result.source.title, 'Soulhack');
    assert.equal(result.source.subtitle, 'Forss');
    assert.equal(result.total, 11);
    assert.deepEqual(result.items.map((i) => i.url), SOULHACK.tracks.map((t) => urlOf(t.id)));
    const hydrations = tracksCalls(mock);
    assert.equal(hydrations.length, 1);
    assert.deepEqual(hydrations[0].query.ids.split(',').map(Number), [295, 296, 297, 298, 299, 300]);
    assert.equal(hydrations[0].query.playlistId, '18');
    assert.equal(hydrations[0].query.playlistSecretToken, undefined);
    assert.equal(mock.apiCalls().length, 2, 'the playlist from /resolve is not fetched again');
  });

  test('100-track set via an api URL needs two hydration batches of at most 50 ids', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://api.soundcloud.com/playlists/729308781');
    assert.equal(result.total, 100);
    assert.equal(result.items.length + result.skipped.length, 100);
    assert.deepEqual(tracksCalls(mock).map((c) => c.query.ids.split(',').length), [50, 45]);
    assert.deepEqual(result.items.map((i) => i.url), expectedItems(BIG_SET.tracks));
    const blocked = BIG_SET.tracks.filter((t) => POOL.get(t.id).policy === 'BLOCK').length;
    assert.ok(blocked > 0);
    assert.equal(result.skipped.filter((s) => s.reason === 'geo_blocked').length, blocked);
  });

  test('private set: hydration carries playlistId + playlistSecretToken, items use the secret_token form', async () => {
    const { mock, client } = setup();
    const setUrl = 'https://soundcloud.com/svart-records/sets/timo-kaukolampi-station-to-station-to-station/s-ziYey?si=x';
    const result = await expand(client, setUrl);
    assert.equal(result.items.length, 4);
    const [call] = tracksCalls(mock);
    assert.equal(call.query.playlistId, '922213810');
    assert.equal(call.query.playlistSecretToken, 's-ziYey');
    assert.deepEqual(result.items.map((i) => i.url), PRIVATE_SET.tracks.map((t) => {
      const page = t.permalink_url.replace(/\/s-[A-Za-z0-9]+$/, '');
      return `${page}&secret_token=${t.secret_token}`;
    }));
    assert.ok(result.warnings.includes('private_tracks'));
    assert.equal(result.source.url, PRIVATE_SET.permalink_url);
  });

  test('station (system playlist of stubs)', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/discover/sets/track-stations%3A293');
    assert.equal(result.source.kind, 'system-playlist');
    assert.equal(result.source.title, 'Flickermood');
    assert.equal(result.source.subtitle, 'Track station');
    assert.equal(result.total, 46);
    assert.equal(tracksCalls(mock).length, 1);
    assert.deepEqual(result.items.map((i) => i.url), expectedItems(STATION.tracks));
  });

  test('legacy station link maps to its system playlist', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/stations/track/forss/flickermood');
    assert.equal(result.source.kind, 'system-playlist');
    assert.equal(result.total, 46);
    assert.deepEqual(mock.apiCalls().map((c) => c.path),
      ['/resolve', '/system-playlists/soundcloud:system-playlists:track-stations:293', '/tracks']);
  });

  test('Weekly Wave with a login (synthetic)', async () => {
    const { mock, client } = setup({ token: TOKEN });
    const result = await expand(client, 'https://soundcloud.com/discover/sets/weekly::w2g-test-user');
    assert.equal(result.source.kind, 'system-playlist');
    assert.equal(result.source.title, 'Weekly Wave');
    assert.equal(result.source.subtitle, 'Made for w2g test user');
    assert.equal(result.total, 30);
    assert.deepEqual(result.items.map((i) => i.url), expectedItems(WEEKLY.tracks));
    assert.ok(mock.apiCalls().every((c) => c.auth === 'OAuth ' + TOKEN));
    assert.deepEqual(mock.violations, []);
  });

  test('Weekly Wave without a login is AUTH_REQUIRED', async () => {
    const { mock, client } = setup();
    await rejectsWith(expand(client, 'https://soundcloud.com/discover/sets/weekly::w2g-test-user'), 'AUTH_REQUIRED');
    assert.equal(mock.apiCalls().length, 1);
  });

  test('/discover/weekly is the logged-in user\'s own Weekly Wave', async () => {
    const loggedOut = setup();
    await rejectsWith(expand(loggedOut.client, 'https://soundcloud.com/discover/weekly'), 'AUTH_REQUIRED');
    assert.equal(loggedOut.mock.calls.length, 0, 'no request without a login');
    const loggedIn = setup({ token: TOKEN });
    const result = await expand(loggedIn.client, 'https://soundcloud.com/discover/weekly');
    assert.equal(result.source.title, 'Weekly Wave');
  });

  test('/discover/your-<year>-playback is the logged-in user\'s own Playback, also as /discover/sets/your-playback:<year>', async () => {
    // The second form is what classifyHref() makes of the first one for the soundcloud.com header button.
    for (const url of ['https://soundcloud.com/discover/your-2025-playback?utm_source=email',
      'https://soundcloud.com/discover/sets/your-playback:2025']) {
      const loggedOut = setup();
      await rejectsWith(expand(loggedOut.client, url), 'AUTH_REQUIRED');
      assert.equal(loggedOut.mock.calls.length, 0, 'no request without a login');
      const expiredJwt = setup({ token: JWT_EXPIRED });
      await rejectsWith(expand(expiredJwt.client, url), 'AUTH_EXPIRED');
      assert.equal(expiredJwt.mock.calls.length, 0, 'no request with a login known to be expired');
      const dead = setup({ token: DEAD_TOKEN });
      await rejectsWith(expand(dead.client, url), 'AUTH_EXPIRED');

      const { mock, client } = setup({ token: TOKEN });
      const result = await expand(client, url);
      assert.equal(result.source.kind, 'system-playlist');
      assert.equal(result.source.title, 'Your 2025 Playback');
      assert.equal(result.source.url, 'https://soundcloud.com/discover/sets/your-playback::w2g-test-user:2025');
      assert.equal(result.total, 12);
      assert.deepEqual(result.items.map((i) => i.url), expectedItems(PLAYBACK.tracks));
      assert.deepEqual(mock.apiCalls().map((c) => [c.path, c.query.url]), [
        ['/resolve', 'https://soundcloud.com/discover/sets/your-playback:2025'], ['/tracks', undefined],
      ]);
      assert.ok(mock.apiCalls().every((c) => c.auth === 'OAuth ' + TOKEN));
      assert.deepEqual(mock.violations, []);
    }
  });

  test('a Playback link with the user in it: anonymous 404 is AUTH_REQUIRED, someone else\'s is NOT_FOUND', async () => {
    const own = 'https://soundcloud.com/discover/sets/your-playback::w2g-test-user:2025';
    const loggedOut = setup();
    await rejectsWith(expand(loggedOut.client, own), 'AUTH_REQUIRED');
    assert.equal(loggedOut.mock.apiCalls().length, 1);
    const { client } = setup({ token: TOKEN });
    assert.equal((await expand(client, own)).source.title, 'Your 2025 Playback');
    await rejectsWith(expand(client, 'https://soundcloud.com/discover/sets/your-playback::someone-else:2025'), 'NOT_FOUND');
  });

  test('a missing public station is NOT_FOUND, not a login problem', async () => {
    const { client } = setup();
    await rejectsWith(expand(client, 'https://soundcloud.com/discover/sets/track-stations:1'), 'NOT_FOUND');
  });

  test('someone else\'s personal playlist with a valid login is NOT_FOUND', async () => {
    const { client } = setup({ token: TOKEN });
    await rejectsWith(expand(client, 'https://soundcloud.com/discover/sets/weekly::someone-else'), 'NOT_FOUND');
  });

  test('user page: the user\'s tracks, following next_href to an empty last page', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/forss');
    assert.equal(result.source.kind, 'user-tracks');
    assert.equal(result.source.title, 'Tracks by Forss');
    assert.equal(result.source.url, 'https://soundcloud.com/forss/tracks');
    assert.equal(result.total, 4);
    const pages = mock.apiCalls().filter((c) => c.path === '/users/183/tracks');
    assert.equal(pages.length, 2);
    assert.equal(pages[0].query.limit, '200');
    assert.equal(pages[0].query.linked_partitioning, '1');
  });

  test('user likes: short and empty pages, next_href without client_id', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/forss/likes');
    assert.equal(result.source.kind, 'user-likes');
    assert.equal(result.source.url, 'https://soundcloud.com/forss/likes');
    const all = [...LIKES_P1.collection, ...LIKES_P2.collection].map((it) => it.track);
    assert.equal(result.total, all.length);
    assert.deepEqual(result.items.map((i) => i.url), all.map((t) => normalizeTrack(t)).filter((t) => t.playable).map((t) => t.url));
    const pages = mock.apiCalls().filter((c) => c.path === '/users/183/track_likes');
    assert.equal(pages.length, 3);
    assert.ok(pages.every((c) => c.query.client_id === CID_HYDRATION));
    assert.equal(pages[1].query.offset, offsetOf(LIKES_P1.next_href));
    assert.deepEqual(result.skipped.map((s) => s.reason).sort(), all.map((t) => normalizeTrack(t).reason).filter(Boolean).sort());
    assert.ok(result.skipped.some((s) => s.reason === 'geo_blocked'));
    assert.ok(result.skipped.some((s) => s.reason === 'preview_only'));
  });

  test('popular tracks and reposts', async () => {
    const { client } = setup();
    const popular = await expand(client, 'https://soundcloud.com/forss/popular-tracks');
    assert.equal(popular.source.kind, 'user-popular-tracks');
    assert.equal(popular.total, 26);
    const reposts = await expand(client, 'https://soundcloud.com/forss/reposts');
    assert.equal(reposts.source.kind, 'user-reposts');
    assert.deepEqual(reposts.items.map((i) => i.url), [urlOf(293), urlOf(290)], 'reposted playlists are left out');
  });

  test('/you/likes uses /me and the logged-in user\'s likes', async () => {
    const { mock, client } = setup({ token: TOKEN });
    const result = await expand(client, 'https://soundcloud.com/you/likes');
    assert.equal(result.source.kind, 'user-likes');
    assert.equal(result.source.url, 'https://soundcloud.com/you/likes');
    assert.equal(result.source.subtitle, 'w2g test user');
    assert.equal(result.total, LIKES_P1.collection.length);
    assert.deepEqual(mock.apiCalls().map((c) => [c.path, c.auth]), [
      ['/me', 'OAuth ' + TOKEN], [`/users/${ME_ID}/track_likes`, 'OAuth ' + TOKEN],
    ]);
    const loggedOut = setup();
    await rejectsWith(expand(loggedOut.client, 'https://soundcloud.com/you/likes'), 'AUTH_REQUIRED');
    assert.equal(loggedOut.mock.calls.length, 0);
  });

  test('short link: follows the redirect and drops the tracking query', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://on.soundcloud.com/9zRpu');
    assert.equal(result.source.kind, 'track');
    assert.equal(result.items[0].url, 'https://soundcloud.com/forss/flickermood');
    const short = mock.calls.find((c) => c.host === 'on.soundcloud.com');
    assert.equal(short.credentials, 'omit');
    assert.equal(mock.apiCalls()[0].query.url, 'https://soundcloud.com/forss/flickermood');
    await rejectsWith(expand(client, 'https://on.soundcloud.com/doesNotExist'), 'NOT_FOUND');
  });

  test('api track URL with a secret token', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://api.soundcloud.com/tracks/soundcloud:tracks:123998367?secret_token=s-8Pjrp');
    assert.deepEqual(result.items, [{
      url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw&secret_token=s-8Pjrp',
      title: PRIVATE_TRACK.title, // contains " - ", so no artist prefix
      thumb: 'https://a1.sndcdn.com/images/default_avatar_large.png',
    }]);
    assert.deepEqual(result.warnings, ['private_tracks']);
    assert.equal(mock.apiCalls()[0].query.secret_token, 's-8Pjrp');
  });

  test('private track link and widget link to a private set', async () => {
    const { client } = setup();
    const track = await expand(client, 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp');
    assert.equal(track.items[0].url, 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw&secret_token=s-8Pjrp');
    const widget = 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fplaylists%2F922213810&secret_token=s-ziYey';
    const set = await expand(client, widget);
    assert.equal(set.items.length, 4);
  });

  test('api user URL expands to the user\'s tracks', async () => {
    const { client } = setup();
    const result = await expand(client, 'https://api.soundcloud.com/users/183');
    assert.equal(result.source.kind, 'user-tracks');
    assert.equal(result.total, 4);
  });

  test('unsupported and invalid links fail without any request', async () => {
    const { mock, client } = setup({ token: TOKEN });
    for (const url of ['https://soundcloud.com/search?q=forss', 'https://soundcloud.com/forss/sets',
      'https://soundcloud.com/forss/albums', 'https://soundcloud.com/you/library', 'https://soundcloud.com/',
      'https://soundcloud.com/discover', 'https://soundcloud.com/forss/followers']) {
      await rejectsWith(expand(client, url), 'UNSUPPORTED_URL');
    }
    for (const url of ['not a url', '', null, 'https://evil.example/forss/flickermood', 'ftp://soundcloud.com/a/b']) {
      await rejectsWith(expand(client, url), 'INVALID_URL');
    }
    assert.equal(mock.calls.length, 0);
  });

  test('a deleted track is NOT_FOUND', async () => {
    const { client } = setup();
    await rejectsWith(expand(client, 'https://soundcloud.com/forss/deleted-track'), 'NOT_FOUND');
  });
});

// ----------------------------------------------------------------------------------------------- filtering + caps

describe('filtering', () => {
  const reasons = (result) => Object.fromEntries(result.skipped.map((s) => [s.title, s.reason]));

  test('skips unplayable tracks with a reason; Go+ previews skipped by default', async () => {
    const { client } = setup();
    const result = await expand(client, 'https://soundcloud.com/test/sets/problems');
    assert.equal(result.total, 9);
    assert.deepEqual(result.items.map((i) => i.title), ['Greg Gibbs - 1+0=10', 'Forss - Flickermood']);
    assert.deepEqual(reasons(result), {
      'The Police - Every Breath You Take': 'preview_only',
      'Phil Collins - Another Day in Paradise (2016 Remaster)': 'geo_blocked',
      'Hybris - The Cleaner': 'not_streamable',
      'Forss - Not Embeddable': 'not_embeddable',
      'Forss - Still Processing': 'processing',
      'Forss - Go Plus Only': 'preview_only',
      null: 'unavailable',
    });
  });

  test('skipPreviews:false keeps SNIP and SUB_HIGH_TIER tracks', async () => {
    const { client } = setup();
    const result = await expand(client, 'https://soundcloud.com/test/sets/problems', { skipPreviews: false });
    assert.deepEqual(result.items.map((i) => i.title), [
      'The Police - Every Breath You Take', 'Greg Gibbs - 1+0=10', 'Forss - Flickermood', 'Forss - Go Plus Only',
    ]);
    assert.ok(!result.skipped.some((s) => s.reason === 'preview_only'));
  });

  test('caps at 1000 tracks with a truncated warning, without hydrating past the cap', async () => {
    const { mock, client } = setup();
    const result = await expand(client, 'https://soundcloud.com/test/sets/huge');
    assert.equal(result.total, 1100);
    assert.equal(result.items.length, 1000);
    assert.deepEqual(result.warnings, ['truncated']);
    const batches = tracksCalls(mock);
    assert.equal(batches.length, 20);
    assert.ok(batches.every((c) => c.query.ids.split(',').length === 50));
    assert.equal(result.items[999].url, `https://soundcloud.com/forss/clone-${HUGE_FIRST_ID + 999}`);
  });

  test('maxTracks: stops before hydrating and before fetching more pages', async () => {
    const { mock, client } = setup();
    const set = await expand(client, 'https://soundcloud.com/forss/sets/soulhack', { maxTracks: 3 });
    assert.equal(set.items.length, 3);
    assert.deepEqual(set.warnings, ['truncated']);
    assert.equal(tracksCalls(mock).length, 0);

    const likes = await expand(client, 'https://soundcloud.com/forss/likes', { maxTracks: 5 });
    assert.equal(likes.items.length, 5);
    assert.deepEqual(likes.warnings, ['truncated']);
    assert.equal(mock.apiCalls().filter((c) => c.path === '/users/183/track_likes').length, 1);
  });
});

// ----------------------------------------------------------------------------------------------- tracks -> items

describe('normalizeTrack / toW2gItem', () => {
  test('public track: canonical URL, artist prefix, 500 px artwork', () => {
    assert.deepEqual(toW2gItem(POOL.get(293)), {
      url: 'https://soundcloud.com/forss/flickermood', title: 'Forss - Flickermood',
      thumb: 'https://i1.sndcdn.com/artworks-000067273316-smsiqx-t500x500.jpg',
    });
    const t = normalizeTrack(POOL.get(293));
    assert.equal(t.playable, true);
    assert.equal(t.reason, null);
    assert.deepEqual(toW2gItem(t), toW2gItem(POOL.get(293)));
  });

  test('private track: <user>/<track>&secret_token=<token>, never the /s- form', () => {
    const item = toW2gItem(PRIVATE_TRACK);
    assert.equal(item.url, 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw&secret_token=s-8Pjrp');
    assert.ok(!item.url.includes('/s-'));
  });

  test('title rules', () => {
    const base = { ...T293, publisher_metadata: null, user: { ...T293.user, username: 'Forss' } };
    const title = (patch) => toW2gItem({ ...base, ...patch }).title;
    assert.equal(title({ title: 'Flickermood' }), 'Forss - Flickermood');
    assert.equal(title({ title: 'Hybris - The Cleaner' }), 'Hybris - The Cleaner');
    assert.equal(title({ title: 'Someone – Something' }), 'Someone – Something');
    assert.equal(title({ title: 'Flickermood (forss remix)' }), 'Flickermood (forss remix)');
    assert.equal(title({ title: 'Forssmann Theme' }), 'Forss - Forssmann Theme', 'a longer word is not the artist');
    assert.equal(title({ title: 'Every Breath', publisher_metadata: { artist: 'The Police' } }), 'The Police - Every Breath');
    assert.equal(title({ title: '  Multi\n  line  ' }), 'Forss - Multi line');
    assert.equal(title({ title: '', permalink: 'flickermood' }), 'Forss - flickermood');
    assert.equal(title({ title: null, permalink: null, user: null }), 'Track 293');
    assert.equal(title({ title: 'A$AP (feat. X)', user: { username: 'A$AP' } }), 'A$AP (feat. X)');
  });

  test('artwork: -large and other sizes become t500x500, avatar fallback, omitted when unknown', () => {
    const thumb = (patch) => toW2gItem({ ...T293, ...patch }).thumb;
    const IMG = 'https://i1.sndcdn.com';
    assert.equal(thumb({ artwork_url: `${IMG}/artworks-abc-large.jpg` }), `${IMG}/artworks-abc-t500x500.jpg`);
    assert.equal(thumb({ artwork_url: 'http://i1.sndcdn.com/artworks-abc-t300x300.png' }), `${IMG}/artworks-abc-t500x500.png`);
    const avatarOnly = { artwork_url: null, user: { username: 'X', avatar_url: `${IMG}/avatars-x-large.jpg` } };
    assert.equal(thumb(avatarOnly), `${IMG}/avatars-x-t500x500.jpg`);
    const station = 'https://al.sndcdn.com/labs-1-0-t500x500.jpg?q=abc';
    assert.equal(thumb({ artwork_url: station }), station);
    assert.ok(!('thumb' in toW2gItem({ ...T293, artwork_url: null, user: { username: 'X', avatar_url: null } })));
  });

  test('stubs and missing tracks are unavailable', () => {
    assert.deepEqual(normalizeTrack({ id: 5, kind: 'track', policy: 'ALLOW' }),
      { id: 5, title: null, url: null, playable: false, reason: 'unavailable' });
    assert.equal(normalizeTrack(null).reason, 'unavailable');
    assert.throws(() => toW2gItem({ id: 5 }), (e) => e.code === 'INTERNAL');
  });

  test('previews are only skipped when asked', () => {
    const snip = PROBLEMS[0];
    assert.equal(normalizeTrack(snip).reason, 'preview_only');
    assert.equal(normalizeTrack(snip, { skipPreviews: false }).playable, true);
    assert.equal(normalizeTrack(snip, { skipPreviews: false }).preview, true);
  });
});

// ----------------------------------------------------------------------------------------------- auth

describe('auth', () => {
  test('a dead token: public data comes back anonymously and the login is reported expired', async () => {
    const { mock, client } = setup({ token: DEAD_TOKEN });
    const result = await expand(client, 'https://soundcloud.com/forss/sets/soulhack');
    assert.equal(result.items.length, 11);
    assert.deepEqual(mock.apiCalls().map((c) => [c.path, Boolean(c.auth)]), [
      ['/resolve', true], ['/resolve', false], ['/tracks', false],
    ]);
    const before = mock.apiCalls().length;
    assert.deepEqual(await getStatus(client), { loggedIn: false, expired: true });
    assert.deepEqual(await listLibrary(client), { loggedIn: false, expired: true, sections: [] });
    assert.equal(mock.apiCalls().length, before, 'a token known to be dead is not tried again');
  });

  test('a dead token where the login is required is AUTH_EXPIRED', async () => {
    const { mock, client } = setup({ token: DEAD_TOKEN });
    await rejectsWith(expand(client, 'https://soundcloud.com/you/likes'), 'AUTH_EXPIRED');
    assert.deepEqual(mock.apiCalls().map((c) => [c.path, Boolean(c.auth)]), [['/me', true], ['/resolve', false]]);
  });

  test('Weekly Wave with a dead token is AUTH_EXPIRED', async () => {
    const { client } = setup({ token: DEAD_TOKEN });
    await rejectsWith(expand(client, 'https://soundcloud.com/discover/sets/weekly::w2g-test-user'), 'AUTH_EXPIRED');
  });

  test('a new token value is tried again after the old one was rejected', async () => {
    let token = DEAD_TOKEN;
    const { client } = setup({ token: () => token });
    assert.deepEqual(await getStatus(client), { loggedIn: false, expired: true });
    token = TOKEN;
    assert.deepEqual(await getStatus(client), { loggedIn: true, username: 'w2g test user' });
  });

  test('an expired JWT is never sent', async () => {
    const { mock, client } = setup({ token: JWT_EXPIRED });
    await expand(client, 'https://soundcloud.com/forss/flickermood');
    await rejectsWith(expand(client, 'https://soundcloud.com/discover/sets/weekly::w2g-test-user'), 'AUTH_EXPIRED');
    await rejectsWith(expand(client, 'https://soundcloud.com/you/likes'), 'AUTH_EXPIRED');
    assert.ok(mock.apiCalls().every((c) => c.auth === null));
    assert.deepEqual(await getStatus(client), { loggedIn: false, expired: true });
    assert.equal(mock.pageLoads()[0].credentials, 'omit');
  });

  test('a valid JWT is sent with the client_id from its claims', async () => {
    const { mock, client } = setup({ token: JWT_VALID });
    const result = await expand(client, 'https://soundcloud.com/discover/sets/weekly::w2g-test-user');
    assert.equal(result.total, 30);
    assert.ok(mock.apiCalls().every((c) => c.auth === 'OAuth ' + JWT_VALID && c.query.client_id === CID_JWT));
  });

  test('a failing cookie read counts as logged out', async () => {
    const { client } = setup({ token: () => { throw new Error('no cookies permission'); } });
    assert.deepEqual(await getStatus(client), { loggedIn: false });
  });
});

// ----------------------------------------------------------------------------------------------- transport

describe('transport', () => {
  test('429 honours Retry-After', async () => {
    const { mock, client, sleeps } = setup();
    mock.fail((c) => c.path === '/resolve', () => empty(429, { 'Retry-After': '3' }));
    const result = await expand(client, 'https://soundcloud.com/forss/flickermood');
    assert.equal(result.items.length, 1);
    assert.deepEqual(sleeps, [3000]);
  });

  test('5xx backs off exponentially, then succeeds', async () => {
    const { mock, client, sleeps } = setup();
    mock.fail((c) => c.path === '/tracks', () => empty(503), 2);
    const result = await expand(client, 'https://soundcloud.com/forss/sets/soulhack');
    assert.equal(result.items.length, 11);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('persistent 429 is RATE_LIMITED, persistent 5xx is SC_HTTP, both after 3 retries', async () => {
    const limited = setup();
    limited.mock.fail((c) => c.host === API_HOST, () => empty(429), 99);
    await rejectsWith(expand(limited.client, 'https://soundcloud.com/forss/flickermood'), 'RATE_LIMITED');
    assert.deepEqual(limited.sleeps, [2000, 4000, 8000]);
    assert.equal(limited.mock.apiCalls().length, 4);

    const broken = setup();
    broken.mock.fail((c) => c.host === API_HOST, () => empty(502), 99);
    await assert.rejects(expand(broken.client, 'https://soundcloud.com/forss/flickermood'),
      (e) => e.code === 'SC_HTTP' && e.status === 502);
  });

  test('a Retry-After longer than a minute fails right away', async () => {
    const { mock, client, sleeps } = setup();
    mock.fail((c) => c.host === API_HOST, () => empty(429, { 'Retry-After': '600' }), 99);
    await rejectsWith(expand(client, 'https://soundcloud.com/forss/flickermood'), 'RATE_LIMITED');
    assert.deepEqual(sleeps, []);
  });

  test('network errors (TypeError) are retried, then reported as NETWORK', async () => {
    const flaky = setup();
    flaky.mock.fail((c) => c.path === '/resolve', () => { throw new TypeError('Failed to fetch'); }, 2);
    const result = await expand(flaky.client, 'https://soundcloud.com/forss/flickermood');
    assert.equal(result.items.length, 1);
    assert.deepEqual(flaky.sleeps, [1000, 2000]);

    const offline = setup();
    offline.mock.fail(() => true, () => { throw new TypeError('Failed to fetch'); }, 99);
    await rejectsWith(expand(offline.client, 'https://soundcloud.com/forss/flickermood'), 'NETWORK');
  });

  test('a body that breaks off mid-way is retried', async () => {
    const { mock, client } = setup();
    mock.fail((c) => c.path === '/resolve', () => {
      const body = new ReadableStream({ start(controller) { controller.error(new TypeError('network error')); } });
      return new Response(body, { status: 200 });
    });
    const result = await expand(client, 'https://soundcloud.com/forss/flickermood');
    assert.equal(result.items.length, 1);
  });

  test('403 with a captcha URL is BOT_CHALLENGE right away when there is no usable datadome cookie', async () => {
    const unusable = [null, '', '   ', 'two words', 'line\nbreak', 42, () => { throw new Error('no cookies permission'); }];
    for (const dataDomeId of unusable) {
      const { mock, client, logs } = setup({ dataDomeId });
      mock.fail((c) => c.path === '/resolve', () => json(403, { url: CAPTCHA_URL }));
      await assert.rejects(expand(client, 'https://soundcloud.com/forss/flickermood'),
        (e) => e.code === 'BOT_CHALLENGE' && e.status === 403 && e.captchaUrl === CAPTCHA_URL);
      assert.deepEqual(mock.apiCalls().map((c) => c.datadome), [null], `no retry for ${String(dataDomeId)}`);
      assert.deepEqual(mock.violations, []);
      if (typeof dataDomeId === 'function') assert.ok(logs.some(([level]) => level === 'warn'), 'a failing cookie read is logged');
    }
    // Without the option at all.
    const bare = setup({ getDataDomeId: undefined });
    bare.mock.fail((c) => c.path === '/resolve', () => json(403, { url: CAPTCHA_URL }));
    await rejectsWith(expand(bare.client, 'https://soundcloud.com/forss/flickermood'), 'BOT_CHALLENGE');
    assert.equal(bare.mock.apiCalls().length, 1);
  });

  test('a bot challenge is retried once with the datadome cookie, read fresh, so a check solved on soundcloud.com unblocks it', async () => {
    let cookie = 'dd-flagged';
    const passed = new Set();
    const { mock, client, dataDomeReads } = setup({ token: TOKEN, dataDomeId: () => cookie, mock: { dataDome: { passed } } });
    const weekly = 'https://soundcloud.com/discover/sets/weekly::w2g-test-user';
    // DataDome flags the network; the browser's current datadome session hasn't solved a check either.
    await assert.rejects(expand(client, weekly), (e) => e.code === 'BOT_CHALLENGE' && e.captchaUrl === CAPTCHA_URL);
    assert.deepEqual(mock.apiCalls().map((c) => [c.path, c.datadome]), [['/resolve', null], ['/resolve', 'dd-flagged']]);

    // The user solves the check on soundcloud.com, which replaces the cookie; the next try goes through.
    cookie = 'dd-solved';
    passed.add('dd-solved');
    const before = mock.apiCalls().length;
    const result = await expand(client, weekly);
    assert.equal(result.total, 30);
    assert.deepEqual(mock.apiCalls().slice(before).map((c) => [c.path, c.datadome]), [
      ['/resolve', null], ['/resolve', 'dd-solved'], ['/tracks', null], ['/tracks', 'dd-solved'],
    ]);
    assert.deepEqual(dataDomeReads, ['dd-flagged', 'dd-solved', 'dd-solved'], 'read again for every challenge');
    assert.ok(mock.apiCalls().every((c) => c.auth === 'OAuth ' + TOKEN && c.credentials === 'omit'));
    assert.deepEqual(mock.violations, []);
  });

  test('the datadome cookie is neither read nor sent without a challenge', async () => {
    const { mock, client, dataDomeReads } = setup({ token: TOKEN });
    await expand(client, 'https://soundcloud.com/forss/sets/soulhack');
    await expand(client, 'https://soundcloud.com/discover/sets/weekly::w2g-test-user');
    await expand(client, 'https://soundcloud.com/forss/likes');
    await listLibrary(client);
    await getStatus(client);
    // A 403 without a captcha URL is not DataDome: no retry.
    mock.fail((c) => c.path === '/resolve', () => json(403, {}));
    await assert.rejects(expand(client, 'https://soundcloud.com/forss/flickermood'), (e) => e.code === 'SC_HTTP' && e.status === 403);
    assert.deepEqual(dataDomeReads, []);
    assert.ok(mock.calls.every((c) => c.datadome === null));
    assert.deepEqual(mock.violations, []);
  });

  test('the DataDome retry keeps the 200 ms spacing', async () => {
    const time = virtualTime();
    const { mock, client } = setup({
      now: time.now, sleep: time.sleep, minIntervalMs: undefined, mock: { clock: time.now, dataDome: { passed: new Set([DD_COOKIE]) } },
    });
    await time.run(expand(client, 'https://soundcloud.com/forss/sets/soulhack'));
    const times = mock.apiCalls().map((c) => c.at);
    assert.equal(times.length, 4);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 200, `gap ${times[i] - times[i - 1]} ms`);
  });

  test('api-v2 requests start at least 200 ms apart, also when issued in parallel', async () => {
    const time = virtualTime();
    const { mock, client } = setup({ token: TOKEN, now: time.now, sleep: time.sleep, minIntervalMs: undefined, mock: { clock: time.now } });
    await time.run(expand(client, 'https://soundcloud.com/forss/sets/soulhack'));
    await time.run(listLibrary(client)); // four requests in parallel after /me
    const times = mock.apiCalls().map((c) => c.at).sort((a, b) => a - b);
    assert.equal(times.length, 7);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 200, `gap ${times[i] - times[i - 1]} ms`);
  });

  test('next_href pointing to another host is refused (the token must only go to api-v2)', async () => {
    const { mock, client } = setup({ token: TOKEN });
    const evil = { collection: LIKES_P1.collection, next_href: 'https://evil.example/steal' };
    mock.fail((c) => c.path === '/users/183/track_likes', () => json(200, evil));
    await rejectsWith(expand(client, 'https://soundcloud.com/forss/likes'), 'SC_HTTP');
    assert.ok(!mock.calls.some((c) => c.host === 'evil.example'));
  });

  test('a repeating next_href ends the list instead of looping', async () => {
    const { mock, client } = setup();
    const loop = {
      collection: LIKES_P1.collection.slice(0, 2),
      next_href: 'https://api-v2.soundcloud.com/users/183/track_likes?offset=same&limit=2',
    };
    mock.fail((c) => c.path === '/users/183/track_likes', () => json(200, loop), 5);
    const result = await expand(client, 'https://soundcloud.com/forss/likes');
    assert.equal(result.total, 4);
    assert.equal(mock.apiCalls().filter((c) => c.path === '/users/183/track_likes').length, 2);
  });
});

// ----------------------------------------------------------------------------------------------- listLibrary / getStatus

describe('listLibrary', () => {
  const ENTRY_KEYS = ['artwork', 'kind', 'subtitle', 'title', 'trackCount', 'url'];

  test('logged in: sections in display order, personal mixes first, every playlist once', async () => {
    const { mock, client } = setup({ token: TOKEN });
    const lib = await listLibrary(client);
    assert.equal(lib.loggedIn, true);
    assert.equal(lib.expired, undefined);
    assert.deepEqual(lib.user, {
      id: ME_ID, username: 'w2g test user', permalink: 'w2g-test-user', avatar: 'https://i1.sndcdn.com/avatars-000000000000-abcdef-large.jpg',
    });
    assert.deepEqual(lib.sections.map((s) => s.id), ['made-for-you', 'own', 'liked', 'likes'],
      'recently played holds only duplicates here');

    const section = (id) => lib.sections.find((s) => s.id === id);
    const mfy = section('made-for-you').entries;
    assert.deepEqual(mfy.slice(0, 2).map((e) => [e.kind, e.title, e.url]), [
      ['system-playlist', 'Weekly Wave', 'https://soundcloud.com/discover/sets/weekly::w2g-test-user'],
      ['system-playlist', 'Daily Drops', 'https://soundcloud.com/discover/sets/new-for-you:987654321'],
    ]);
    assert.equal(mfy[0].subtitle, 'Made for w2g test user');
    assert.equal(mfy[0].trackCount, 30);
    assert.ok(mfy.length <= 30);
    assert.deepEqual(section('own').entries.map((e) => e.title), ['Ecclesia Inspiration', 'Remixes']);
    assert.deepEqual(section('liked').entries.map((e) => [e.kind, e.title, e.subtitle, e.trackCount]),
      [['playlist', 'Acid Jazz', 'TMN Playlisted', 50]]);
    assert.deepEqual(section('likes').entries, [
      { kind: 'likes', url: 'https://soundcloud.com/you/likes', title: 'Liked tracks', subtitle: null, artwork: null, trackCount: 40 },
    ]);

    const all = lib.sections.flatMap((s) => s.entries);
    for (const e of all) assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS, JSON.stringify(e));
    assert.equal(new Set(all.map((e) => e.url)).size, all.length, 'no duplicates across sections');
    assert.ok(mock.apiCalls().every((c) => c.auth === 'OAuth ' + TOKEN));
    assert.deepEqual(mock.violations, []);
  });

  test('shelf items wrapped as {item} are unwrapped', async () => {
    const { client } = setup({ token: TOKEN, mock: { wrapShelfItems: true } });
    const lib = await listLibrary(client);
    assert.equal(lib.sections[0].entries[0].title, 'Weekly Wave');
  });

  test('a playlist the user owns, liked or played stays in that section when a shelf lists it too', async () => {
    const { mock, client } = setup({ token: TOKEN });
    const mixed = fixture('SYNTHETIC-mixed-selections-logged-in.json');
    // Real playlists from the real "Artists to watch out for" and "Curated by SoundCloud" shelves.
    const onShelf = (slug) => mixed.collection.flatMap((s) => s.items.collection)
      .map((x) => x.item || x).find((p) => p.permalink_url && p.permalink_url.endsWith('/sets/' + slug));
    const library = fixture('SYNTHETIC-me-library-all.json');
    library.collection.push({ type: 'playlist-like', created_at: '2026-10-01T00:00:00Z', user: {}, playlist: onShelf('buzzing-electronic') });
    const history = fixture('SYNTHETIC-me-play-history-contexts.json');
    history.collection.push({ kind: 'playlist', context_urn: 'soundcloud:playlists:1', played_at: 1791500000000, playlist: onShelf('techno-new-techno-now') });
    // The user's own playlist, featured on a shelf.
    const ownPlaylist = fixture('user-playlists-without-albums.json').collection[1];
    mixed.collection[2].items.collection.unshift(ownPlaylist);
    mock.fail((c) => c.path === '/mixed-selections', () => json(200, mixed));
    mock.fail((c) => c.path === '/me/library/all', () => json(200, library));
    mock.fail((c) => c.path === '/me/play-history/contexts', () => json(200, history));

    const lib = await listLibrary(client);
    const titles = (id) => lib.sections.find((s) => s.id === id).entries.map((e) => e.title);
    assert.deepEqual(lib.sections.map((s) => s.id), ['made-for-you', 'own', 'liked', 'recent', 'likes']);
    assert.deepEqual(titles('own'), ['Ecclesia Inspiration', 'Remixes']);
    assert.deepEqual(titles('liked'), ['Acid Jazz', 'Buzzing Electronic']);
    assert.deepEqual(titles('recent'), ['New Techno Now: Techno']);
    const mfy = titles('made-for-you');
    assert.deepEqual(mfy.slice(0, 3), ['Weekly Wave', 'Daily Drops', 'Buzzing Mexico'], 'personal mixes first, then the shelves');
    assert.equal(mfy.length, 30, 'the shelves still fill the section up to its cap');
    for (const t of ['Buzzing Electronic', 'New Techno Now: Techno', 'Remixes']) assert.ok(!mfy.includes(t), t);
    const all = lib.sections.flatMap((s) => s.entries);
    assert.equal(new Set(all.map((e) => e.url)).size, all.length, 'no duplicates across sections');
  });

  test('a "Recently Played" shelf is skipped: it repeats the play history', async () => {
    const own = fixture('user-playlists-without-albums.json').collection[0]; // Ecclesia Inspiration
    const liked = fixture('SYNTHETIC-me-library-all.json').collection.find((x) => x.type === 'playlist-like').playlist; // Acid Jazz
    const playedOnly = { ...liked, id: 4242, permalink_url: 'https://soundcloud.com/someone/sets/played-once', title: 'Played Once' };
    const shelf = { kind: 'selection', urn: 'soundcloud:selections:x', id: 'soundcloud:selections:x', title: 'Something', tracking_feature_name: 'x' };
    const markers = [
      { urn: 'soundcloud:selections:recently-played' }, { id: 'soundcloud:selections:recently-played' },
      { tracking_feature_name: 'recently-played' }, { title: 'Recently Played' }, {},
    ];
    for (const marker of markers) {
      const { mock, client } = setup({ token: TOKEN });
      const mixed = fixture('SYNTHETIC-mixed-selections-logged-in.json');
      mixed.collection.splice(1, 0, { ...shelf, ...marker, items: { collection: [own, liked, playedOnly], next_href: null } });
      mock.fail((c) => c.path === '/mixed-selections', () => json(200, mixed));
      const lib = await listLibrary(client);
      const titles = (id) => lib.sections.find((s) => s.id === id).entries.map((e) => e.title);
      const label = JSON.stringify(marker);
      assert.deepEqual(titles('own'), ['Ecclesia Inspiration', 'Remixes'], label);
      assert.deepEqual(titles('liked'), ['Acid Jazz'], label);
      const skipped = Object.keys(marker).length > 0;
      assert.equal(titles('made-for-you')[2], skipped ? 'Buzzing Mexico' : 'Played Once', label);
      assert.equal(titles('made-for-you').includes('Played Once'), !skipped, label);
    }
  });

  test('a liked station without permalink_url gets its page URL from the urn', async () => {
    const { mock, client } = setup({ token: TOKEN });
    const station = { kind: 'system-playlist', urn: 'soundcloud:system-playlists:artist-stations:183', title: 'Forss', tracks: [] };
    mock.fail((c) => c.path === '/me/library/all', () => json(200, {
      collection: [{ type: 'system-playlist-like', created_at: '2026-10-01T00:00:00Z', system_playlist: station }], next_href: null,
    }));
    const lib = await listLibrary(client);
    const liked = lib.sections.find((s) => s.id === 'liked').entries;
    assert.deepEqual(liked.map((e) => [e.kind, e.url, e.trackCount]), [
      ['system-playlist', 'https://soundcloud.com/discover/sets/artist-stations:183', 0],
    ]);
  });

  test('logged out: no requests, no sections', async () => {
    const { mock, client } = setup();
    assert.deepEqual(await listLibrary(client), { loggedIn: false, sections: [] });
    assert.equal(mock.calls.length, 0);
  });

  test('expired login', async () => {
    const jwt = setup({ token: JWT_EXPIRED });
    assert.deepEqual(await listLibrary(jwt.client), { loggedIn: false, expired: true, sections: [] });
    const dead = setup({ token: DEAD_TOKEN });
    assert.deepEqual(await listLibrary(dead.client), { loggedIn: false, expired: true, sections: [] });
  });

  test('a failing part leaves the other sections intact', async () => {
    const { mock, client, logs } = setup({ token: TOKEN });
    mock.fail((c) => c.path === '/me/library/all', () => empty(500), 99);
    mock.fail((c) => c.path === '/mixed-selections', () => { throw new TypeError('Failed to fetch'); }, 99);
    const lib = await listLibrary(client);
    assert.equal(lib.loggedIn, true);
    assert.deepEqual(lib.sections.map((s) => s.id), ['own', 'recent', 'likes']);
    assert.deepEqual(lib.sections.find((s) => s.id === 'recent').entries.map((e) => e.title), ['Weekly Wave', 'Acid Jazz']);
    assert.equal(logs.filter(([level]) => level === 'warn').length, 2);
  });

  test('a network failure of /me is an error, not "logged out"', async () => {
    const { mock, client } = setup({ token: TOKEN });
    mock.fail((c) => c.path === '/me', () => { throw new TypeError('Failed to fetch'); }, 99);
    await rejectsWith(listLibrary(client), 'NETWORK');
  });
});

describe('getStatus', () => {
  test('logged in, logged out, expired', async () => {
    assert.deepEqual(await getStatus(setup({ token: TOKEN }).client), { loggedIn: true, username: 'w2g test user' });
    assert.deepEqual(await getStatus(setup().client), { loggedIn: false });
    assert.deepEqual(await getStatus(setup({ token: DEAD_TOKEN }).client), { loggedIn: false, expired: true });
    assert.deepEqual(await getStatus(setup({ token: JWT_EXPIRED }).client), { loggedIn: false, expired: true });
  });
});
