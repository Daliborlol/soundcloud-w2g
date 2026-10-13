# SoundCloud for w2g

A browser extension that adds SoundCloud playlist support to [w2g.tv](https://w2g.tv) (Watch2Gether). That includes your personal mixes like **Weekly Wave** and **Daily Drops**, which SoundCloud doesn't let you share.

It does two things:

- **In a w2g room:** a SoundCloud button next to w2g's search box opens a panel. Paste a SoundCloud link or pick one of your own playlists, and the extension adds every track to the room's playlist, in order.
- **On soundcloud.com:** while a w2g room is open in another tab, an **Add to w2g** button appears next to tracks and playlists. One click sends that track, or the whole playlist, to the room.

The tracks go into the room as normal SoundCloud tracks, which w2g already knows how to play. **Your friend doesn't need to install anything.** Only the person adding music needs the extension.

## Install (Brave, Chrome, Edge, Vivaldi)

1. Get the `extension` folder: use it straight from this repository, or unzip `soundcloud-w2g-<version>.zip` (made by `npm run package`).
2. Open `brave://extensions` (Chrome: `chrome://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `extension` folder (the one that contains `manifest.json`).
5. Optional: pin the extension (puzzle icon in the toolbar) so its popup is one click away.

To update after changing or pulling the code, click the reload arrow on the extension's card in `brave://extensions`. Tabs that were already open keep working: the extension re-attaches to them by itself. If something in a tab doesn't respond after an update, reload that tab.

The extension doesn't run in private windows.

## Before your first session

- **Log in to soundcloud.com in the same browser.** Public playlists work without a login. Weekly Wave, Daily Drops, your likes, your library and private playlists need it.
- **Join your w2g room.** If w2g shows "Join the Room" (the nickname dialog), click through it first. w2g only accepts new playlist items from people who joined.

## Using it

### In the w2g room

1. Open your room. Right after w2g's search box there's a new button with the SoundCloud cloud (tooltip: "Add from SoundCloud"). Click it.
2. In the panel, do one of these:
   - Paste a SoundCloud link into the panel's box. It loads right away (or type it and press Enter / click **Load**).
   - Under **Your SoundCloud**, pick something: Made for you (Weekly Wave, Daily Drops, …), your playlists, liked playlists, recently played, or your liked tracks.
3. You see a preview: title, number of tracks, what gets skipped and why, and the full track list. Click **Add N tracks**.

The panel header says which w2g playlist the tracks go into. A progress bar shows how far it got, and **Cancel** stops it. If an add stops halfway, the button changes to **Add the remaining N tracks**, so nothing gets added twice.

Links that work: playlists and albums, Weekly Wave and Daily Drops, stations, "Your <year> Playback", someone's tracks, likes, reposts or popular tracks, single tracks, private (secret) links, and short `on.soundcloud.com` links.

**Shortcut:** paste (or drag) a SoundCloud playlist link straight into **w2g's own search box**. The panel opens with that playlist's preview. Plain public track links are left to w2g, which adds those by itself. Click the SoundCloud button once more to get to the panel with the keyboard, or to see your own playlists there too.

### On soundcloud.com

Keep the w2g room open in another tab and browse SoundCloud as usual. The **Add to w2g** button (a little screen with a plus) shows up:

- on track rows in playlists, Weekly Wave, Daily Drops and stations (hover a row)
- on the big header of a track, playlist or mix page ("Add to w2g" on Weekly Wave and Daily Drops pages)
- on tracks in your feed, on profiles and in search results
- on tiles on the Home and Discover pages, and on the small cards in sidebars
- in the player bar at the bottom and in the **Next up** queue
- in the **⋯ More** menu (on SoundCloud's new track page too)

A track's button adds that track. A playlist's button adds all its tracks. A small notification in the bottom right shows progress and the result. For more than 100 tracks it asks first (**Add** / **Cancel**); you can change that number in the popup. If the room is busy with another add, the notification says it's waiting its turn.

If you have more than one w2g room open, tracks go to the room you used last. To always send them to one room, pick it in the popup.

### The toolbar popup

- **Add tracks to:** the w2g rooms the extension sees and whether you've joined each. With several rooms you can pick one, or leave it on "Most recently used room".
- **SoundCloud:** whether you're logged in, and an **Open SoundCloud** button if not.
- **Settings:** "Skip Go+ previews" and "Ask before adding more than N tracks".

## What gets skipped, and why

Some SoundCloud tracks can't play in w2g's SoundCloud player. The extension leaves them out so the room doesn't get stuck on them. The preview or the notification says how many were skipped and why:

| Shown as | What it means |
|---|---|
| Go+ previews skipped | SoundCloud Go+ tracks. Anyone without Go+ would only hear a 30-second preview. Skipped by default; turn off "Skip Go+ previews" in the panel or the popup to add them anyway. |
| not available in your country | The uploader blocked your region. |
| not streamable / can't play outside SoundCloud | The uploader turned off streaming or embedding. |
| unavailable | Deleted, or made private since it was added to the playlist. |
| still processing | Just uploaded; SoundCloud hasn't finished processing it. |

Private tracks in your own or shared private playlists are added through their secret links, so they play in the room for everyone.

## Good to know

- **Big playlists take a moment.** w2g takes at most 50 tracks per request, and the extension waits a few seconds between requests like w2g's own app does, so it doesn't get rate-limited. One add takes up to 1,000 tracks.
- **One add at a time per room.** If you start a second add while one is running, it waits and starts when the first is done.
- **Locked playlist:** if the room owner locked the playlist, only the owner and moderators can add. The panel says so.
- **Switching w2g playlists while adding:** the add stops ("The room switched to another playlist"). Switch back and click **Add the remaining N tracks**.
- **SoundCloud login expired, or SoundCloud wants to "check that you are human":** open soundcloud.com once in the same browser (the panel and the popup have an **Open SoundCloud** button), then try again. After a new login the room panel reloads your library by itself.

## Privacy and permissions

The extension has no server of its own. It only talks to SoundCloud and w2g, from your browser:

- **SoundCloud** (`soundcloud.com`, `api-v2.soundcloud.com`, `on.soundcloud.com`). To load your personal playlists it reads SoundCloud's login cookie (`oauth_token`) and sends it only to SoundCloud's API, the same way soundcloud.com does. If SoundCloud's bot check (DataDome) blocks a request, it retries once with SoundCloud's `datadome` cookie value. Nothing else is sent anywhere.
- **w2g** (`w2g.tv`). It adds tracks through w2g's own playlist endpoint with your normal w2g session, the same request the room page sends when you add something.
- **Permissions:**
  - `cookies`: read those two SoundCloud cookies
  - `storage`: settings and the list of open rooms
  - `scripting`: re-attach to tabs that were already open when the extension was installed or updated

The w2g and SoundCloud pages (and the ad scripts they load) can't reach into the extension: the panel and the notifications live in closed shadow DOM, ignore clicks and input that page scripts fake, load your library only after you click the SoundCloud button yourself, and never show secrets such as your SoundCloud login or a room's full invite key. A page could still guess at text that's on screen (for example a playlist title in the open panel) through the browser's find function, so the extension keeps what it shows to what you asked for. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) lists the details and the remaining limits.

## Troubleshooting

| Problem | What to do |
|---|---|
| No SoundCloud button in the room | Reload the room tab. The URL should look like `https://w2g.tv/<lang>/room/?room_id=...`. On the mobile layout the button sits in the room header next to w2g's search icon; if neither fits, it floats at the bottom right. |
| No **Add to w2g** buttons on SoundCloud | A w2g room tab must be open in the same browser profile (not in a private window). Row buttons only show when you hover the row. |
| "Click 'Join the Room' first" | Join the room in w2g (nickname dialog), then try again. |
| "Couldn't reach w2g" / the popup says "Offline" | The room tab lost its connection to w2g. Check your connection and try again; if it stays, reload the room tab. |
| "Log in to SoundCloud" for Weekly Wave | Log in on soundcloud.com in the same browser and profile. |
| "Nothing here can be played in w2g" | Every track was skipped. If they're Go+ tracks, turn off "Skip Go+ previews". |
| "The room tab stopped responding" | Check the room's playlist (some tracks may have landed), then try again. Reload the room tab if it stays stuck. |
| Anything else | Open `brave://extensions`, find this extension and click **Errors** or **service worker** to see what went wrong. |

## Tested so far

- Public playlists, albums, stations, profiles, likes, single tracks and private (secret) tracks were tested against the real w2g.tv and soundcloud.com, in Chromium and Brave. A private track really plays in the room's player.
- **Weekly Wave, Daily Drops, your library and private playlists were only tested with simulated SoundCloud logins**, built from SoundCloud's real API responses. No real SoundCloud account was available. If one of them fails with your login, the error message in the panel says which step failed.
- SoundCloud's new track page ("Add to w2g" in its **⋯ More** menu) was tested logged out in English. The logged-in variant and other languages were tested with copies of that page.

## Development

```bash
npm install            # Playwright, for the end-to-end tests
npm test               # unit tests (offline, a few seconds)
npm run test:e2e       # end-to-end tests: real Chromium, real w2g rooms, real SoundCloud (about 20 minutes)
npm run test:e2e:brave # the same with the installed Brave (/opt/brave-bin/brave)
npm run package        # dist/soundcloud-w2g-<version>.zip
```

The end-to-end tests create temporary w2g rooms and load real SoundCloud pages, so they need internet access. The extension has no build step: `extension/` is loaded as is. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes how it works and the w2g and SoundCloud details it relies on.
