// Small helpers shared by the background modules. No `chrome` access here.

/**
 * An error carrying one of the contract's error codes (docs/ARCHITECTURE.md, "Error codes"). `details` may add the
 * fields an error payload can carry (see errorDetails).
 */
export class BgError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BgError';
    this.code = code;
    Object.assign(this, errorDetails(details));
  }
}

function isCount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * The detail fields of an error payload (protocol revision 2): `added` (tracks already in the room) and `total`
 * as non-negative counts, `skipped` as [{ title, reason }]. Anything else is dropped.
 */
export function errorDetails(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  if (isCount(src.added)) out.added = Math.floor(src.added);
  if (isCount(src.total)) out.total = Math.floor(src.total);
  if (Array.isArray(src.skipped)) {
    out.skipped = src.skipped.filter((s) => s && typeof s === 'object').map((s) => ({
      title: typeof s.title === 'string' ? s.title : null,
      reason: typeof s.reason === 'string' ? s.reason : 'unavailable',
    }));
  }
  return out;
}

/** The largest of the given counts, or undefined when none is a count. */
export function maxCount(...values) {
  const counts = values.filter(isCount);
  return counts.length ? Math.floor(Math.max(...counts)) : undefined;
}

/**
 * The `error` object of a failure response. Coded errors (BgError, ScError) pass through with their details;
 * anything else is INTERNAL.
 */
export function errorPayload(err) {
  const message = String((err && err.message) || err || 'Unknown error');
  if (err && typeof err.code === 'string' && err.code) return { code: err.code, message, ...errorDetails(err) };
  // fetch() rejects with a bare TypeError when the network is down.
  if (err instanceof TypeError && /failed to fetch|network/i.test(message)) return { code: 'NETWORK', message };
  return { code: 'INTERNAL', message };
}

export function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/** Runs async functions one at a time, in call order. A failing function doesn't block the ones after it. */
export function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
}

/** Rejects with makeError() unless `promise` settles within `ms`. */
export function withTimeout(promise, ms, makeError) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Resolves once all promises have settled, or after `ms`, whichever comes first. Never rejects. */
export function settleWithin(promises, ms) {
  if (!promises.length) return Promise.resolve();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([Promise.allSettled(promises), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Calls an extension API that may throw or reject because its target is gone (a closed tab, a frame without
 * our content script) and resolves to undefined instead.
 */
export function quietly(fn) {
  try {
    return Promise.resolve(fn()).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/** Like fn(), but a synchronous throw becomes a rejection. */
export function attempt(fn) {
  return new Promise((resolve) => resolve(fn()));
}

/** Map whose entries expire after `ttlMs`; the oldest entries are evicted beyond `maxEntries`. */
export function createTtlCache({ ttlMs, now, maxEntries = 20 }) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * While at least one holder is active, calls `ping` (a cheap extension API) every `intervalMs`. Chrome stops a
 * service worker after 30 s without extension events or API calls; network requests and timers don't count.
 */
export function createKeepAlive(ping, intervalMs) {
  let holders = 0;
  let timer = null;

  function acquire() {
    if (holders++ === 0) timer = setInterval(() => quietly(ping), intervalMs);
  }

  function release() {
    if (holders > 0 && --holders === 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function during(fn) {
    acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire, release, during };
}

/** RegExp for a Chrome match pattern (manifest `matches`). As in Chrome, the path part also covers the query. */
export function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>') return /^(?:https?|wss?|ftp|file):\/\//;
  const m = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern);
  if (!m) throw new Error('Invalid match pattern: ' + pattern);
  const [, scheme, host = '', path] = m;
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  let hostRe = escape(host);
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = '(?:[^/]+\\.)?' + escape(host.slice(2));
  const pathRe = path.split('*').map(escape).join('.*');
  return new RegExp('^' + schemeRe + ':\\/\\/' + hostRe + pathRe + '$');
}

export function urlMatches(url, patterns) {
  if (typeof url !== 'string' || !patterns) return false;
  const bare = url.split('#')[0];
  return [].concat(patterns).some((p) => matchPatternToRegExp(p).test(bare));
}
