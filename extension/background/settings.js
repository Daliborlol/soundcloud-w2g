// User settings in chrome.storage.local under the key 'settings', always read merged over the defaults.
import { BgError, createLock } from './util.js';

const KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  skipPreviews: true, // drop Go+ tracks: room members without Go+ would only hear a 30 s preview
  confirmAbove: 100, // ask before adding more tracks than this
});

export const CONFIRM_ABOVE_MAX = 10000;

/** Keeps only known keys with usable values. Numbers (or numeric strings) are rounded and clamped. */
export function sanitizeSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.skipPreviews === 'boolean') out.skipPreviews = patch.skipPreviews;
  let n = patch.confirmAbove;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n === 'number' && Number.isFinite(n)) out.confirmAbove = Math.min(CONFIRM_ABOVE_MAX, Math.max(0, Math.round(n)));
  return out;
}

export function createSettingsStore({ storage }) {
  const lock = createLock();

  async function get() {
    const stored = (await storage.get(KEY))[KEY];
    return { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) };
  }

  /** Merges the valid parts of `patch` and resolves to the settings now in effect; invalid values are ignored. */
  function set(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return Promise.reject(new BgError('INTERNAL', 'settings:set needs a { patch } object'));
    }
    return lock(async () => {
      const next = { ...(await get()), ...sanitizeSettings(patch) };
      await storage.set({ [KEY]: next });
      return next;
    });
  }

  return { get, set };
}
