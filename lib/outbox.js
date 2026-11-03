/**
 * Outbound delivery queue: the one place that decides when the phone hears
 * something.
 *
 * Every message the plugin sends to WeChat goes through here — command replies,
 * assistant prose, progress digests, notifications — for three reasons:
 *
 *   1. **Ordering.** A progress digest must never overtake the reply to the
 *      command that produced it, and two flushes landing out of order reads as
 *      a broken bot.
 *   2. **Throttling.** WeChat friendship with a bot does not survive the bot
 *      sending a message every 200ms; the queue enforces one small gap per user
 *      and merges bursty progress text into one body.
 *   3. **Nothing is silently lost.** iLink attaches an outbound message to a
 *      conversation window opened by the user's own message, so a push can be
 *      refused when that window is not available (a restart, a long silence).
 *      A refused body is persisted and re-sent the moment the user next speaks,
 *      instead of disappearing.
 */

/** Minimum gap between two messages to the same user. */
const MIN_GAP_MS = 1_100;

/** Two queued segments with the same tag inside this window merge into one. */
const COALESCE_WINDOW_MS = 8_000;

/**
 * How long a tagged segment is held before its first send.
 *
 * A burst of tool calls arrives as several `enqueue` calls within a few
 * milliseconds; without a settle window the first line would leave on its own
 * and the merge would never happen. Untagged bodies (replies, notifications)
 * are never delayed.
 */
const TAG_SETTLE_MS = 400;

/** One merged body stops growing here, so a merge cannot exceed a chat bubble. */
const COALESCE_LIMIT = 1_500;

/** Queued segments kept per user before the oldest is dropped. */
const QUEUE_LIMIT = 12;

/** One flushed backlog is capped to this many characters. */
const BACKLOG_LIMIT = 1_800;

/** Abortable delay. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

/**
 * Per-user outbound queue with persistent backlog.
 */
export class Outbox {
  /**
   * @param {object} deps
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {(userId: string, text: string, token?: string) => Promise<boolean>} deps.send
   * @param {(message: string) => void} [deps.log]
   * @param {() => number} [deps.now] clock override, for tests
   */
  constructor({ store, send, log, now }) {
    this.store = store;
    this.send = send;
    this.log = log;
    this.now = now ?? (() => Date.now());
    /** @type {Map<string, { segments: object[], draining: boolean, blocked: boolean }>} */
    this.queues = new Map();
    /** @type {Map<string, number>} userId → last successful send time */
    this.lastSentAt = new Map();
    this.stopped = false;
  }

  /** The queue record for one user, created on first use. */
  #queueFor(userId) {
    let queue = this.queues.get(userId);
    if (queue === undefined) {
      queue = { segments: [], draining: false, blocked: false };
      this.queues.set(userId, queue);
    }
    return queue;
  }

  /**
   * Queue one message for delivery.
   *
   * @param {string} userId
   * @param {string} text message body
   * @param {object} [options]
   * @param {string} [options.tag] merge key; bodies sharing a tag merge in a burst
   * @returns {void}
   */
  enqueue(userId, text, options = {}) {
    if (this.stopped) return;
    if (typeof userId !== 'string' || userId.length === 0) return;
    if (typeof text !== 'string' || text.length === 0) return;
    const queue = this.#queueFor(userId);
    const now = this.now();
    const tag = typeof options.tag === 'string' ? options.tag : undefined;
    const last = queue.segments.at(-1);

    if (
      tag !== undefined
      && last !== undefined
      && last.tag === tag
      && now - last.at < COALESCE_WINDOW_MS
      && last.text.length + text.length + 1 <= COALESCE_LIMIT
    ) {
      last.text = `${last.text}\n${text}`;
      last.at = now;
      this.#kick(userId);
      return;
    }

    queue.segments.push({ text, tag, at: now, firstAt: now });
    while (queue.segments.length > QUEUE_LIMIT) {
      // The oldest progress segment is the least valuable thing in the queue;
      // a command reply or a notification is never dropped here.
      const index = queue.segments.findIndex((segment) => segment.tag !== undefined);
      queue.segments.splice(index >= 0 ? index : 0, 1);
    }
    this.#kick(userId);
  }

  /** Start draining one user's queue if it is not already draining. */
  #kick(userId) {
    const queue = this.#queueFor(userId);
    if (queue.draining) return;
    queue.draining = true;
    void this.#drain(userId)
      .catch((error) => {
        this.log?.(`outbox drain failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        queue.draining = false;
        if (queue.segments.length > 0 && this.stopped !== true) this.#kick(userId);
      });
  }

  /** Send queued segments in order, holding the per-user gap. */
  async #drain(userId) {
    const queue = this.#queueFor(userId);
    while (queue.segments.length > 0 && this.stopped !== true) {
      const segment = queue.segments[0];
      if (segment === undefined) return;

      // Let a burst of tagged lines settle into one body before it leaves.
      // The wait is tracked on the segment itself (not on the wall clock), so a
      // merged burst settles exactly once.
      if (segment.tag !== undefined && segment.settled !== true) {
        segment.settled = true;
        await delay(TAG_SETTLE_MS);
        continue;
      }

      const wait = MIN_GAP_MS - (this.now() - (this.lastSentAt.get(userId) ?? 0));
      if (wait > 0) await delay(wait);

      const ok = await this.send(userId, segment.text, undefined);
      queue.segments.shift();
      if (ok === true) {
        this.lastSentAt.set(userId, this.now());
        queue.blocked = false;
        continue;
      }
      // The channel is closed: persist this body plus everything behind it and
      // wait for the user's next message to reopen a window.
      const lost = [segment, ...queue.segments.splice(0)];
      for (const item of lost) await this.store.addPendingOut(userId, item.text);
      queue.blocked = true;
      this.log?.(`outbox: ${lost.length} message(s) held for ${userId} (no delivery window)`);
      return;
    }
  }

  /**
   * Deliver one user's held messages and resume normal delivery.
   *
   * Called when a fresh `context_token` arrives, which is exactly the moment a
   * window exists again.
   *
   * @param {string} userId
   * @returns {Promise<number>} how many held bodies were re-queued
   */
  async flushPending(userId) {
    const entry = await this.store.takePendingOut(userId);
    if (entry === null) return 0;
    const count = entry.lines.length;
    let body = entry.lines.join('\n\n');
    if (body.length > BACKLOG_LIMIT) body = `${body.slice(0, BACKLOG_LIMIT)}…`;
    const dropped = entry.dropped > 0 ? `（更早的 ${entry.dropped} 条已舍弃）` : '';
    this.#queueFor(userId).blocked = false;
    this.enqueue(userId, `📬 补发 ${count} 条未送达消息${dropped}\n\n${body}`);
    return count;
  }

  /**
   * How one user's push channel currently behaves.
   *
   * @param {string} userId
   * @returns {'ready' | 'held'}
   */
  channelState(userId) {
    return this.#queueFor(userId).blocked ? 'held' : 'ready';
  }

  /** Counters for `/status` and the panel. */
  summary() {
    let heldUsers = 0;
    let queued = 0;
    for (const queue of this.queues.values()) {
      if (queue.blocked) heldUsers += 1;
      queued += queue.segments.length;
    }
    return { heldUsers, queued };
  }

  /** Hold everything and stop delivering. */
  stop() {
    this.stopped = true;
    for (const [userId, queue] of this.queues) {
      if (queue.segments.length > 0) {
        const lost = queue.segments.splice(0);
        for (const item of lost) void this.store.addPendingOut(userId, item.text);
      }
    }
  }
}
