// SoundCloud api-v2 client for the background service worker (also loaded by the Node unit tests).
// expand() turns a SoundCloud link into w2g playlist items, listLibrary() lists the logged-in user's
// playlists for the room panel. fetch, the login token, storage and timers are injectable.
// Data shapes (ExpandResult, LibraryResult) and error codes are specified in docs/ARCHITECTURE.md.
import '../shared/sc-url.js';

const U = globalThis.SCW2G.url;

const API_HOST = 'api-v2.soundcloud.com';
const API_ORIGIN = 'https://' + API_HOST;
const WEB = 'https://soundcloud.com';
const CLIENT_ID_KEY = 'scClientId';
const CLIENT_ID_RE = /^[A-Za-z0-9]{32}$/;
const SECRET_RE = /^s-[A-Za-z0-9]+$/;
const NUMERIC_ID_RE = /^\d+$/;

const TRACK_BATCH = 50;           // /tracks?ids= answers 400 for more than 50 ids
const PAGE_LIMIT = 200;           // the server caps linked-partitioning pages at 200 raw items
const MAX_PAGES = 50;
const DEFAULT_MAX_TRACKS = 1000;
const MIN_INTERVAL_MS = 200;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60000;
const REQUEST_TIMEOUT_MS = 20000;
const REDISCOVER_COOLDOWN_MS = 60000;
const MADE_FOR_YOU_MAX = 30;

// Any answer other than 401 to this anonymous request proves that the client_id is accepted.
const PROBE = { path: '/resolve', query: { url: WEB + '/soundcloud' } };

// System playlists that anyone can open: a 404 for one of them is a real "not found", not a missing login.
const PUBLIC_SYSTEM_PLAYLIST_RE = /^(track-stations|artist-stations|trending-by-genre):/;

// The site's aliases for the logged-in user's own copy: /discover/weekly (permalink "weekly") and
// /discover/your-<year>-playback (permalink "your-playback:<year>"). Nobody can open them without a login.
const OWN_SYSTEM_PLAYLIST_RE = /^(weekly|your-playback:\d+)$/;

// soundcloud.com's DataDome tag proves its session on api-v2 calls with this header, carrying the value of the
// `datadome` cookie (ddoptions.sessionByHeader). Header values must not contain spaces or control characters.
const DATADOME_HEADER = 'X-Datadome-ClientId';
const DATADOME_ID_RE = /^[\x21-\x7e]{1,4096}$/;

// A "Recently Played" shelf of /mixed-selections repeats /me/play-history/contexts (KittyTune skips it too).
const RECENTLY_PLAYED_RE = /recently-played/i;

const NO_LOGIN = Object.freeze({ token: null, present: false, expired: false, clientId: null });

const MESSAGES = {
  INVALID_URL: 'That is not a SoundCloud link.',
  UNSUPPORTED_URL: 'This SoundCloud page has no tracks to add. '
    + 'Use a track, playlist, album, station, or a profile\'s tracks or likes.',
  NOT_FOUND: 'SoundCloud could not find this. '
    + 'It may be deleted, private without its secret link, or someone else\'s personal playlist.',
  AUTH_REQUIRED: 'This needs your SoundCloud login. Log in on soundcloud.com in this browser, then retry.',
  AUTH_EXPIRED: 'Your SoundCloud login has expired. Open soundcloud.com once to refresh it, then retry.',
  BOT_CHALLENGE: 'SoundCloud wants to check that you are not a bot. Open soundcloud.com, then retry.',
  RATE_LIMITED: 'SoundCloud is limiting requests right now. Wait a minute, then retry.',
  NETWORK: 'Could not reach SoundCloud. Check the connection, then retry.',
};

const USER_LISTS = {
  tracks: { kind: 'user-tracks', endpoint: (id) => `/users/${id}/tracks`, label: 'Tracks by' },
  'popular-tracks': { kind: 'user-popular-tracks', endpoint: (id) => `/users/${id}/toptracks`, label: 'Popular tracks by' },
  likes: { kind: 'user-likes', endpoint: (id) => `/users/${id}/track_likes`, label: 'Tracks liked by' },
  reposts: { kind: 'user-reposts', endpoint: (id) => `/stream/users/${id}/reposts`, label: 'Reposts by' },
};

const LIBRARY_SECTIONS = [
  ['made-for-you', 'Made for you'],
  ['own', 'Your playlists'],
  ['liked', 'Liked playlists'],
  ['recent', 'Recently played'],
  ['likes', 'Likes'],
];

export class ScError extends Error {
  constructor(code, message = MESSAGES[code] || code, details = {}) {
    super(message);
    this.name = 'ScError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * options: { fetch, getOAuthToken, getDataDomeId, storage, sleep, now, log, minIntervalMs, timeoutMs }
 *   getOAuthToken: async () => the `oauth_token` cookie value of https://soundcloud.com/ or null
 *   getDataDomeId: async () => the `datadome` cookie value of https://soundcloud.com/ or null. Read only after
 *     a bot challenge, and sent only on that one retry.
 *   storage: { get(key) -> value, set(key, value) } (chrome.storage.local wrapped; caches the client_id)
 *   log: (level, ...args), level 'debug' | 'warn' | 'error'
 */
export function createSoundCloudClient(options = {}) {
  return new SoundCloudClient(options);
}

class SoundCloudClient {
  constructor({
    fetch, getOAuthToken, getDataDomeId, storage, sleep, now, log,
    minIntervalMs = MIN_INTERVAL_MS, timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    const fetchImpl = fetch || globalThis.fetch;
    // Called as a plain function: browsers throw "Illegal invocation" when fetch runs with a foreign `this`.
    this._fetch = (input, init) => fetchImpl(input, init);
    this._getOAuthToken = getOAuthToken || (async () => null);
    this._getDataDomeId = getDataDomeId || (async () => null);
    this._storage = storage || memoryStorage();
    this._sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._now = now || (() => Date.now());
    this._log = log || defaultLog;
    this._minIntervalMs = minIntervalMs;
    this._timeoutMs = timeoutMs;
    this._clientId = null;
    this._clientIdPending = null;
    this._discoveredAt = -Infinity;
    this._nextSlot = 0;
    this._rejectedToken = null;
  }

  log(level, ...args) {
    this._log(level, ...args);
  }

  /** { token, present, expired, clientId }: token is null when there is no login cookie or it is known to be dead. */
  async authState() {
    let raw = null;
    try {
      raw = await this._getOAuthToken();
    } catch (err) {
      this._log('warn', 'could not read the SoundCloud login cookie', err);
    }
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!token) return NO_LOGIN;
    // Newer tokens are short-lived JWTs; only soundcloud.com refreshes them (refresh tokens are single-use).
    const claims = decodeJwt(token);
    const expired = token === this._rejectedToken
      || Boolean(claims && typeof claims.exp === 'number' && claims.exp * 1000 <= this._now());
    if (expired) return { token: null, present: true, expired: true, clientId: null };
    const claimed = claims && claims.client_id;
    const clientId = typeof claimed === 'string' && CLIENT_ID_RE.test(claimed) ? claimed : null;
    return { token, present: true, expired: false, clientId };
  }

  /**
   * GETs an api-v2 path (or an absolute next_href) and returns the parsed JSON.
   * auth: 'optional' sends the login when there is one, 'required' fails without it, 'none' never sends it.
   */
  async get(pathOrUrl, { query = {}, auth = 'optional' } = {}) {
    const login = auth === 'none' ? NO_LOGIN : await this.authState();
    if (auth === 'required' && !login.token) throw authError(login);
    let token = login.token;
    let loginExpired = login.expired;
    for (let round = 0; ; round++) {
      const clientId = await this.clientId();
      let res = await this._apiGet(pathOrUrl, query, (token && login.clientId) || clientId, token);
      if (res.status === 401 && token) {
        // A dead token gets 401 even from public endpoints, just like a bad client_id. Ask once more without it.
        const probe = auth === 'required'
          ? await this._apiGet(PROBE.path, PROBE.query, clientId, null)
          : await this._apiGet(pathOrUrl, query, clientId, null);
        if (probe.ok || probe.status === 404) {
          this._rejectedToken = token;
          this._log('debug', 'SoundCloud rejected the login token');
          if (auth === 'required') throw new ScError('AUTH_EXPIRED');
          token = null;
          loginExpired = true;
          res = probe;
        } else if (probe.status !== 401) {
          throw responseError(probe);
        }
      }
      if (res.status === 401) {
        if (round === 0 && await this._replaceClientId(clientId)) continue;
        throw new ScError('SC_HTTP', 'SoundCloud refused the request (HTTP 401).', { status: 401 });
      }
      if (res.ok) return res.body;
      throw responseError(res, { loginExpired });
    }
  }

  /** The api-v2 client_id: from memory, then storage, then discovered on soundcloud.com. */
  async clientId({ refresh = false } = {}) {
    if (!refresh) {
      if (this._clientId) return this._clientId;
      const stored = this._clientIdPending ? null : await this._storageGet(CLIENT_ID_KEY);
      if (this._clientId) return this._clientId;
      if (typeof stored === 'string' && CLIENT_ID_RE.test(stored)) return (this._clientId = stored);
    }
    if (!this._clientIdPending) {
      this._clientIdPending = this._discoverClientId()
        .then(async (id) => {
          this._clientId = id;
          this._discoveredAt = this._now();
          await this._storageSet(CLIENT_ID_KEY, id);
          return id;
        })
        .finally(() => { this._clientIdPending = null; });
    }
    return this._clientIdPending;
  }

  /** Follows an on.soundcloud.com short link and returns the URL it ends on. */
  async followShortLink(url) {
    const res = await this._request(url, { credentials: 'omit', as: 'none' });
    return res.url;
  }

  async _apiGet(pathOrUrl, query, clientId, token) {
    const url = apiUrl(pathOrUrl, query, clientId);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'OAuth ' + token;
    // api-v2 authenticates through the header only, so never attach soundcloud.com cookies.
    const res = await this._request(url, { headers, credentials: 'omit', throttle: true });
    if (!isBotChallenge(res)) return res;
    // Retry once with the browser's DataDome session, like soundcloud.com itself does, so a check the user
    // solved on soundcloud.com counts for the extension too. Without that cookie the challenge stands.
    const dataDomeId = await this._dataDomeId();
    if (!dataDomeId) return res;
    this._log('debug', 'bot challenge, retrying with the DataDome session of soundcloud.com', url);
    return this._request(url, {
      headers: { ...headers, [DATADOME_HEADER]: dataDomeId },
      credentials: 'omit',
      throttle: true,
    });
  }

  /** The `datadome` cookie value, read fresh (solving a check on soundcloud.com replaces it), or null. */
  async _dataDomeId() {
    let raw = null;
    try {
      raw = await this._getDataDomeId();
    } catch (err) {
      this._log('warn', 'could not read the SoundCloud DataDome cookie', err);
    }
    const id = typeof raw === 'string' ? raw.trim() : '';
    return DATADOME_ID_RE.test(id) ? id : null;
  }

  /** GET with retries for network errors, 5xx and 429. Resolves to { ok, status, url, body }. */
  async _request(url, { headers = {}, credentials = 'omit', as = 'json', throttle = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (throttle) await this._throttle();
      let res;
      let body = null;
      try {
        res = await this._fetch(url, { method: 'GET', headers, credentials, signal: timeoutSignal(this._timeoutMs) });
        if (isTransient(res.status) && attempt < MAX_RETRIES) discardBody(res);
        else body = await readBody(res, as);
      } catch (err) {
        if (err instanceof ScError) throw err;
        if (attempt >= MAX_RETRIES) throw new ScError('NETWORK', undefined, { cause: err });
        this._log('debug', 'network error, retrying', url, err);
        await this._sleep(backoffMs(attempt, false));
        continue;
      }
      if (isTransient(res.status) && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(res.headers, this._now()) ?? backoffMs(attempt, res.status === 429);
        if (wait > MAX_RETRY_AFTER_MS) return { ok: false, status: res.status, url: res.url || url, body: null };
        this._log('debug', `HTTP ${res.status}, retrying in ${wait} ms`, url);
        await this._sleep(wait);
        continue;
      }
      return { ok: res.ok, status: res.status, url: res.url || url, body };
    }
  }

  async _throttle() {
    const now = this._now();
    const slot = Math.max(now, this._nextSlot);
    this._nextSlot = slot + this._minIntervalMs;
    if (slot > now) await this._sleep(slot - now);
  }

  /** After a 401: gets a fresh client_id unless that just happened. True when there is a different id to retry with. */
  async _replaceClientId(staleId) {
    if (this._clientIdPending) {
      await this._clientIdPending;
    } else if (this._clientId === staleId && this._now() - this._discoveredAt >= REDISCOVER_COOLDOWN_MS) {
      this._log('debug', 'client_id rejected, discovering a new one');
      await this.clientId({ refresh: true });
    }
    return this._clientId !== staleId;
  }

  async _discoverClientId() {
    // Always anonymous: soundcloud.com answers a request whose oauth_token cookie it doesn't accept (revoked, or
    // expired by its clock) with Set-Cookie headers that delete the login, which would log the user out of
    // SoundCloud. The extension must never touch the user's SoundCloud session.
    const page = await this._request(WEB + '/', {
      headers: { Accept: 'text/html' },
      credentials: 'omit',
      as: 'text',
    });
    if (page.status === 403) throw new ScError('BOT_CHALLENGE', undefined, { status: 403 });
    if (!page.ok) throw new ScError('SC_HTTP', `soundcloud.com answered HTTP ${page.status}.`, { status: page.status });
    const html = page.body || '';
    const hydrated = clientIdFromHydration(html);
    if (hydrated) return hydrated;
    // Fallback: the id baked into the web app's config, which lives in the last script of the page.
    for (const src of scriptUrls(html).reverse()) {
      const script = await this._request(src, { credentials: 'omit', as: 'text' });
      const m = script.ok && typeof script.body === 'string' && script.body.match(/\bclient_id\s*:\s*"([A-Za-z0-9]{32})"/);
      if (m) return m[1];
    }
    throw new ScError('SC_HTTP', 'Could not find the SoundCloud client_id.');
  }

  async _storageGet(key) {
    try {
      const value = await this._storage.get(key);
      // Also accept a raw chrome.storage area, whose get() resolves to { [key]: value }.
      return value && typeof value === 'object' && key in value ? value[key] : value;
    } catch (err) {
      this._log('warn', 'storage read failed', err);
      return null;
    }
  }

  async _storageSet(key, value) {
    try {
      await this._storage.set(key, value);
    } catch (err) {
      this._log('warn', 'storage write failed', err);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// expand()

/** Turns any supported SoundCloud URL into an ExpandResult. Throws ScError. */
export async function expand(client, url, { skipPreviews = true, maxTracks = DEFAULT_MAX_TRACKS } = {}) {
  const opts = {
    skipPreviews: Boolean(skipPreviews),
    limit: Number.isFinite(maxTracks) && maxTracks >= 1 ? Math.floor(maxTracks) : DEFAULT_MAX_TRACKS,
  };
  let p = U.parse(url);
  if (p.type === 'shortlink') {
    p = U.parse(await client.followShortLink(p.url));
    if (p.type === 'shortlink') throw new ScError('NOT_FOUND', 'This short link does not lead anywhere anymore.');
  }
  const withSecret = { query: { secret_token: p.secretToken } };
  switch (p.type) {
    case 'track':
    case 'playlist':
    case 'legacy-station': {
      const item = await resolve(client, p.resolveUrl);
      return expandItem(client, item, opts, { secretToken: p.secretToken, fallbackUrl: p.resolveUrl });
    }
    case 'system-playlist':
      return expandSystemPlaylist(client, p, opts);
    case 'user': {
      if (!USER_LISTS[p.sub || 'tracks']) throw unsupported('a list of playlists');
      const user = await resolve(client, p.resolveUrl);
      return expandItem(client, user, opts, { sub: p.sub, fallbackUrl: p.resolveUrl });
    }
    case 'me': {
      if (p.sub !== 'likes') throw unsupported('/you/' + p.sub);
      const me = await client.get('/me', { auth: 'required' });
      return userListResult(client, me, 'likes', opts, { auth: 'required', own: true });
    }
    case 'api-track':
      return expandItem(client, await client.get('/tracks/' + p.id, withSecret), opts);
    case 'api-playlist':
      return expandItem(client, await client.get('/playlists/' + p.id, withSecret), opts, { secretToken: p.secretToken });
    case 'api-user':
      return expandItem(client, await client.get('/users/' + p.id), opts);
    case 'unsupported':
      throw unsupported(p.reason);
    default:
      throw new ScError('INVALID_URL');
  }
}

function resolve(client, url) {
  return client.get('/resolve', { query: { url } });
}

async function expandSystemPlaylist(client, p, opts) {
  const login = await client.authState();
  // /discover/weekly and /discover/your-<year>-playback (also as /discover/sets/<alias>) mean "the logged-in
  // user's own copy", so they fail without a usable login before any request is made.
  if ((p.needsAuth || OWN_SYSTEM_PLAYLIST_RE.test(p.permalink)) && !login.token) throw authError(login);
  let playlist;
  try {
    playlist = await resolve(client, p.resolveUrl);
  } catch (err) {
    // Personal system playlists (Weekly Wave, Daily Drops, mixes) are 404 for everyone except their owner.
    const personal = !PUBLIC_SYSTEM_PLAYLIST_RE.test(p.permalink);
    if (err.code === 'NOT_FOUND' && personal && !login.present) throw new ScError('AUTH_REQUIRED');
    throw err;
  }
  return expandItem(client, playlist, opts, { fallbackUrl: p.resolveUrl });
}

async function expandItem(client, item, opts, { sub = null, secretToken = null, fallbackUrl = null } = {}) {
  switch (item && item.kind) {
    case 'track':
      return trackResult(client, item, opts);
    case 'playlist':
      return playlistResult(client, item, opts, secretToken, fallbackUrl);
    case 'system-playlist':
      return systemPlaylistResult(client, item, opts, fallbackUrl);
    case 'station': {
      // Legacy /stations/... links resolve to { kind: 'station', system_playlist_permalink }.
      const permalink = item.system_playlist_permalink || String(item.id || '').replace(/^soundcloud:/, '');
      if (!permalink) throw new ScError('NOT_FOUND');
      const playlist = await client.get(systemPlaylistPath(permalink));
      if (!playlist || playlist.kind !== 'system-playlist') throw unsupported('station');
      return systemPlaylistResult(client, playlist, opts, item.permalink_url || fallbackUrl);
    }
    case 'user':
      return userListResult(client, item, sub, opts);
    default:
      throw unsupported(item && item.kind ? 'SoundCloud ' + item.kind : 'unknown content');
  }
}

async function trackResult(client, raw, opts) {
  const collected = await collectTracks(client, [raw], opts);
  const track = normalizeTrack(raw);
  return finish({
    kind: 'track',
    url: raw.permalink_url,
    title: track.name || track.title || 'SoundCloud track',
    subtitle: track.artist,
    artwork: track.artwork,
  }, collected);
}

async function playlistResult(client, playlist, opts, secretToken, fallbackUrl) {
  const tracks = collectionOf(playlist.tracks);
  // Private sets only hydrate their (individually private) tracks with the set's id and secret token.
  const context = { playlistId: playlist.id, playlistSecretToken: playlist.secret_token || secretToken || undefined };
  const collected = await collectTracks(client, tracks, { ...opts, context });
  const firstArtwork = tracks.find((t) => t && t.artwork_url);
  return finish({
    kind: 'playlist',
    url: playlist.permalink_url || fallbackUrl || WEB,
    title: clean(playlist.title) || 'Untitled playlist',
    subtitle: clean(playlist.user && playlist.user.username) || null,
    artwork: artwork500(playlist.artwork_url) || artwork500(firstArtwork && firstArtwork.artwork_url)
      || artwork500(playlist.user && playlist.user.avatar_url),
  }, collected);
}

async function systemPlaylistResult(client, playlist, opts, fallbackUrl) {
  const collected = await collectTracks(client, collectionOf(playlist.tracks), opts);
  return finish({
    kind: 'system-playlist',
    url: systemPlaylistUrl(playlist) || fallbackUrl || WEB,
    title: clean(playlist.title) || clean(playlist.short_title) || 'SoundCloud playlist',
    subtitle: clean(playlist.short_description) || clean(playlist.description) || null,
    artwork: artwork500(playlist.calculated_artwork_url) || artwork500(playlist.artwork_url),
  }, collected);
}

async function userListResult(client, user, sub, opts, { auth = 'optional', own = false } = {}) {
  const key = sub || 'tracks';
  const list = USER_LISTS[key];
  if (!list) throw unsupported('a list of playlists');
  if (!NUMERIC_ID_RE.test(String(user && user.id))) throw new ScError('NOT_FOUND');
  const collected = await collectPaged(client, list.endpoint(user.id), { ...opts, auth });
  const name = clean(user.username) || clean(user.permalink) || 'this user';
  const profileUrl = user.permalink_url || (user.permalink ? U.canonical([user.permalink]) : WEB);
  return finish({
    kind: list.kind,
    url: own ? WEB + '/you/likes' : profileUrl + '/' + key,
    title: own ? 'Your liked tracks' : `${list.label} ${name}`,
    subtitle: own ? name : null,
    artwork: artwork500(user.avatar_url),
  }, collected);
}

function finish(source, { total, items, skipped, truncated }) {
  const warnings = [];
  if (truncated) warnings.push('truncated');
  if (items.some((t) => t.secretToken)) warnings.push('private_tracks');
  return {
    source: {
      kind: source.kind,
      url: source.url,
      title: source.title,
      subtitle: source.subtitle || null,
      artwork: source.artwork || null,
    },
    total,
    items: items.map(toW2gItem),
    skipped: skipped.map((t) => ({ title: t.title, reason: t.reason })),
    warnings,
  };
}

/**
 * Normalizes a source's tracks in order. Stubs ({id, kind, policy, monetization_model}) are hydrated through
 * /tracks?ids= in batches, and only as far as needed to find `limit` playable tracks.
 */
async function collectTracks(client, list, { limit, skipPreviews, context = {}, auth = 'optional' }) {
  const known = new Map();
  for (const t of list) if (isHydrated(t) && idKey(t)) known.set(idKey(t), t);
  const out = { total: list.length, items: [], skipped: [], truncated: false };
  for (let i = 0; i < list.length; i++) {
    if (out.items.length >= limit) {
      out.truncated = true;
      break;
    }
    const key = idKey(list[i]);
    if (key && !known.has(key)) await hydrateFrom(client, list, i, known, context, auth);
    const raw = isHydrated(list[i]) ? list[i] : key ? known.get(key) : null;
    const track = normalizeTrack(raw, { skipPreviews });
    (track.playable ? out.items : out.skipped).push(track);
  }
  return out;
}

async function hydrateFrom(client, list, start, known, { playlistId, playlistSecretToken }, auth) {
  const ids = [];
  for (let i = start; i < list.length && ids.length < TRACK_BATCH; i++) {
    const key = idKey(list[i]);
    if (key && !known.has(key) && !ids.includes(key)) ids.push(key);
  }
  const found = await client.get('/tracks', { query: { ids: ids.join(','), playlistId, playlistSecretToken }, auth });
  // The answer comes in arbitrary order and silently leaves out tracks it can't return.
  for (const t of collectionOf(found)) if (isHydrated(t) && idKey(t)) known.set(idKey(t), t);
  for (const id of ids) if (!known.has(id)) known.set(id, null);
}

// Pages of user lists can be short or even empty while next_href is still set (the server drops unavailable
// tracks after paging), so only next_href === null ends the list.
async function collectPaged(client, path, { limit, skipPreviews, auth }) {
  const entries = [];
  let playable = 0;
  const unvisited = await eachPage(client, path, { auth }, (collection) => {
    for (const item of collection) {
      const track = item && (item.kind === 'track' ? item : item.track);
      if (!track || typeof track !== 'object') continue;
      entries.push(track);
      if (normalizeTrack(track, { skipPreviews }).playable) playable++;
    }
    return playable < limit;
  });
  const collected = await collectTracks(client, entries, { limit, skipPreviews, auth });
  if (unvisited) collected.truncated = true;
  return collected;
}

/** Calls onPage(collection) per page until it returns false or the list ends; returns the next_href left unvisited. */
async function eachPage(client, path, { auth = 'optional', pageLimit = PAGE_LIMIT, maxPages = MAX_PAGES }, onPage) {
  let next = path;
  let query = { limit: pageLimit, linked_partitioning: 1 };
  const visited = new Set();
  for (let page = 0; next && page < maxPages; page++) {
    visited.add(next);
    const data = await client.get(next, { query, auth });
    query = {}; // next_href carries the cursor and limit, but not the client_id (added by get())
    const href = data && typeof data.next_href === 'string' ? data.next_href : null;
    next = href && !visited.has(href) ? href : null;
    if (onPage(collectionOf(data)) === false) break;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Tracks -> w2g items

/**
 * Internal track descriptor: { id, name, artist, title, url, permalinkUrl, artwork, secretToken, preview, playable,
 * reason }. url is what w2g gets; title is the w2g item title. reason is null or one of 'unavailable',
 * 'geo_blocked', 'not_streamable', 'not_embeddable', 'processing', 'preview_only' (the latter only with skipPreviews).
 */
export function normalizeTrack(raw, { skipPreviews = true } = {}) {
  if (!isHydrated(raw)) {
    return { id: raw && raw.id != null ? raw.id : null, title: null, url: null, playable: false, reason: 'unavailable' };
  }
  const secretToken = typeof raw.secret_token === 'string' && raw.secret_token ? raw.secret_token : null;
  const url = w2gTrackUrl(raw.permalink_url, secretToken);
  // Go+ tracks play as a 30 s preview in the widget for every listener without Go+.
  const preview = raw.policy === 'SNIP' || raw.monetization_model === 'SUB_HIGH_TIER';
  const reason = !url ? 'unavailable' : blockReason(raw) || (skipPreviews && preview ? 'preview_only' : null);
  const name = clean(raw.title) || clean(raw.permalink) || 'Track ' + raw.id;
  const artist = clean(raw.publisher_metadata && raw.publisher_metadata.artist)
    || clean(raw.user && raw.user.username) || null;
  return {
    id: raw.id,
    name,
    artist,
    title: withArtist(name, artist),
    url,
    permalinkUrl: raw.permalink_url,
    artwork: artwork500(raw.artwork_url) || artwork500(raw.user && raw.user.avatar_url),
    secretToken,
    preview,
    playable: !reason,
    reason,
  };
}

/** W2gItem { url, title, thumb? } for a normalized track (or a raw api-v2 track). */
export function toW2gItem(track) {
  const t = track && typeof track.permalink_url === 'string' ? normalizeTrack(track, { skipPreviews: false }) : track;
  if (!t || !t.url) throw new ScError('INTERNAL', 'Cannot add a track without a URL.');
  const item = { url: t.url, title: t.title || t.url };
  if (t.artwork) item.thumb = t.artwork;
  return item;
}

function blockReason(raw) {
  if (raw.policy === 'BLOCK') return 'geo_blocked';
  if (raw.streamable === false) return 'not_streamable';
  if (raw.embeddable_by === 'none') return 'not_embeddable';
  if (typeof raw.state === 'string' && raw.state !== 'finished') return 'processing';
  return null;
}

// w2g's player builds w.soundcloud.com/player/?url=<item url>&... without encoding. The widget rejects the
// /s-XXXX permalink of a private track but plays <user>/<track>&secret_token=<token>.
function w2gTrackUrl(permalinkUrl, secretToken) {
  let u;
  try {
    u = new URL(permalinkUrl);
  } catch (_) {
    return null;
  }
  if (!/^(www\.|m\.)?soundcloud\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const page = `${WEB}/${parts[0]}/${parts[1]}`;
  if (!secretToken) return page;
  return `${page}&secret_token=${SECRET_RE.test(secretToken) ? secretToken : encodeURIComponent(secretToken)}`;
}

function withArtist(name, artist) {
  if (!artist || /\s[-–—]\s/.test(name) || containsName(name, artist)) return name;
  return `${artist} - ${name}`;
}

function containsName(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

function artwork500(url) {
  const https = httpsUrl(url);
  return https && https.replace(/-(large|t\d+x\d+|crop|small|tiny|mini|badge)(\.[a-z]+)(?=$|\?)/i, '-t500x500$2');
}

// ---------------------------------------------------------------------------------------------------------------
// listLibrary() and getStatus()

/** The logged-in user's playlists for the room panel. Never throws for "not logged in". */
export async function listLibrary(client) {
  const login = await client.authState();
  if (!login.token) return loggedOut(login.present);
  let me;
  try {
    me = await client.get('/me', { auth: 'required' });
  } catch (err) {
    if (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED') return loggedOut(err.code === 'AUTH_EXPIRED');
    throw err;
  }
  const results = await Promise.allSettled([
    client.get('/mixed-selections', { query: { limit: 20, linked_partitioning: 1 }, auth: 'required' }),
    collectPages(client, '/me/library/all', { auth: 'required', maxPages: 3 }),
    collectPages(client, `/users/${me.id}/playlists_without_albums`, { maxPages: 2 }),
    client.get('/me/play-history/contexts', { query: { limit: 25, linked_partitioning: 1 }, auth: 'required' }),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') client.log('warn', 'part of the SoundCloud library failed to load', r.reason);
  }
  const settled = (r) => (r.status === 'fulfilled' ? collectionOf(r.value) : []);
  const [selections, library, ownPlaylists, history] = results.map(settled);

  const book = createLibraryBook();
  // Weekly Wave, Daily Drops and personal mixes are the system playlists that carry made_for.
  const shelf = shelfItems(selections);
  const personal = (it) => it.kind === 'system-playlist' && it.made_for;
  for (const it of shelf.filter(personal)) book.add('made-for-you', it.kind, it);
  for (const li of library) if (li && li.type === 'playlist') book.add('own', 'playlist', li.playlist);
  for (const pl of ownPlaylists) book.add('own', 'playlist', pl);
  for (const li of library) {
    if (li && li.type === 'playlist-like') book.add('liked', 'playlist', li.playlist);
    else if (li && li.type === 'system-playlist-like') book.add('liked', 'system-playlist', li.system_playlist);
  }
  for (const h of history) {
    if (h && h.kind === 'playlist') book.add('recent', 'playlist', h.playlist);
    else if (h && h.kind === 'system-playlist') book.add('recent', 'system-playlist', h.system_playlist);
  }
  // The other shelf items (editorial playlists, genre charts) fill 'Made for you' only after the user's own,
  // liked and recently played playlists have claimed theirs, so the dedupe keeps those in their own sections.
  for (const it of shelf.filter((x) => !personal(x))) book.add('made-for-you', it.kind, it, MADE_FOR_YOU_MAX);
  book.addEntry('likes', {
    kind: 'likes',
    url: WEB + '/you/likes',
    title: 'Liked tracks',
    subtitle: null,
    artwork: null,
    trackCount: Number.isFinite(me.likes_count) ? me.likes_count : null,
  });
  return {
    loggedIn: true,
    user: {
      id: me.id,
      username: clean(me.username) || clean(me.permalink) || null,
      permalink: me.permalink || null,
      avatar: httpsUrl(me.avatar_url),
    },
    sections: book.sections(),
  };
}

/** { loggedIn, username?, expired? }; throws ScError only for network/HTTP trouble, not for "logged out". */
export async function getStatus(client) {
  const login = await client.authState();
  if (!login.token) return loggedOut(login.present, false);
  try {
    const me = await client.get('/me', { auth: 'required' });
    return { loggedIn: true, username: clean(me && me.username) || clean(me && me.permalink) || null };
  } catch (err) {
    if (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED') return loggedOut(err.code === 'AUTH_EXPIRED', false);
    throw err;
  }
}

function loggedOut(expired, withSections = true) {
  const out = { loggedIn: false };
  if (expired) out.expired = true;
  if (withSections) out.sections = [];
  return out;
}

async function collectPages(client, path, opts) {
  const all = [];
  await eachPage(client, path, opts, (collection) => { all.push(...collection); });
  return all;
}

function shelfItems(selections) {
  const out = [];
  for (const selection of selections) {
    if (!selection || isRecentlyPlayedShelf(selection)) continue;
    for (const wrapped of collectionOf(selection.items)) {
      const item = wrapped && wrapped.item ? wrapped.item : wrapped;
      if (item && (item.kind === 'playlist' || item.kind === 'system-playlist')) out.push(item);
    }
  }
  return out;
}

function isRecentlyPlayedShelf(selection) {
  const ids = [selection.urn, selection.id, selection.tracking_feature_name];
  return ids.some((v) => typeof v === 'string' && RECENTLY_PLAYED_RE.test(v))
    || clean(selection.title).toLowerCase() === 'recently played';
}

/** Sections in display order; every playlist appears once, in the section that added it first. */
function createLibraryBook() {
  const sections = LIBRARY_SECTIONS.map(([id, title]) => ({ id, title, entries: [] }));
  const seen = new Set();
  const byId = (id) => sections.find((s) => s.id === id);
  return {
    add(sectionId, kind, raw, max = Infinity) {
      const entry = kind === 'system-playlist' ? systemPlaylistEntry(raw) : playlistEntry(raw);
      if (!entry || byId(sectionId).entries.length >= max) return;
      const keys = [stripQuery(entry.url)];
      if (raw.urn || raw.id != null) keys.push(raw.urn || `${kind}:${raw.id}`);
      if (keys.some((k) => seen.has(k))) return;
      keys.forEach((k) => seen.add(k));
      byId(sectionId).entries.push(entry);
    },
    addEntry(sectionId, entry) {
      byId(sectionId).entries.push(entry);
    },
    sections: () => sections.filter((s) => s.entries.length > 0),
  };
}

function playlistEntry(pl) {
  if (!pl || typeof pl.permalink_url !== 'string') return null;
  const firstArtwork = collectionOf(pl.tracks).find((t) => t && t.artwork_url);
  return {
    kind: 'playlist',
    url: pl.permalink_url,
    title: clean(pl.title) || 'Untitled playlist',
    subtitle: clean(pl.user && pl.user.username) || null,
    artwork: httpsUrl(pl.artwork_url) || httpsUrl(firstArtwork && firstArtwork.artwork_url)
      || httpsUrl(pl.user && pl.user.avatar_url),
    trackCount: Number.isFinite(pl.track_count) ? pl.track_count : Array.isArray(pl.tracks) ? pl.tracks.length : null,
  };
}

function systemPlaylistEntry(sp) {
  const url = sp && systemPlaylistUrl(sp);
  if (!url) return null;
  const madeFor = clean(sp.made_for && sp.made_for.username);
  return {
    kind: 'system-playlist',
    url,
    title: clean(sp.title) || clean(sp.short_title) || 'SoundCloud playlist',
    subtitle: clean(sp.short_description) || (madeFor ? 'Made for ' + madeFor : null),
    artwork: httpsUrl(sp.calculated_artwork_url) || httpsUrl(sp.artwork_url),
    trackCount: Array.isArray(sp.tracks) ? sp.tracks.length : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

// Library entries for liked stations may come without permalink_url; the page URL follows from the urn.
function systemPlaylistUrl(sp) {
  if (typeof sp.permalink_url === 'string') return sp.permalink_url;
  const m = /^soundcloud:system-playlists:(.+)$/.exec(sp.urn || '');
  const permalink = sp.permalink || (m && m[1]);
  return permalink ? U.canonical(['discover', 'sets', permalink]) : null;
}

function apiUrl(pathOrUrl, query, clientId) {
  const url = new URL(pathOrUrl, API_ORIGIN);
  // next_href comes from the API: never let it send the login token to another host.
  if (url.protocol !== 'https:' || url.hostname !== API_HOST) throw new ScError('SC_HTTP', 'Unexpected SoundCloud API URL.');
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  url.searchParams.set('client_id', clientId);
  return url.href;
}

function systemPlaylistPath(permalink) {
  return '/system-playlists/' + encodeURIComponent('soundcloud:system-playlists:' + permalink).replace(/%3A/gi, ':');
}

// DataDome answers 403 with { url: <captcha page> }.
function isBotChallenge({ status, body }) {
  return status === 403 && Boolean(body) && typeof body.url === 'string';
}

function responseError(res, { loginExpired = false } = {}) {
  const { status, body } = res;
  // With a dead login a 404 may just mean "only visible when logged in" (own private sets, personal mixes).
  if (status === 404) return new ScError(loginExpired ? 'AUTH_EXPIRED' : 'NOT_FOUND', undefined, { status });
  if (isBotChallenge(res)) return new ScError('BOT_CHALLENGE', undefined, { status, captchaUrl: body.url });
  if (status === 429) return new ScError('RATE_LIMITED', undefined, { status });
  return new ScError('SC_HTTP', `SoundCloud answered HTTP ${status}.`, { status });
}

function authError(login) {
  return new ScError(login.present ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
}

function unsupported(reason) {
  return new ScError('UNSUPPORTED_URL', undefined, reason ? { reason } : {});
}

function clientIdFromHydration(html) {
  const m = html.match(/window\.__sc_hydration\s*=\s*(\[.*?\]);\s*<\/script>/s);
  if (!m) return null;
  try {
    const entry = JSON.parse(m[1]).find((x) => x && x.hydratable === 'apiClient');
    const id = entry && entry.data && entry.data.id;
    return typeof id === 'string' && CLIENT_ID_RE.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}

function scriptUrls(html) {
  return [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    return claims && typeof claims === 'object' ? claims : null;
  } catch (_) {
    return null;
  }
}

async function readBody(res, as) {
  if (as === 'none') {
    discardBody(res);
    return null;
  }
  const text = await res.text();
  if (as === 'text') return text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    if (res.ok) throw new ScError('SC_HTTP', 'SoundCloud sent an unreadable response.', { status: res.status });
    return null;
  }
}

function discardBody(res) {
  try {
    if (res.body && !res.bodyUsed) res.body.cancel().catch(() => {});
  } catch (_) { /* already consumed or locked */ }
}

function isTransient(status) {
  return status === 429 || status >= 500;
}

function backoffMs(attempt, rateLimited) {
  return (rateLimited ? 2000 : 1000) * 2 ** attempt;
}

function retryAfterMs(headers, now) {
  const value = headers && headers.get('retry-after');
  if (!value) return null;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function timeoutSignal(ms) {
  return ms > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

function isHydrated(t) {
  return Boolean(t && typeof t === 'object' && typeof t.permalink_url === 'string');
}

function idKey(t) {
  return t && t.id != null && NUMERIC_ID_RE.test(String(t.id)) ? String(t.id) : null;
}

function collectionOf(data) {
  if (Array.isArray(data)) return data;
  return data && Array.isArray(data.collection) ? data.collection : [];
}

function clean(s) {
  return s == null ? '' : String(s).replace(/\s+/g, ' ').trim();
}

function httpsUrl(url) {
  if (typeof url !== 'string') return null;
  const https = url.trim().replace(/^http:\/\//i, 'https://');
  return /^https:\/\/\S+$/i.test(https) ? https : null;
}

function stripQuery(url) {
  return url.replace(/[?#].*$/, '');
}

function memoryStorage() {
  const map = new Map();
  return { get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); } };
}

function defaultLog(level, ...args) {
  if (level === 'warn' || level === 'error') console[level]('[scw2g]', ...args);
}
