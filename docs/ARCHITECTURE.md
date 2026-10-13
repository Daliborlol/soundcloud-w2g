# Architecture

SoundCloud for w2g is a Manifest V3 extension for Chromium-based browsers such as Brave, Chrome, Edge and Vivaldi, version 116 or later. It does two things.

1. **Room panel on w2g.tv.** A SoundCloud launcher next to w2g's search box opens a panel. The panel takes any SoundCloud link: a set or album, Weekly Wave, Daily Drops, a station, likes, a user's tracks, a short link or a private link. It shows a preview and appends every playable track to the room's shared playlist. If the user is logged in to soundcloud.com in the same browser, the panel also lists their playlists for one-click import. A SoundCloud list link that the user pastes or drops into w2g's own search box opens the panel with that link's preview.
2. **"Add to w2g" on soundcloud.com.** While at least one w2g room tab is open, soundcloud.com shows an "Add to w2g" button next to tracks and playlists and an entry in their More menus. A click queues that track, or every track of that playlist, into a room.

The extension adds tracks as ordinary `https://soundcloud.com/<user>/<track>` items, which w2g plays with its built-in SoundCloud player. Other people in the room don't need the extension. Only the person who adds tracks needs it, and only that person's SoundCloud login is used.

"Verified facts" at the end lists the w2g, SoundCloud and browser behaviour this design depends on.

## Components and files

```
extension/
  manifest.json              MV3 manifest; "incognito": "not_allowed", minimum Chrome 116
  shared/sc-url.js           SoundCloud URL parsing and classification on globalThis.SCW2G.url
  background/main.js         service worker entry, an ES module: creates the background and registers its listeners
  background/app.js          createBackground(): message routes, sender checks, rooms:changed, sc:login-changed, tab events
  background/jobs.js         the queue flow: target room and room:ping, expansion, confirmation, room:add, progress, stall
  background/rooms.js        registry of open room tabs in chrome.storage.session, documentId rules, automatic target
  background/sc-service.js   SoundCloud access for the handlers: one client, cookies, caches, login-change invalidation
  background/soundcloud.js   SoundCloud api-v2 client: client_id, auth, retries, expand(), listLibrary(), getStatus()
  background/settings.js     settings in chrome.storage.local, merged over defaults and sanitized
  background/util.js         BgError and error payloads, lock, timeouts, TTL cache, keep-alive, match patterns
  background/inject.js       re-injects the content scripts into tabs that were open before install, update or startup
  content/w2g-room.js        w2g room tab, top frame: room detection, add queue on w2g's REST API, launcher, panel, paste and drop detection
  content/soundcloud.js      every soundcloud.com frame: "Add to w2g" buttons, More-menu entries, toasts
  content/soundcloud.css     room gating and layout fixes for the injected buttons
  popup/popup.html|js|css    toolbar popup: target room, SoundCloud login state, settings, help
  icons/
scripts/package.mjs          zips extension/ into dist/soundcloud-w2g-<version>.zip
test/
  unit/*.test.mjs            node:test, offline, mocks and fixtures; soundcloud.live.test.mjs calls api-v2 only with LIVE=1
  e2e/*.e2e.mjs              node:test + Playwright with the unpacked extension, real w2g rooms and SoundCloud pages
  e2e/harness.mjs            launch, createRoom, openRoom, roomItems, mockSoundCloudLogin, buildExtensionVariant, ...
  e2e/stubs/*.js             stub backgrounds that run one real content script in isolation
  fixtures/sc/*.json         real api-v2 responses; SYNTHETIC-* files for shapes only a logged-in user gets
```

There is no build step and no runtime dependency. Chromium loads `extension/` unpacked as it is. The content scripts are classic scripts, each an IIFE in strict mode. The background and the popup script are ES modules.

## Runtime flows

### A. Panel in the room

```
launcher click ─► panel ── {type:'sc:library'} ──────────────────────► background ── api-v2 ──► SoundCloud
link pasted, dropped or loaded in the panel ── {type:'sc:expand', url} ──► background ── api-v2 ──► SoundCloud
                                   ◄──────────── {ok, result: ExpandResult} ──┘
"Add N tracks" ─► room tab's add queue ── GET sync_state, POST .../playlist_items/sync_update, ≤50 items ──► w2g-api.w2g.tv
```

- The panel gets previews through `sc:expand`, the library through `sc:library` and the settings through `settings:get` and `settings:set`. Adding doesn't involve the background. The room tab's add queue posts to w2g's REST API from the room page, with the user's w2g session cookie.
- The add queue runs one job at a time, panel jobs and soundcloud.com jobs alike. A panel job that has to wait says "Waiting for the current add to finish…".
- Cancel drops a queued job at once. A running job first finds out whether its in-flight batch landed, then stops.
- After a partial add, the primary button adds only the tracks that are still missing, matched by URL. "Add all N tracks again" re-adds everything.

### B. Button on soundcloud.com

```
trusted click ─► content/soundcloud.js ── {type:'queue', jobId, source:{url, kind, urn?}} ──► background, jobs.js
  background: choose the target room ── room:ping ──► room tab ── {joined, unreachable, ...}
  background ── job:progress {phase:'resolving'} ──► the frame
  background: expand(url) ── api-v2 ──► SoundCloud
     more than confirmAbove tracks, not confirmed: reply {needsConfirm} ─► toast "Add N tracks to w2g?" ── Add ─► queue again, confirmed:true
  background ── job:progress {phase:'adding', done:0} ──► the frame
  background ── room:add {jobId: background id, items, title} ──► room tab, frame 0 ─► add queue
  room tab ── job:progress {queued, position} at once and every 60 s, then {adding, done} per batch ──► background ──► the frame
  room tab replies {ok, added} ──► background replies to 'queue' ──► toast
  10 min without job:progress: background ── room:cancel ──► room tab; the first answer decides ROOM_STALLED or success
```

- The background pings the target room before it asks SoundCloud anything. NO_ROOM, NOT_JOINED, W2G_UNREACHABLE and ROOM_UNREACHABLE from that step come back before any SoundCloud request and before anything is posted to w2g.
- A confirmed re-send runs the whole flow again, ping included. The expansion comes from the 2-minute cache.
- A job that waits behind another job in the room tab reports `queued` with its position, and the toast says it waits for the room's current add.
- The room panel lists soundcloud.com jobs too, each with Cancel. A job cancelled there ends with CANCELLED.
- If the room tab sends no progress for 10 minutes, the background cancels the job in the room tab with `room:cancel` before it reports ROOM_STALLED. A job reported as failed never adds anything later.

## Message protocol

All messages are `chrome.runtime` messages with a `type`. Every response is `{ ok: true, ... }` or `{ ok: false, error: ErrorPayload }`. Listeners answer through `sendResponse` and `return true` instead of returning a promise. The background's handlers never reject, and a type the background doesn't know gets no answer.

A missing or failed answer becomes an error on the asking side. w2g-room.js turns it into INTERNAL and destroys itself if its extension context died. soundcloud.js reports CONNECTION_LOST when the message channel closed while the background held the request, CONTEXT_INVALIDATED when its own context died, and INTERNAL otherwise. The popup reports INTERNAL. The background treats a room tab that doesn't answer as ROOM_UNREACHABLE.

### Senders

`senderKind()` in app.js requires `sender.id === chrome.runtime.id` and reads the origin from `sender.origin`, or from `sender.url` when that is missing.

| kind | sender | accepted types |
|---|---|---|
| room | frame 0 of a `https://w2g.tv` tab | `room:hello` from room URLs only, `room:bye`, `room:active`, `job:progress`, `sc:expand`, `sc:library`, `sc:status`, `settings:get`, `settings:set`, `open:soundcloud`, `rooms:get` |
| old-document | a `https://w2g.tv` document whose frameId isn't 0, in practice a room tab's previous page during a navigation to another site | `room:bye` |
| soundcloud | any frame of a `https://soundcloud.com` tab | `rooms:get`, `queue`, `settings:get` |
| extension | the extension's own pages | `sc:expand`, `sc:library`, `sc:status`, `settings:get`, `settings:set`, `open:soundcloud`, `rooms:get`, `rooms:set-target`, `queue` |

Any other sender or combination gets INTERNAL "`<type>` is not accepted from this sender.", with the `jobId` echoed for `queue`. Some accepted types are never sent by that sender. The room tab sends neither `sc:status` nor `rooms:get`, and soundcloud.js doesn't send `settings:get`.

### Sent by content/w2g-room.js to the background

| type | sent | payload | response |
|---|---|---|---|
| `room:hello` | on start; when streamkey, joined, roomName or unreachable changes; on a trusted bfcache `pageshow`; before every `room:active` | `{ streamkey: string\|null, joined: boolean, roomName: string\|null, unreachable: boolean, url }` | `{ ok }` |
| `room:bye` | trusted `pagehide` | `{}` | `{ ok }` |
| `room:active` | trusted `focus`, or trusted `visibilitychange` to visible; at most once a second | `{}` | `{ ok }` |
| `job:progress` | background jobs only: `adding` when the job starts and after each batch, `queued` at once and every 60 s while it waits | `{ jobId, phase: 'adding', done, total }` or `{ jobId, phase: 'queued', done: 0, total, position }` | `{ ok }` |
| `sc:expand` | preview of a link | `{ url }` | `{ ok, result: ExpandResult }` |
| `sc:library` | the user asks for the library or refreshes it; login change; tab activation while a logged-out library is shown | `{ refresh?: true }` | `{ ok, library: LibraryResult }` |
| `settings:get` | first opening of the panel | `{}` | `{ ok, settings }` |
| `settings:set` | Go+ checkbox | `{ patch: { skipPreviews } }` | `{ ok, settings }` |
| `open:soundcloud` | "Open SoundCloud" buttons | `{}` | `{ ok }` |

- `room:hello` is debounced by 50 ms. The background accepts it only if `sender.url` is a room URL, and stores `roomFields(msg)`. That keeps a streamkey only if it matches `[A-Za-z0-9_-]{1,64}`, trims roomName to 120 characters, takes `joined` only as `true`, and keeps `unreachable` only while not joined. `unreachable: true` means the room tab's last check of w2g failed while w2g's join dialog wasn't showing. The entry also stores `sender.documentId`. The first hello of a tab, or the first from a new document, sets `lastActive` to now. A hello from the document that registered the entry keeps `lastActive`, because page scripts can make a page re-announce itself. If either side has no documentId, the hello counts as coming from the same document.
- `room:bye` removes the entry when its `documentId` matches the stored one. If either side has no documentId, only a bye from frame 0 counts. When a room tab navigates to another site, Chrome delivers the pagehide bye from the old document with a non-zero frameId and documentLifecycle `pending_deletion`. That is the `old-document` sender kind, and its bye counts only with a matching documentId. A late bye from an older document never removes its successor's entry.
- `room:active` sets the entry's `lastActive` to now. It is the only way an already registered page becomes the most recently used room.
- `job:progress` must name a running background job, `bg<n>-<time>`, whose room tab is the sender. Everything else is ignored, and the answer is `{ ok: true }` either way. Each accepted message restarts the job's stall timer. `position` is the job's 1-based place among the jobs waiting in that room tab, so 1 means next. Between heartbeats it can be up to 60 s old.
- `sc:expand` checks the URL offline first and fails with INVALID_URL or UNSUPPORTED_URL. It reads `skipPreviews` from the settings when the request arrives.
- `sc:library` with `refresh: true` skips the 5-minute cache.
- `settings:set` keeps only valid values of known keys, see `Settings`. A `patch` that isn't an object gives INTERNAL. The response holds the settings now in effect.
- `open:soundcloud` opens `https://soundcloud.com/` in a new active tab right after the sender's tab, with the sender as opener.

### Sent by content/soundcloud.js to the background

| type | sent | payload | response |
|---|---|---|---|
| `rooms:get` | on start, when the tab becomes visible, on a bfcache restore | `{}` | `{ ok, rooms: RoomInfo[], target: RoomInfo\|null, pinnedTabId: number\|null }` |
| `queue` | trusted click on a button or menu entry; the confirmation's "Add"; "Try again" | `{ jobId, source: { url, kind, urn? }, confirmed?: true }` | `QueueResult` |

- `jobId` is a `crypto.randomUUID()`. A confirmation re-sends the same jobId with `confirmed: true`, and "Try again" sends a new one. The background accepts a string of 1 to 200 characters or a finite number. A second `queue` with the same jobId from the same frame, while the first one runs, gets INTERNAL.
- `source.kind` is `'track'`, `'playlist'` or `'system-playlist'` as `classifyHref()` reports it. `urn` is `soundcloud:tracks:<id>` or `soundcloud:playlists:<id>` from a More menu's Report link. The background uses only `source.url`. The toast uses `kind`.
- soundcloud.js uses only `rooms` from the answer, for gating and for the room label.

### Sent by the popup to the background

| type | payload | response |
|---|---|---|
| `rooms:get` | `{}` | `{ ok, rooms, target, pinnedTabId }` |
| `rooms:set-target` | `{ tabId: number\|null }` | `{ ok }`, or NO_ROOM when the tab isn't registered |
| `sc:status` | `{}` | `{ ok, loggedIn, username?, expired? }` |
| `settings:get` / `settings:set` | `{}` / `{ patch }` | `{ ok, settings }` |
| `open:soundcloud` | `{}` | `{ ok }` |

`rooms:set-target` with null returns to the automatic choice. A pin outlives its registry entry, so reloading the pinned room tab keeps it. While the pinned tab isn't registered, the pin is ignored. The popup also follows `chrome.storage.onChanged`. The session keys `rooms` and `targetTabId` re-render the room list, and the local key `settings` reloads the settings unless the number field has focus.

### Sent by the background to content scripts

| type | to | payload | response |
|---|---|---|---|
| `rooms:changed` | every frame of every non-discarded `https://soundcloud.com/*` tab, after each persisted registry change | `{ rooms: RoomInfo[], target: RoomInfo\|null }` | none |
| `room:ping` | frame 0 of a registered room tab, only in the queue flow | `{}` | `{ ok, streamkey, joined, roomName, unreachable }` |
| `room:add` | frame 0 of the target room tab | `{ jobId, items: W2gItem[], title }` | `{ ok: true, added, playlistKey }` or `{ ok: false, error: { code, message, added } }` |
| `room:cancel` | frame 0 of that room tab, after a stall | `{ jobId }` | `{ ok: true, cancelled: boolean, added }` |
| `job:progress` | the frame that sent `queue`, through `{ frameId: sender.frameId }`; extension pages get it through `runtime.sendMessage` | `{ jobId, phase: 'resolving' }`, `{ jobId, phase: 'queued', total, title, position }` or `{ jobId, phase: 'adding', done, total, title }` | none |
| `sc:login-changed` | frame 0 of every registered room tab, 1 s after the last change of the `oauth_token` cookie | `{}` | `{ ok }` |

- For `room:ping` the background waits up to 5 s, `pingTimeoutMs`. A room tab that has a streamkey, isn't joined and doesn't show w2g's join dialog first re-checks `sync_state` for up to 1.5 s, so a stale "not joined" doesn't block the add.
- The `jobId` of `room:add` is the background's own id, `bg<n>-<base36 time>`, not the frame's jobId. Equal jobIds from different frames can't mix, and a restarted worker's ids don't collide with older ones a room tab may still report. The reply comes when the job ends, which can take minutes plus the time the job waited in the queue. Error replies always carry `added`. A `room:add` with the id of a running or finished background job joins that job instead of adding twice.
- `room:cancel` uses the same background id. The room tab drops a queued job at once. It aborts a running job, which first checks whether its in-flight batch landed. The room tab answers once the job has settled, at most about 11 s later, so `added` includes a batch that landed meanwhile. An unknown or finished job gets `{ ok: true, cancelled: false, added }`. The background waits `cancelReplyMs`, 15 s, for this reply or the `room:add` reply. See "Stall and cancel" under background/jobs.js.
- `job:progress` carries the frame's own jobId. `resolving` follows a successful ping. `adding` with `done: 0` comes right before `room:add`. `queued` is relayed only until the room tab has reported `adding` with a count, so a late heartbeat can't turn a running toast back to waiting. `done` is capped at `total`, and `position` is an integer or null. Before it answers `queue`, the background gives pending progress messages up to 1 s, `progressFlushMs`, to arrive.
- `sc:login-changed` makes the room panel reload the library with `refresh: true` if it had loaded one before, and reload a preview that failed with AUTH_REQUIRED or AUTH_EXPIRED.

## Data types

```js
// What w2g's add_items accepts. Exactly these keys are sent to w2g.
W2gItem = { url: string, title: string /* never empty */, thumb?: string /* https only */ }

RoomInfo = {
  tabId: number,
  streamkey: string|null,
  joined: boolean,
  roomName: string|null,   // read from the room page's DOM: untrusted text
  unreachable: boolean,    // the last check of w2g failed without w2g's join dialog; false while joined
  lastActive: number,      // ms; set by room:active and by the first room:hello of a document
}
// Registry entries also store the documentId of the registering page. RoomInfo never includes it.

ErrorPayload = { code: string, message: string, added?: number, total?: number, skipped?: [{ title: string|null, reason }] }
// added: tracks already in the room, when known. skipped and total: EMPTY. util.js errorDetails() drops anything else.

ExpandResult = {
  source: { kind, url, title, subtitle: string|null, artwork: string|null },
  // kind: 'track' | 'playlist' | 'system-playlist' | 'user-tracks' | 'user-likes' | 'user-reposts' | 'user-popular-tracks'
  total: number,           // tracks looked at: the whole set, or the profile-list entries on the pages fetched
  items: W2gItem[],        // what will be added, in source order, at most 1000
  skipped: [{ title: string|null, reason }],
  // reason: 'unavailable' | 'geo_blocked' | 'not_streamable' | 'not_embeddable' | 'processing' | 'preview_only'
  warnings: string[],      // 'truncated': the 1000-track cap or the page limit; 'private_tracks': secret links in items
}

LibraryResult =
    { loggedIn: true, user: { id, username, permalink, avatar }, sections: Section[] }
  | { loggedIn: false, expired?: true, sections: [] }   // expired: a token cookie exists but is expired or rejected
Section = {
  id, title,
  entries: [{ kind: 'playlist'|'system-playlist'|'likes', url, title, subtitle: string|null, artwork: string|null, trackCount: number|null }],
}
// Display order, empty sections left out:
// 'made-for-you' Made for you, 'own' Your playlists, 'liked' Liked playlists, 'recent' Recently played, 'likes' Likes

QueueResult =
    { ok: true, jobId, needsConfirm: true, count, title, skippedCount }   // count > confirmAbove and not confirmed
  | { ok: true, jobId, added, title, skipped: [...], warnings: [...], room: RoomInfo }
  | { ok: false, jobId, error: ErrorPayload }                             // jobId is null if the request had none

Settings = { skipPreviews: boolean, confirmAbove: number }
// Defaults { skipPreviews: true, confirmAbove: 100 }; confirmAbove is an integer from 0 to 10000.
// chrome.storage.local key 'settings', read merged over DEFAULT_SETTINGS in background/settings.js.
```

### Error codes

The last column tells how far a request can have got:
- `before` means nothing was posted to w2g for this request. `added` is 0 and "Try again" is safe.
- `exact` means the room tab raised it right before a POST. `added` is exact but may be above 0.
- `partial` means it can follow a POST whose outcome is unknown. `added` is a lower bound, and the user should check the room's playlist.

| code | raised by | meaning, UI hint | posts |
|---|---|---|---|
| `INVALID_URL` | background, room panel | not a SoundCloud link | before |
| `UNSUPPORTED_URL` | background, room panel, soundcloud.js | a SoundCloud page without tracks to add: search, the home page, a user's sets or albums, `/you/*` other than likes. On soundcloud.com also a clicked item without a usable link | before |
| `NOT_FOUND` | background | deleted, private without its secret link, someone else's personal playlist, or a dead short link | before |
| `AUTH_REQUIRED` | background | needs the SoundCloud login: personal system playlists, `/discover/weekly`, Playback, `/you/likes`. "Log in on soundcloud.com in this browser" | before |
| `AUTH_EXPIRED` | background | the login cookie is expired or SoundCloud rejected it. "Open soundcloud.com once to refresh it" | before |
| `BOT_CHALLENGE` | background | SoundCloud's DataDome check, also after the retry with the `datadome` cookie. "Open soundcloud.com, then retry" | before |
| `RATE_LIMITED` | background | SoundCloud kept answering 429 or asked to wait more than 60 s. w2g's 429 is opaque to the room tab and ends as W2G_FAILED | before |
| `NETWORK` | background | a SoundCloud request failed 4 times, timeouts included | before |
| `SC_HTTP` | background | any other SoundCloud HTTP error, an unreadable response, or no client_id found | before |
| `EMPTY` | background, room tab | nothing playable after filtering; carries `skipped` and `total`. The room tab answers it to a `room:add` without valid items | before |
| `NO_ROOM` | background | no room tab is registered, or `rooms:set-target` named an unregistered tab | before |
| `NOT_JOINED` | background, room tab | the pinged room hasn't joined; the job's first check found w2g's join dialog; the room tab has no room ID; the room changed during a job. "Click Join the Room" | before or exact |
| `W2G_UNREACHABLE` | background, room tab | the room tab can't reach w2g's API: its pong says `unreachable`, or the job's first `sync_state` read failed without the join dialog. "Check your connection" | before |
| `ROOM_UNREACHABLE` | background | the room tab didn't answer `room:ping` but still shows a room, or four pings found no usable room. During `room:add`: the tab closed, reloaded or replied nothing. "Reload the room tab" | before for a ping, partial during `room:add` |
| `MODERATED` | room tab | the owner locked the playlist and this user is neither owner nor moderator | exact |
| `PLAYLIST_CHANGED` | room tab | someone selected another playlist in the room during the add, so adding stopped | exact |
| `W2G_FAILED` | room tab | w2g didn't take a batch in 3 POSTs; a failed POST's outcome couldn't be checked; `sync_state` reads between batches kept failing; w2g reported no selected playlist | partial |
| `ROOM_STALLED` | background | the room tab sent no progress for 10 minutes, and the background cancelled the job there. "Check the room's playlist" | partial |
| `CANCELLED` | room tab | the user cancelled in the room panel. A cancel sent by the background comes back as ROOM_STALLED | partial |
| `INTERNAL` | any | a bug, a rejected sender, a duplicate or malformed request, an extension that didn't answer | partial |

`content/soundcloud.js` adds two client-only codes that never travel between components:
- `CONNECTION_LOST` means the message channel closed while the background held the `queue` request, for example because the service worker stopped. The room tab doesn't need the worker and may still be adding.
- `CONTEXT_INVALIDATED` means the frame's extension context died after an extension reload, update or removal. The room tab's copy dies with it and stops after its in-flight batch.

"Try again" on soundcloud.com appears only if all three hold:
- The code allows it: NO_ROOM, NOT_JOINED, W2G_UNREACHABLE, ROOM_UNREACHABLE, AUTH_EXPIRED, BOT_CHALLENGE, NETWORK, SC_HTTP, CONNECTION_LOST or INTERNAL.
- Nothing was added. The larger of the last progress `done` and `error.added` is 0.
- The frame hasn't seen `adding` or `queued` progress for the job, or the code is in `BEFORE_POST`: NOT_JOINED, NETWORK or W2G_UNREACHABLE. Once the room tab has the job, NOT_JOINED and W2G_UNREACHABLE come only from its check before the next POST, so their `added` is exact. The room tab never sends NETWORK.

A retry is a new `queue` with a new jobId. In the room panel, preview and library errors offer "Try again" for NETWORK, RATE_LIMITED, SC_HTTP, INTERNAL, BOT_CHALLENGE, AUTH_EXPIRED and W2G_UNREACHABLE, and "Open SoundCloud" for AUTH_REQUIRED, AUTH_EXPIRED and BOT_CHALLENGE. After a failed or cancelled panel job, the Add button adds only what is still missing.

## Component specs

### shared/sc-url.js

`globalThis.SCW2G.url` holds `WEB`, `parse`, `classifyHref`, `extractUrl`, `isW2gNativeTrack` and `canonical`. The file has no import or export statement because three loaders use it. The manifest lists it as a classic content script before each content script, background/main.js and background/soundcloud.js import it for its side effect, and the Node tests import it.

- `parse(url)` classifies a URL without network access. The types are `invalid`, `unsupported` with a reason, `shortlink`, `track` and `playlist` with a secret token, `system-playlist`, `legacy-station`, `user` with sub null, tracks, likes, reposts, popular-tracks, sets or albums, `me` for `/you/<sub>`, and `api-track`, `api-playlist`, `api-user`. It accepts www. and m. hosts, widget and player URLs with an inner `url=`, api and api-v2 URLs, and the Webi prefix `/n/<user>/<track>`. `/discover/weekly` and `/discover/your-<year>-playback` become the system playlists `weekly` and `your-playback:<year>` with `needsAuth`.
- `classifyHref(href, base)` turns a link in SoundCloud's DOM into `{ kind: 'track'|'playlist'|'system-playlist', url }` or null. It drops query strings such as `?in=`, keeps secret tokens, and counts legacy stations as system playlists.
- `extractUrl(text)` returns the first SoundCloud URL in pasted text, with or without scheme, as https.
- `isW2gNativeTrack(url)` is true only if w2g's own search-box regex matches the text and the URL is a plain public track. The regex alone also matches `/user/likes`, `/you/likes` and `/discover/weekly`, which w2g turns into the wrong item or nothing.

Tests: `test/unit/sc-url.test.mjs`.

### background/main.js and app.js

main.js imports sc-url.js and soundcloud.js, calls `createBackground({ chrome, sc, urlTools })` and registers `runtime.onMessage`, `runtime.onInstalled`, `runtime.onStartup`, `tabs.onRemoved`, `tabs.onUpdated` and `cookies.onChanged` in the worker's first run. MV3 delivers events only to listeners registered then.

app.js holds the logic and runs against a fake `chrome` in the unit tests.
- Routes and sender kinds are listed under "Message protocol". An error with a code, such as a `BgError` or `ScError`, becomes its error payload. A fetch TypeError becomes NETWORK and anything else INTERNAL. INTERNAL errors are logged.
- `DEFAULT_TIMING`: `pingTimeoutMs` 5 s, `addIdleTimeoutMs` 10 min, `cancelReplyMs` 15 s, `keepAliveMs` 15 s, `expandTtlMs` 2 min, `scCacheTtlMs` 5 min, `progressFlushMs` 1 s, `loginChangedMs` 1 s.
- `broadcastRooms()` runs after each persisted registry change. It queries the soundcloud.com tabs, which host permissions allow without the `tabs` permission, and only then reads the registry, so overlapping broadcasts carry the latest state. It sends `rooms:changed` without a frameId to every non-discarded tab and ignores send errors.
- `onCookieChanged()` hands the change to sc-service.js. For an `oauth_token` change on soundcloud.com it schedules `sendLoginChanged()` 1 s after the last change of a burst.
- `onTabUpdated()` removes a registered tab whose `changeInfo.url` isn't a room URL. Chrome reports `changeInfo.url` only for sites the extension can access, so it also removes a tab on status `loading` whose `tab.url` is missing or not a room URL. For a navigation to another site, that event comes once the navigation commits.
- `tabs.onRemoved` removes the tab's entry. `onInstalled` and `onStartup` call `reinjectContentScripts()`.

### background/rooms.js

- The state lives in `chrome.storage.session`. `rooms` maps tab ids to RoomInfo plus documentId, and `targetTabId` holds the popup's pin or null. The background is the only writer and keeps a copy in memory. Calls run one at a time through a lock, and `onChange` runs after each change that was persisted.
- `isRoomUrl(url)` matches the content script's pages, `https://w2g.tv/*/room/*` and `https://w2g.tv/room/*`.
- `hello`, `bye` and `touch` implement `room:hello`, `room:bye` and `room:active`. `refresh` applies a `room:ping` reply without touching `lastActive`. `remove` drops an entry. `pin` sets or clears the target and returns false for an unregistered tab.
- `snapshot()` returns `{ rooms, target, pinnedTabId }` with the most recently active room first. `pinnedTabId` is null while the pinned tab isn't registered.
- `selectTarget(rooms, pinnedTabId)` returns the pinned room if it is registered, else the joined room with the highest `lastActive`, else the most recent room with a streamkey, else null. The queue flow refines this choice. The popup's "Now: X" shows this result, so it can name another room than the one the next add goes to.

### background/jobs.js

`createJobRunner()` handles `queue` and the room tab's `job:progress`.

1. Reject an invalid jobId, or a jobId that already runs for the same frame, with INTERNAL.
2. Create the job with its own id, `bg<n>-<time>`, and the origin frame. Extension pages have no origin frame. The keep-alive runs until the job ends.
3. `checkUrl(source.url)` fails with INVALID_URL or UNSUPPORTED_URL before any request.
4. `reachableTarget()` picks and pings the room, see below.
5. Send `resolving` to the frame.
6. Expand with the current `skipPreviews`. Without playable items, fail with EMPTY plus `skipped` and `total`. With more items than `confirmAbove` and no `confirmed: true`, reply `needsConfirm`.
7. Send `adding` with `done: 0`, then `room:add` to the room tab's frame 0, and relay its progress.
8. On success, reply with `added` and the room as the registry now has it. On failure, reply with the room tab's code and set `added` to the larger of its `added` and the last relayed `done`, in `fromReply()`.
9. Give pending progress messages up to 1 s, then answer.

Target selection, in `reachableTarget()` and `reach()`:
- With an empty registry the answer is NO_ROOM. If rooms are registered but none has joined, the answer is the pinged room's error, such as NOT_JOINED or W2G_UNREACHABLE, not NO_ROOM.
- With a pin, only the pinned room is pinged, and its failure is the answer.
- Without a pin, the most recently active room is pinged first, even if its entry says `joined: false`. The flag may be stale, and the ping makes the room tab re-check w2g. If that room hasn't joined, the registry's automatic choice gets its turn and may be another, joined room. The success reply's `room` names the room used. If no other room is available, the most recent room's error is the answer.
- A pong with `joined: true` selects the room. A pong with `unreachable: true` gives W2G_UNREACHABLE, any other pong NOT_JOINED. Every pong updates the registry entry.
- Without a pong within 5 s, a tab that still shows a room URL in `tab.url` or `tab.pendingUrl` gives ROOM_UNREACHABLE. Otherwise the entry is stale, is removed, and selection starts over. After 4 pings, `MAX_PINGS`, the answer is ROOM_UNREACHABLE.

Stall and cancel, in `addToRoom()` and `cancelStalledJob()`:
- Every `job:progress` from the room tab, heartbeats included, restarts a 10-minute timer. Waiting jobs report every 60 s and running jobs after each batch, so the timer fires only when the room tab goes silent, for example on a hung request.
- When it fires, the background sends `room:cancel` and waits up to `cancelReplyMs` for the first of two answers. The room tab settles the job before it answers either.
- If the `room:add` reply comes first, it counts as usual. Only CANCELLED, which this cancel caused, becomes ROOM_STALLED.
- If the cancel reply comes first and says `cancelled: false` with every track added, the job succeeded. Any other reply, and a timeout, gives ROOM_STALLED with `added` set to the larger of the reply's `added` and the last relayed `done`.
- If `room:add` itself fails because the tab closed, reloaded or navigated, the answer is ROOM_UNREACHABLE with "The w2g room tab was closed or reloaded before the tracks were added." and `added`.

### background/sc-service.js

- Creates the api-v2 client on first use, with `fetch`, `getOAuthToken`, `getDataDomeId` and a storage wrapper over `chrome.storage.local` that caches the client_id.
- `getOAuthToken()` and `getDataDomeId()` read the `oauth_token` and `datadome` cookies of `https://soundcloud.com/` through `chrome.cookies` on every call, because soundcloud.com replaces both, on a token refresh and after a solved bot check. A failed read gives null.
- `checkUrl(input)` trims and parses offline and throws INVALID_URL or UNSUPPORTED_URL.
- `expand(url, { skipPreviews })` keeps up to 20 results for 2 minutes, keyed by login generation, `skipPreviews` and URL. Identical requests share one fetch. Expansions run one at a time, so a big import doesn't interleave with others against SoundCloud's rate limit.
- `getStatus()` and `getLibrary({ refresh })` keep their value for 5 minutes and share an in-flight load. `refresh` skips the stored value.
- `onCookieChanged(info)` reacts to an `oauth_token` cookie on a soundcloud.com domain, which changes on login, logout and refreshes by soundcloud.com. It bumps the generation, drops the client and clears the expansions. Results that started under an older generation aren't cached.
- Expansions and library loads hold the keep-alive.

### background/settings.js

`DEFAULT_SETTINGS` is `{ skipPreviews: true, confirmAbove: 100 }`, stored under the `chrome.storage.local` key `settings`. `sanitizeSettings()` keeps a boolean `skipPreviews` and a numeric `confirmAbove`, numeric strings included, rounded and clamped to 0..`CONFIRM_ABOVE_MAX`, which is 10000. `get()` merges the stored values over the defaults. `set(patch)` merges under a lock and resolves to the settings now in effect. The room panel watches the same key through `storage.onChanged`, so the key and its shape are part of the contract.

### background/util.js

`BgError(code, message, details)` and `errorDetails()` keep `added` and `total` as non-negative integers and `skipped` as `[{ title, reason }]`. `errorPayload()` passes coded errors through with these details, turns a fetch TypeError into NETWORK and anything else into INTERNAL. The other helpers are `maxCount`, `failure`, `createLock`, `withTimeout`, `settleWithin`, `quietly` for API calls whose target may be gone, `attempt`, `createTtlCache`, `matchPatternToRegExp`, `urlMatches` and `createKeepAlive()`. The keep-alive calls `chrome.runtime.getPlatformInfo()` every 15 s while it has holders. Chrome stops a worker after 30 s without extension events or API calls, and network requests and timers don't count.

### background/inject.js

`reinjectContentScripts(chrome)` runs on install, update and browser start. For each `content_scripts` entry of the manifest it queries the matching tabs and skips discarded ones. It asks every frame for its URL and injects the CSS and JS only into frames that match the entry's patterns, as the browser would. `allFrames` alone would also reach `about:blank` and other-site frames. It never rejects and reports per-tab errors. Both content scripts ignore a second injection while their first copy is alive.

### background/soundcloud.js

```js
export class ScError extends Error { code; status?; captchaUrl?; reason? }
export function createSoundCloudClient({ fetch, getOAuthToken, getDataDomeId, storage, sleep?, now?, log?, minIntervalMs?, timeoutMs? })
export async function expand(client, url, { skipPreviews = true, maxTracks = 1000 } = {})  // ExpandResult
export async function listLibrary(client)  // LibraryResult; "not logged in" is a result, not an error
export async function getStatus(client)    // { loggedIn, username?, expired? }
export function normalizeTrack(raw, { skipPreviews = true } = {})  // internal track descriptor with playable and reason
export function toW2gItem(track)           // W2gItem
```

client_id
- `clientId()` takes the id from memory, then from the storage key `scClientId`, then discovers it. Discovery fetches `https://soundcloud.com/` and reads the `window.__sc_hydration` entry `{ hydratable: 'apiClient', data: { id } }`. The fallback scans the page's `a-v2.sndcdn.com/assets/*.js` scripts, last first, for `client_id:"<32 chars>"`.
- Discovery is always anonymous, with `credentials: 'omit'`. soundcloud.com answers a request with an `oauth_token` cookie it doesn't accept with `Set-Cookie` headers that delete the login.
- After a 401 that the token doesn't explain, the client discovers a new id and retries once, at most once a minute, `REDISCOVER_COOLDOWN_MS`. Concurrent requests share one discovery.
- If the token is a JWT with a `client_id` claim, authenticated calls use that id.

Auth
- The token is the `oauth_token` cookie value. A JWT whose `exp` has passed, or a token SoundCloud already rejected, counts as expired and isn't sent.
- `get(path, { auth })` with `'optional'` sends the token when there is one. `'required'` throws AUTH_REQUIRED without a cookie, or AUTH_EXPIRED with an unusable one, before any request. `'none'` never sends it.
- Every api-v2 call sends `Authorization: OAuth <token>` and uses `credentials: 'omit'`.
- On a 401 with a token, the client asks once more without it. Required-auth calls use the probe `/resolve?url=https://soundcloud.com/soundcloud`, optional ones repeat the request. If that answer is OK or 404, the token is dead. The client remembers it, throws AUTH_EXPIRED for required auth, and otherwise uses the anonymous answer, where a 404 then means AUTH_EXPIRED. If that answer is 401 too, the client_id is the problem.
- The permalinks `weekly` and `your-playback:<year>` mean the logged-in user's own Weekly Wave and Playback, `OWN_SYSTEM_PLAYLIST_RE`, also in the `/discover/sets/<permalink>` form. Without a usable login they fail with AUTH_REQUIRED or AUTH_EXPIRED before any request.
- Other personal system playlists answer 404 to everyone but their owner. That covers everything except track stations, artist stations and genre charts, `PUBLIC_SYSTEM_PLAYLIST_RE`. Without a login cookie that 404 becomes AUTH_REQUIRED, with an expired login AUTH_EXPIRED, with a valid one NOT_FOUND.

DataDome
- A 403 with a JSON body `{ url }` is DataDome's bot challenge. `_apiGet()` then reads the `datadome` cookie through `getDataDomeId`. If the value has 1 to 4096 visible ASCII characters, it retries once with `X-Datadome-ClientId: <value>`, as soundcloud.com's own DataDome tag does. Solving the check on soundcloud.com therefore unblocks the extension too.
- Without a usable cookie, or after a second challenge, the result is BOT_CHALLENGE with the `captchaUrl`. The header is never sent otherwise. A 403 on the discovery page is BOT_CHALLENGE without a retry.

Requests
- GET only, with a 20 s timeout per attempt. Network errors and timeouts retry after 1, 2 and 4 s. 429 and 5xx retry after `Retry-After`, or else after 2, 4 and 8 s for 429 and 1, 2 and 4 s for 5xx. At most 3 retries. A `Retry-After` above 60 s ends the retries at once.
- api-v2 calls are spaced at least 200 ms apart.
- `apiUrl()` refuses any URL outside `https://api-v2.soundcloud.com`, including a `next_href` from a response, so the token can't reach another host.
- A 404 is NOT_FOUND, or AUTH_EXPIRED after a dead login. A challenge is BOT_CHALLENGE, a 429 is RATE_LIMITED. Anything else, and unreadable JSON on success, is SC_HTTP.

Expansion
- Short links: the client follows `on.soundcloud.com` with `credentials: 'omit'` and parses the final URL. A short link that leads nowhere is NOT_FOUND.
- Tracks, sets and legacy stations go through `/resolve`. A legacy station resolves to `{ kind: 'station', system_playlist_permalink }`, which leads to `/system-playlists/soundcloud:system-playlists:<permalink>`. System playlists go through `/resolve` after the auth rules above.
- User lists use `/users/<id>/tracks`, `/users/<id>/track_likes`, `/users/<id>/toptracks` and `/stream/users/<id>/reposts`. A user URL without sub means the tracks. `/you/likes` reads `/me`, then `/users/<me>/track_likes`, both with required auth. A user's sets or albums and other `/you/*` pages are UNSUPPORTED_URL.
- `api-*` URLs fetch `/tracks/<id>`, `/playlists/<id>` or `/users/<id>`, tracks and playlists with their `secret_token`.
- Playlists hydrate only their first 5 tracks, and system playlists return stubs. `collectTracks()` hydrates stubs through `/tracks?ids=`, at most 50 per request, and only as far as it needs to find `maxTracks` playable tracks. The answer comes in arbitrary order and silently leaves out ids, so the client rebuilds the order and marks missing ids `unavailable`. Private sets pass `playlistId` and `playlistSecretToken`.
- Lists page with `limit=200&linked_partitioning=1` and follow `next_href`, appending the client_id, until it is null or repeats, at most 50 pages. Short or empty pages are normal. Paging stops once enough playable tracks are found, and an unvisited `next_href` adds `truncated`.

Filtering, in `normalizeTrack()`
- `policy === 'BLOCK'` → `geo_blocked`; `streamable === false` → `not_streamable`; `embeddable_by === 'none'` → `not_embeddable`; a `state` other than `finished` → `processing`; not hydrated or no usable permalink → `unavailable`.
- With `skipPreviews`, `policy === 'SNIP'` or `monetization_model === 'SUB_HIGH_TIER'` → `preview_only`. Listeners without Go+ would only hear a 30 s preview.
- At most `maxTracks` items; more set `truncated`.

toW2gItem
- `url` is `https://soundcloud.com/<user>/<track>`, built from the permalink's first two path segments, without query or hash. A private track gets `&secret_token=<token>` appended. w2g's player builds `w.soundcloud.com/player/?url=<item url>&...` without encoding, and the widget plays `<permalink>&secret_token=<token>` but rejects the `/s-XXXX` form.
- `title` is the track title, prefixed with `Artist - ` unless the title already contains a spaced hyphen, en dash or em dash, or the artist name as a word. The artist is `publisher_metadata.artist`, else `user.username`. The title is never empty.
- `thumb` is `artwork_url`, else `user.avatar_url`, as https, with size suffixes such as `-large` or `-t300x300` replaced by `-t500x500`.

listLibrary
- Without a usable token the result is `{ loggedIn: false, expired?, sections: [] }`. Otherwise the client reads `/me` with required auth. AUTH_REQUIRED or AUTH_EXPIRED there also mean logged out, and other errors propagate.
- Four requests run in parallel through `Promise.allSettled`, and a failed one is logged and counts as empty: `/mixed-selections?limit=20`, `/me/library/all` with up to 3 pages, `/users/<me>/playlists_without_albums` with up to 2 pages and optional auth, and `/me/play-history/contexts?limit=25`.
- Sections fill in the order below. Each playlist appears once, in the first section that claims it, deduplicated by URL without query and by urn or kind and id.
  1. `made-for-you`: the shelves' system playlists that carry `made_for`, which are Weekly Wave, Daily Drops and the personal mixes. A shelf item is `x.item ?? x`. "Recently played" shelves are skipped, since they repeat the play history.
  2. `own`: library items of type `playlist`, then `playlists_without_albums`.
  3. `liked`: library items of type `playlist-like` and `system-playlist-like`.
  4. `recent`: play-history contexts of kind playlist or system-playlist.
  5. `made-for-you` again: the other shelf items, such as editorial playlists and charts, until the section has 30 entries, `MADE_FOR_YOU_MAX`.
  6. `likes`: one "Liked tracks" entry, `https://soundcloud.com/you/likes`, with `me.likes_count`.
- Liked stations without `permalink_url` get their URL from the urn.

getStatus
- Without a usable token the result is `{ loggedIn: false, expired? }`. Otherwise `/me` gives `{ loggedIn: true, username }`. AUTH errors mean logged out, and other errors throw.

### content/w2g-room.js

The script runs at `document_start` on `https://w2g.tv/*/room/*` and `https://w2g.tv/room/*`, in the top frame only. The global `__scw2gRoom` holds the live copy, and a second injection returns while that copy is alive. A copy whose extension context died after an update is destroyed by its successor, directly or through the `scw2g:room-takeover` document event. A live copy ignores that event, since page scripts can dispatch it too.

Room detection
- Streamkey: first `?room_id=` or `?r=`, the part after the last `-`. Then w2g's own API traffic, which a buffered `PerformanceObserver` sees as resource entries for `https://w2g-api.w2g.tv/(rooms|streams)/<sk>/...`, skipping `default`. Then w2g's invite link `a[href*="w2g.tv%2F%3Fr%3D"]`. After joining, the URL holds only `?access_key=`, so the traffic is the main source.
- Joined: a resource entry for `sync_state` or `playlists/<id>/playlist_items` with a 2xx or unknown status, or a successful `checkRoom()`. w2g makes those requests only after joining. Failed ones, like our own probes of a room not joined, show status 0. w2g's join dialog, `#intro-modal` with `#w2g-join-button`, means not joined.
- Unreachable: a check that fails while the join dialog isn't showing sets `room.unreachable`. w2g's errors carry no CORS headers, so a 403 for a non-member looks like a network failure, and only the dialog tells them apart. A successful check, or the dialog appearing, clears it.
- Room name: the first non-empty `.w2g-users a.w2g-bind-moderation` or `[data-w2g*="room_name"]`.
- Lock: `body.mod-pl-active` without `body.moderator` is a live hint. Each check computes the lock from `sync_state`, using `stream_moderation.moderated_playlist` and the user's role. The role comes from the user list, matched through the own tile `[id^="user-"].self`, or from the body classes `owner` and `moderator`.
- Probes run `checkRoom({ tries: 2 })`, one at a time. They run 4 s after start and 2.5 s after the join dialog closes if the room still isn't joined, on `room:ping`, when the panel opens and the last check is older than 10 s, and every 5 s while the open panel's room isn't joined and no join dialog shows, in `reprobe()`.

Add queue, the only write path
- `jobs` is a FIFO shared by panel and background jobs. `pump()` runs one job at a time.
- A job's first check, `checkRoom()`, reads `GET /rooms/<sk>/sync_state` with `credentials: 'include'`, up to 3 tries 0.7 and 1.4 s apart. A failure gives NOT_JOINED while the join dialog shows and W2G_UNREACHABLE otherwise. No selected playlist gives W2G_FAILED.
- The job pins the selected playlist key and title from that check and writes only to that list. w2g's live patches carry no list id, and one import must not end up split across two lists.
- The job posts batches of up to 50 items. Before each batch after the first, it waits until 3 s after the previous one and re-reads `sync_state` in `recheckRoom()`. A failed read there counts as transient. The job waits 11 s and retries up to 2 times, then fails with W2G_FAILED, "Lost the connection to w2g, so adding stopped." It never marks the room as not joined. Before every batch, `assertTarget()` throws MODERATED for a locked playlist and PLAYLIST_CHANGED for another selected list, and a changed streamkey gives NOT_JOINED.
- The job POSTs to `/rooms/<sk>/playlists/<key>/playlist_items/sync_update` with `{"add_items":[...]}`, at least 1 s after any previous POST, and aborts the POST after 30 s, `POST_TIMEOUT_MS`.
- A failed POST is opaque. A 403, Cloudflare's 429, a network error and the timeout all look the same, and the batch may have landed anyway. The job waits 11 s, `FAILURE_WAIT_MS`, because Cloudflare's 429 says `Retry-After: 10`. Then it reads `GET /streams/<sk>/playlists/<key>/playlist_items`. If the list ends with the batch, allowing up to 5 items other members appended, the batch counts. If not, the job re-checks room and target and posts again, at most 2 more times, then fails with W2G_FAILED. If it can't tell, it fails with W2G_FAILED and the batch counts as "may have been added".
- After every batch the panel re-renders, and background jobs send `job:progress`.
- Cancel drops a queued job at once. For a running job it aborts the job's signal. If a POST was in flight or not yet verified, `landedAfterCancel()` waits until 2 s after that POST and checks the playlist with an 8 s timeout. A landed batch counts as added, an unknown one as "may have been added". The panel says "Cancelling…" meanwhile. A POST that w2g processes more than about 2 s after the abort is reported as not added.
- `room:add` normalizes the items to an https URL, a non-empty title with the URL as fallback and an https thumb, and replies when the job ends. Background jobs report `queued` at once and every 60 s while they wait.
- The job list shows finished jobs for 8 s. Finished jobs stay in memory for 5 minutes, 30 at most. The last panel job of each previewed link stays for the life of the page.

Panel and launcher
- The launcher `scw2g-launcher` and the panel `scw2g-panel` are light-DOM hosts with closed shadow roots, `SHADOW_MODE`. Untrusted text goes through `textContent` only. `h()` wraps every `on*` handler in `trusted()`, and the direct listeners that start actions are wrapped too.
- On the desktop layout the launcher sits right after `#w2g-content-search`, where it survives w2g's re-renders and is re-inserted if removed. On the mobile layout, `body.w2g-mobile`, it sits before `#mobile-open-content` in the room header. Otherwise it floats at the bottom right after 3 s. A meter and a badge show a running add, then a check mark or `!` for 4 s. The launcher's title and aria-label say what is being added.
- A trusted launcher click opens the panel with focus in the link box and shows the library. On a panel that a detected link opened (`ui.openedBy === 'link'`), keyboard or assistive-technology activation of the launcher (click `detail` 0) does the same instead of closing it, while a pointer click closes it like any disclosure button. Escape, a pointerdown outside panel and launcher, and a w2g modal, `body.w2g-modal-open`, close the panel. Key events inside the panel don't reach w2g's page shortcuts.
- The panel shows, top to bottom:
  - a header "Adds to <playlist>", or the room name;
  - a banner while adding is blocked: looking for the room, can't find it, join first, can't reach w2g with re-checks every few seconds, checking, playlist locked;
  - the link box, where a paste or drop loads at once and Enter or Load loads what the box shows;
  - the "Skip Go+ previews" checkbox;
  - the preview with artwork, kind, a title link to SoundCloud, subtitle, "N tracks · M skipped", skip reasons, warnings and a collapsible track list;
  - the add button, progress with Cancel, and a result line;
  - other jobs with their origin and Cancel, soundcloud.com jobs included;
  - "Your SoundCloud".
- `ui.libraryShown` gates the library. It renders only after the user asked for it since the panel opened, with a trusted launcher click, "Show my SoundCloud" or Refresh. Until then, and again after closing, the section shows only the "Show my SoundCloud" prompt, even if a library was loaded before. A copy younger than 60 s shows as is. Each section shows 5 entries plus "Show all N", and a click on an entry loads its preview.
- `panelJobs` maps a previewed URL to the panel's last job for it. The preview keeps that job across every rebuild: a Go+ toggle in the panel, the popup or another room tab, Load, or coming back to the link. The preview keeps its progress, and Add stays hidden while the job runs.
- `remaining(p)` matches the URLs the link's jobs added, counting repeats, against the preview's tracks. After a partial add the primary button reads "Add the remaining N tracks" and adds only those, and "Add all N tracks again" re-adds everything. When every track is in the room already, the button reads "Add again" and isn't primary. The map is per page and keyed on the exact URL, so a different `?si=` or a short link starts fresh.
- Settings: `settings:get` on the first opening. `storage.onChanged` on `settings` updates the checkbox. A changed `skipPreviews`, from anywhere, reloads the preview, also one still loading.
- A load started inside the panel moves focus to the primary Add button once the preview is ready, if focus is still in the panel. A detected link never moves focus.
- The panel is a `role="dialog"`. The banner and the result lines are `role="status"`, errors `role="alert"`, the job list `aria-live="polite"`, and progress bars `role="progressbar"` with values. The launcher's shadow root holds a visually hidden `role="status"` line that stays rendered while the panel is closed. When a detected link opens the panel, it says "SoundCloud panel opened for your link. The SoundCloud button next to w2g's search takes you there." A link detected while the panel is already open is announced again (`restateStatus()` clears the line and re-sets it 100 ms later, so screen readers repeat it; after a launcher open the text is "The SoundCloud panel now shows your link."). It is cleared on close and on the launcher path.

Link detection in w2g's search box
- `paste` and `drop` listeners capture on `window`, registered at document_start before any page script. For a trusted event on the input inside `#w2g-content-search` whose data holds an interceptable link, `onPasteOrDrop()` calls `preventDefault()` and `stopImmediatePropagation()` and opens the panel with that link. w2g's box keeps its text.
- `interceptable(text, boxText)` extracts the link, rejects invalid and unsupported ones, and leaves the link to w2g if the whole box text is a plain public track, `isW2gNativeTrack()`. w2g turns anything else into a keyword search or the wrong item.
- An `input` listener handles a paste or drop that was left to w2g but made the box text something w2g can't play. It looks only at `insertFromPaste` and `insertFromDrop`.
- Typing and Enter in w2g's box are never intercepted. Page scripts can make the browser fire trusted `insertText` and `insertTranspose` input events with `document.execCommand`, but not a paste or a drop.
- A detected link opens the panel with only its preview, without the library and without moving focus, and sets the status line above.
- The script doesn't create `#w2g-extension-loaded`, w2g's own extension marker, and doesn't use `window.postMessage`, which w2g's official extension listens to. Its only page-world signal is the takeover CustomEvent on `document`.

### content/soundcloud.js and soundcloud.css

The script runs at document_idle in every frame of `https://soundcloud.com/*`, because logged-in track pages render in a same-origin iframe under `/n/<user>/<track>`, SoundCloud's MUI "Webi" UI. Frames that aren't `https://soundcloud.com` return at once. The global `__scw2gSoundCloud` holds the live copy. A new copy dispatches `scw2g:soundcloud-takeover`, and only a copy whose extension context died tears down on it.

Buttons and menu entries
- Rules, from item container to mount to the link that names the item, with the button variant copied from SoundCloud's neighbouring buttons:

| item | mount | link | variant |
|---|---|---|---|
| `.trackItem` | `.trackItem__actions .sc-button-group` | `a.trackItem__trackTitle` | small |
| `.sound` | `.sound__soundActions .sc-button-group` | `a.soundTitle__title`, else `a.sc-ministats[href]` | medium |
| `.soundBadge` | `.soundBadge__actions .sc-button-group` | `a.soundTitle__title` | small |
| `.soundBadge` without `.soundBadge__actions` | a built `div.soundBadge__actions > div.soundActions.sc-button-toolbar.soundActions__small > div.sc-button-group.sc-button-group-small` in `.soundBadge__additional` | `a.soundTitle__title` | small |
| `.playableTile` | `.playableTile__actionWrapper` | `a.playableTile__mainHeading, a.playableTile__artworkLink` | tile |
| `.listenEngagement` | `.listenEngagement__actions .sc-button-group` | the page URL | medium |
| `.systemPlaylistDetails` | `.systemPlaylistDetails__controls`, wrapped in `div.systemPlaylistDetails__button`, before `.systemPlaylistDetails__description` | the page URL | labeled |
| `.playbackSoundBadge` | `.playbackSoundBadge__actions`, before `.playbackSoundBadge__showQueue` | `a.playbackSoundBadge__titleLink` | player |
| `.queueItemView` | `.queueItemView__actions` | `.queueItemView__title a` | queue |

- Cards of tracks with a custom background have no title link. Their stats links still name the track, and `parse()` drops the `/likes` or `/reposts` suffix.
- More menus are portaled to `<body>` as `div.dropdownMenu` and rebuilt on every open. An entry goes into `body > .dropdownMenu .moreActions__group` when the menu's opener, found through `[aria-owns="<menu id>"]`, is a `.sc-button-more` inside a rule's item. It goes after `.sc-button-addtoset` or `.addToNextUp`, else before Report, else last. A track menu's Report link supplies `content_urn` when its `content_permalink_url` is the same item. A click closes the menu with an Escape keydown, since a synthetic click on `<body>` doesn't close it.
- Webi frames, whose path starts with `/n/`, use `injectWebi()` with the frame's URL as the source. Generated class names change between builds and labels follow the browser's language, so the main anchor is structural: `section[aria-label] button[id^="desktop-menu-button-"][aria-haspopup="true"][variant="outlined"]`, the track header's only outlined More button. The English `button[aria-label="Copy link"]` row is a second anchor, which also covers the anonymous "not found" page. The button goes before the More button. It copies the live class list and `variant` of a neighbouring button, the Copy link button or an outlined one, minus `Mui-disabled` and `Mui-focusVisible`. The toast title comes from the background's answer.
- A click classifies its link with `classifyHref()` at that moment, since nodes outlive their track during SPA navigation. Buttons go before `.sc-button-more`, or before the rule's `before` element, when present. A presence check per mount replaces marker attributes. One `MutationObserver` on `document.body` with `childList` and `subtree` ignores our own `w2g-node` elements and runs one scan 100 ms after the first relevant mutation. A More menu added to `<body>` is filled at once, before the next paint.

Clicks and jobs
- `bindClick()` always calls `preventDefault()` and `stopPropagation()`, since rows and tiles start playback on bubbling clicks. Only a trusted click counts, and not during the 1.5 s check-mark flash.
- `inFlight` maps a source URL to its unfinished job in this frame. Another click on the same item re-shows that job's toast, re-created if it was dismissed and highlighted if it is open, instead of queueing it again.
- Every button and menu entry is labelled "Add to w2g". Nothing in SoundCloud's DOM names a room.
- `call()` never throws. A dead context gives CONTEXT_INVALIDATED. After a rejected call it waits up to 1 s, `CONTEXT_CHECK_MS`, for the context to die, since an extension reload rejects pending calls a moment before it invalidates the context. A dead context then gives CONTEXT_INVALIDATED, a closed message channel or port CONNECTION_LOST, and any other failure INTERNAL.
- A job is `pending`, `queued` or `adding`. It counts as started from its first `adding` or `queued` progress, and `added` is the highest `done` seen. Progress is recorded while the toast is closed or waiting for confirmation, because a later failure must know about it.

Toast texts
- Busy: "Adding 'Title' to w2g…"; "Waiting for the room's current add to finish… (position N)"; for more than one track "Adding N tracks… d/N" with a bar.
- Confirmation: "Add N tracks to w2g?" with the title and the number of tracks that will be skipped, and the actions "Add" and "Cancel". Closing the toast means Cancel.
- Success: "Added 'Title' to <room>" for a single track, else "Added N tracks to <room>", with the skip summary and warnings. It hides after 5 s, but not while hovered.
- The room label is the room name, or "your w2g room". With more than one room registered, it adds the first 4 characters of the streamkey, as in "Temporary Room (mgdr…)" or "room mgdr…". A fallback to another room is visible that way without showing the room's invite key.
- Errors use a headline and hint per code, `ERRORS`. EMPTY lists the skip reasons. When every skipped track is a Go+ preview, it points to "Skip Go+ previews" in the popup. INTERNAL adds the error message.
- If anything was added, the error says how many tracks were added before it happened and asks to check the playlist. After start with nothing known, the `UNSURE` codes ROOM_UNREACHABLE, INTERNAL, CONNECTION_LOST and CONTEXT_INVALIDATED say that the track, or some tracks, may already be in the room.
- CONNECTION_LOST after start reads "Lost track of this add". It says how many tracks were added so far, if any, that the room tab may still be adding the rest, and to check the playlist in a minute before adding again. CONTEXT_INVALIDATED offers "Reload page" and, after start, reads "SoundCloud for w2g stopped while adding".
- "Try again" follows the rule under "Error codes".

Toast UI
- The host `div.w2g-node.w2g-toasts` sits in `<body>`, fixed at right 16 px and bottom 64 px above the 48 px player bar, at z-index 1002. Its shadow root is closed, `TOAST_SHADOW_MODE`; the e2e tests replace that exact line to read toasts. Toast colors are literal values from two palettes, `PALETTES.dark` and `PALETTES.light`, written into the shadow CSS; `themePalette()` picks one from SoundCloud's theme (the classic UI's `body.theme-dark`/`theme-light`, Webi's `html.mui-theme-*`, the `theme` query parameter, the body background) and sets it as a class on the inner `.stack`. No toast style uses `var()`: custom properties inherit into shadow trees, and a page rule or a registered `@property` could otherwise make the toast transparent. `.stack` starts with `all: initial` and uses only generic font families (`system-ui, sans-serif`), so inherited page styles and page `@font-face` rules don't reach the text.
- Beyond 5 toasts, the stack drops the oldest finished ones. The stack is `aria-live="polite"`, error toasts are `role="alert"` and the others `role="status"`.
- SoundCloud's Next up panel opens above the player bar in the same corner. While `.playControls .queue` has `m-visible`, the stack moves left of it if the panel's left edge is at least 392 px from the window's left, else above it if its top is at least 160 px down, else it stays in the corner. A class observer on the panel and window resizes re-place the stack.
- Teardown keeps a copy's toast stack, since its jobs still report how they ended. A new copy moves other `body > .w2g-toasts` hosts into its own host through a `<slot>`, so the stacks don't overlap.
- Toast actions that add tracks, the confirmation's "Add" and "Try again", react only after IntersectionObserver v2 has reported them visible and fully intersecting (`intersectionRatio` >= 0.99) for 500 ms without a break, `VISIBLE_MS`, compared with the click's `timeStamp`. The observer uses `trackVisibility: true`, `delay: 100` and thresholds 0, 0.99 and 1. At click time `seenLongEnough()` also requires the button at full size (at least 24 x 16 px) and fully on screen, and `pageTampered()` rejects what IO v2 doesn't check: a host that is no longer a child of `<body>`, no longer fixed, or whose rendered box (or the stack inside it) isn't where `place()` put it; and `zoom`, `transform`, `translate`, `scale`, `rotate`, masks, `clip-path`, `mix-blend-mode` or hidden visibility on the host or any ancestor. Cancel, Dismiss and "Reload page" aren't gated. Without IO v2 support there is no gate.
- "Try again" (`retryJob()`) starts a fresh attempt: a new jobId and reset per-attempt state (`started`, phase, totals), so a retry that fails before reaching the room tab is judged like a fresh click.
- IO v2 counts a button as hidden while it or an ancestor has opacity below 1, a filter or a non-translation transform, or while anything paints over it, even a shadow. The toast CSS therefore uses such effects only in the enter and leave animations, mixes hover colors instead of fading, and keeps each toast's shadow within 15 px above it, clear of the buttons of the toast above.

Room gating and teardown
- The frame asks `rooms:get` at start, on `visibilitychange` to visible and on a bfcache `pageshow`, and it applies every `rooms:changed`. A `rooms:changed` makes an older `rooms:get` answer still in flight stale.
- `<html data-w2g-room>` is set while any room is registered. soundcloud.css hides `.w2g-add`, `.w2g-add-menu` and `.w2g-group` without it. It also colors the check-mark flash orange, widens Next up rows to 96 px for a third button, and hides the track-card buttons in windows up to 1079 px wide, where the More-menu entry remains.
- When the extension context is dead, teardown stops the observer and listeners, removes every injected node except toast stacks, removes `data-w2g-room` and releases the guard.

### popup

- Rooms: one room shows as a card. Several show as a radio group with "Most recently used room", whose detail line shows the registry's current choice, and one entry per room with a "Joined", "Not joined" or "Offline" badge. "Offline" means `unreachable`. Choosing sends `rooms:set-target`. The popup shows full streamkeys, since page scripts can't read extension pages. The empty state says private windows aren't supported.
- SoundCloud: `sc:status` shows "Logged in as X", "Login expired" or "Not logged in", the latter two with "Open SoundCloud". A failed check offers "Try again".
- Settings: "Skip Go+ previews", and "Ask before adding more than N tracks" for 0 to 10000, saved while typing.

## Security model and residual risks

Page scripts on w2g.tv room pages and on soundcloud.com, including third-party ad and tracking scripts, share the DOM with the content scripts but not their JavaScript world. soundcloud.com's top frame runs many third-party scripts. The extension must keep them from adding tracks to the user's room, reading the SoundCloud login or library, learning a room's invite key, and steering adds to another room. Where it can't do that fully, it limits exposure to what the user has on screen.

Credentials
- The background reads the `oauth_token` cookie through `chrome.cookies` and sends it only in the `Authorization` header to `https://api-v2.soundcloud.com`. `apiUrl()` refuses other hosts, also for a `next_href` from a response. The token never enters a content script or a page.
- Every SoundCloud request uses `credentials: 'omit'`, so soundcloud.com cookies are never sent. The `datadome` value goes only into `X-Datadome-ClientId`, on the one retry after a bot challenge.
- With `"incognito": "not_allowed"` the extension can't be enabled in private windows, so private rooms and logins never mix with the normal profile's.

What page scripts can't do
- Talk to the extension. The manifest declares no `externally_connectable`, so pages can't message it, and the background accepts messages only from its own content scripts and pages, checked by origin and frame.
- Reach into the launcher, panel or toasts. Closed shadow roots give page scripts no element references, no input values and no way to call `click()` on our buttons.
- Start an action with synthetic events. Every handler that starts something checks `isTrusted`. That covers page buttons and menu entries, toast actions and close buttons, every panel control, paste and drop detection, `focus` and `visibilitychange` for `room:active`, `pagehide` for `room:bye`, and the bfcache `pageshow` for `room:hello`. The takeover events tear down only a copy whose extension context is dead.
- Trigger link detection by script alone. Detection reacts only to trusted paste and drop events, and `document.execCommand('paste')` returns false even with the clipboard-read permission granted. The trusted `insertText` and `insertTranspose` events that `execCommand` produces in w2g's box are ignored.
- Make their room the most recently used. A page can make its room tab re-send `room:hello`, for example by editing the room-name element, but a hello from the same document keeps `lastActive`. Only `room:active` after trusted focus or visibility bumps it.

Residual risks
1. Rendered text is readable. `window.find()` matches text inside closed shadow roots, so a page script can probe whatever the open panel or a toast shows, character by character. Hence the library renders only after the user asks for it in the current opening, a detected link shows only its own preview, and toasts carry track titles, the room name and at most 4 characters of the streamkey, never the token or a full key. Images the panel loads, artwork and avatars, also show up in the page's Resource Timing. Only rendering the UI in an extension-origin iframe would close this.
2. Injected page buttons can be redressed. The "Add to w2g" buttons and More-menu entries are light-DOM elements on soundcloud.com. A page script can restyle or move them, transparent and under the cursor, so the user's next ordinary click lands on one as a trusted click. It can also change the item's link just before, or the page URL through `history.replaceState` for the rules that use the page URL. The result is a page-chosen track or set of up to `confirmAbove` tracks, 100 by default, added to the target room. Larger sets need the toast's "Add", which the visibility gate protects. On w2g.tv the launcher and panel hosts are light-DOM elements too, and the panel's buttons have no visibility gate. A redressed click on the launcher opens the panel with the library, and one on Add adds the link in the preview.
3. The visibility gate has limits. IO v2 reports changes up to about 100 ms plus a frame late, so a page that hides the toast right before a click it predicts can still get that click through, if the toast really was visible at that spot for the 500 ms before. A toast that is fully visible in its usual corner can still be clicked by a user who didn't mean to (the page can't move it, but it can time a decoy next to it). The gate fails closed: anything painted over the buttons, even a transparent layer, or any of the effects `pageTampered()` checks makes them ignore clicks without feedback. Engines without IO v2 get no gate.
4. A page can control a pasted or dropped link. If a page controls what the user pastes into w2g's search box, through clipboard writes, or drops there, with drag data from a drag that starts on w2g's page, it gets that link previewed with the user's login. `/you/likes` or `/discover/weekly` then show the username and track counts, which risk 1 makes readable. Adding still needs a trusted click.
5. `execCommand` can type into the focused panel input. While focus is in the panel's link box, `document.execCommand('insertText', ...)` from the page types into it despite the closed shadow root. The box doesn't load by itself, since only paste and drop load at once, but the user's next Enter or Load loads whatever it shows.
6. Room data is page-controlled. The room name comes from w2g's DOM and shows as text wherever the room is named. A page script can also close the panel with a synthetic `pointerdown`.
7. `html[data-w2g-room]` tells soundcloud.com scripts that some w2g room tab is open. The CSS gating needs it.

## Conventions

- Plain modern JavaScript, 2-space indent, single quotes, semicolons. Small functions. Comments only for a non-obvious "why", citing the w2g or SoundCloud quirk.
- Untrusted strings, meaning titles, usernames, room names and URLs from SoundCloud or w2g, go only through `textContent` or attributes, never `innerHTML`. Static SVG icons may use `innerHTML` with constants.
- Log sparingly with the prefix `[scw2g]`, and not on the happy path except at debug level.
- Content scripts must not throw at top level on unexpected DOM, and they wrap `chrome.runtime.*` calls, because an extension update can invalidate their context.
- Tests: `npm test` runs the unit tests offline. `LIVE=1 node --test test/unit/soundcloud.live.test.mjs` checks the client against the real api-v2. `npm run test:e2e` and `npm run test:e2e:brave` run Playwright against real w2g and SoundCloud. E2E tests create at most a few throwaway w2g rooms.

## Verified facts as of 2026-10-13

w2g
- `POST https://w2g-api.w2g.tv/rooms/<sk>/playlists/<key>/playlist_items/sync_update` with `{"add_items":[{url,title,thumb}]}` adds items for any session that joined the room, through the HttpOnly, SameSite=Lax cookie `w2g_session_id`, without an API key. It takes at most 50 items per request; 51 give 403. Cloudflare answers 429 after about 23 POSTs in about 5 s, with `Retry-After: 10`. Error responses lack CORS headers. Sequential requests keep their order. The server stores title and thumb verbatim. An empty title drops the item silently, and a missing thumb shows a generic icon. Items appear live for all members.
- `GET /rooms/<sk>/sync_state` answers `{ state: [["playlists", { payload: { lists, selectedPlaylist } }], ["stream_moderation", ...], ["user_list", ...]] }`. `GET /streams/<sk>/playlists/<key>/playlist_items` lists a playlist's items in playlist order.
- A content-script fetch from the room tab goes out with `Origin: https://w2g.tv` and passes CORS.
- w2g plays `https://soundcloud.com/...` items with the SoundCloud widget and auto-advances between them. A set URL added as is plays only its first track, which is why this extension exists.

SoundCloud
- api-v2's CORS allows only `https://soundcloud.com`. The service worker with host permissions has no CORS limits. Track and artist stations, `/discover/sets/track-stations:<id>`, resolve anonymously and behave like Weekly Wave, with stubs only.
- The `oauth_token` cookie is readable through `chrome.cookies`; it isn't HttpOnly. New tokens may be short-lived JWTs that only soundcloud.com refreshes. The extension never calls SoundCloud's refresh endpoint, because refresh tokens are single-use and a race could log the user out.
- soundcloud.com answers a request carrying an `oauth_token` cookie it doesn't accept with `Set-Cookie` headers that delete `oauth_token` and `_soundcloud_session`, which logs the user out.
- A Playback mix answers 404 to anonymous requests.
- api-v2 answered 200 to a request with a made-up `X-Datadome-ClientId` header, so the DataDome retry is a valid request. A real DataDome 403 from api-v2 hasn't been observed.

Browsers, checked in Chromium and Brave
- `window.find()` called by a page script matches text inside closed shadow roots, also with `user-select: none`.
- `document.execCommand()` called by a page script makes the browser fire trusted `input` events. In an `<input>`, `transpose` gives inputType `insertTranspose` with `data` null, and `insertText` and `insertHTML` give `insertText`. `execCommand('paste')` returns false even with the clipboard-read permission granted.
- IntersectionObserver v2 with `trackVisibility: true` works in headless Chromium 156 and Brave 155. It reported a toast action visible about 210 to 250 ms after the toast appeared. A hover style with `opacity: 0.85` made a button count as hidden while the pointer rested on it. With an 8 px gap between toasts, the next toast's `box-shadow` with a 6 px y-offset counted as covering the buttons above it from a blur of about 20 px.
- Both browsers load the extension with `"incognito": "not_allowed"`.
- When a room tab navigates to another site, Chrome delivers the old page's `pagehide` message with a non-zero `frameId`, `documentLifecycle: 'pending_deletion'` and the `documentId` of its `room:hello`. `tabs.onUpdated` reports no `url` for the new site. A `status: 'loading'` event without `tab.url` comes once the navigation commits, and cancelled navigations, downloads and 204 responses send none.

Browsers, single probes
- A page script's `document.execCommand('insertText', ...)` types into a focused `<input>` inside a closed shadow root.
- An extension reload rejects a content script's pending `runtime.sendMessage` about 10 ms before the content script's context reports itself invalid.
