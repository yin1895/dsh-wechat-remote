/**
 * The long-poll runtime: one loop that receives WeChat messages and hands each
 * to the command router, plus the outbound send path every other module uses.
 *
 * Lifecycle:
 *   start() → getupdates loop → dispatch → sendmessage
 *                 ↑                    │
 *                 └──── cursor ────────┘
 *
 * A token-expiry rejection ends the loop and flips `needsRelogin`, which the
 * Settings panel surfaces as "重新登录". Everything else is retried with
 * exponential backoff, because a phone that silently stops receiving is the
 * worst failure mode for this plugin.
 */

import { IlinkError, messageText } from './ilink-client.js';

/** Backoff schedule for transport failures, in milliseconds. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Floor between two poll starts, so an instant empty response cannot spin. */
const MIN_POLL_INTERVAL_MS = 1_000;

/** Context tokens are required for replies; keep the last seen one per user. */
const TOKEN_CACHE_LIMIT = 64;

/**
 * How long an unacknowledged completion push waits before the next inbound
 * message is allowed to repeat it.
 *
 * Shorter than this and a user who simply replies right away would be told what
 * they just read.
 */
const RECAP_MIN_AGE_MS = 60_000;

/**
 * Owns the inbound loop and the outbound send path.
 */
export class Runtime {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./ilink-client.js').IlinkClient} deps.client
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {import('./command-router.js').CommandRouter} deps.router
   * @param {import('./session-attach.js').SessionAttach} deps.attach
   * @param {import('./notification.js').Notifier} deps.notifier
   * @param {import('./outbox.js').Outbox} deps.outbox
   * @param {() => object} deps.config
   */
  constructor({ ctx, client, store, router, attach, notifier, outbox, config }) {
    this.ctx = ctx;
    this.client = client;
    this.store = store;
    this.router = router;
    this.attach = attach;
    this.notifier = notifier;
    this.outbox = outbox;
    this.config = config;

    this.controller = null;
    this.loopPromise = null;
    this.connectionStatus = 'disconnected';
    this.lastHeartbeat = 0;
    this.needsRelogin = false;
    this.lastError = null;
    /** @type {Map<string, string>} userId → most recent context_token */
    this.contextTokens = new Map();
    /** Users already told that media is unsupported, to avoid repeating. */
    this.mediaNotified = new Set();
  }

  /** Whether the long-poll loop is currently receiving. */
  get running() {
    return this.controller !== null && !this.controller.signal.aborted;
  }

  /**
   * Adopt the stored token and begin receiving. No-op when unpaired.
   * @returns {Promise<boolean>} whether the loop started
   */
  async start() {
    if (this.running) return true;
    const state = await this.store.read();
    if (state.paired !== true || typeof state.botToken !== 'string') {
      this.connectionStatus = 'disconnected';
      return false;
    }

    this.client.adopt({ botToken: state.botToken, baseUrl: state.baseUrl ?? undefined });
    this.needsRelogin = false;
    this.lastError = null;
    this.connectionStatus = 'reconnecting';

    // A restart must not cost the ability to push. The last window token each
    // user opened is persisted, and it is adopted here so an unsolicited
    // progress digest can still land before they say anything.
    for (const [userId, token] of Object.entries(state.contextTokens ?? {})) {
      if (typeof token === 'string' && token.length > 0) this.contextTokens.set(userId, token);
    }

    const controller = new AbortController();
    this.controller = controller;
    this.notifier.start();

    try {
      await this.client.notifyStart(AbortSignal.timeout(10_000));
    } catch {
      // notifystart is advisory; receiving works without it.
    }

    this.loopPromise = this.#loop(controller.signal)
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.connectionStatus = 'disconnected';
        // A loop that ended on its own (token expiry, fatal stop) must not leave
        // a controller behind, or `running` would keep reporting true.
        if (this.controller === controller) this.controller = null;
      });

    return true;
  }

  /**
   * Stop receiving without discarding the pairing.
   * @returns {Promise<void>}
   */
  async stop() {
    const controller = this.controller;
    const loop = this.loopPromise;
    this.controller = null;
    this.loopPromise = null;
    controller?.abort();
    this.notifier.stop();
    this.attach.closeAll();
    this.connectionStatus = 'disconnected';
    if (this.client.paired) {
      try {
        await this.client.notifyStop();
      } catch {
        // Best effort only.
      }
    }
    await loop?.catch(() => undefined);
  }

  /**
   * Restart the loop after a configuration or pairing change.
   * @returns {Promise<void>}
   */
  async restart() {
    await this.stop();
    await this.start();
  }

  /** The single inbound loop. */
  async #loop(signal) {
    let attempt = 0;

    while (!signal.aborted) {
      const state = await this.store.read();
      const cursor = state.cursor;
      const pollStartedAt = Date.now();

      try {
        const { messages, cursor: nextCursor } = await this.client.getUpdates({
          cursor,
          signal,
        });

        attempt = 0;
        this.connectionStatus = 'online';
        this.lastHeartbeat = Date.now();

        if (nextCursor !== cursor) {
          await this.store.setCursor(nextCursor);
        }

        for (const message of messages) {
          if (signal.aborted) return;
          await this.#dispatchMessage(message);
        }

        // The protocol lets the server answer immediately. Without a floor, an
        // instant empty response would spin this loop thousands of times per
        // second and trip server-side rate limiting.
        const elapsed = Date.now() - pollStartedAt;
        if (elapsed < MIN_POLL_INTERVAL_MS) {
          await delay(MIN_POLL_INTERVAL_MS - elapsed, signal);
        }
      } catch (error) {
        if (signal.aborted) return;

        if (error instanceof IlinkError && error.isTokenInvalid) {
          this.needsRelogin = true;
          this.lastError = '微信登录已失效，请在设置中重新登录';
          this.connectionStatus = 'disconnected';
          this.client.forget();
          return;
        }

        this.lastError = error instanceof Error ? error.message : String(error);
        this.connectionStatus = 'reconnecting';
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        await delay(wait, signal);
      }
    }
  }

  /** Route one inbound message. */
  async #dispatchMessage(message) {
    if (message === null || typeof message !== 'object') return;
    // 1 = inbound user message; bot echoes and system frames are ignored.
    if (message.message_type !== 1) return;

    const userId = message.from_user_id;
    if (typeof userId !== 'string' || userId.length === 0) return;

    const contextToken = typeof message.context_token === 'string' ? message.context_token : '';
    if (contextToken.length > 0) {
      this.#rememberToken(userId, contextToken);
    }

    const text = messageText(message);
    if (text === undefined) {
      await this.#rejectMedia(userId, contextToken);
      return;
    }

    const parts = await this.router.handle({ userId, text, contextToken });
    for (const part of parts) {
      await this.send(userId, part, contextToken);
    }

    // A completion push that this user never acknowledged is re-surfaced here.
    // The channel cannot confirm that a proactive send was actually shown, and a
    // finished job the user never hears about is the one failure this bridge
    // exists to prevent.
    await this.#recapUnconfirmed(userId, text, contextToken).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });

    // The user just opened a delivery window. Anything that could not be pushed
    // while they were away goes out now, behind the direct reply so it reads in
    // the order it happened.
    try {
      const flushed = await this.outbox.flushPending(userId);
      if (flushed > 0) {
        this.ctx?.logger?.info?.(`[wechat-remote] delivered ${flushed} held message(s) to ${userId}`);
      }
    } catch (error) {
      // A backlog that cannot be delivered now stays persisted for next time.
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Re-send the last completion push once, if nobody acknowledged it.
   *
   * Deliberately narrow: only a completion (never progress chatter), only after
   * it has had a minute to be seen, never twice, and never on top of the two
   * commands that ask about progress anyway.
   *
   * @param {string} userId
   * @param {string} text the inbound message
   * @param {string} contextToken
   */
  async #recapUnconfirmed(userId, text, contextToken) {
    const state = await this.store.read();
    const entry = state.unconfirmed[userId];
    if (entry === undefined) return;
    if (/\/(?:t|tail|status)\b/u.test(text)) {
      await this.store.clearUnconfirmed(userId);
      return;
    }
    if (Date.now() - entry.at < RECAP_MIN_AGE_MS) return;
    await this.store.clearUnconfirmed(userId);
    await this.send(
      userId,
      `ℹ️ 补一条可能没显示给你的通知：\n\n${entry.text}`,
      contextToken,
    );
  }

  /** Tell a sender that non-text input is not supported. */
  async #rejectMedia(userId, contextToken) {
    if (this.mediaNotified.has(userId)) return;
    this.mediaNotified.add(userId);
    await this.send(userId, '暂不支持图片/语音/文件，请发送文字。', contextToken);
  }

  /** Keep the newest context token for one sender, in memory and on disk. */
  #rememberToken(userId, token) {
    this.contextTokens.delete(userId);
    this.contextTokens.set(userId, token);
    while (this.contextTokens.size > TOKEN_CACHE_LIMIT) {
      const oldest = this.contextTokens.keys().next().value;
      if (oldest === undefined) break;
      this.contextTokens.delete(oldest);
    }
    void this.store.saveContextToken(userId, token).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  /**
   * Whether one user currently has a delivery window.
   *
   * `false` means a push right now would be refused and held instead, which is
   * the honest answer `/status` and the panel need.
   *
   * @param {string} userId
   * @returns {boolean}
   */
  hasChannel(userId) {
    const token = this.contextTokens.get(userId);
    return typeof token === 'string' && token.length > 0;
  }

  /**
   * Send one text reply.
   *
   * @param {string} userId
   * @param {string} text
   * @param {string} [contextToken] falls back to the last token seen from this user
   * @returns {Promise<boolean>} whether the send succeeded
   */
  async send(userId, text, contextToken) {
    const token = typeof contextToken === 'string' && contextToken.length > 0
      ? contextToken
      : (this.contextTokens.get(userId) ?? '');
    if (token.length === 0) {
      // Without a context token the message cannot be attached to a window.
      return false;
    }
    try {
      await this.client.sendText({ toUserId: userId, contextToken: token, text });
      return true;
    } catch (error) {
      if (error instanceof IlinkError && error.isTokenInvalid) {
        this.needsRelogin = true;
        this.client.forget();
      }
      return false;
    }
  }

  /**
   * Report typing state, swallowing failures.
   * @param {string} userId
   * @param {boolean} active
   */
  async typing(userId, active) {
    const token = this.contextTokens.get(userId);
    if (token === undefined) return;
    try {
      await this.client.sendTyping({ status: active ? 1 : 2 });
    } catch {
      // Typing is cosmetic.
    }
  }
}

/** Abortable delay. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
