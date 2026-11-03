/**
 * Durable plugin state: credentials, long-poll cursor, and the user's current
 * selection.
 *
 * The record is one small JSON file under the Harness home
 * (`<DSH_HOME>/wechat-remote/state.json`), written whole and atomically on every
 * change. It deliberately does NOT go through the `storage` service: the hub's
 * data forms are per-profile (`storage.form(<key>)` throws
 * `StorageError: form-not-mounted` unless some loaded plugin mounted that exact
 * key — this profile mounts `domain` only), and a bundle installed from a
 * directory must not import the domain package to declare one. A missing form
 * here previously rejected from plugin activation, and an unhandled rejection
 * is fatal to the whole DSH host, so the store owns its own file instead.
 *
 * Three per-user concepts live here, and they are deliberately separate:
 *
 *   currents[userId]      which session plain WeChat text is sent to
 *   watches[userId]       which sessions push their progress to that user
 *   contextTokens[userId] the last inbound `context_token`, kept so an
 *                         unsolicited push still has a window to land in
 *
 * Keeping them separate is what stops "look at the session I am running on the
 * desktop" from colliding with "send my next line of text to that session".
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Directory under the Harness home owning this plugin's state. */
const STATE_DIR = 'wechat-remote';

/** File name of the single state record. */
const STATE_FILE = 'state.json';

/** Schema version; bump when the stored shape changes incompatibly. */
const STATE_VERSION = 2;

/** How many not-yet-delivered push segments one user may accumulate. */
export const PENDING_OUT_LIMIT = 20;

/**
 * Resolve the Harness home directory.
 *
 * `dshHomePath` is provided by the boot on the root context; the environment
 * variable and the default location cover a store built outside a booted host
 * (tests, tooling).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 * @returns {string} absolute Harness home
 */
function resolveDshHome(ctx) {
  const provided = ctx?.dshHomePath;
  if (typeof provided === 'string' && provided.length > 0) return provided;
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * Build the empty state used before the first successful pairing.
 * @returns {object}
 */
function emptyState() {
  return {
    version: STATE_VERSION,
    botToken: null,
    baseUrl: null,
    accountId: null,
    cursor: '',
    paired: false,
    pairedAt: null,
    currentWorkspaceId: null,
    currents: {},
    watches: {},
    contextTokens: {},
    pendingOut: {},
    unconfirmed: {},
    pendingQuestions: {},
    notify: {
      turnEnd: true,
      error: true,
      approval: true,
      progress: true,
      stream: true,
    },
  };
}

/** One string-keyed map of non-empty strings, with every value validated. */
function stringMap(loaded) {
  const out = {};
  if (loaded === null || typeof loaded !== 'object') return out;
  for (const [key, value] of Object.entries(loaded)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof value !== 'string' || value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** One user → session-list map, de-duplicated and validated. */
function watchMap(loaded) {
  const out = {};
  if (loaded === null || typeof loaded !== 'object') return out;
  for (const [userId, value] of Object.entries(loaded)) {
    if (typeof userId !== 'string' || userId.length === 0) continue;
    const list = Array.isArray(value) ? value : [];
    const ids = [];
    for (const item of list) {
      if (typeof item !== 'string' || item.length === 0) continue;
      if (!ids.includes(item)) ids.push(item);
    }
    if (ids.length > 0) out[userId] = ids;
  }
  return out;
}

/**
 * One user → buffered push segments map.
 *
 * A segment is a whole message body that the phone never received, usually
 * because no usable `context_token` was available at the time. It is persisted
 * so a restart or a long silence cannot silently drop the user's progress.
 */
function pendingOutMap(loaded) {
  const out = {};
  if (loaded === null || typeof loaded !== 'object') return out;
  for (const [userId, entry] of Object.entries(loaded)) {
    if (typeof userId !== 'string' || userId.length === 0) continue;
    if (entry === null || typeof entry !== 'object') continue;
    const lines = Array.isArray(entry.lines)
      ? entry.lines.filter((line) => typeof line === 'string' && line.length > 0).slice(-PENDING_OUT_LIMIT)
      : [];
    if (lines.length === 0) continue;
    out[userId] = {
      lines,
      since: typeof entry.since === 'number' ? entry.since : 0,
      dropped: typeof entry.dropped === 'number' && entry.dropped > 0 ? entry.dropped : 0,
    };
  }
  return out;
}

/** One user → the last completion push nobody acknowledged. */
function unconfirmedMap(loaded) {
  const out = {};
  if (loaded === null || typeof loaded !== 'object') return out;
  for (const [userId, entry] of Object.entries(loaded)) {
    if (typeof userId !== 'string' || userId.length === 0) continue;
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) continue;
    out[userId] = {
      sessionId: entry.sessionId,
      title: typeof entry.title === 'string' ? entry.title : entry.sessionId,
      text: typeof entry.text === 'string' ? entry.text : '',
      at: typeof entry.at === 'number' ? entry.at : 0,
    };
  }
  return out;
}

/** Coerce one loaded record onto the current shape without trusting it. */
function normalize(loaded) {
  const base = emptyState();
  if (loaded === null || typeof loaded !== 'object') return base;

  // v1 stored a single binding per user as `attachedSessions`; it becomes the
  // current session, and that session is auto-subscribed so an upgraded install
  // keeps pushing exactly what it pushed before.
  const legacyCurrents = stringMap(loaded.attachedSessions);
  const currents = Object.keys(stringMap(loaded.currents)).length > 0
    ? stringMap(loaded.currents)
    : legacyCurrents;
  const watches = watchMap(loaded.watches);
  if (Object.keys(watches).length === 0) {
    for (const [userId, sessionId] of Object.entries(currents)) watches[userId] = [sessionId];
  }
  for (const [userId, sessionId] of Object.entries(currents)) {
    const list = watches[userId] ?? [];
    if (!list.includes(sessionId)) watches[userId] = [sessionId, ...list];
  }

  const pending = {};
  if (loaded.pendingQuestions !== null && typeof loaded.pendingQuestions === 'object') {
    for (const [callId, entry] of Object.entries(loaded.pendingQuestions)) {
      if (entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string') {
        pending[callId] = {
          sessionId: entry.sessionId,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          kind: entry.kind === 'approval' ? 'approval' : 'question',
        };
      }
    }
  }
  const notify = loaded.notify !== null && typeof loaded.notify === 'object' ? loaded.notify : {};
  return {
    version: STATE_VERSION,
    botToken: typeof loaded.botToken === 'string' && loaded.botToken.length > 0 ? loaded.botToken : null,
    baseUrl: typeof loaded.baseUrl === 'string' && loaded.baseUrl.length > 0 ? loaded.baseUrl : null,
    accountId: typeof loaded.accountId === 'string' ? loaded.accountId : null,
    cursor: typeof loaded.cursor === 'string' ? loaded.cursor : '',
    paired: loaded.paired === true,
    pairedAt: typeof loaded.pairedAt === 'number' ? loaded.pairedAt : null,
    currentWorkspaceId: typeof loaded.currentWorkspaceId === 'string' ? loaded.currentWorkspaceId : null,
    currents,
    watches,
    contextTokens: stringMap(loaded.contextTokens),
    pendingOut: pendingOutMap(loaded.pendingOut),
    unconfirmed: unconfirmedMap(loaded.unconfirmed),
    pendingQuestions: pending,
    notify: {
      turnEnd: notify.turnEnd !== false,
      error: notify.error !== false,
      approval: notify.approval !== false,
      progress: notify.progress !== false,
      stream: notify.stream !== false,
    },
  };
}

/**
 * File-backed state store.
 *
 * Every mutation reads the latest value, applies a pure change, and rewrites the
 * whole record. Calls are serialized through an internal promise chain so
 * concurrent command handling cannot lose a write.
 */
export class StateStore {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx host context carrying `dshHomePath`
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = null;
    this.writeChain = Promise.resolve();
    /** @type {string | undefined} memoized record path */
    this.filePath = undefined;
  }

  /** Absolute path of the state record. */
  get file() {
    this.filePath ??= join(resolveDshHome(this.ctx), STATE_DIR, STATE_FILE);
    return this.filePath;
  }

  /**
   * Read the current state, loading it once and caching afterwards.
   *
   * A missing record is normal and yields the empty state. A record that cannot
   * be read or parsed is reported as empty rather than wedging the panel: the
   * caller decides whether to surface it.
   *
   * @returns {Promise<object>} a detached copy safe to mutate
   */
  async read() {
    if (this.cache === null) {
      let raw = '';
      try {
        raw = await readFile(this.file, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // Unreadable (permissions, a directory in the way): start clean and
          // let the next write report the real failure.
          raw = '';
        }
      }
      if (raw.length > 0) {
        try {
          this.cache = normalize(JSON.parse(raw));
        } catch {
          // A corrupt record is recoverable: start clean rather than wedge.
          this.cache = emptyState();
        }
      } else {
        this.cache = emptyState();
      }
    }
    return structuredClone(this.cache);
  }

  /**
   * Apply one pure change to the state and persist the result.
   *
   * @param {(current: object) => object | void} mutate receives a mutable copy;
   *   return a replacement object or mutate in place
   * @returns {Promise<object>} the persisted state
   */
  async update(mutate) {
    const run = async () => {
      const current = await this.read();
      const next = mutate(current) ?? current;
      const normalized = normalize(next);
      await this.#persist(normalized);
      this.cache = normalized;
      return structuredClone(normalized);
    };
    const queued = this.writeChain.then(run, run);
    // Keep the chain alive even when this write rejects.
    this.writeChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Write the record whole, through a temporary file so a crash cannot tear it. */
  async #persist(state) {
    const file = this.file;
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    await rename(temporary, file);
  }

  /** Persist a fresh pairing result. */
  async markPaired({ botToken, baseUrl, accountId }) {
    return this.update((state) => {
      state.botToken = botToken;
      state.baseUrl = baseUrl ?? state.baseUrl;
      state.accountId = accountId ?? state.accountId;
      state.paired = true;
      state.pairedAt = Date.now();
      state.cursor = '';
    });
  }

  /** Persist the advanced long-poll cursor. */
  async setCursor(cursor) {
    return this.update((state) => {
      state.cursor = cursor;
    });
  }

  /** Persist the workspace the user selected from WeChat. */
  async setCurrentWorkspace(workspaceId) {
    return this.update((state) => {
      state.currentWorkspaceId = workspaceId;
    });
  }

  /**
   * Point one WeChat user's outbound text at one session.
   *
   * Opening a session also subscribes it, because the only reason to name a
   * session from the phone is to watch or drive it, and requiring a second
   * command for the first half of that was the plugin's main friction.
   */
  async setCurrent(userId, sessionId) {
    return this.update((state) => {
      state.currents[userId] = sessionId;
      const list = state.watches[userId] ?? [];
      if (!list.includes(sessionId)) state.watches[userId] = [sessionId, ...list];
    });
  }

  /** Remove one WeChat user's current session, keeping their subscriptions. */
  async clearCurrent(userId) {
    return this.update((state) => {
      delete state.currents[userId];
    });
  }

  /**
   * Add or drop one progress subscription.
   *
   * @param {string} userId
   * @param {string} sessionId
   * @param {boolean} on
   */
  async setWatch(userId, sessionId, on) {
    return this.update((state) => {
      const list = (state.watches[userId] ?? []).filter((id) => id !== sessionId);
      if (on === true) list.unshift(sessionId);
      if (list.length === 0) delete state.watches[userId];
      else state.watches[userId] = list;
    });
  }

  /** Drop every subscription for one user. */
  async clearWatches(userId) {
    return this.update((state) => {
      delete state.watches[userId];
    });
  }

  /**
   * Remember the newest inbound `context_token` for one sender.
   *
   * iLink attaches an outbound message to a conversation window through this
   * token, and the window is what a user's own message opens. Persisting it is
   * what lets a push survive a host restart, and knowing that we have one is
   * what lets `/status` tell the truth about whether pushes can land at all.
   */
  async saveContextToken(userId, token) {
    if (typeof token !== 'string' || token.length === 0) return this.read();
    return this.update((state) => {
      state.contextTokens[userId] = token;
    });
  }

  /**
   * Append one undelivered push body, newest last, bounded.
   *
   * @param {string} userId
   * @param {string} text
   */
  async addPendingOut(userId, text) {
    if (typeof text !== 'string' || text.length === 0) return this.read();
    return this.update((state) => {
      const entry = state.pendingOut[userId] ?? { lines: [], since: Date.now(), dropped: 0 };
      entry.lines.push(text);
      while (entry.lines.length > PENDING_OUT_LIMIT) {
        entry.lines.shift();
        entry.dropped += 1;
      }
      state.pendingOut[userId] = entry;
    });
  }

  /** Read one user's undelivered push bodies without clearing them. */
  async readPendingOut(userId) {
    const state = await this.read();
    return state.pendingOut[userId] ?? null;
  }

  /**
   * Remember that a completion push went out and nobody has spoken since.
   *
   * iLink can accept a proactive send and still not show it, so "we sent it" is
   * not evidence that "it was seen". This record is what lets the next inbound
   * message carry a one-line recap when the push was never acknowledged.
   *
   * @param {string} userId
   * @param {{ sessionId: string, title: string, text: string, at?: number }} entry
   */
  async setUnconfirmed(userId, entry) {
    return this.update((state) => {
      state.unconfirmed[userId] = {
        sessionId: entry.sessionId,
        title: entry.title,
        text: entry.text,
        at: typeof entry.at === 'number' && entry.at > 0 ? entry.at : Date.now(),
      };
    });
  }

  /** Forget one user's unacknowledged push. */
  async clearUnconfirmed(userId) {
    return this.update((state) => {
      delete state.unconfirmed[userId];
    });
  }

  /**
   * Take and clear one user's undelivered push bodies.
   *
   * @param {string} userId
   * @returns {Promise<{ lines: string[], since: number, dropped: number } | null>}
   */
  async takePendingOut(userId) {
    const state = await this.read();
    const entry = state.pendingOut[userId];
    if (entry === undefined) return null;
    await this.update((next) => {
      delete next.pendingOut[userId];
    });
    return entry;
  }

  /** Record an open approval or question awaiting a WeChat reply. */
  async addPendingQuestion(callId, entry) {
    return this.update((state) => {
      state.pendingQuestions[callId] = {
        sessionId: entry.sessionId,
        kind: entry.kind,
        createdAt: Date.now(),
      };
    });
  }

  /** Drop one settled approval or question. */
  async removePendingQuestion(callId) {
    return this.update((state) => {
      delete state.pendingQuestions[callId];
    });
  }

  /**
   * Update one notification toggle.
   * @param {'turnEnd'|'error'|'approval'|'progress'|'stream'} key
   * @param {boolean} value
   */
  async setNotify(key, value) {
    return this.update((state) => {
      state.notify[key] = value === true;
    });
  }

  /** Clear credentials and bindings while preserving notification preferences. */
  async clearPairing() {
    return this.update((state) => {
      state.botToken = null;
      state.baseUrl = null;
      state.accountId = null;
      state.cursor = '';
      state.paired = false;
      state.pairedAt = null;
      state.currents = {};
      state.watches = {};
      state.contextTokens = {};
      state.pendingOut = {};
      state.unconfirmed = {};
      state.pendingQuestions = {};
    });
  }
}

/** Stable identifier helper for locally generated correlation keys. */
export function correlationId() {
  return randomUUID();
}
