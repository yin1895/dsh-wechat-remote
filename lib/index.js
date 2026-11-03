/**
 * WeChat remote-control plugin — Host half.
 *
 * Wires the iLink client, durable state, command router, session mirroring,
 * progress tracking and pushing, notifications, and the Settings panel's HTTP
 * control surface.
 *
 * Data flow, in one picture:
 *
 *   WeChat ──getupdates──▶ Runtime ──▶ CommandRouter ──▶ SessionAttach(prompt)
 *                            │                              │
 *                            │                        follow() prose
 *                            ▼                              ▼
 *                          Outbox ◀── ProgressPusher ◀── ProgressTracker
 *                            │             (session/event, every session)
 *                            ▼
 *                    sendmessage ──▶ WeChat phone
 *
 * Everything outbound funnels through the {@link Outbox}, so ordering,
 * throttling, and the held-back backlog have exactly one owner.
 *
 * The Settings panel talks to this plugin over `ctx.webServer` exact routes
 * rather than a generated Typert Remote contribution: generated Remote
 * descriptors are build products of the Harness compiler, and a plain-JS
 * bundle cannot add itself to the compiled assembly. Exact routes carry the
 * same authority, because the carrier already authenticated the browser.
 *
 * No third-party import appears in this file on purpose. A bundle installed
 * from a directory is loaded through its real path, so a bare specifier such
 * as `@deepseek-ai/schemastery` resolves against that directory and its
 * ancestors — not against the profile's `node_modules`. Keeping the host half
 * import-free is what makes this plugin installable from any path; defaults
 * therefore live in `DEFAULTS` and are normalized by `resolveConfig` instead of
 * being declared through a schema object.
 */

import { IlinkClient, DEFAULT_BASE_URL } from './ilink-client.js';
import { StateStore } from './state-store.js';
import { PairingManager } from './pairing.js';
import { CommandRouter } from './command-router.js';
import { SessionAttach } from './session-attach.js';
import { ProgressTracker } from './progress.js';
import { ProgressPusher, DEFAULT_PROGRESS_INTERVAL_MS, DEFAULT_PROGRESS_GAP_MS } from './pusher.js';
import { Outbox } from './outbox.js';
import { Notifier } from './notification.js';
import { Runtime } from './runtime.js';
import { registerControlRoutes } from './control-routes.js';

export const name = 'wechat-remote';

/**
 * Hard dependencies, as Cordis declares them: an array of service names, or a
 * name → intercept-config map. `{ required, optional }` is NOT a grouping this
 * Cordis understands — it would be read as two services literally named
 * "required" and "optional", and the plugin would sit pending forever waiting
 * for them. Optional services are therefore left out and reached through
 * `ctx.inject([...], child => …)`, which simply never runs when absent.
 *
 * `storage` is NOT listed. The hub's data forms are per-profile and this plugin
 * keeps its own file under the Harness home instead (see `state-store.js`);
 * requiring a form that a profile does not mount is what previously turned a
 * missing dependency into a fatal host exit.
 */
export const inject = ['sessionController', 'workspaceRegistry', 'workspaceController'];

/** Every config field's fallback, used when the loader passes nothing. */
export const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  channelVersion: '2.4.6',
  requestTimeoutMs: 20_000,
  progressIntervalMs: DEFAULT_PROGRESS_INTERVAL_MS,
  progressMinGapMs: DEFAULT_PROGRESS_GAP_MS,
  notifyOnTurnEnd: true,
  notifyOnError: true,
  notifyOnApproval: true,
  notifyOnProgress: true,
  notifyOnStream: true,
};

/**
 * Normalize the loader-supplied config into a complete settings object.
 *
 * A malformed value falls back to its default rather than propagating: the
 * phone bridge should still come up when one knob is wrong.
 *
 * @param {unknown} config raw row config from the patch layer
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const notifyOn = (value) => value !== false;
  return {
    baseUrl: nonEmptyString(input.baseUrl) ?? DEFAULTS.baseUrl,
    channelVersion: nonEmptyString(input.channelVersion) ?? DEFAULTS.channelVersion,
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs) ?? DEFAULTS.requestTimeoutMs,
    progressIntervalMs: positiveInteger(input.progressIntervalMs) ?? DEFAULTS.progressIntervalMs,
    progressMinGapMs: positiveInteger(input.progressMinGapMs) ?? DEFAULTS.progressMinGapMs,
    notifyOnTurnEnd: notifyOn(input.notifyOnTurnEnd ?? DEFAULTS.notifyOnTurnEnd),
    notifyOnError: notifyOn(input.notifyOnError ?? DEFAULTS.notifyOnError),
    notifyOnApproval: notifyOn(input.notifyOnApproval ?? DEFAULTS.notifyOnApproval),
    notifyOnProgress: notifyOn(input.notifyOnProgress ?? DEFAULTS.notifyOnProgress),
    notifyOnStream: notifyOn(input.notifyOnStream ?? DEFAULTS.notifyOnStream),
  };
}

/**
 * Mount the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config raw row config; see `resolveConfig`
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const readConfig = () => resolved;
  const logger = typeof ctx?.logger?.info === 'function'
    ? (message) => ctx.logger.info(`[wechat-remote] ${message}`)
    : undefined;

  const store = new StateStore(ctx);
  const client = new IlinkClient({
    baseUrl: resolved.baseUrl,
    channelVersion: resolved.channelVersion,
    requestTimeoutMs: resolved.requestTimeoutMs,
  });

  // The runtime is referenced by the send path before it exists; both sides of
  // that cycle resolve at call time, never at construction.
  /** @type {Runtime | null} */
  let runtime = null;
  const send = (userId, text, token) => runtime === null
    ? Promise.resolve(false)
    : runtime.send(userId, text, token);

  const outbox = new Outbox({ store, send, log: logger });
  const tracker = new ProgressTracker({ ctx, log: logger });
  const titleOf = makeTitleLookup(ctx);
  const attach = new SessionAttach({ ctx, store, outbox, config: readConfig, log: logger });
  const router = new CommandRouter({ ctx, store, attach, tracker, config: readConfig });
  const notifier = new Notifier({
    ctx,
    store,
    outbox,
    config: readConfig,
    // A completion push should say which session finished and what it said.
    summarize: async (sessionId) => ({
      title: await titleOf(sessionId),
      lastText: tracker.peek(sessionId)?.lastText,
    }),
    log: logger,
  });
  const pairing = new PairingManager({ client, store });
  const pusher = new ProgressPusher({
    ctx,
    store,
    tracker,
    outbox,
    config: readConfig,
    titleOf,
    log: logger,
  });

  runtime = new Runtime({ ctx, store, client, router, attach, notifier, outbox, config: readConfig });

  // Activation must never leave a floating rejection: the DSH host installs a
  // process-wide `unhandledRejection` handler that treats one as a fatal load
  // failure and exits the whole host (`dsh: fatal load failure: …`). Every
  // fire-and-forget promise below therefore terminates in a local catch.
  const reportFailure = (label, error) => {
    logger?.(`${label}: ${describeError(error)}`);
  };

  // Start receiving for an existing pairing; a no-op while unpaired.
  ctx.effect(() => {
    void runtime.start().catch((error) => reportFailure('long-poll start failed', error));
    return () => {
      void runtime.stop().catch((error) => reportFailure('long-poll stop failed', error));
    };
  }, 'wechat-remote: long-poll lifecycle');

  // Progress collection is independent of any binding: it watches every
  // session, so a job started on the desktop is visible to a phone that never
  // named it.
  ctx.effect(() => {
    tracker.start();
    pusher.start();
    return () => {
      pusher.stop();
      tracker.stop();
    };
  }, 'wechat-remote: progress tracking');

  ctx.effect(() => () => outbox.stop(), 'wechat-remote: outbound queue');

  // The Settings panel's control surface.
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () => registerControlRoutes({
        ctx: child,
        store,
        runtime: () => runtime,
        pairing,
        outbox,
        tracker,
      }),
      'wechat-remote: control routes',
    );
  });

  // Panel presentation is optional: without the settings service the phone
  // bridge still works, just without a management page. A refusal here is
  // reported and swallowed, never allowed to fail the whole activation.
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      try {
        return child.settings.configure({ auto: false }, ctx.fiber);
      } catch (error) {
        logger?.(`settings presentation unavailable: ${describeError(error)}`);
        return () => undefined;
      }
    }, 'wechat-remote: settings presentation');
  });

  // Keep persisted notify toggles aligned with the config, so a config edit and
  // a `/notify` command cannot disagree.
  ctx.effect(() => {
    void store.update((state) => {
      state.notify.turnEnd = resolved.notifyOnTurnEnd;
      state.notify.error = resolved.notifyOnError;
      state.notify.approval = resolved.notifyOnApproval;
      state.notify.progress = resolved.notifyOnProgress;
      state.notify.stream = resolved.notifyOnStream;
    }).catch((error) => reportFailure('config sync failed', error));
    return () => undefined;
  }, 'wechat-remote: config sync');

  logger?.(`state file: ${store.file}`);
}

/**
 * Build a cached session-id → title lookup for progress digests.
 *
 * A digest is composed every tick for up to a handful of sessions, so the
 * projection is cached briefly rather than re-read per line.
 *
 * @param {object} ctx host context
 * @returns {(sessionId: string) => Promise<string | undefined>}
 */
function makeTitleLookup(ctx) {
  const cache = new Map();
  const TTL_MS = 10_000;
  return async (sessionId) => {
    const hit = cache.get(sessionId);
    if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.title;
    let title;
    try {
      const query = ctx.get('sessionQuery');
      if (query !== undefined) {
        const snapshot = await query.readTitle(sessionId, AbortSignal.timeout(3_000));
        if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) title = snapshot.title;
      }
      if (title === undefined) {
        const titles = ctx.get('sessionTitle');
        const live = ctx.sessions?.get?.(sessionId);
        if (live !== undefined && titles !== undefined) {
          const snapshot = titles.get(live);
          if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) title = snapshot.title;
        }
      }
    } catch {
      // A missing title only costs a shorter digest header.
    }
    cache.set(sessionId, { at: Date.now(), title });
    return title;
  };
}

/** One non-empty string, or undefined. */
function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** One positive integer, or undefined. */
function positiveInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/** Render one thrown value for the log. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
