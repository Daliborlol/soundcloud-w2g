// Live checks of background/soundcloud.js against the real api-v2, anonymously (about 15 requests).
// Skipped unless LIVE=1:  LIVE=1 node --test test/unit/soundcloud.live.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSoundCloudClient, expand, getStatus, listLibrary, ScError } from '../../extension/background/soundcloud.js';

const LIVE = process.env.LIVE === '1';
const skip = LIVE ? false : 'set LIVE=1 to run against the real SoundCloud API';
const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sc');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));

const PUBLIC_TRACK_URL = /^https:\/\/soundcloud\.com\/[^/?#&]+\/[^/?#&]+$/;
const REASONS = new Set(['unavailable', 'geo_blocked', 'not_streamable', 'not_embeddable', 'processing', 'preview_only']);

const client = createSoundCloudClient({
  log: (level, ...args) => { if (level !== 'debug' || process.env.DEBUG) console.error('[scw2g]', level, ...args); },
});

function assertWellFormed(result) {
  assert.ok(result.items.length > 0, 'something to add');
  for (const item of result.items) {
    assert.ok(item.title && item.title.trim(), 'title never empty');
    assert.ok(!item.thumb || item.thumb.startsWith('https://'), item.thumb);
  }
  for (const s of result.skipped) assert.ok(REASONS.has(s.reason), s.reason);
  assert.ok(result.items.length + result.skipped.length <= result.total);
}

test('public set: all 11 tracks in set order', { skip }, async () => {
  const result = await expand(client, 'https://soundcloud.com/forss/sets/soulhack');
  // Track order of the set as captured on 2026-10-13: 5 hydrated tracks, then 6 stubs.
  const hydrated = new Map([...fixture('resolve-playlist-public-soulhack.json').tracks, ...fixture('tracks-ids-soulhack-stubs.json')]
    .filter((t) => t.permalink_url).map((t) => [t.id, t.permalink_url]));
  const expected = fixture('resolve-playlist-public-soulhack.json').tracks.map((t) => hydrated.get(t.id));
  assert.equal(result.source.kind, 'playlist');
  assert.equal(result.total, 11);
  assert.deepEqual(result.items.map((i) => i.url), expected);
  assertWellFormed(result);
});

test('track station (system playlist of stubs, anonymous)', { skip }, async () => {
  const result = await expand(client, 'https://soundcloud.com/discover/sets/track-stations:293');
  assert.equal(result.source.kind, 'system-playlist');
  assert.ok(result.total >= 20, `total ${result.total}`);
  assert.ok(result.items.every((i) => PUBLIC_TRACK_URL.test(i.url)), 'public permalinks');
  assertWellFormed(result);
});

test('user likes across pages', { skip }, async () => {
  const result = await expand(client, 'https://soundcloud.com/forss/likes');
  assert.equal(result.source.kind, 'user-likes');
  assert.ok(result.total >= 100, `total ${result.total}`);
  assert.equal(new Set(result.items.map((i) => i.url)).size, result.items.length, 'no duplicates');
  assertWellFormed(result);
});

test('private track: widget-safe secret_token URL', { skip }, async () => {
  const result = await expand(client, 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw&secret_token=s-8Pjrp');
  assert.deepEqual(result.warnings, ['private_tracks']);
});

test('short link', { skip }, async (t) => {
  let result;
  try {
    result = await expand(client, 'https://on.soundcloud.com/9zRpu');
  } catch (err) {
    if (err instanceof ScError && (err.code === 'NOT_FOUND' || err.code === 'UNSUPPORTED_URL')) {
      t.skip('the short link no longer resolves');
      return;
    }
    throw err;
  }
  assert.ok(['track', 'playlist', 'system-playlist'].includes(result.source.kind), result.source.kind);
  assert.ok(result.items.every((i) => i.url.startsWith('https://soundcloud.com/') && !i.url.includes('?')));
  assertWellFormed(result);
});

test('someone\'s Weekly Wave without a login is AUTH_REQUIRED', { skip }, async () => {
  await assert.rejects(expand(client, 'https://soundcloud.com/discover/sets/weekly::forss'), (e) => e.code === 'AUTH_REQUIRED');
});

test('someone\'s Playback without a login is AUTH_REQUIRED (anonymous 404), the alias fails without a request', { skip }, async () => {
  await assert.rejects(expand(client, 'https://soundcloud.com/discover/sets/your-playback::forss:2025'),
    (e) => e.code === 'AUTH_REQUIRED');
  let requests = 0;
  const counting = createSoundCloudClient({ fetch: (input, init) => { requests++; return fetch(input, init); }, log: () => {} });
  await assert.rejects(expand(counting, 'https://soundcloud.com/discover/your-2025-playback'), (e) => e.code === 'AUTH_REQUIRED');
  assert.equal(requests, 0);
});

test('no login: status and library without requests', { skip }, async () => {
  assert.deepEqual(await getStatus(client), { loggedIn: false });
  assert.deepEqual(await listLibrary(client), { loggedIn: false, sections: [] });
});
