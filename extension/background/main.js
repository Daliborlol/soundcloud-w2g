// Service worker entry. The logic lives in app.js (unit-tested against a fake `chrome`); this file only wires
// the real modules and events together.
import '../shared/sc-url.js';
import * as soundcloud from './soundcloud.js';
import { createBackground } from './app.js';

const background = createBackground({ chrome, sc: soundcloud, urlTools: globalThis.SCW2G.url });

// MV3 delivers events only to listeners registered synchronously while the worker script first runs.
chrome.runtime.onMessage.addListener(background.onMessage);
chrome.runtime.onInstalled.addListener(background.onInstalled);
chrome.runtime.onStartup.addListener(background.onStartup);
chrome.tabs.onRemoved.addListener(background.onTabRemoved);
chrome.tabs.onUpdated.addListener(background.onTabUpdated);
chrome.cookies.onChanged.addListener(background.onCookieChanged);
