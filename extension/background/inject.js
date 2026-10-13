// Injects the manifest's content scripts into tabs that were already open when the extension was installed,
// updated or (re)started, so they work without a reload. Both content scripts guard against double injection.
import { urlMatches } from './util.js';

function frameMatches(url, cs) {
  return urlMatches(url, cs.matches) && !urlMatches(url, cs.exclude_matches || []);
}

/** Resolves to [{ tabId, frameIds?, injected, reason? }] for every candidate tab; never rejects. */
export async function reinjectContentScripts(chrome) {
  const entries = (chrome.runtime.getManifest().content_scripts || [])
    .filter((cs) => (cs.js && cs.js.length) || (cs.css && cs.css.length));
  const outcomes = [];
  for (const cs of entries) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: cs.matches });
    } catch {
      continue;
    }
    outcomes.push(...await Promise.all(tabs.map((tab) => injectIntoTab(chrome, tab, cs))));
  }
  return outcomes;
}

async function injectIntoTab(chrome, tab, cs) {
  if (tab.discarded) return { tabId: tab.id, injected: false, reason: 'discarded' };
  try {
    // Ask every frame for its URL first so we inject exactly where the browser would (all_frames would also
    // reach about:blank and other-site frames we have host access to).
    const probes = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: !!cs.all_frames },
      func: () => location.href,
    });
    const frameIds = (probes || []).filter((p) => frameMatches(p.result, cs)).map((p) => p.frameId);
    if (!frameIds.length) return { tabId: tab.id, injected: false, reason: 'no matching frame' };
    const target = { tabId: tab.id, frameIds };
    if (cs.css && cs.css.length) await chrome.scripting.insertCSS({ target, files: cs.css });
    if (cs.js && cs.js.length) {
      await chrome.scripting.executeScript({ target, files: cs.js, ...(cs.world === 'MAIN' ? { world: 'MAIN' } : {}) });
    }
    return { tabId: tab.id, frameIds, injected: true };
  } catch (err) {
    // Error pages, tabs still loading or being closed: the manifest injection covers them once they load.
    return { tabId: tab.id, injected: false, reason: (err && err.message) || String(err) };
  }
}
