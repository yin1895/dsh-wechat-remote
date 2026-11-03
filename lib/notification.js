/**
 * Proactive notifications: the reason a phone is useful while away from the
 * desk. Four classes are observed, mirroring the persisted `notify` toggles:
 *
 *   - turn end  → an agent finished a turn
 *   - error     → a step or turn failed
 *   - approval  → the agent is blocked waiting for a human decision
 *   - progress  → the running digest (produced by `pusher.js`, not here)
 *
 * Delivery goes through the {@link Outbox} rather than straight to the
 * transport, so a notification cannot overtake a command reply and a refused
 * push is held instead of lost.
 *
 * A session's notifications reach every user who either drives it (their
 * *current* session) or subscribed to it (`/watch`), so a notification never
 * lands in an unrelated conversation.
 *
 * All listeners are registered on the plugin's own context and are therefore
 * removed on unload.
 */

/** Do not repeat the same notification for one session within this window. */
const DEDUPE_WINDOW_MS = 3_000;

/**
 * Listens to host events and pushes WeChat notifications.
 */
export class Notifier {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {import('./outbox.js').Outbox} deps.outbox
   * @param {() => object} deps.config
   * @param {(sessionId: string) => Promise<{ title?: string, lastText?: string } | undefined>} [deps.summarize]
   * @param {(message: string) => void} [deps.log] plugin logger
   */
  constructor({ ctx, store, outbox, config, summarize, log }) {
    this.ctx = ctx;
    this.store = store;
    this.outbox = outbox;
    this.config = config;
    this.summarize = summarize;
    this.log = log;
    this.disposers = [];
    this.lastPush = new Map();
    this.runningSince = new Map();
  }

  /** Register every listener; safe to call once. */
  start() {
    if (this.disposers.length > 0) return;

    this.disposers.push(
      this.ctx.on('agent/error', (payload) => {
        const sessionId = sessionIdOf(payload);
        if (sessionId === undefined) return;
        const message = payload.error instanceof Error
          ? payload.error.message
          : String(payload.error);
        this.#notify('error', sessionId, `❌ 会话出错: ${truncate(message, 500)}`);
      }),
    );

    this.disposers.push(
      this.ctx.on('agent/status', (payload) => {
        const sessionId = sessionIdOf(payload);
        if (sessionId === undefined) return;
        if (payload.status === 'running') {
          this.runningSince.set(sessionId, Date.now());
          return;
        }
        if (payload.status !== 'idle') return;
        const startedAt = this.runningSince.get(sessionId);
        this.runningSince.delete(sessionId);
        if (startedAt === undefined) return;
        // A turn shorter than this is almost certainly not worth a push.
        if (Date.now() - startedAt < 2_000) return;
        void this.#notifyTurnEnd(sessionId);
      }),
    );

    this.disposers.push(
      this.ctx.on('approval/request', (request, next) => {
        const sessionId = sessionIdOf(request);
        if (sessionId !== undefined) {
          void this.#notify('approval', sessionId, this.#approvalText(request));
        }
        // Never answer on the user's behalf; the desktop or phone must decide.
        return next();
      }),
    );

    this.disposers.push(
      this.ctx.on('user-questions/request', (request, next) => {
        const sessionId = sessionIdOf(request);
        if (sessionId !== undefined) {
          void this.#notify('approval', sessionId, this.#questionText(request));
        }
        return next();
      }),
    );
  }

  /** Remove every listener. */
  stop() {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.lastPush.clear();
    this.runningSince.clear();
  }

  /**
   * Send one notification if its class is enabled and somebody asked for it.
   *
   * This is a fire-and-forget path: several callers sit in host event listeners
   * that cannot await, and a rejection escaping here would reach the host's
   * process-wide `unhandledRejection` handler, which treats it as a fatal load
   * failure. The failure is therefore contained and reported to the plugin log.
   */
  #notify(kind, sessionId, text) {
    void this.#push(kind, sessionId, text).catch((error) => {
      this.log?.(
        `notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Queue one notification for every user subscribed to the session. */
  async #push(kind, sessionId, text, options = {}) {
    const state = await this.store.read();
    if (state.notify[kind] !== true) return;

    const key = `${kind}:${sessionId}`;
    const last = this.lastPush.get(key) ?? 0;
    if (Date.now() - last < DEDUPE_WINDOW_MS) return;

    const recipients = recipientsOf(state, sessionId);
    if (recipients.length === 0) return;
    this.lastPush.set(key, Date.now());

    for (const userId of recipients) {
      this.outbox.enqueue(userId, text);
      // A proactive send can be accepted and still not be seen, so a completion
      // is recorded as unacknowledged until this user speaks again.
      if (options.unconfirmed === true) {
        void this.store.setUnconfirmed(userId, {
          sessionId,
          title: options.title ?? sessionId,
          text,
        }).catch((error) => {
          this.log?.(`unconfirmed record failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  /**
   * Announce a finished turn with the session's name and its last words.
   *
   * "✅ 任务已完成。" told a user standing in a queue nothing they could act on;
   * naming the session and including the closing message is the difference
   * between a ping and an answer.
   */
  async #notifyTurnEnd(sessionId) {
    let summary;
    try {
      summary = await this.summarize?.(sessionId);
    } catch {
      // A missing summary degrades the text, never the notification.
    }
    const title = summary?.title ?? shortId(sessionId);
    const last = typeof summary?.lastText === 'string' ? summary.lastText.trim() : '';
    const body = [`✅ ${title} 完成了这一轮`];
    if (last.length > 0) body.push('', truncate(last, 700));
    body.push('', '回 /t 可看细节。');
    await this.#push('turnEnd', sessionId, body.join('\n'), { unconfirmed: true, title });
  }

  /**
   * Compose an approval notification body.
   *
   * `ApprovalRequestEvent` carries `toolName`, `reason`, and an optional
   * localized `displayReason`; there is no `title`/`description`/`kind`, so
   * those older probes remain only as a last-resort fallback.
   */
  #approvalText(request) {
    const display = request?.displayReason;
    const localized = display !== null && typeof display === 'object'
      ? (display.zh ?? display.en ?? Object.values(display)[0])
      : undefined;
    const title = firstText(localized, request?.reason, request?.toolName)
      ?? firstText(request?.title, request?.description)
      ?? '操作';
    return [
      '📋 需要你确认',
      truncate(String(title), 400),
      '',
      '请在电脑端处理，或回复「批准」/「拒绝」。',
    ].join('\n');
  }

  /** Compose a question notification body. */
  #questionText(request) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    const first = questions[0];
    const text = first?.question ?? first?.header ?? '需要你回答一个问题';
    const options = Array.isArray(first?.options)
      ? first.options.map((option, index) => `${index + 1}. ${option.label ?? option}`).join('\n')
      : '';
    return ['❓ 需要你回答', truncate(String(text), 400), options, '', '请直接在微信回复。']
      .filter((line) => line.length > 0)
      .join('\n');
  }
}

/**
 * Every user who should hear about one session.
 *
 * The current session counts as subscribed: `/open` is how a user says "this is
 * the conversation I am in", and being told when it finishes is the obvious
 * half of that.
 *
 * @param {object} state persisted state
 * @param {string} sessionId
 * @returns {string[]}
 */
export function recipientsOf(state, sessionId) {
  const users = new Set();
  for (const [userId, current] of Object.entries(state.currents ?? {})) {
    if (current === sessionId) users.add(userId);
  }
  for (const [userId, list] of Object.entries(state.watches ?? {})) {
    if (Array.isArray(list) && list.includes(sessionId)) users.add(userId);
  }
  return [...users];
}

/** Read a session id out of one host event payload. */
function sessionIdOf(payload) {
  const candidate = payload?.agent?.session?.id
    ?? payload?.agent?.sessionId
    ?? payload?.agent?.id
    ?? payload?.sessionId
    ?? payload?.session?.id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/** Truncate one string at a character budget, keeping the head. */
function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Shorten one session id for a notification header. */
function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…` : String(id);
}

/** The first non-empty string among the candidates, trimmed; otherwise undefined. */
function firstText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}
