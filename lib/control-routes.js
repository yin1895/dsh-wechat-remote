/**
 * Exact HTTP routes backing the Settings panel.
 *
 * The browser already passed the connection's browser-trust and cookie checks
 * before these handlers run, so each one speaks for the authenticated local
 * user. Every response is JSON; failures keep the same shape as successes so
 * the panel never has to parse a stack trace.
 */

import { readJsonBody, sendJson } from './http-util.js';
import { loginQrImage } from './qr-image.js';

/** Route prefix owned by this plugin. */
const PREFIX = '/wechat-remote';

/** Notification keys the panel may flip, matching the persisted flags. */
const NOTIFY_KEYS = ['turnEnd', 'error', 'approval', 'progress', 'stream'];

/**
 * Register the panel's control routes.
 *
 * @param {object} deps
 * @param {object} deps.ctx host context
 * @param {import('./state-store.js').StateStore} deps.store
 * @param {() => import('./runtime.js').Runtime} deps.runtime
 * @param {import('./pairing.js').PairingManager} deps.pairing
 * @param {import('./outbox.js').Outbox} deps.outbox
 * @param {import('./progress.js').ProgressTracker} deps.tracker
 * @returns {() => void} disposer removing every route
 */
export function registerControlRoutes({ ctx, store, runtime, pairing, outbox, tracker }) {
  const webServer = ctx.webServer;
  const disposers = [];

  /** Register one exact route. */
  const route = (name, handler) => {
    disposers.push(webServer.register({
      path: `${PREFIX}/${name}`,
      kind: 'exact',
      handler,
    }));
  };

  // Current status for the panel's periodic refresh.
  route('status', async (request, response) => {
    const state = await store.read();
    const live = runtime();
    let workspaceName = null;
    if (typeof state.currentWorkspaceId === 'string') {
      const workspace = ctx.workspaceRegistry.get(state.currentWorkspaceId);
      if (workspace !== undefined) {
        workspaceName = workspace.title ?? workspace.path ?? workspace.id;
      }
    }
    const outbound = outbox?.summary?.() ?? { heldUsers: 0, queued: 0 };
    const heldBodies = Object.values(state.pendingOut ?? {}).reduce(
      (total, entry) => total + (Array.isArray(entry?.lines) ? entry.lines.length : 0),
      0,
    );
    const currentSessionId = Object.values(state.currents ?? {})[0] ?? null;
    const watched = [...new Set(Object.values(state.watches ?? {}).flat())];
    const reachable = Object.keys(state.contextTokens ?? {}).length > 0;

    sendJson(response, 200, {
      ok: true,
      value: {
        paired: state.paired,
        accountId: state.accountId,
        connectionStatus: live.connectionStatus,
        currentWorkspaceId: state.currentWorkspaceId,
        currentWorkspaceName: workspaceName,
        currentSessionId,
        currentSessionName: currentSessionId === null ? null : await currentTitle(ctx, currentSessionId),
        watchedSessionCount: watched.length,
        runningSessionCount: tracker?.runningSessions?.().length ?? 0,
        attachedSessionCount: Object.keys(state.currents ?? {}).length,
        pendingQuestionCount: Object.keys(state.pendingQuestions).length,
        lastHeartbeat: live.lastHeartbeat,
        longPollingActive: live.running,
        needsRelogin: live.needsRelogin,
        lastError: live.lastError,
        pairedAt: state.pairedAt,
        /** Whether a push can land right now (needs a window a user's message opened). */
        pushReachable: reachable,
        pendingOutCount: heldBodies,
        heldChannelCount: outbound.heldUsers,
        notify: { ...state.notify },
      },
    });
  });

  // Restart the receive loop.
  route('reconnect', async (request, response) => {
    const state = await store.read();
    if (state.paired !== true) {
      sendJson(response, 200, { ok: false, error: { code: 'not-paired', message: '尚未配对' } });
      return;
    }
    try {
      await runtime().restart();
      sendJson(response, 200, { ok: true, value: { reconnected: runtime().running } });
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'reconnect-failed', message: messageOf(error) },
      });
    }
  });

  // Begin a QR login attempt.
  //
  // iLink answers with a lite-app *link* (`qrcode_img_content`), so the picture
  // the phone scans is rendered here and handed to the panel as a data URI.
  route('relogin', async (request, response) => {
    try {
      const state = await store.read();
      await runtime().stop();
      const code = await pairing.begin(state.botToken ?? undefined);
      const qr = loginQrImage(code);
      sendJson(response, 200, {
        ok: true,
        value: {
          qrcode: code.qrcode,
          qrcodeImgContent: code.qrcodeImgContent,
          qrcodeKind: qr.kind,
          qrcodeImage: qr.image,
          qrcodeLink: qr.link,
        },
      });
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'relogin-failed', message: messageOf(error) },
      });
    }
  });

  // Poll the live login attempt.
  route('qrcode-status', async (request, response) => {
    try {
      const outcome = await pairing.poll();
      if (outcome.paired === true) {
        await runtime().start();
      }
      sendJson(response, 200, { ok: true, value: outcome });
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'qrcode-status-failed', message: messageOf(error) },
      });
    }
  });

  // Accept the phone-displayed numeric code.
  route('verify-code', async (request, response) => {
    const body = await readJsonBody(request, 4_096);
    const outcome = pairing.submitVerifyCode(body?.code);
    if (outcome.submitted !== true) {
      sendJson(response, 200, {
        ok: false,
        error: { code: outcome.reason ?? 'verify-code-failed', message: '没有进行中的登录尝试，或配对码为空' },
      });
      return;
    }
    sendJson(response, 200, { ok: true, value: { submitted: true } });
  });

  // Abandon the live login attempt.
  route('cancel-relogin', async (request, response) => {
    pairing.cancel();
    sendJson(response, 200, { ok: true, value: { cancelled: true } });
  });

  // Forget the pairing.
  route('unbind', async (request, response) => {
    try {
      await runtime().stop();
      await store.clearPairing();
      sendJson(response, 200, { ok: true, value: { unbound: true } });
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'unbind-failed', message: messageOf(error) },
      });
    }
  });

  // Update one notification toggle.
  route('notify', async (request, response) => {
    const body = await readJsonBody(request, 4_096);
    const key = body?.key;
    const value = body?.value === true;
    if (!NOTIFY_KEYS.includes(key)) {
      sendJson(response, 400, {
        ok: false,
        error: { code: 'bad-key', message: `unknown key: ${String(key)}` },
      });
      return;
    }
    const state = await store.setNotify(key, value);
    sendJson(response, 200, { ok: true, value: { key, value: state.notify[key] === true } });
  });

  // Send one test message to every WeChat user this bridge knows about.
  //
  // This exists because the honest answer to "will a push reach me?" depends on
  // a delivery window that only a user's own message opens. One button turns
  // that from a guess into an observation.
  route('test-push', async (request, response) => {
    const state = await store.read();
    if (state.paired !== true) {
      sendJson(response, 200, { ok: false, error: { code: 'not-paired', message: '尚未配对' } });
      return;
    }
    const recipients = [...new Set([
      ...Object.keys(state.currents ?? {}),
      ...Object.keys(state.watches ?? {}),
      ...Object.keys(state.contextTokens ?? {}),
    ])];
    if (recipients.length === 0) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'no-recipient', message: '还没有微信联系人给这个机器人发过消息' },
      });
      return;
    }
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const live = runtime();
    for (const userId of recipients) {
      const body = live.hasChannel(userId) === true
        ? `🔔 测试消息（${stamp}）\n看到这条，说明推送通道是通的。`
        : `🔔 测试消息（${stamp}，排队中）\n你还没给机器人发过消息，所以这条会在你下次发一句时先补给你——那正是补发通道在起作用。`;
      outbox.enqueue(userId, body);
    }
    const missing = recipients.filter((userId) => live.hasChannel(userId) !== true);
    sendJson(response, 200, {
      ok: true,
      value: {
        recipients: recipients.length,
        waitingForWindow: missing.length,
      },
    });
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Resolve one session's display title for the panel, if a projection exists. */
async function currentTitle(ctx, sessionId) {
  try {
    const query = ctx.get('sessionQuery');
    if (query !== undefined) {
      const snapshot = await query.readTitle(sessionId, AbortSignal.timeout(3_000));
      if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) return snapshot.title;
    }
    const titles = ctx.get('sessionTitle');
    const live = ctx.sessions?.get?.(sessionId);
    if (live !== undefined && titles !== undefined) {
      const snapshot = titles.get(live);
      if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) return snapshot.title;
    }
  } catch {
    // A missing title only costs a shorter row.
  }
  return null;
}

/** Render one thrown value for the panel. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
