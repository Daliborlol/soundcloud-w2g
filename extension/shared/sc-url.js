/*
 * SoundCloud URL helpers shared by the background service worker, both content scripts and the tests.
 *
 * This file is loaded three ways, so it must stay free of import/export statements:
 *   - as a classic content script, listed before the content script that uses it;
 *   - as a side-effect module import from background/main.js (`import '../shared/sc-url.js'`);
 *   - from Node tests via `await import(...)`.
 * It exposes everything on globalThis.SCW2G.url.
 */
(function (root) {
  'use strict';

  const WEB = 'https://soundcloud.com';
  const SECRET_RE = /^s-[A-Za-z0-9]+$/;

  // First path segments that are SoundCloud app routes, never user permalinks.
  const RESERVED_ROOTS = new Set([
    'discover', 'stations', 'you', 'charts', 'search', 'upload', 'settings', 'pages', 'tags', 'people',
    'signin', 'signup', 'logout', 'messages', 'notifications', 'terms-of-use', 'imprint', 'jobs', 'mobile',
    'pro', 'premium', 'go', 'artists', 'creators', 'feed', 'stream', 'popular', 'explore', 'connect',
    'for-artists', 'checkout', 'next', 'n', 'oembed', 'player', 'widget', 'apps', 'community-guidelines',
  ]);

  // Second path segments of /<user>/<x> that are profile tabs, not track slugs.
  const USER_SUBPAGES = new Set([
    'tracks', 'sets', 'albums', 'likes', 'reposts', 'popular-tracks', 'followers', 'following',
    'comments', 'spotlight', 'toptracks', 'stations', 'insights',
  ]);

  // Profile tabs we can turn into a track list.
  const USER_TRACK_LISTS = new Set(['tracks', 'likes', 'reposts', 'popular-tracks']);

  // Exactly what w2g's own search box accepts as "a single Soundcloud track (no sets)" (w2g room.js provider regex).
  const W2G_NATIVE_TRACK_RE = /^https:\/\/soundcloud.com\/([a-z0-9-_]+\/(?!sets)[a-z0-9-_]+)($|\?)/;

  function canonical(parts) {
    return WEB + '/' + parts.map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  /**
   * Classifies a pasted or linked SoundCloud URL without touching the network.
   *
   * Returns one of:
   *   { type: 'invalid' }
   *   { type: 'unsupported', reason }
   *   { type: 'shortlink', url }                                  on.soundcloud.com, caller must follow the redirect
   *   { type: 'track', resolveUrl, secretToken }
   *   { type: 'playlist', resolveUrl, secretToken }               sets and albums
   *   { type: 'system-playlist', permalink, urn, resolveUrl, needsAuth }
   *                                                               /discover/sets/<permalink>: Weekly Wave, Daily Drops, stations, mixes
   *   { type: 'legacy-station', resolveUrl }                      /stations/track/<u>/<slug>, /stations/artist/<u>
   *   { type: 'user', sub, resolveUrl }                           sub: null | 'tracks' | 'likes' | 'reposts' | 'popular-tracks' | 'sets' | 'albums'
   *   { type: 'me', sub }                                         /you/<sub>, needs the logged-in user
   *   { type: 'api-track' | 'api-playlist' | 'api-user', id, secretToken }
   */
  function parse(input) {
    let u;
    try { u = new URL(String(input == null ? '' : input).trim()); } catch (_) { return { type: 'invalid' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { type: 'invalid' };
    const host = u.hostname.toLowerCase();

    if (host === 'on.soundcloud.com') {
      return u.pathname.length > 1 ? { type: 'shortlink', url: 'https://on.soundcloud.com' + u.pathname } : { type: 'invalid' };
    }

    if (host === 'w.soundcloud.com' || host === 'p.soundcloud.com' || host === 'player.soundcloud.com') {
      const inner = u.searchParams.get('url');
      if (!inner) return { type: 'invalid' };
      const parsed = parse(inner);
      const tok = u.searchParams.get('secret_token');
      if (tok && SECRET_RE.test(tok) && 'secretToken' in parsed && !parsed.secretToken) parsed.secretToken = tok;
      return parsed;
    }

    if (host === 'api.soundcloud.com' || host === 'api-v2.soundcloud.com') {
      const m = u.pathname.match(/^\/(tracks|playlists|users)\/(?:soundcloud(?::|%3A)(?:tracks|playlists|users)(?::|%3A))?(\d+)\/?$/i);
      if (!m) return { type: 'invalid' };
      const kind = { tracks: 'track', playlists: 'playlist', users: 'user' }[m[1].toLowerCase()];
      const tok = u.searchParams.get('secret_token');
      return { type: 'api-' + kind, id: Number(m[2]), secretToken: tok && SECRET_RE.test(tok) ? tok : null };
    }

    if (!/^(www\.|m\.)?soundcloud\.com$/.test(host)) return { type: 'invalid' };

    let parts = u.pathname.split('/').filter(Boolean).map(safeDecode);
    // The redesigned track page runs in an iframe under /n/<user>/<track>.
    if (parts[0] === 'n' && parts.length >= 3) parts = parts.slice(1);
    if (parts.length === 0) return { type: 'unsupported', reason: 'home page' };
    const [a, b, c, d] = parts;

    if (a === 'discover') {
      if (b === 'sets' && c) {
        return { type: 'system-playlist', permalink: c, urn: 'soundcloud:system-playlists:' + c, resolveUrl: canonical(parts.slice(0, 3)), needsAuth: false };
      }
      // The site maps /discover/weekly to the logged-in user's own Weekly Wave.
      if (b === 'weekly' && !c) {
        return { type: 'system-playlist', permalink: 'weekly', urn: null, resolveUrl: WEB + '/discover/sets/weekly', needsAuth: true };
      }
      // ...and /discover/your-<year>-playback to their "Your <year> Playback" mix (SoundCloud's route table:
      // route "your-(?::num+)-playback" -> systemPlaylistPermalink "your-playback:" + year, requiresLogin).
      const playback = !c && /^your-(\d{4})-playback$/.exec(b || '');
      if (playback) {
        const permalink = 'your-playback:' + playback[1];
        return { type: 'system-playlist', permalink, urn: null, resolveUrl: WEB + '/discover/sets/' + permalink, needsAuth: true };
      }
      return { type: 'unsupported', reason: 'discover page' };
    }
    if (a === 'stations' && b === 'track' && c && d) return { type: 'legacy-station', resolveUrl: canonical(parts.slice(0, 4)) };
    if (a === 'stations' && b === 'artist' && c) return { type: 'legacy-station', resolveUrl: canonical(parts.slice(0, 3)) };
    if (a === 'you') return { type: 'me', sub: b || 'library' };
    if (RESERVED_ROOTS.has(a)) return { type: 'unsupported', reason: '/' + a + ' page' };

    if (!b) return { type: 'user', sub: null, resolveUrl: canonical([a]) };
    if (USER_SUBPAGES.has(b)) {
      if (b === 'sets' && c) {
        const secretToken = d && SECRET_RE.test(d) ? d : null;
        return { type: 'playlist', resolveUrl: canonical([a, b, c].concat(secretToken ? [secretToken] : [])), secretToken };
      }
      if (c) return { type: 'unsupported', reason: 'profile sub-page' };
      if (USER_TRACK_LISTS.has(b) || b === 'sets' || b === 'albums') return { type: 'user', sub: b, resolveUrl: canonical([a]) };
      return { type: 'unsupported', reason: 'profile ' + b + ' page' };
    }
    // /<user>/<track>[/s-<token>]; other third segments (/recommended, /likes, /comments/..) are track sub-pages.
    const secretToken = c && SECRET_RE.test(c) ? c : null;
    return { type: 'track', resolveUrl: canonical([a, b].concat(secretToken ? [secretToken] : [])), secretToken };
  }

  /**
   * Classifies a link found in SoundCloud's DOM (relative or absolute) for the "Add to w2g" buttons.
   * Returns { kind: 'track' | 'playlist' | 'system-playlist', url } or null for anything else (users, tags, ...).
   * Query strings such as ?in=<set> or ?in_system_playlist=<id> are dropped; secret tokens are kept.
   */
  function classifyHref(href, base) {
    if (!href) return null;
    let abs;
    try { abs = new URL(href, base || WEB + '/'); } catch (_) { return null; }
    if (!/^(www\.|m\.)?soundcloud\.com$/i.test(abs.hostname)) return null;
    const p = parse(abs.origin + abs.pathname);
    if (p.type === 'track' || p.type === 'playlist') return { kind: p.type, url: p.resolveUrl };
    if (p.type === 'system-playlist') return { kind: 'system-playlist', url: p.resolveUrl };
    if (p.type === 'legacy-station') return { kind: 'system-playlist', url: p.resolveUrl };
    return null;
  }

  /** First SoundCloud URL inside arbitrary pasted text (scheme optional), normalized to https. */
  function extractUrl(text) {
    const m = String(text == null ? '' : text).match(/(?:https?:\/\/)?(?:(?:www|m|on|w|api|api-v2)\.)?soundcloud\.com\/[^\s"'<>]*/i);
    if (!m) return null;
    let s = m[0].replace(/[).,;!?\]]+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/^http:\/\//i, 'https://');
  }

  /**
   * True when w2g can already handle the URL itself: its search box regex matches AND it really is a plain public
   * track. The regex alone also matches profile lists (/user/likes, /you/likes, /discover/weekly), which w2g then
   * turns into the wrong item or nothing.
   */
  function isW2gNativeTrack(url) {
    const raw = String(url == null ? '' : url).trim();
    if (!W2G_NATIVE_TRACK_RE.test(raw)) return false;
    const p = parse(raw);
    return p.type === 'track' && !p.secretToken;
  }

  const api = { WEB, parse, classifyHref, extractUrl, isW2gNativeTrack, canonical };
  root.SCW2G = root.SCW2G || {};
  root.SCW2G.url = api;
})(globalThis);
