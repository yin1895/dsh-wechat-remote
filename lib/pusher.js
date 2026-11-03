/**
 * Progress pusher: the part that makes a phone useful while you are away.
 *
 * `progress.js` collects what every session is doing; this module decides what
 * a given WeChat user is told about, and how often:
 *
 *   - **Subscribed sessions** (`/watch`, plus whatever `/open` subscribed) always
 *     report.
 *   - **The one session that is actually working right now** also reports, even
 *     when the user never opened it from the phone. That is the whole point:
 *     starting a long job on the desktop and walking away must not require a
 *     command on the phone first.
 *   - **Silence is information.** A session that is running but has produced no
 *     event for a while gets one "still alive" line instead of looking dead.
 *
 * Digests are batched into a single body per user per tick, and every body goes
 * through the outbox, so a burst of twenty tool calls arrives as one readable
 * message rather than twenty notifications.
 */

import { SILENCE_MS, formatElapsed } from './progress.js';

/** Activity lines per digest body. */
const DIGEST_LINES = 6;

/** Subscribed sessions considered per user per tick. */
const MAX_TARGETS = 4;

/** Default tick interval: often enough to feel live, rare enough to stay quiet. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;

/**
 * Default floor between two digests to the same user.
 *
 * The tick decides how often the plugin *looks*; this decides how often a phone
 * is *spoken to*. A busy session produces a tool call every couple of seconds,
 * and four messages a minute is spam; nothing is lost by waiting, because a
 * session's cursor only advances when its lines are actually sent.
 */
export const DEFAULT_PROGRESS_GAP_MS = 45_000;

/**
 * Sends activity digests to the users who should see them.
 */
export class ProgressPusher {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx host context
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {import('./progress.js').ProgressTracker} deps.tracker
   * @param {import('./outbox.js').Outbox} deps.outbox
   * @param {() => object} deps.config current plugin config
   * @param {(sessionId: string) => Promise<string | undefined>} [deps.titleOf]
   * @param {() => number} [deps.now] clock override, for tests
   * @param {(message: string) => void} [deps.log]
   */
  constructor({ ctx, store, tracker, outbox, config, titleOf, now, log }) {
    this.ctx = ctx;
    this.store = store;
    this.tracker = tracker;
    this.outbox = outbox;
    this.config = config;
    this.titleOf = titleOf ?? (async () => undefined);
    this.now = now ?? (() => Date.now());
    this.log = log;
    /** @type {Map<string, number>} `${userId}|${sessionId}` → highest seq delivered */
    this.cursors = new Map();
    /** @type {Map<string, number>} `${userId}|${sessionId}` → silence alarm already sent for this run */
    this.silenced = new Map();
    /** @type {Map<string, number>} userId → when this user was last spoken to */
    this.lastPushAt = new Map();
    this.timer = null;
  }

  /** Start ticking. */
  start() {
    if (this.timer !== null) return;
    const interval = intervalOf(this.config);
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.log?.(`progress push failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, interval);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  /** Stop ticking. */
  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One delivery pass over every user who can receive anything.
   *
   * Public so the offline suite can drive it without waiting on timers.
   *
   * @returns {Promise<number>} digests queued
   */
  async tick() {
    const state = await this.store.read();
    if (state.paired !== true || state.notify.progress !== true) return 0;

    const userIds = new Set([
      ...Object.keys(state.currents),
      ...Object.keys(state.watches),
    ]);
    if (userIds.size === 0) return 0;

    const active = await this.#mostActiveSession();
    let sent = 0;
    for (const userId of userIds) {
      // Rate limit per user, not per session: lines that arrive during the gap
      // are still new next time, because a cursor advances only on a real send.
      const lastPush = this.lastPushAt.get(userId) ?? 0;
      if (this.now() - lastPush < gapOf(this.config)) continue;
      const queued = await this.#pushFor(userId, state, active);
      if (queued > 0) {
        this.lastPushAt.set(userId, this.now());
        sent += queued;
      }
    }
    return sent;
  }

  /** Compose and queue one user's digest for every target session. */
  async #pushFor(userId, state, active) {
    const targets = [];
    for (const sessionId of state.watches[userId] ?? []) {
      if (!targets.includes(sessionId)) targets.push(sessionId);
    }
    if (typeof active === 'string' && !targets.includes(active)) targets.push(active);

    let sent = 0;
    for (const sessionId of targets.slice(0, MAX_TARGETS)) {
      sent += await this.#pushSession(userId, sessionId);
    }
    return sent;
  }

  /** Push one session's fresh activity to one user. */
  async #pushSession(userId, sessionId) {
    const progress = this.tracker.peek(sessionId);
    if (progress === undefined) return 0;
    const key = `${userId}|${sessionId}`;
    const cursor = this.cursors.get(key) ?? 0;
    const fresh = this.tracker.since(sessionId, cursor);
    const now = this.now();
    const title = (await this.titleOf(sessionId)) ?? sessionId;
    let sent = 0;

    const interesting = fresh.lines.filter((line) => line.kind !== 'user');
    if (interesting.length > 0) {
      const shown = interesting.slice(-DIGEST_LINES);
      const hidden = interesting.length - shown.length;
      const head = progress.running
        ? `📡 ${title} · 运行 ${formatElapsed(now - (progress.startedAt || progress.lastEventAt || now))}`
        : `📡 ${title} · 已结束`;
      const body = shown.map((line) => line.text);
      if (hidden > 0) body.push(`…（另有 ${hidden} 个动作）`);
      this.outbox.enqueue(userId, [head, ...body].join('\n'), { tag: `progress:${sessionId}` });
      sent += 1;
      this.silenced.delete(key);
    }
    if (fresh.cursor > cursor) this.cursors.set(key, fresh.cursor);

    // Silence alarm: one line per quiet stretch, only while the session runs.
    if (progress.running) {
      const quietSince = Math.max(progress.lastEventAt, progress.startedAt, 0);
      const quietFor = now - quietSince;
      if (quietFor > SILENCE_MS && this.silenced.get(key) !== progress.startedAt) {
        this.silenced.set(key, progress.startedAt);
        this.outbox.enqueue(
          userId,
          `💤 ${title} 还在运行，已经 ${formatElapsed(quietFor)} 没有新动作（可能在跑长命令或长思考）。回 /tail 可看最新状态。`,
        );
        sent += 1;
      }
    } else {
      this.silenced.delete(key);
    }
    return sent;
  }

  /**
   * The session that is doing something right now, if any.
   *
   * Running sessions win; among them, whichever reported activity last. This is
   * what lets a desktop-started job reach a phone that never named it.
   *
   * @returns {Promise<string | undefined>}
   */
  async #mostActiveSession() {
    const running = this.tracker.runningSessions();
    if (running.length === 0) return undefined;
    let best = running[0];
    for (const candidate of running) {
      if ((candidate.lastEventAt ?? 0) > (best.lastEventAt ?? 0)) best = candidate;
    }
    return best?.sessionId;
  }
}

/** The configured tick interval, with a floor that keeps the phone quiet. */
function intervalOf(config) {
  const value = config?.()?.progressIntervalMs;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 5_000) return value;
  return DEFAULT_PROGRESS_INTERVAL_MS;
}

/** The configured per-user gap between digests. */
function gapOf(config) {
  const value = config?.()?.progressMinGapMs;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 10_000) return value;
  return DEFAULT_PROGRESS_GAP_MS;
}
