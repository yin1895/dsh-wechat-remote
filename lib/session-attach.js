/**
 * Session attach: one WeChat user names one *current* session, and that
 * session's assistant prose is mirrored live to their phone.
 *
 * Three invariants hold here and are asserted rather than assumed:
 *   1. At most one follow stream exists per user at a time.
 *   2. Output is only mirrored while the user still holds the binding; a
 *      detached or replaced binding stops its stream by abort.
 *   3. Nothing is sent to WeChat directly. Every body goes through the
 *      {@link Outbox}, which owns ordering, throttling, and the held-back
 *      backlog — a mirror that writes straight to the transport would overtake
 *      the reply to the command that opened it.
 *
 * The mirror is deliberately *only* prose. Tool-level progress is collected for
 * every session (bound or not) by `progress.js` and pushed by `pusher.js`, so a
 * user who never typed `/open` still sees what is happening.
 */

/** Characters of one turn's stream buffered before it is queued for delivery. */
const FLUSH_THRESHOLD = 600;

/** Minimum gap between two intermediate flushes of one turn. */
const FLUSH_INTERVAL_MS = 2_500;

/** Merge tag for live prose of one session, so a burst becomes one message. */
function streamTag(sessionId) {
  return `stream:${sessionId}`;
}

/**
 * Extract readable text from one assistant-stream frame.
 *
 * The wire frame is `{ type: 'chunk' | 'start' | 'end', chunk }`, where a
 * `chunk` is one model delta. Only text deltas carry prose; tool-call deltas,
 * block markers, usage, and finish chunks carry none — tool activity is the
 * progress tracker's business, not the mirror's.
 *
 * @param {object} frame the `frame` field of an `assistant-stream` entry
 * @returns {string | undefined}
 */
function assistantFrameText(frame) {
  if (frame === null || typeof frame !== 'object') return undefined;
  const chunk = frame.chunk;
  if (chunk === null || typeof chunk !== 'object') return undefined;
  if (chunk.type !== 'text-delta') return undefined;
  return typeof chunk.text === 'string' ? chunk.text : undefined;
}

/**
 * Extract readable text from one durable session event.
 *
 * An assistant message lives at `event.data.message.content`; every other event
 * type is either invisible by design (plans, injections) or already covered by
 * the progress tracker.
 *
 * @param {object} event
 * @returns {string | undefined}
 */
function sessionEventText(event) {
  if (event === null || typeof event !== 'object') return undefined;
  if (event.type !== 'assistant/message') return undefined;
  const message = event.data?.message;
  if (message === null || typeof message !== 'object') return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

/**
 * Owns every live binding between a WeChat user and a DSH session.
 */
export class SessionAttach {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx host context
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {import('./outbox.js').Outbox} deps.outbox outbound delivery queue
   * @param {() => object} deps.config current plugin config
   * @param {(message: string) => void} [deps.log] plugin logger
   */
  constructor({ ctx, store, outbox, config, log }) {
    this.ctx = ctx;
    this.store = store;
    this.outbox = outbox;
    this.config = config;
    this.log = log;
    /** @type {Map<string, { controller: AbortController, sessionId: string }>} */
    this.streams = new Map();
    /** Per-session turn buffers, keyed by session id. */
    this.buffers = new Map();
  }

  /** Whether one user currently mirrors a session. */
  isStreaming(userId) {
    return this.streams.has(userId);
  }

  /**
   * Inject one WeChat message into the current session.
   *
   * Uses `queue` delivery so the message waits behind the current turn instead
   * of interrupting it; a second WeChat message therefore cannot corrupt an
   * in-flight response. (`SessionPromptRequest.mode` admits exactly `queue` and
   * `steer`; anything else is rejected by the Remote schema before the Agent
   * sees it.)
   *
   * @param {object} options
   * @param {string} options.userId WeChat user
   * @param {string} options.text message body
   * @returns {Promise<{ sessionId: string } | { error: string }>}
   */
  async prompt({ userId, text }) {
    const state = await this.store.read();
    const sessionId = state.currents[userId];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { error: '还没有选中会话。用 /ls 看列表，或 /open <序号> 选中一个。' };
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { error: '消息为空' };
    }
    try {
      // `signal` is part of the Host-service contract, not an optional extra:
      // the implementation aborts admission through it.
      await this.ctx.sessionController.prompt(
        {
          sessionId,
          content: [{ type: 'text', text: trimmed }],
          mode: 'queue',
          requestId: `wx-${userId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        },
        AbortSignal.timeout(30_000),
      );
      return { sessionId };
    } catch (error) {
      return { error: friendlyPromptError(error) };
    }
  }

  /**
   * Make one session current for one user and start mirroring its prose.
   *
   * @param {object} options
   * @param {string} options.userId
   * @param {string} options.sessionId
   * @returns {Promise<{ ok: true } | { error: string }>}
   */
  async open({ userId, sessionId }) {
    try {
      const list = await this.ctx.sessionController.list({}, AbortSignal.timeout(10_000));
      const match = Array.isArray(list?.items)
        ? list.items.find((item) => item.sessionId === sessionId)
        : undefined;
      if (match === undefined) {
        return { error: `会话不存在: ${sessionId}` };
      }
      await this.close(userId);
      await this.store.setCurrent(userId, sessionId);
      this.#startStream({ userId, sessionId });
      return { ok: true, running: match.running === true };
    } catch (error) {
      return { error: `读取会话列表失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Release one user's current session and stop its stream.
   * @param {string} userId
   */
  async close(userId) {
    const stream = this.streams.get(userId);
    if (stream !== undefined) {
      stream.controller.abort();
      this.streams.delete(userId);
      this.buffers.delete(stream.sessionId);
    }
    await this.store.clearCurrent(userId);
  }

  /** Release every stream; called when the plugin unloads. */
  closeAll() {
    for (const [, stream] of this.streams) stream.controller.abort();
    this.streams.clear();
    this.buffers.clear();
  }

  /**
   * Start the follow stream for one binding.
   *
   * The stream is intentionally fire-and-forget: its lifetime is the binding's
   * lifetime, and its failures are reported to the user rather than thrown.
   */
  #startStream({ userId, sessionId }) {
    const controller = new AbortController();
    this.streams.set(userId, { controller, sessionId });

    void this.#consume({ userId, sessionId, signal: controller.signal })
      .catch((error) => {
        if (controller.signal.aborted) return;
        this.outbox.enqueue(userId, `⚠️ 会话流中断: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        const current = this.streams.get(userId);
        if (current?.controller === controller) this.streams.delete(userId);
        this.buffers.delete(sessionId);
      });
  }

  /** Drive one follow iterable to completion, queueing prose as it arrives. */
  async #consume({ userId, sessionId, signal }) {
    const iterable = this.ctx.sessionController.follow(
      {
        address: { kind: 'session', sessionId },
        assistantStream: true,
      },
      signal,
    );

    let lastFlush = 0;
    for await (const frame of iterable) {
      if (signal.aborted) return;
      if (await this.#streamMuted()) continue;

      if (frame?.type === 'assistant-stream') {
        const text = assistantFrameText(frame.frame);
        if (text === undefined) continue;
        const buffer = this.#bufferFor(sessionId);
        buffer.text += text;
        const now = Date.now();
        if (buffer.text.length >= FLUSH_THRESHOLD && now - lastFlush >= FLUSH_INTERVAL_MS) {
          const chunk = buffer.text.trim();
          buffer.text = '';
          lastFlush = now;
          if (chunk.length > 0) this.outbox.enqueue(userId, chunk, { tag: streamTag(sessionId) });
        }
        continue;
      }

      if (frame?.type === 'event') {
        const buffer = this.#bufferFor(sessionId);
        const text = sessionEventText(frame.event);
        if (text !== undefined) {
          // A durable assistant message supersedes whatever was buffered live.
          buffer.text = '';
          this.outbox.enqueue(userId, text);
          continue;
        }
        // A durable boundary means the current turn is finished.
        if (isTurnBoundary(frame.event) && buffer.text.trim().length > 0) {
          const chunk = buffer.text.trim();
          buffer.text = '';
          this.outbox.enqueue(userId, chunk);
        }
      }
    }
  }

  /**
   * Whether the user asked for live assistant text at all.
   *
   * Read through a short cache: this is called for every stream frame, and the
   * setting can only change from the panel or a `/notify` command, so a couple
   * of seconds of staleness costs nothing and saves a state read per delta.
   */
  async #streamMuted() {
    const now = Date.now();
    if (this.muteCache === undefined || now - this.muteCache.at > 2_000) {
      const state = await this.store.read();
      this.muteCache = { at: now, value: state.notify.stream !== true };
    }
    return this.muteCache.value;
  }

  /** The turn buffer for one session. */
  #bufferFor(sessionId) {
    let buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      buffer = { text: '' };
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }
}

/** Whether one durable event closes the current turn. */
function isTurnBoundary(event) {
  const type = event?.type ?? event?.kind;
  return type === 'turn/end' || type === 'turn-end';
}

/** Render a prompt failure without leaking a stack trace to the phone. */
function friendlyPromptError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not-found')) return '会话不存在或已被删除';
  if (message.includes('agent-busy')) return '会话正忙，请稍后再发';
  if (message.includes('attachment-invalid')) return '消息内容不被接受';
  return `发送失败: ${message}`;
}
