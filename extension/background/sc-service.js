// SoundCloud access for the message handlers: one lazily created api-v2 client, the login cookie, and caches
// (expansions 2 min, login status and library 5 min). A change of the oauth_token cookie (login, logout,
// token refresh by soundcloud.com) drops the caches and the client.
import { BgError, createLock, createTtlCache } from './util.js';

const TOKEN_COOKIE = { url: 'https://soundcloud.com/', name: 'oauth_token' };
// After a bot challenge the client retries once with this cookie's value, as soundcloud.com's own DataDome tag
// does (X-Datadome-ClientId), so solving the check on soundcloud.com unblocks the extension too.
const DATADOME_COOKIE = { url: 'https://soundcloud.com/', name: 'datadome' };
export const MAX_TRACKS = 1000;

// Worded like the same codes in soundcloud.js.
const URL_ERRORS = {
  INVALID_URL: 'That is not a SoundCloud link.',
  UNSUPPORTED_URL: 'This SoundCloud page has no tracks to add. Use a track, playlist, album, station, or a profile\'s tracks or likes.',
};

export function isLoginCookie(cookie) {
  return !!cookie && cookie.name === 'oauth_token' && /(^|\.)soundcloud\.com$/i.test(String(cookie.domain || ''));
}

export function createScService({ chrome, sc, urlTools, fetch, now, keepAlive, expandTtlMs, cacheTtlMs }) {
  let client = null;
  let generation = 0; // bumped on every login change; results fetched under an older login are not cached
  const expandLock = createLock();
  const expansions = createTtlCache({ ttlMs: expandTtlMs, now });
  const pendingExpansions = new Map();
  const status = createCachedCall();
  const library = createCachedCall();

  // Read fresh on every use: soundcloud.com replaces both cookies (token refresh, solved bot check).
  async function cookieValue(details) {
    try {
      const cookie = await chrome.cookies.get(details);
      return (cookie && cookie.value) || null;
    } catch {
      return null;
    }
  }

  const getOAuthToken = () => cookieValue(TOKEN_COOKIE);
  const getDataDomeId = () => cookieValue(DATADOME_COOKIE);

  // Key/value storage for the client (client_id cache).
  const storage = {
    async get(key) {
      return (await chrome.storage.local.get(key))[key] ?? null;
    },
    set(key, value) {
      return chrome.storage.local.set({ [key]: value });
    },
  };

  function getClient() {
    if (!client) client = sc.createSoundCloudClient({ fetch, getOAuthToken, getDataDomeId, storage });
    return client;
  }

  /** The trimmed URL if it can be expanded at all (offline check); throws INVALID_URL or UNSUPPORTED_URL. */
  function checkUrl(input) {
    const url = typeof input === 'string' ? input.trim() : '';
    const { type } = urlTools.parse(url);
    if (type === 'invalid') throw new BgError('INVALID_URL', URL_ERRORS.INVALID_URL);
    if (type === 'unsupported') throw new BgError('UNSUPPORTED_URL', URL_ERRORS.UNSUPPORTED_URL);
    return url;
  }

  /**
   * ExpandResult for `url`. Identical requests share one fetch; expansions run one at a time so a big import
   * doesn't interleave with others against SoundCloud's rate limit.
   */
  function expand(url, { skipPreviews }) {
    const key = `${generation}|${skipPreviews ? 1 : 0}|${url}`;
    const cached = expansions.get(key);
    if (cached) return Promise.resolve(cached);
    if (pendingExpansions.has(key)) return pendingExpansions.get(key);
    const startedIn = generation;
    const pending = expandLock(() => keepAlive.during(() => sc.expand(getClient(), url, { skipPreviews, maxTracks: MAX_TRACKS })))
      .then((result) => {
        if (startedIn === generation) expansions.set(key, result);
        return result;
      })
      .finally(() => pendingExpansions.delete(key));
    pendingExpansions.set(key, pending);
    return pending;
  }

  function getStatus() {
    return status.get(() => sc.getStatus(getClient()));
  }

  function getLibrary({ refresh = false } = {}) {
    return library.get(() => keepAlive.during(() => sc.listLibrary(getClient())), { refresh });
  }

  /** chrome.cookies.onChanged listener. Returns true when the change concerned the SoundCloud login. */
  function onCookieChanged(info) {
    if (!isLoginCookie(info && info.cookie)) return false;
    generation++;
    client = null;
    expansions.clear();
    return true;
  }

  // One cached value with a TTL, shared in-flight loads, and no caching across login changes.
  function createCachedCall() {
    let entry = null; // { value, at, generation }
    let inflight = null; // { promise, generation }
    return {
      get(load, { refresh = false } = {}) {
        if (!refresh && entry && entry.generation === generation && now() - entry.at < cacheTtlMs) {
          return Promise.resolve(entry.value);
        }
        if (inflight && inflight.generation === generation) return inflight.promise;
        const startedIn = generation;
        const promise = Promise.resolve()
          .then(load)
          .then((value) => {
            if (startedIn === generation) entry = { value, at: now(), generation: startedIn };
            return value;
          })
          .finally(() => {
            if (inflight && inflight.promise === promise) inflight = null;
          });
        inflight = { promise, generation: startedIn };
        return promise;
      },
    };
  }

  return { checkUrl, expand, getStatus, getLibrary, onCookieChanged };
}
