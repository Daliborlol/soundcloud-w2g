// Toolbar popup: choose the target w2g room, see the SoundCloud login state, change settings.
// Room names and usernames come from w2g and SoundCloud, so all dynamic text goes through text nodes.

const roomsList = document.getElementById('rooms');
const roomsEmpty = document.getElementById('rooms-empty');
const roomsError = document.getElementById('rooms-error');
const scStatus = document.getElementById('sc-status');
const skipPreviews = document.getElementById('skip-previews');
const confirmAbove = document.getElementById('confirm-above');
const settingsError = document.getElementById('settings-error');

let currentSettings = null;
let roomsRefreshTimer = null;

/** Sends a message to the background; resolves to its response or to an { ok: false } error. */
async function send(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    return response || { ok: false, error: { code: 'INTERNAL', message: 'The extension did not answer.' } };
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL', message: err.message } };
  }
}

/** Creates an element; string children become text nodes. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function showError(node, error) {
  node.textContent = (error && (error.message || error.code)) || 'Something went wrong.';
  node.hidden = false;
}

// ---------------------------------------------------------------------------------------------------------------
// Rooms

function roomLabel(room) {
  return room.roomName || (room.streamkey ? `Room ${room.streamkey}` : 'w2g room');
}

function roomDetail(room) {
  if (!room.joined && room.unreachable) return "That tab can't reach w2g right now. Check your connection.";
  if (!room.joined) return 'Click "Join the Room" in that tab first';
  return room.streamkey ? `w2g.tv · ${room.streamkey}` : 'w2g.tv';
}

function roomBadge(room) {
  if (room.joined) return el('span', { class: 'badge badge--ok' }, 'Joined');
  return el('span', { class: 'badge badge--warn' }, room.unreachable ? 'Offline' : 'Not joined');
}

function roomOption({ value, checked, name, detail, badge }) {
  return el('label', { class: 'room' },
    el('input', { type: 'radio', name: 'target', value, checked, onchange: onTargetChange }),
    el('span', { class: 'room__name', title: name }, name),
    badge || el('span'),
    el('span', { class: 'room__detail', title: detail }, detail),
  );
}

// With a single room there is nothing to choose: show it without radio buttons.
function roomCard(room) {
  return el('div', { class: 'room room--single' },
    el('span', { class: 'room__name', title: roomLabel(room) }, roomLabel(room)),
    roomBadge(room),
    el('span', { class: 'room__detail', title: roomDetail(room) }, roomDetail(room)),
  );
}

function renderRooms({ rooms, target, pinnedTabId }) {
  roomsEmpty.hidden = rooms.length > 0;
  roomsList.hidden = rooms.length === 0;
  if (rooms.length <= 1) {
    roomsList.removeAttribute('role');
    roomsList.replaceChildren(...rooms.map(roomCard));
    return;
  }
  roomsList.setAttribute('role', 'radiogroup');
  const automatic = pinnedTabId == null;
  roomsList.replaceChildren(
    roomOption({
      value: '',
      checked: automatic,
      name: 'Most recently used room',
      detail: automatic && target ? `Now: ${roomLabel(target)}` : 'Follows the w2g tab you used last',
    }),
    ...rooms.map((room) => roomOption({
      value: String(room.tabId),
      checked: pinnedTabId === room.tabId,
      name: roomLabel(room),
      detail: roomDetail(room),
      badge: roomBadge(room),
    })),
  );
}

async function loadRooms() {
  const res = await send('rooms:get');
  if (!res.ok) {
    showError(roomsError, res.error);
    return;
  }
  roomsError.hidden = true;
  renderRooms(res);
}

async function onTargetChange(event) {
  const tabId = event.target.value === '' ? null : Number(event.target.value);
  const res = await send('rooms:set-target', { tabId });
  await loadRooms();
  if (!res.ok) showError(roomsError, res.error);
}

function scheduleRoomsRefresh() {
  clearTimeout(roomsRefreshTimer);
  roomsRefreshTimer = setTimeout(loadRooms, 50);
}

// ---------------------------------------------------------------------------------------------------------------
// SoundCloud login

/** title: string or nodes; text: optional second line; action: optional { label, run, quiet } button. */
function renderStatus(state, { title, text, action }) {
  const nodes = [
    el('span', { class: 'status__dot', 'aria-hidden': 'true' }),
    el('p', { class: 'status__title' }, ...[].concat(title)),
  ];
  if (action) {
    nodes.push(el('button', { class: action.quiet ? 'button button--quiet' : 'button', type: 'button', onclick: action.run }, action.label));
  }
  if (text) nodes.push(el('p', { class: 'status__text' }, text));
  scStatus.className = `status status--${state}`;
  scStatus.replaceChildren(...nodes);
}

async function openSoundCloud() {
  await send('open:soundcloud');
  window.close();
}

async function loadStatus() {
  renderStatus('loading', { title: 'Checking your SoundCloud login…' });
  const res = await send('sc:status');
  const openAction = { label: 'Open SoundCloud', run: openSoundCloud };
  if (!res.ok) {
    renderStatus('error', { title: 'Couldn\'t check your login', text: res.error.message, action: { label: 'Try again', quiet: true, run: loadStatus } });
  } else if (res.loggedIn) {
    renderStatus('in', {
      title: ['Logged in as ', el('strong', {}, res.username || 'you')],
      text: 'Weekly Wave and your playlists are available in the room panel.',
    });
  } else if (res.expired) {
    renderStatus('expired', { title: 'Login expired', text: 'Open soundcloud.com once to refresh your login, then try again.', action: openAction });
  } else {
    renderStatus('out', { title: 'Not logged in', text: 'Log in on soundcloud.com to use Weekly Wave and your playlists.', action: openAction });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

function applySettings(settings) {
  currentSettings = settings;
  skipPreviews.checked = settings.skipPreviews;
  confirmAbove.value = String(settings.confirmAbove);
}

async function loadSettings() {
  const res = await send('settings:get');
  if (res.ok) applySettings(res.settings);
  else showError(settingsError, res.error);
}

/** reflect: write the stored (normalized) values back into the inputs, which would disturb typing. */
async function saveSettings(patch, { reflect = true } = {}) {
  const res = await send('settings:set', { patch });
  if (!res.ok) {
    showError(settingsError, res.error);
    if (currentSettings) applySettings(currentSettings);
    return;
  }
  settingsError.hidden = true;
  if (reflect) applySettings(res.settings);
  else currentSettings = res.settings;
}

skipPreviews.addEventListener('change', () => saveSettings({ skipPreviews: skipPreviews.checked }));

// Saved while typing too: a popup that loses focus closes without a final change event.
confirmAbove.addEventListener('input', () => {
  if (Number.isFinite(confirmAbove.valueAsNumber)) saveSettings({ confirmAbove: confirmAbove.valueAsNumber }, { reflect: false });
});
confirmAbove.addEventListener('change', () => {
  if (Number.isFinite(confirmAbove.valueAsNumber)) saveSettings({ confirmAbove: confirmAbove.valueAsNumber });
  else if (currentSettings) applySettings(currentSettings);
});

// ---------------------------------------------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && ('rooms' in changes || 'targetTabId' in changes)) scheduleRoomsRefresh();
  if (area === 'local' && 'settings' in changes && document.activeElement !== confirmAbove) loadSettings();
});

loadRooms();
loadStatus();
loadSettings();
