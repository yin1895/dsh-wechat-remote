/**
 * Progress tracking: what a running session is actually doing, in lines short
 * enough to read on a phone lock screen.
 *
 * The plugin used to mirror only assistant prose, so a session that spent four
 * minutes thinking and running twenty tools looked identical to a session that
 * had died. This module watches the durable session event feed instead — one
 * small, process-local subscription that covers *every* session, not only the
 * one a phone happens to be attached to — and turns it into:
 *
 *   - a per-session activity log (tool calls, failures, turn boundaries, the
 *     last thing the assistant said), used by `/tail` and by progress pushes;
 *   - a running/idle state with a start time, so "still working, 3m12s" is
 *     something the phone can be told rather than guessed.
 *
 * Rendering is deliberately separate from collection ({@link describeEvent} is
 * pure), because `/tail` also renders a *cold* session from
 * `sessionController.inspect()`, where no live tracking ever happened.
 */

/** Tool-call argument keys worth showing, most specific first. */
const ARG_KEYS = [
  'description',
  'command',
  'cmd',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'title',
  'name',
  'id',
  'sessionId',
];

/** One activity line never exceeds this many characters. */
const LINE_LIMIT = 140;

/** One user-message line never exceeds this many characters. */
const USER_LINE_LIMIT = 80;

/** Activity lines retained per session for `/tail`. */
const LINE_BUFFER = 60;

/**
 * Whether one event proves work is happening.
 *
 * `running` cannot be derived from `turn/start` alone: this plugin usually
 * boots while a turn is already in flight (or reloads mid-turn), and a session
 * that looks finished while it is plainly working is worse than no progress
 * line at all. So "running" means "we have seen work and no turn end since".
 *
 * @param {string | undefined} type
 * @returns {boolean}
 */
export function isWorkEvent(type) {
  return type === 'turn/start'
    || type === 'step/start'
    || type === 'tool/call'
    || type === 'tool/result'
    || type === 'assistant/message';
}

/**
 * Credential-shaped text, masked out of every activity line.
 *
 * A progress line is a *summary* of a tool call, not a copy of it: a command
 * containing a bearer token must not end up on a phone lock screen.
 */
const SECRET_PATTERNS = [
  [/(bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, '$1***'],
  [/\b(eyJ[A-Za-z0-9._-]{16,})\b/gu, '***'],
  [/\b((?:sk|pk|ghp|xox[baprs])-[A-Za-z0-9_-]{12,})\b/giu, '***'],
  // `scheme://user:password@host` — a credential embedded in a URL argument.
  [/(:\/\/)[^/\s:@]+:[^/\s@]+@/gu, '$1***:***@'],
  [/\b([A-Za-z0-9_-]{40,})\b/gu, '***'],
  [/((?:token|api[_-]?key|password|passwd|secret|authorization|credential)s?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1***'],
];

/**
 * Mask obvious credentials inside one brief.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A running session with no event for this long gets one "still alive" push. */
export const SILENCE_MS = 120_000;

/**
 * Read a session identity out of whatever the event feed hands over.
 *
 * `session/event` is emitted with the live `Session` object, whose identity
 * field is not part of the Service contract this bundle compiles against, so
 * the known candidates are tried in order instead of assuming one.
 *
 * @param {unknown} session
 * @returns {string | undefined}
 */
export function sessionIdOf(session) {
  if (session === null || typeof session !== 'object') return undefined;
  const candidates = [
    session.id,
    session.sessionId,
    session.header?.id,
    session.meta?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Collapse whitespace and truncate one line for the phone. */
function oneLine(value, limit) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Compress one tool call's raw argument JSON into a short subject.
 *
 * The goal is to answer "what is it touching?" for tools whose meaning lives in
 * a different key: `read` in `file_path`, `pwsh` in `command`, `grep` in
 * `pattern`. An unknown tool falls back to its first short string value, and a
 * body that is not JSON at all keeps a truncated raw slice.
 *
 * The result is a projection, not a copy: only the chosen field is shown, it is
 * redacted, and it is truncated. Tool results and private arguments never
 * travel to the phone.
 *
 * @param {string} raw tool call arguments as sent by the model
 * @returns {string} a phrase, or '' when there is nothing readable
 */
export function briefArguments(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return redact(oneLine(raw, 70));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return redact(oneLine(String(parsed), 70));
  }
  for (const key of ARG_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return redact(oneLine(value, 70));
    }
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim().length > 0) return redact(oneLine(value, 70));
  }
  return '';
}

/** The first text block of one message body, if any. */
function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

/** Render one turn end reason for a phone line. */
function turnEndLine(turn, reason) {
  const kind = reason?.kind ?? 'completed';
  switch (kind) {
    case 'completed':
      return { kind: 'mark', text: `✅ 第 ${turn} 轮完成` };
    case 'error':
      return { kind: 'error', text: `❌ 第 ${turn} 轮出错: ${oneLine(reason?.error?.message ?? '', 80)}` };
    case 'blocked':
      return { kind: 'mark', text: `🔒 第 ${turn} 轮被阻塞，等待处理` };
    case 'max-tokens':
      return { kind: 'mark', text: `✂️ 第 ${turn} 轮达到 token 上限` };
    case 'aborted':
      return { kind: 'mark', text: `⛔ 第 ${turn} 轮已中止` };
    case 'interrupted':
      return { kind: 'mark', text: `⏹ 第 ${turn} 轮被中断` };
    case 'forked':
      return { kind: 'mark', text: `⑂ 第 ${turn} 轮已分叉` };
    default:
      return { kind: 'mark', text: `第 ${turn} 轮结束 (${kind})` };
  }
}

/**
 * Turn one durable session event into a phone-readable activity entry.
 *
 * Pure: everything needed to describe an event is in the event, except the
 * tool name for a `tool/result`, which is looked up through the caller's
 * `nameOf` callback (the call-name map a live tracker keeps).
 *
 * @param {{ type?: string, data?: any }} event session event or wire event
 * @param {(callId: string) => string | undefined} [nameOf]
 * @returns {{ kind: 'tool'|'error'|'mark'|'user', text: string } | undefined}
 */
export function describeEvent(event, nameOf) {
  const type = event?.type;
  const data = event?.data ?? {};
  switch (type) {
    case 'tool/call': {
      const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : 'tool';
      const brief = briefArguments(data.arguments);
      return { kind: 'tool', text: oneLine(`🔧 ${name}${brief.length > 0 ? `: ${brief}` : ''}`, LINE_LIMIT) };
    }
    case 'tool/result': {
      const callId = data.message?.toolCallId ?? data.callId;
      const name = (typeof callId === 'string' ? nameOf?.(callId) : undefined) ?? 'tool';
      if (data.error !== undefined && data.error !== null) {
        const reason = data.error.reason ?? data.error.code ?? data.error.name ?? '失败';
        return { kind: 'error', text: oneLine(`⚠️ ${name} 失败: ${reason}`, LINE_LIMIT) };
      }
      if (data.message?.isError === true) {
        return { kind: 'error', text: oneLine(`⚠️ ${name} 返回错误`, LINE_LIMIT) };
      }
      return undefined;
    }
    case 'turn/start':
      return { kind: 'mark', text: `▶️ 第 ${data.turn ?? '?'} 轮开始` };
    case 'turn/end':
      return turnEndLine(data.turn ?? '?', data.reason);
    case 'user/message': {
      const text = messageText(data);
      if (text === undefined || text.trim().length === 0) return undefined;
      return { kind: 'user', text: oneLine(`👤 ${text}`, USER_LINE_LIMIT) };
    }
    case 'assistant/message':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
    case 'request/header':
    case 'request/context':
    case 'developer/message':
    case 'system/message':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Human-readable elapsed time, coarse enough for one line.
 * @param {number} ms
 * @returns {string} e.g. `12 秒`, `3 分 04 秒`, `1 小时 12 分`
 */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

/** Wall-clock `HH:MM:SS` for one timestamp, or '' when unset. */
function clockOf(time) {
  if (typeof time !== 'number' || time <= 0) return '';
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * One session's collected activity.
 *
 * @param {string} sessionId
 */
function emptyState(sessionId) {
  return {
    sessionId,
    running: false,
    turn: 0,
    step: 0,
    startedAt: 0,
    endedAt: 0,
    lastEventAt: 0,
    actions: 0,
    lastActionAt: 0,
    lastText: '',
    lines: [],
    /** @type {Map<string, string>} callId → tool name */
    names: new Map(),
    lastSilenceNotifiedAt: 0,
  };
}

/**
 * Collects activity for every session the host runs, bound or not.
 */
export class ProgressTracker {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx host context
   * @param {(message: string) => void} [deps.log] plugin logger
   * @param {() => number} [deps.now] clock override, for tests
   */
  constructor({ ctx, log, now }) {
    this.ctx = ctx;
    this.log = log;
    this.now = now ?? (() => Date.now());
    /** @type {Map<string, ReturnType<typeof emptyState>>} */
    this.sessions = new Map();
    this.disposers = [];
    this.shapeWarned = false;
  }

  /** Subscribe to the durable feed. Safe to call more than once. */
  start() {
    if (this.disposers.length > 0) return;
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      const sessionId = sessionIdOf(session);
      if (sessionId === undefined) {
        if (this.shapeWarned !== true) {
          this.shapeWarned = true;
          // A silent mismatch would disable every progress feature at once, so
          // it is reported once instead of failing quietly.
          this.log?.('progress: session/event arrived without a readable session id');
        }
        return;
      }
      this.observe(sessionId, event);
    }));
  }

  /** Remove the subscription. */
  stop() {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  /** Drop one session's history (a deleted or archived session). */
  forget(sessionId) {
    this.sessions.delete(sessionId);
  }

  /** Drop everything. */
  clear() {
    this.sessions.clear();
  }

  /**
   * Fold one durable event into one session's state.
   *
   * @param {string} sessionId
   * @param {{ type?: string, seq?: number, time?: number, data?: any }} event
   */
  observe(sessionId, event) {
    const state = this.stateFor(sessionId);
    const now = this.now();
    const at = typeof event?.time === 'number' && event.time > 0 ? event.time : now;
    state.lastEventAt = now;

    if (event?.type === 'tool/call') {
      const callId = event.data?.callId;
      const name = event.data?.name;
      if (typeof callId === 'string' && typeof name === 'string') state.names.set(callId, name);
      state.actions += 1;
      state.lastActionAt = now;
    }
    if (event?.type === 'turn/start') {
      state.running = true;
      state.turn = typeof event.data?.turn === 'number' ? event.data.turn : state.turn;
      state.startedAt = at;
      state.endedAt = 0;
      state.actions = 0;
      state.lastSilenceNotifiedAt = 0;
    }
    if (event?.type === 'step/start' && typeof event.data?.step === 'number') {
      state.step = event.data.step;
    }
    if (event?.type === 'turn/end') {
      state.running = false;
      state.endedAt = now;
      state.lastSilenceNotifiedAt = 0;
    } else if (isWorkEvent(event?.type) && state.running !== true) {
      // Either a fresh turn or a turn that was already running when tracking
      // started; both mean the phone should be told it is running.
      state.running = true;
      state.startedAt = at;
      state.endedAt = 0;
      state.lastSilenceNotifiedAt = 0;
    }
    if (event?.type === 'assistant/message') {
      const text = messageText(event.data?.message);
      if (text !== undefined && text.trim().length > 0) state.lastText = text;
    }

    const described = describeEvent(event, (callId) => state.names.get(callId));
    if (described !== undefined) {
      state.lines.push({
        seq: typeof event?.seq === 'number' ? event.seq : undefined,
        time: at,
        kind: described.kind,
        text: described.text,
      });
      while (state.lines.length > LINE_BUFFER) state.lines.shift();
    }
    return state;
  }

  /** The state record for one session, created on first sight. */
  stateFor(sessionId) {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = emptyState(sessionId);
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** One session's state, or undefined when it was never observed. */
  peek(sessionId) {
    return this.sessions.get(sessionId);
  }

  /** Every session currently marked running. */
  runningSessions() {
    const out = [];
    for (const state of this.sessions.values()) {
      if (state.running) out.push(state);
    }
    return out;
  }

  /**
   * Activity lines newer than one *sequence* cursor, oldest first.
   *
   * Sequence cursors (not array indexes) are what the progress pusher stores,
   * because the ring buffer drops its oldest lines: an index would silently
   * skip or repeat after a long turn.
   *
   * @param {string} sessionId
   * @param {number} cursor the highest seq already delivered, or 0
   * @returns {{ lines: object[], cursor: number }} fresh lines and the new cursor
   */
  since(sessionId, cursor) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return { lines: [], cursor: cursor ?? 0 };
    const floor = typeof cursor === 'number' ? cursor : 0;
    const lines = state.lines.filter((line) => typeof line.seq === 'number' && line.seq > floor);
    let next = floor;
    for (const line of lines) if (line.seq > next) next = line.seq;
    return { lines, cursor: next };
  }

  /**
   * Render one session's progress as the body of `/tail`.
   *
   * @param {string} sessionId
   * @param {object} [options]
   * @param {string} [options.title] display name for the session
   * @param {number} [options.limit] activity lines to include
   * @param {boolean} [options.text] include the last assistant text
   * @param {number} [options.now] clock override, for tests
   * @returns {string | undefined} undefined when nothing was ever observed
   */
  render(sessionId, options = {}) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return undefined;
    const now = options.now ?? Date.now();
    const limit = options.limit ?? 12;
    const title = options.title ?? sessionId;

    const head = state.running
      ? `📡 ${title} · 运行中 ${formatElapsed(now - (state.startedAt || state.lastEventAt))}`
      : `⚪️ ${title} · 空闲${state.endedAt > 0 ? `，结束于 ${clockOf(state.endedAt)}` : ''}`;

    const facts = [];
    if (state.turn > 0) facts.push(`第 ${state.turn} 轮`);
    if (state.step > 0) facts.push(`步骤 ${state.step}`);
    if (state.actions > 0) facts.push(`${state.actions} 个动作`);
    if (state.lastActionAt > 0) facts.push(`最后动作 ${formatElapsed(now - state.lastActionAt)}前`);
    else if (state.running) facts.push(`已运行 ${formatElapsed(now - state.startedAt)}`);

    const body = state.lines.slice(-limit).map((line) => {
      const clock = clockOf(line.time);
      return `${clock.length > 0 ? `${clock} ` : ''}${line.text}`;
    });

    const parts = [head];
    if (facts.length > 0) parts.push(facts.join(' · '));
    if (body.length > 0) {
      parts.push('─────');
      parts.push(...body);
    } else {
      parts.push('（还没有动作记录）');
    }
    if (options.text !== false && state.lastText.length > 0) {
      parts.push('─────');
      parts.push(`最后输出：\n${oneLine(state.lastText, 500)}`);
    }
    return parts.join('\n');
  }
}

/**
 * Build a progress view from a cold session's event list.
 *
 * `/tail` must answer for a session that was already running before this plugin
 * loaded, where the live tracker saw nothing. `sessionController.inspect()`
 * returns the durable prefix, so the same activity description is replayed over
 * its tail.
 *
 * @param {{ type?: string, seq?: number, time?: number, data?: any }[]} events
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {number} [options.limit] events to scan backwards through
 * @param {number} [options.now] clock override, for tests
 * @returns {string} the `/tail` body
 */
export function renderFromEvents(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const now = options.now ?? Date.now();
  const title = options.title ?? '(未命名会话)';
  const scanFrom = Math.max(0, list.length - (options.limit ?? 120));
  const names = new Map();
  const lines = [];
  let running = false;
  let startedAt = 0;
  let turn = 0;
  let step = 0;
  let actions = 0;
  let lastActionAt = 0;
  let lastEventAt = 0;
  let lastText = '';

  for (const event of list.slice(0, scanFrom)) {
    if (event?.type === 'turn/start') running = true;
    if (event?.type === 'turn/end') running = false;
  }

  for (const event of list.slice(scanFrom)) {
    const at = typeof event?.time === 'number' && event.time > 0 ? event.time : 0;
    if (at > 0) lastEventAt = at;
    if (event?.type === 'tool/call') {
      const callId = event.data?.callId;
      const name = event.data?.name;
      if (typeof callId === 'string' && typeof name === 'string') names.set(callId, name);
      actions += 1;
      if (at > 0) lastActionAt = at;
    }
    if (event?.type === 'turn/start') {
      running = true;
      turn = typeof event.data?.turn === 'number' ? event.data.turn : turn;
      startedAt = at;
      actions = 0;
    } else if (event?.type === 'turn/end') {
      running = false;
    } else if (isWorkEvent(event?.type) && running !== true) {
      // Work with no recorded turn start: the turn predates this plugin load.
      running = true;
      if (startedAt === 0) startedAt = at;
    }
    if (event?.type === 'step/start' && typeof event.data?.step === 'number') step = event.data.step;
    if (event?.type === 'assistant/message') {
      const text = messageText(event.data?.message);
      if (text !== undefined && text.trim().length > 0) lastText = text;
    }
    const described = describeEvent(event, (callId) => names.get(callId));
    if (described !== undefined) {
      lines.push({ time: at, kind: described.kind, text: described.text });
    }
  }

  const head = running
    ? `📡 ${title} · 运行中 ${formatElapsed(now - (startedAt || lastEventAt || now))}`
    : `⚪️ ${title} · 空闲${lastEventAt > 0 ? `，最后动作 ${formatElapsed(now - lastEventAt)}前` : ''}`;
  const facts = [];
  if (turn > 0) facts.push(`第 ${turn} 轮`);
  if (step > 0) facts.push(`步骤 ${step}`);
  if (actions > 0) facts.push(`${actions} 个动作`);
  if (running && lastActionAt > 0) facts.push(`最后动作 ${formatElapsed(now - lastActionAt)}前`);

  const parts = [head];
  if (facts.length > 0) parts.push(facts.join(' · '));
  const tailLines = lines.slice(-(options.lines ?? 12));
  if (tailLines.length > 0) {
    parts.push('─────');
    for (const line of tailLines) {
      const clock = clockOf(line.time);
      parts.push(`${clock.length > 0 ? `${clock} ` : ''}${line.text}`);
    }
  } else {
    parts.push('（还没有动作记录）');
  }
  if (lastText.length > 0) {
    parts.push('─────');
    parts.push(`最后输出：\n${oneLine(lastText, 500)}`);
  }
  return parts.join('\n');
}
