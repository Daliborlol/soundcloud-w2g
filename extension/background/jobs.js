// The `queue` flow: a soundcloud.com frame (or an extension page) asks to add a track or playlist to the target
// w2g room. Steps: check the URL, find a room tab that answers room:ping and has joined, expand the URL,
// ask for confirmation above settings.confirmAbove, send room:add, and relay the room tab's job:progress
// messages to the frame that asked.
import { BgError, attempt, errorPayload, maxCount, quietly, settleWithin, withTimeout } from './util.js';
import { isRoomUrl, roomFields } from './rooms.js';

const MESSAGES = {
  NO_ROOM: 'No w2g room is open. Open a w2g.tv room in this browser first.',
  ROOM_UNREACHABLE: 'The w2g room tab is not responding. Reload the room tab and try again.',
  ROOM_GONE: 'The w2g room tab was closed or reloaded before the tracks were added.',
  ROOM_STALLED: 'The w2g room tab stopped reporting progress, so adding was stopped. Check the room\'s playlist.',
  NOT_JOINED: 'Join the w2g room first: click "Join the Room" in the room tab.',
  W2G_UNREACHABLE: "The w2g room tab can't reach w2g right now. Check your connection, then try again.",
  EMPTY: 'Nothing playable to add: every track was skipped.',
  DUPLICATE: 'This request is already running.',
  NO_JOB_ID: 'queue needs a jobId.',
};
const MAX_PINGS = 4;

function isJobId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 200) || Number.isFinite(id);
}

function count(n) {
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** BgError from an `error` object a content script replied with; keeps its `added`, or `done` if that is more. */
function fromReply(error, fallbackCode, done) {
  const code = error && typeof error.code === 'string' && error.code ? error.code : fallbackCode;
  const message = (error && error.message) || MESSAGES[code] || 'The w2g room tab reported an error.';
  return new BgError(code, message, { added: maxCount(done, error && error.added) });
}

export function createJobRunner({ chrome, rooms, settings, scService, keepAlive, timing }) {
  const jobs = new Map(); // id sent to the room tab -> job
  let seq = 0;

  /** Handles a `queue` message; always resolves to a QueueResult. */
  async function queue(msg, sender, senderKind) {
    const jobId = msg.jobId;
    if (!isJobId(jobId)) return { ok: false, jobId: jobId ?? null, error: { code: 'INTERNAL', message: MESSAGES.NO_JOB_ID } };
    // Extension pages get progress through runtime.sendMessage; tabs.sendMessage only reaches content scripts.
    const origin = senderKind === 'extension' || !sender.tab ? null : { tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
    if (findJob(jobId, origin)) return { ok: false, jobId, error: { code: 'INTERNAL', message: MESSAGES.DUPLICATE } };

    // Our own id for the room tab, so equal jobIds from different frames can't mix up progress. The timestamp keeps
    // it unique across worker restarts, when a room tab may still report progress for an older worker's job.
    // `done` is the room tab's last reported progress: tracks already in the room if the job fails later.
    const job = {
      id: `bg${++seq}-${Date.now().toString(36)}`, jobId, origin, roomTabId: null, title: null, total: null, done: null, sends: [], onProgress: () => {},
    };
    jobs.set(job.id, job);
    keepAlive.acquire();
    try {
      return await run(job, msg);
    } catch (err) {
      return { ok: false, jobId, error: errorPayload(err) };
    } finally {
      // Let the last progress messages reach the frame before the final reply does.
      await settleWithin(job.sends, timing.progressFlushMs);
      jobs.delete(job.id);
      keepAlive.release();
    }
  }

  async function run(job, msg) {
    const url = scService.checkUrl(msg.source && msg.source.url);
    const room = await reachableTarget();
    job.roomTabId = room.tabId;
    notify(job, { phase: 'resolving' });

    const { skipPreviews, confirmAbove } = await settings.get();
    const result = await scService.expand(url, { skipPreviews });
    const items = Array.isArray(result.items) ? result.items : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const title = (result.source && result.source.title) || url;
    if (!items.length) throw new BgError('EMPTY', MESSAGES.EMPTY, { skipped, total: count(result.total) ?? skipped.length });
    if (msg.confirmed !== true && items.length > confirmAbove) {
      return { ok: true, jobId: job.jobId, needsConfirm: true, count: items.length, title, skippedCount: skipped.length };
    }

    job.title = title;
    job.total = items.length;
    notify(job, { phase: 'adding', done: 0, total: items.length, title });
    const reply = await addToRoom(job, room.tabId, items, title);
    return {
      ok: true,
      jobId: job.jobId,
      added: count(reply.added) ?? items.length,
      title,
      skipped,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      room: (await rooms.get(room.tabId)) || room,
    };
  }

  /**
   * The room to add to, after a room:ping that says it has joined. Stale entries for closed tabs are dropped on
   * the way. An explicit pin is used or reported as is. Otherwise the most recently active room is asked first even
   * when its entry says joined:false (the flag may be stale, and room:ping re-probes w2g), so adds don't quietly go
   * to another room; only if it hasn't joined does the registry's automatic choice get its turn.
   */
  async function reachableTarget() {
    const asked = new Set();
    let recentError = null; // why the most recently active room couldn't be used
    for (let pings = 0; pings < MAX_PINGS; pings++) {
      const { rooms: list, target, pinnedTabId } = await rooms.snapshot();
      if (!list.length) throw new BgError('NO_ROOM', MESSAGES.NO_ROOM);
      const recent = list[0];
      const askRecentFirst = pinnedTabId == null && (!target || target.tabId !== recent.tabId) && !asked.has(recent.tabId);
      const room = askRecentFirst ? recent : target;
      // Rooms are open, but none has joined (e.g. one waits at w2g's join dialog after a reload).
      if (!room) throw recentError || new BgError('NOT_JOINED', MESSAGES.NOT_JOINED);
      asked.add(room.tabId);
      const outcome = await reach(room);
      if (outcome.room) return outcome.room;
      if (outcome.stale) continue;
      if (!askRecentFirst) throw outcome.error;
      recentError = outcome.error;
    }
    throw new BgError('ROOM_UNREACHABLE', MESSAGES.ROOM_UNREACHABLE);
  }

  /** Pings a registered room: { room } if it has joined, { stale } if its entry was dropped, else { error }. */
  async function reach(room) {
    const pong = await ping(room.tabId);
    if (pong && pong.ok) {
      await rooms.refresh(room.tabId, pong);
      const fields = roomFields(pong);
      if (fields.joined) return { room: { ...room, ...fields } };
      if (fields.unreachable) return { error: new BgError('W2G_UNREACHABLE', MESSAGES.W2G_UNREACHABLE) };
      return { error: new BgError('NOT_JOINED', MESSAGES.NOT_JOINED) };
    }
    if (pong && pong.error) return { error: fromReply(pong.error, 'ROOM_UNREACHABLE') };
    if (await showsRoom(room.tabId)) return { error: new BgError('ROOM_UNREACHABLE', MESSAGES.ROOM_UNREACHABLE) };
    await rooms.remove(room.tabId);
    return { stale: true };
  }

  function ping(tabId) {
    const reply = attempt(() => chrome.tabs.sendMessage(tabId, { type: 'room:ping' }, { frameId: 0 }));
    return withTimeout(reply, timing.pingTimeoutMs, () => new BgError('ROOM_UNREACHABLE', 'room:ping timed out')).catch(() => undefined);
  }

  // False when the tab is gone or shows something else, i.e. the registry entry is stale. The extension can see the
  // URL of w2g.tv pages, so a tab without a url shows another site.
  async function showsRoom(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return isRoomUrl(tab.url) || isRoomUrl(tab.pendingUrl);
    } catch {
      return false;
    }
  }

  async function addToRoom(job, tabId, items, title) {
    let idleTimer;
    // Adding 1000 tracks takes minutes (w2g allows 50 per request, 3 s apart), and a job waiting behind others in the
    // room tab's queue reports 'queued' every 60 s, so only a long silence counts as a stall.
    const stalled = new Promise((resolve) => {
      job.onProgress = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => resolve({ stalled: true }), timing.addIdleTimeoutMs);
      };
    });
    job.onProgress();
    const request = attempt(() => chrome.tabs.sendMessage(tabId, { type: 'room:add', jobId: job.id, items, title }, { frameId: 0 }))
      .then((reply) => ({ reply }), () => ({ gone: true }));
    try {
      let outcome = await Promise.race([request, stalled]);
      if (outcome.stalled) outcome = await cancelStalledJob(job, tabId, request);
      if (outcome.error) throw outcome.error;
      if (outcome.gone) throw new BgError('ROOM_UNREACHABLE', MESSAGES.ROOM_GONE, { added: job.done });
      const { reply } = outcome;
      if (!reply) throw new BgError('ROOM_UNREACHABLE', MESSAGES.ROOM_UNREACHABLE, { added: job.done });
      if (!reply.ok) throw fromReply(reply.error, 'W2G_FAILED', job.done);
      return reply;
    } finally {
      clearTimeout(idleTimer);
      job.onProgress = () => {};
    }
  }

  /**
   * The room tab went silent: tell it to drop the job (room:cancel), so nothing is added after we report a failure.
   * The room tab settles the job before it answers either message, so whichever answer comes first decides: the
   * room:add reply as usual, or the cancel reply. A job that finished after all (cancelled:false with every track
   * added, e.g. after a hung check of the last batch) is a success; anything else is ROOM_STALLED with the count.
   */
  async function cancelStalledJob(job, tabId, request) {
    const cancel = quietly(() => chrome.tabs.sendMessage(tabId, { type: 'room:cancel', jobId: job.id }, { frameId: 0 }))
      .then((cancelReply) => ({ cancelReply }));
    const first = await withTimeout(Promise.race([request, cancel]), timing.cancelReplyMs, () => new Error('room:cancel timed out'))
      .catch(() => ({}));
    if ('reply' in first || first.gone) {
      const error = first.reply && !first.reply.ok ? first.reply.error : null;
      // Stopped by our own room:cancel: report the stall, not a cancel the user never asked for.
      if (error && error.code === 'CANCELLED') return { error: new BgError('ROOM_STALLED', MESSAGES.ROOM_STALLED, { added: maxCount(job.done, error.added) }) };
      return first;
    }
    const reply = first.cancelReply;
    const added = maxCount(job.done, reply && reply.added);
    if (reply && reply.ok && reply.cancelled === false && job.total && added >= job.total) return { reply: { ok: true, added } };
    return { error: new BgError('ROOM_STALLED', MESSAGES.ROOM_STALLED, { added }) };
  }

  /**
   * Handles job:progress from a room tab: any message is a sign of life for the stall timer. 'queued' (the job
   * waits behind another one in the room tab) and 'adding' are relayed to the frame that queued the job.
   */
  function progress(msg, sender) {
    const job = jobs.get(msg.jobId);
    if (job && job.roomTabId === sender.tab.id) {
      job.onProgress();
      const total = count(msg.total) ?? job.total;
      if (msg.phase === 'queued') {
        // Once the room tab reported 'adding', a late heartbeat must not turn the frame's toast back to waiting.
        if (job.done === null) notify(job, { phase: 'queued', total, title: job.title, position: count(msg.position) });
      } else {
        const done = Math.min(count(msg.done) ?? 0, total ?? Infinity);
        if (count(msg.done) !== null) job.done = Math.max(job.done ?? 0, done);
        notify(job, { phase: 'adding', done, total, title: job.title });
      }
    }
    return { ok: true };
  }

  function notify(job, payload) {
    const message = { type: 'job:progress', jobId: job.jobId, ...payload };
    const { origin } = job;
    job.sends.push(quietly(() => (origin
      ? chrome.tabs.sendMessage(origin.tabId, message, { frameId: origin.frameId })
      : chrome.runtime.sendMessage(message))));
  }

  function findJob(jobId, origin) {
    for (const job of jobs.values()) {
      const sameOrigin = job.origin === origin
        || (job.origin && origin && job.origin.tabId === origin.tabId && job.origin.frameId === origin.frameId);
      if (job.jobId === jobId && sameOrigin) return job;
    }
    return null;
  }

  return { queue, progress };
}
