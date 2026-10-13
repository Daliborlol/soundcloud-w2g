import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../extension/shared/sc-url.js');
const U = globalThis.SCW2G.url;

test('parse: tracks, with tracking params, mobile host and secret tokens', () => {
  assert.deepEqual(U.parse('https://soundcloud.com/forss/flickermood'),
    { type: 'track', resolveUrl: 'https://soundcloud.com/forss/flickermood', secretToken: null });
  assert.deepEqual(U.parse('https://m.soundcloud.com/forss/flickermood?si=abc&utm_source=clipboard#t=10'),
    { type: 'track', resolveUrl: 'https://soundcloud.com/forss/flickermood', secretToken: null });
  assert.deepEqual(U.parse('https://soundcloud.com/forss/flickermood?in=forss/sets/soulhack'),
    { type: 'track', resolveUrl: 'https://soundcloud.com/forss/flickermood', secretToken: null });
  assert.deepEqual(U.parse('https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'),
    { type: 'track', resolveUrl: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp', secretToken: 's-8Pjrp' });
  assert.equal(U.parse('https://soundcloud.com/forss/flickermood/recommended').resolveUrl, 'https://soundcloud.com/forss/flickermood');
  assert.equal(U.parse('https://soundcloud.com/n/forss/flickermood?crossfade=true').resolveUrl, 'https://soundcloud.com/forss/flickermood');
});

test('parse: playlists, private sets and system playlists', () => {
  assert.deepEqual(U.parse('https://soundcloud.com/forss/sets/soulhack'),
    { type: 'playlist', resolveUrl: 'https://soundcloud.com/forss/sets/soulhack', secretToken: null });
  assert.deepEqual(U.parse('https://soundcloud.com/u/sets/my-set/s-AbC123?si=x'),
    { type: 'playlist', resolveUrl: 'https://soundcloud.com/u/sets/my-set/s-AbC123', secretToken: 's-AbC123' });
  const ww = U.parse('https://soundcloud.com/discover/sets/weekly::someone');
  assert.equal(ww.type, 'system-playlist');
  assert.equal(ww.permalink, 'weekly::someone');
  assert.equal(ww.urn, 'soundcloud:system-playlists:weekly::someone');
  assert.equal(ww.resolveUrl, 'https://soundcloud.com/discover/sets/weekly::someone');
  const enc = U.parse('https://soundcloud.com/discover/sets/track-stations%3A293');
  assert.equal(enc.resolveUrl, 'https://soundcloud.com/discover/sets/track-stations:293');
  const weekly = U.parse('https://soundcloud.com/discover/weekly');
  assert.equal(weekly.type, 'system-playlist');
  assert.equal(weekly.needsAuth, true);
  assert.equal(U.parse('https://soundcloud.com/stations/track/forss/flickermood').type, 'legacy-station');
  assert.equal(U.parse('https://soundcloud.com/stations/artist/forss').type, 'legacy-station');
  const playback = U.parse('https://soundcloud.com/discover/your-2025-playback?ref=home');
  assert.deepEqual(playback, { type: 'system-playlist', permalink: 'your-playback:2025', urn: null,
    resolveUrl: 'https://soundcloud.com/discover/sets/your-playback:2025', needsAuth: true });
  assert.deepEqual(U.classifyHref('/discover/your-2025-playback'),
    { kind: 'system-playlist', url: 'https://soundcloud.com/discover/sets/your-playback:2025' });
  assert.equal(U.parse('https://soundcloud.com/discover/your-playback').type, 'unsupported');
});

test('parse: user pages, /you pages and unsupported routes', () => {
  assert.deepEqual(U.parse('https://soundcloud.com/forss'), { type: 'user', sub: null, resolveUrl: 'https://soundcloud.com/forss' });
  assert.deepEqual(U.parse('https://soundcloud.com/forss/likes'), { type: 'user', sub: 'likes', resolveUrl: 'https://soundcloud.com/forss' });
  assert.equal(U.parse('https://soundcloud.com/forss/popular-tracks').sub, 'popular-tracks');
  assert.equal(U.parse('https://soundcloud.com/forss/sets').sub, 'sets');
  assert.equal(U.parse('https://soundcloud.com/forss/albums').sub, 'albums');
  assert.equal(U.parse('https://soundcloud.com/forss/followers').type, 'unsupported');
  assert.deepEqual(U.parse('https://soundcloud.com/you/likes'), { type: 'me', sub: 'likes' });
  assert.deepEqual(U.parse('https://soundcloud.com/you'), { type: 'me', sub: 'library' });
  for (const u of ['https://soundcloud.com/', 'https://soundcloud.com/discover', 'https://soundcloud.com/search?q=x',
    'https://soundcloud.com/tags/house', 'https://soundcloud.com/charts/top', 'https://soundcloud.com/feed']) {
    assert.equal(U.parse(u).type, 'unsupported', u);
  }
});

test('parse: short links, widget URLs, api URLs and junk', () => {
  assert.deepEqual(U.parse('https://on.soundcloud.com/9zRpu'), { type: 'shortlink', url: 'https://on.soundcloud.com/9zRpu' });
  assert.deepEqual(U.parse('https://api.soundcloud.com/tracks/123998367?secret_token=s-8Pjrp'),
    { type: 'api-track', id: 123998367, secretToken: 's-8Pjrp' });
  assert.deepEqual(U.parse('https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A290'), { type: 'api-track', id: 290, secretToken: null });
  assert.equal(U.parse('https://api.soundcloud.com/playlists/18').type, 'api-playlist');
  const w = U.parse('https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fplaylists%2F922213810&secret_token=s-xyz12');
  assert.deepEqual(w, { type: 'api-playlist', id: 922213810, secretToken: 's-xyz12' });
  assert.equal(U.parse('https://w.soundcloud.com/player/?url=https://soundcloud.com/forss/sets/soulhack').type, 'playlist');
  for (const u of ['', null, 'not a url', 'ftp://soundcloud.com/x/y', 'https://evil.com/forss/flickermood',
    'https://soundcloud.com.evil.com/a/b', 'https://w.soundcloud.com/player/']) {
    assert.equal(U.parse(u).type, 'invalid', String(u));
  }
});

test('classifyHref: DOM links', () => {
  const base = 'https://soundcloud.com/forss';
  assert.deepEqual(U.classifyHref('/forss/city-ports?in=forss/sets/soulhack', base),
    { kind: 'track', url: 'https://soundcloud.com/forss/city-ports' });
  assert.deepEqual(U.classifyHref('/forss/flickermood?in_system_playlist=track-stations%3A293', base),
    { kind: 'track', url: 'https://soundcloud.com/forss/flickermood' });
  assert.deepEqual(U.classifyHref('/forss/sets/soulhack', base), { kind: 'playlist', url: 'https://soundcloud.com/forss/sets/soulhack' });
  assert.deepEqual(U.classifyHref('/forss/sets/soulhack/s-AbCdE', base), { kind: 'playlist', url: 'https://soundcloud.com/forss/sets/soulhack/s-AbCdE' });
  assert.deepEqual(U.classifyHref('/forss/flickermood/s-AbCdE', base), { kind: 'track', url: 'https://soundcloud.com/forss/flickermood/s-AbCdE' });
  assert.deepEqual(U.classifyHref('/discover/sets/trending-by-genre%3Aelectronic', base),
    { kind: 'system-playlist', url: 'https://soundcloud.com/discover/sets/trending-by-genre:electronic' });
  assert.deepEqual(U.classifyHref('/n/forss/flickermood', base), { kind: 'track', url: 'https://soundcloud.com/forss/flickermood' });
  assert.deepEqual(U.classifyHref('/forss/flickermood/comments/123', base), { kind: 'track', url: 'https://soundcloud.com/forss/flickermood' });
  for (const h of ['/forss', '/forss/tracks', '/forss/sets', '/forss/likes', '/search?q=x', '/tags/x', '/you/library',
    '/charts/top', 'https://on.soundcloud.com/x', 'https://example.com/forss/flickermood', '', null]) {
    assert.equal(U.classifyHref(h, base), null, String(h));
  }
});

test('extractUrl: finds SoundCloud links in pasted text', () => {
  assert.equal(U.extractUrl('listen https://soundcloud.com/forss/sets/soulhack!'), 'https://soundcloud.com/forss/sets/soulhack');
  assert.equal(U.extractUrl('soundcloud.com/forss/flickermood'), 'https://soundcloud.com/forss/flickermood');
  assert.equal(U.extractUrl('(https://on.soundcloud.com/9zRpu)'), 'https://on.soundcloud.com/9zRpu');
  assert.equal(U.extractUrl('http://m.soundcloud.com/forss'), 'https://m.soundcloud.com/forss');
  assert.equal(U.extractUrl('https://youtube.com/watch?v=x'), null);
  assert.equal(U.extractUrl(''), null);
});

test('isW2gNativeTrack: mirrors the w2g search box rule', () => {
  assert.equal(U.isW2gNativeTrack('https://soundcloud.com/forss/flickermood'), true);
  assert.equal(U.isW2gNativeTrack('https://soundcloud.com/forss/flickermood?in=forss/sets/soulhack'), true);
  assert.equal(U.isW2gNativeTrack('https://soundcloud.com/forss/sets/soulhack'), false);
  assert.equal(U.isW2gNativeTrack('https://soundcloud.com/forss/flickermood/s-AbCdE'), false);
  assert.equal(U.isW2gNativeTrack('https://soundcloud.com/discover/sets/weekly::x'), false);
  assert.equal(U.isW2gNativeTrack('https://on.soundcloud.com/9zRpu'), false);
  // w2g's regex matches these too, but they are lists, not single tracks.
  for (const u of ['https://soundcloud.com/forss/likes', 'https://soundcloud.com/forss/tracks', 'https://soundcloud.com/forss/reposts',
    'https://soundcloud.com/forss/popular-tracks', 'https://soundcloud.com/you/likes', 'https://soundcloud.com/discover/weekly']) {
    assert.equal(U.isW2gNativeTrack(u), false, u);
  }
  // w2g's search box only knows https://soundcloud.com/... exactly.
  assert.equal(U.isW2gNativeTrack('soundcloud.com/forss/flickermood'), false);
  assert.equal(U.isW2gNativeTrack('http://soundcloud.com/forss/flickermood'), false);
  assert.equal(U.isW2gNativeTrack('  https://soundcloud.com/forss/flickermood  '), true);
});
