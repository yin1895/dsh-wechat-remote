/**
 * Pairing: QR login, status polling, and the token handoff into the store.
 *
 * The device-side flow is a small state machine driven by the caller:
 *
 *   idle --begin()--> awaiting_scan --(confirmed)--> paired
 *                                  --(need_verifycode)--> awaiting_code
 *                                  --(expired)--> idle
 *
 * Only one pairing attempt may be live at a time. The attempt owns its own
 * AbortController so the panel can cancel it, and it clears itself on any
 * terminal transition.
 */

import { IlinkError } from './ilink-client.js';

/** How long one QR code remains pollable before the panel must re-request. */
const QRCODE_LIFETIME_MS = 8 * 60 * 1000;

/** Polling cadence while waiting for the user to scan. */
const POLL_INTERVAL_MS = 2_000;

/** Terminal statuses that end an attempt without a token. */
const TERMINAL_FAILURES = new Set(['expired', 'cancel', 'cancelled', 'refused', 'failed']);

/**
 * Owns at most one in-flight pairing attempt.
 */
export class PairingManager {
  /**
   * @param {object} deps
   * @param {import('./ilink-client.js').IlinkClient} deps.client
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {() => string} [deps.onPaired] callback invoked after a token is stored
   */
  constructor({ client, store }) {
    this.client = client;
    this.store = store;
    this.attempt = null;
  }

  /** Whether an attempt is currently live. */
  get inProgress() {
    return this.attempt !== null;
  }

  /**
   * Start a pairing attempt and return the QR code to render.
   *
   * `qrcodeImgContent` is the lite-app link the phone opens, so callers that
   * display it must encode it (`lib/qr-image.js`) rather than treat it as image
   * bytes.
   *
   * @param {string} [localToken] previously held token, to allow silent reuse
   * @returns {Promise<{ qrcode: string, qrcodeImgContent: string }>}
   */
  async begin(localToken) {
    if (this.attempt !== null) {
      this.cancel();
    }
    const tokens = typeof localToken === 'string' && localToken.length > 0 ? [localToken] : [];
    const { qrcode, qrcodeImgContent } = await this.client.getBotQrcode(tokens);

    const controller = new AbortController();
    const startedAt = Date.now();
    const attempt = {
      qrcode,
      qrcodeImgContent,
      status: 'wait',
      controller,
      startedAt,
      expiresAt: startedAt + QRCODE_LIFETIME_MS,
      verifyCodeSubmitted: false,
      settled: false,
      result: null,
    };
    this.attempt = attempt;
    return { qrcode, qrcodeImgContent };
  }

  /**
   * Poll the live attempt once.
   *
   * @returns {Promise<{ status: string, expired?: boolean, paired?: boolean, error?: string }>}
   */
  async poll() {
    const attempt = this.attempt;
    if (attempt === null) return { status: 'idle' };
    if (Date.now() > attempt.expiresAt) {
      this.#settle(attempt, { status: 'expired', expired: true });
      return { status: 'expired', expired: true };
    }

    let state;
    const verifyCode = attempt.verifyCode;
    try {
      state = await this.client.getQrcodeStatus(
        attempt.qrcode,
        attempt.controller.signal,
        verifyCode,
      );
      // Deliver a typed pairing code exactly once; a rejected code makes the
      // next status `need_verifycode` again, and the panel prompts again.
      if (typeof verifyCode === 'string') attempt.verifyCode = undefined;
    } catch (error) {
      if (error instanceof IlinkError && error.code === -14) {
        this.#settle(attempt, { status: 'expired', expired: true });
        return { status: 'expired', expired: true };
      }
      if (attempt.controller.signal.aborted) {
        return { status: 'idle' };
      }
      return {
        status: attempt.status,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (attempt.controller.signal.aborted) {
      return { status: 'idle' };
    }

    attempt.status = state.status;

    if (state.status === 'confirmed') {
      const botToken = state.botToken ?? state.token ?? state.bot_token;
      if (typeof botToken === 'string' && botToken.length > 0) {
        await this.store.markPaired({
          botToken,
          baseUrl: state.baseUrl,
          accountId: state.accountId,
        });
        this.client.adopt({ botToken, baseUrl: state.baseUrl });
        this.#settle(attempt, { status: 'confirmed', paired: true });
        return { status: 'confirmed', paired: true };
      }
      this.#settle(attempt, { status: 'failed', error: 'confirmed without a bot token' });
      return { status: 'failed', error: 'confirmed without a bot token' };
    }

    if (state.status === 'scaned_but_redirect' && state.baseUrl) {
      this.client.adopt({ botToken: this.client.botToken, baseUrl: state.baseUrl });
      return { status: 'scaned_but_redirect' };
    }

    if (TERMINAL_FAILURES.has(state.status)) {
      this.#settle(attempt, { status: state.status, expired: state.status === 'expired' });
      return { status: state.status, expired: state.status === 'expired' };
    }

    return { status: state.status };
  }

  /**
   * Poll until the attempt settles or the caller aborts.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ status: string, paired?: boolean }>}
   */
  async wait(signal) {
    if (this.attempt === null) return { status: 'idle' };
    while (this.attempt !== null) {
      if (signal?.aborted === true) return { status: 'cancelled' };
      const outcome = await this.poll();
      if (this.attempt === null || outcome.paired === true || outcome.expired === true) {
        return outcome;
      }
      if (outcome.status === 'failed') return outcome;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    return { status: 'idle' };
  }

  /**
   * Record the numeric pairing code the user typed.
   *
   * The iLink protocol carries the code on the next status poll rather than in
   * a separate endpoint, so this stores it for {@link poll} to deliver once.
   *
   * @param {unknown} code value typed in the panel
   * @returns {{ submitted: boolean, reason?: string }}
   */
  submitVerifyCode(code) {
    const attempt = this.attempt;
    if (attempt === null) return { submitted: false, reason: 'not-pairing' };
    const value = typeof code === 'string' ? code.trim() : '';
    if (value.length === 0) return { submitted: false, reason: 'empty-code' };
    attempt.verifyCode = value;
    return { submitted: true };
  }

  /** Abandon the live attempt without a token. */
  cancel() {
    const attempt = this.attempt;
    if (attempt === null) return;
    this.#settle(attempt, { status: 'cancelled' });
  }

  /** Retire an attempt exactly once. */
  #settle(attempt, result) {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.result = result;
    attempt.controller.abort();
    if (this.attempt === attempt) this.attempt = null;
  }
}
