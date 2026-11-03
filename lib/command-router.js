/**
 * Command routing for inbound WeChat messages.
 *
 * Two shapes of inbound text exist:
 *   - `/command args`  → a management action handled here
 *   - anything else    → the current session's next user message
 *
 * The command surface is intentionally small, because a phone user is standing
 * in a queue, not sitting at a desk: three everyday actions (send text, `/t`,
 * `/ls` + `/open`) and a handful of occasional ones. Every handler returns the
 * exact text to send back, and the router never throws: a failing handler
 * becomes an explanatory reply, because a silent phone is worse than an error
 * message.
 */

import { renderFromEvents } from './progress.js';

/** Maximum characters per outbound WeChat text part. */
const MAX_PART_LENGTH = 1800;

/** Hard cap on parts for one reply, to avoid a runaway flood. */
const MAX_PARTS = 8;

/** Rows listed by `/ls`. */
const LIST_LIMIT = 30;

/**
 * Split one logical reply into sendable parts at natural boundaries.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitReply(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (source.length === 0) return ['(空)'];
  if (source.length <= MAX_PART_LENGTH) return [source];

  const parts = [];
  let rest = source;
  while (rest.length > 0 && parts.length < MAX_PARTS) {
    // Once the budget is exhausted, the remaining text becomes one summary part.
    if (parts.length === MAX_PARTS - 1) {
      parts.push(`…（已截断，剩余 ${rest.length} 字）`);
      rest = '';
      break;
    }
    if (rest.length <= MAX_PART_LENGTH) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n', MAX_PART_LENGTH);
    if (cut < MAX_PART_LENGTH * 0.4) cut = MAX_PART_LENGTH;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/u, '');
  }
  return parts;
}

/** Parse one inbound line into a command name and its argument string. */
export function parseCommand(line) {
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/u.exec(line.trim());
  if (match === null) return undefined;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * Resolve one session selector against a list.
 *
 * Accepts the row number `/ls` printed, a full session id, or any unambiguous
 * id prefix, so a user can paste whatever the desktop showed them.
 *
 * @param {object[]} items session rows
 * @param {string} selector
 * @returns {object | undefined}
 */
export function pickSession(items, selector) {
  const query = typeof selector === 'string' ? selector.trim() : '';
  if (query.length === 0) return undefined;
  if (/^\d+$/u.test(query)) {
    const index = Number.parseInt(query, 10) - 1;
    return index >= 0 && index < items.length ? items[index] : undefined;
  }
  const exact = items.find((item) => item.sessionId === query);
  if (exact !== undefined) return exact;
  const prefixed = items.filter((item) => typeof item.sessionId === 'string' && item.sessionId.startsWith(query));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Resolve one workspace selector against a list.
 *
 * @param {object[]} workspaces
 * @param {string} selector
 * @returns {object | undefined}
 */
export function pickWorkspace(workspaces, selector) {
  const query = typeof selector === 'string' ? selector.trim() : '';
  if (query.length === 0) return undefined;
  if (/^\d+$/u.test(query)) {
    const index = Number.parseInt(query, 10) - 1;
    return index >= 0 && index < workspaces.length ? workspaces[index] : undefined;
  }
  return workspaces.find((workspace) => {
    const title = workspace.title ?? workspace.path ?? workspace.id;
    return title === query || workspace.id === query;
  });
}

/**
 * Attach display titles to session list rows.
 *
 * `sessionController.list()` reports identity and runtime state but not the
 * user-facing title; that lives in the session-title projection. Reading it
 * here keeps the phone list readable without activating an Agent.
 *
 * @param {object} ctx host context
 * @param {object[]} items list rows
 * @returns {Promise<object[]>} rows with an added `title` field
 */
async function withTitles(ctx, items) {
  const titles = ctx.get('sessionTitle');
  const query = ctx.get('sessionQuery');
  if (titles === undefined && query === undefined) return items;

  return Promise.all(items.map(async (item) => {
    try {
      if (query !== undefined) {
        const snapshot = await query.readTitle(item.sessionId, AbortSignal.timeout(3_000));
        if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) {
          return { ...item, title: snapshot.title };
        }
      }
      const live = ctx.sessions?.get?.(item.sessionId);
      if (live !== undefined && titles !== undefined) {
        const snapshot = titles.get(live);
        if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) {
          return { ...item, title: snapshot.title };
        }
      }
    } catch {
      // A title lookup failure must not hide the session.
    }
    return item;
  }));
}

/** Format one session row for the phone. */
function sessionLine(item, currentId, watched) {
  const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : '(未命名)';
  const running = item.running === true ? '🟢' : '⚪';
  const marker = currentId === item.sessionId ? '▶ ' : '';
  const star = watched === true ? ' ★' : '';
  const id = item.sessionId;
  const short = typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return `${marker}${running} ${title} — ${short}${star}`;
}

/** Format one workspace row for the phone. */
function workspaceLine(workspace, marker) {
  const title = typeof workspace.title === 'string' && workspace.title.length > 0
    ? workspace.title
    : workspace.path ?? workspace.id;
  return `${marker} ${title}`;
}

/** Shorten a session id for display. */
function shortId(id) {
  return typeof id === 'string' && id.length > 10 ? `${id.slice(0, 8)}…` : String(id);
}

/** Shorten a WeChat user id for display. */
function shortUser(userId) {
  return typeof userId === 'string' && userId.length > 12 ? `${userId.slice(0, 10)}…` : String(userId);
}

/** One notification key's help line fragment. */
const NOTIFY_KEYS = ['turn', 'error', 'approval', 'progress', 'stream'];

/** Map a short `/notify` key onto the persisted flag name. */
const NOTIFY_FLAGS = {
  turn: 'turnEnd',
  error: 'error',
  approval: 'approval',
  progress: 'progress',
  stream: 'stream',
};

/**
 * Routes one inbound WeChat message.
 */
export class CommandRouter {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx host context
   * @param {import('./state-store.js').StateStore} deps.store
   * @param {import('./session-attach.js').SessionAttach} deps.attach
   * @param {import('./progress.js').ProgressTracker} [deps.tracker] live progress
   * @param {() => object} deps.config current plugin config
   */
  constructor({ ctx, store, attach, tracker, config }) {
    this.ctx = ctx;
    this.store = store;
    this.attach = attach;
    this.tracker = tracker;
    this.config = config;
  }

  /**
   * Handle one inbound text and return the reply parts.
   *
   * @param {object} options
   * @param {string} options.userId
   * @param {string} options.text
   * @param {string} options.contextToken
   * @returns {Promise<string[]>}
   */
  async handle({ userId, text, contextToken }) {
    const command = parseCommand(text);
    if (command === undefined) {
      return this.#sendText({ userId, text });
    }

    try {
      const reply = await this.#dispatch(command, { userId, contextToken });
      return Array.isArray(reply) ? reply : splitReply(reply);
    } catch (error) {
      return [`⚠️ 命令失败: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /** Dispatch one parsed command to its handler. */
  async #dispatch(command, context) {
    switch (command.name) {
      case 'help':
        return HELP_TEXT;
      case 'status':
        return this.#status(context);
      case 'ws':
        return this.#workspace(command.args);
      case 'ls':
        return this.#listSessions(context);
      case 'new':
        return this.#newSession(command.args, context);
      case 'open':
      case 'use':
        return this.#open(command.args, context);
      case 'close':
      case 'detach':
        return this.#close(context);
      case 't':
      case 'tail':
        return this.#tail(command.args, context);
      case 'watch':
        return this.#watch(command.args, context);
      case 'stop':
        return this.#stop(context);
      case 'msg':
        return this.#sendText(context, command.args);
      case 'notify':
        return this.#notify(command.args);
      default:
        return `未知命令 /${command.name}\n\n${HELP_TEXT}`;
    }
  }

  /**
   * Plain text: the current session's next message.
   *
   * When nothing is current, the single obvious candidate is adopted instead of
   * rejecting the message: a phone user should not have to run a binding command
   * before every first message, and the reply says what happened.
   */
  async #sendText({ userId, text }, override) {
    const body = typeof override === 'string' && override.length > 0 ? override : text;
    if (typeof body !== 'string' || body.trim().length === 0) {
      return ['用法: /msg <文字>。不过直接发文字就行，不需要 /msg。'];
    }
    const state = await this.store.read();
    if (state.currents[userId] === undefined) {
      const items = await this.#sessions();
      const candidate = pickAutoTarget(items);
      if (candidate === undefined) {
        return [items.length === 0
          ? '当前还没有会话。用 /new 新建一个，或先 /ws list 选个工作区。'
          : `有 ${items.length} 个会话在跑，先选一个：\n\n${await this.#listSessions({ userId }, { header: false })}\n\n用 /open <序号> 选中后再发。`];
      }
      const opened = await this.attach.open({ userId, sessionId: candidate.sessionId });
      if (opened.error !== undefined) return [opened.error];
      const result = await this.attach.prompt({ userId, text: body });
      if (result.error !== undefined) return [result.error];
      return [`已自动接入「${titleOf(candidate)}」并发送。（以后直接发文字就是发给它）`];
    }

    const result = await this.attach.prompt({ userId, text: body });
    if (result.error !== undefined) return [result.error];
    return [];
  }

  /** `/status`: connection, current session, subscriptions, notification flags. */
  async #status({ userId }) {
    const state = await this.store.read();
    const workspace = await this.#currentWorkspace(state.currentWorkspaceId);
    const items = await this.#sessions().catch(() => []);
    const currentId = state.currents[userId];
    const current = items.find((item) => item.sessionId === currentId);
    const watched = (state.watches[userId] ?? []).map((sessionId) => {
      const match = items.find((item) => item.sessionId === sessionId);
      return `  • ${match === undefined ? shortId(sessionId) : titleOf(match)}`;
    });
    const pending = Object.keys(state.pendingQuestions).length;
    const held = state.pendingOut[userId]?.lines.length ?? 0;
    const channel = this.attach.isStreaming(userId) ? '已接入' : '未接入';

    return [
      `配对: ${state.paired ? '已配对' : '未配对'}`,
      `账号: ${state.accountId ?? '—'}`,
      `工作区: ${workspace ?? '—'}`,
      `当前会话: ${current === undefined ? (currentId ?? '未选中') : `${titleOf(current)}${current.running === true ? '（运行中）' : ''}`}`,
      `实时文字: ${channel}`,
      `订阅进展: ${watched.length === 0 ? '无' : `${watched.length} 个`}`,
      ...watched,
      `待补发推送: ${held} 条`,
      `待处理提问: ${pending} 个`,
      `通知: 完成=${flag(state.notify.turnEnd)} 错误=${flag(state.notify.error)} 审批=${flag(state.notify.approval)} 进展=${flag(state.notify.progress)} 实时文字=${flag(state.notify.stream)}`,
      '开关用法: /notify progress off',
    ].join('\n');
  }

  /** `/ws` family: list, use, create. */
  async #workspace(args) {
    const registry = this.ctx.workspaceRegistry;
    const [sub, ...rest] = args.split(/\s+/u).filter((part) => part.length > 0);
    const state = await this.store.read();

    if (sub === undefined || sub === 'list') {
      const workspaces = registry.list();
      if (workspaces.length === 0) return '还没有任何工作区。';
      const lines = workspaces.map((workspace) => workspaceLine(
        workspace,
        workspace.id === state.currentWorkspaceId ? '▶' : ' ',
      ));
      return ['工作区:', ...lines, '', '用 /ws use <序号> 切换'].join('\n');
    }

    if (sub === 'use') {
      const selector = rest.join(' ').trim();
      if (selector.length === 0) return '用法: /ws use <序号或名称>';
      const workspaces = registry.list();
      const chosen = pickWorkspace(workspaces, selector);
      if (chosen === undefined) return `找不到工作区: ${selector}`;
      await this.store.setCurrentWorkspace(chosen.id);
      return `已切换工作区: ${chosen.title ?? chosen.path ?? chosen.id}`;
    }

    if (sub === 'create') {
      const path = rest.join(' ').trim();
      if (path.length === 0) return '用法: /ws create <绝对路径>';
      // `WorkspaceCreateValue` is `{ workspace, created }` and its projection
      // spells the identity `workspaceId` — not `id`.
      const created = await this.ctx.workspaceController.create({ path });
      const workspaceId = created?.workspace?.workspaceId
        ?? created?.workspace?.id
        ?? created?.workspaceId
        ?? created?.id;
      if (typeof workspaceId === 'string') {
        await this.store.setCurrentWorkspace(workspaceId);
      }
      const title = created?.workspace?.title ?? path;
      return `已创建工作区: ${title}`;
    }

    return '用法: /ws [list|use <序号>|create <路径>]';
  }

  /**
   * `/ls`: sessions in the current workspace, falling back to all.
   *
   * @param {object} context
   * @param {object} [options]
   * @param {boolean} [options.header] include the trailing usage line
   */
  async #listSessions({ userId }, options = {}) {
    const state = await this.store.read();
    const items = await this.#sessions();

    let scoped = items;
    if (typeof state.currentWorkspaceId === 'string') {
      const workspace = this.ctx.workspaceRegistry.get(state.currentWorkspaceId);
      if (workspace !== undefined && Array.isArray(workspace.sessionIds)) {
        const allowed = new Set(workspace.sessionIds);
        const filtered = items.filter((item) => allowed.has(item.sessionId));
        if (filtered.length > 0) scoped = filtered;
      }
    }

    if (scoped.length === 0) {
      return state.currentWorkspaceId === null
        ? '还没有会话。用 /new 新建一个。'
        : '当前工作区还没有会话。用 /new 新建一个。';
    }

    const currentId = state.currents[userId];
    const watched = new Set(state.watches[userId] ?? []);
    const rows = scoped.slice(0, LIST_LIMIT).map(
      (item, index) => `${index + 1}. ${sessionLine(item, currentId, watched.has(item.sessionId))}`,
    );
    const lines = ['会话:', ...rows];
    if (options.header !== false) {
      lines.push('', '▶ 当前 ★ 已订阅 | 用 /open <序号> 选中，/t 看进展');
    } else {
      lines.push('', '▶ 当前 ★ 已订阅');
    }
    return lines.join('\n');
  }

  /** `/new`: create a session in the current workspace, adopt it, and title it. */
  async #newSession(args, { userId }) {
    const state = await this.store.read();
    const request = {};
    if (typeof state.currentWorkspaceId === 'string') {
      request.workspaceId = state.currentWorkspaceId;
    }
    const created = await this.ctx.sessionController.create(request);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string') return '新建会话失败：Host 没有返回 sessionId';
    if (args.length > 0) {
      try {
        await this.ctx.sessionController.rename({ sessionId, title: args });
      } catch {
        // A title is a nicety; the session exists either way.
      }
    }
    const label = `已新建会话${args.length > 0 ? `: ${args}` : ''}`;
    const opened = await this.attach.open({ userId, sessionId });
    if (opened.error !== undefined) return `${label}，但自动接入失败: ${opened.error}`;
    return `${label} 并接入。`;
  }

  /** `/open <序号|ID>`: make one session current and subscribe it. */
  async #open(args, { userId }) {
    const selector = args.trim();
    if (selector.length === 0) return `用法: /open <序号|ID>\n\n${await this.#listSessions({ userId })}`;
    const items = await this.#sessions();
    const target = pickSession(items, selector);
    if (target === undefined) return `找不到会话: ${selector}\n\n${await this.#listSessions({ userId })}`;
    const opened = await this.attach.open({ userId, sessionId: target.sessionId });
    if (opened.error !== undefined) return opened.error;
    return [
      `已接入「${titleOf(target)}」${target.running === true ? '（正在运行）' : ''}`,
      '',
      '直接发文字就会发给它；/t 看进展，/close 断开。',
    ].join('\n');
  }

  /** `/close`: stop mirroring, keep nothing current. */
  async #close({ userId }) {
    const state = await this.store.read();
    const had = state.currents[userId];
    await this.attach.close(userId);
    return had === undefined ? '当前没有接入会话。' : '已断开当前会话（订阅保留，仍会收到进展推送）。';
  }

  /**
   * `/tail [序号|ID]`: what is the session doing right now.
   *
   * Live progress when this process watched it happen; otherwise the durable
   * event log is replayed, so the answer is never "I have not seen that one".
   */
  async #tail(args, { userId }) {
    const state = await this.store.read();
    const items = await this.#sessions();
    const selector = args.trim();
    let target;
    if (selector.length > 0) {
      target = pickSession(items, selector);
      if (target === undefined) return `找不到会话: ${selector}\n\n${await this.#listSessions({ userId })}`;
    } else {
      const currentId = state.currents[userId];
      target = items.find((item) => item.sessionId === currentId);
      if (target === undefined && items.length > 0) target = pickAutoTarget(items);
      if (target === undefined) {
        return `还没有选中会话。\n\n${await this.#listSessions({ userId })}`;
      }
    }

    const title = titleOf(target);
    const live = this.tracker?.peek(target.sessionId);
    if (live !== undefined) {
      return this.tracker.render(target.sessionId, { title, limit: 15 });
    }
    try {
      const inspection = await this.ctx.sessionController.inspect(
        target.sessionId,
        AbortSignal.timeout(10_000),
      );
      return renderFromEvents(inspection?.events ?? [], { title, lines: 15 });
    } catch (error) {
      return `读取会话进展失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** `/watch [序号|ID|off]`: manage progress subscriptions. */
  async #watch(args, { userId }) {
    const state = await this.store.read();
    const items = await this.#sessions();
    const [sub, ...rest] = args.split(/\s+/u).filter((part) => part.length > 0);

    if (sub === undefined) {
      const list = state.watches[userId] ?? [];
      if (list.length === 0) {
        return [
          '还没有订阅任何会话。',
          '',
          '正在运行的会话会自动推送进展；用 /watch <序号> 额外固定订阅一个。',
        ].join('\n');
      }
      const rows = list.map((sessionId) => {
        const match = items.find((item) => item.sessionId === sessionId);
        return `  • ${match === undefined ? shortId(sessionId) : titleOf(match)}`;
      });
      return ['已订阅:', ...rows, '', '用 /watch off <序号> 取消。'].join('\n');
    }

    if (sub === 'off') {
      const selector = rest.join(' ').trim();
      if (selector.length === 0) {
        await this.store.clearWatches(userId);
        return '已取消全部进展订阅（正在运行的会话仍会自动推送）。';
      }
      const target = pickSession(items, selector);
      if (target === undefined) return `找不到会话: ${selector}`;
      await this.store.setWatch(userId, target.sessionId, false);
      return `已取消订阅「${titleOf(target)}」。`;
    }

    const target = pickSession(items, sub);
    if (target === undefined) {
      return `找不到会话: ${sub}\n\n${await this.#listSessions({ userId })}`;
    }
    await this.store.setWatch(userId, target.sessionId, true);
    return `已订阅「${titleOf(target)}」的进展推送。`;
  }

  /** `/stop`: ask the current session's agent to stop. */
  async #stop({ userId }) {
    const state = await this.store.read();
    const sessionId = state.currents[userId];
    if (typeof sessionId !== 'string') return '还没有选中会话，无法停止。';
    this.ctx.sessionController.cancel({ sessionId });
    return '已请求停止当前任务。';
  }

  /** `/notify <key> <on|off>`: flip one notification class. */
  async #notify(args) {
    const [key, value] = args.split(/\s+/u).filter((part) => part.length > 0);
    const flagName = NOTIFY_FLAGS[key];
    if (flagName === undefined || !['on', 'off'].includes(value)) {
      return [
        '用法: /notify <键> <on|off>',
        '键: turn(整轮完成) error(报错) approval(需要确认) progress(进展推送) stream(实时文字)',
      ].join('\n');
    }
    const state = await this.store.setNotify(flagName, value === 'on');
    return `通知 ${key} = ${flag(state.notify[flagName])}`;
  }

  /** Every visible session, with titles attached. */
  async #sessions() {
    const listing = await this.ctx.sessionController.list({}, AbortSignal.timeout(15_000));
    const raw = Array.isArray(listing?.items) ? listing.items : [];
    return withTitles(this.ctx, raw);
  }

  /** Resolve the current workspace's display name. */
  async #currentWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string') return undefined;
    const workspace = this.ctx.workspaceRegistry.get(workspaceId);
    if (workspace === undefined) return undefined;
    return workspace.title ?? workspace.path ?? workspace.id;
  }
}

/** One session row's display title. */
function titleOf(item) {
  return typeof item?.title === 'string' && item.title.length > 0 ? item.title : shortId(item?.sessionId);
}

/**
 * The one session a first plain-text message should obviously go to.
 *
 * Exactly one running session is unambiguous; exactly one session at all is
 * nearly as clear; anything else is a real choice and the user is asked.
 *
 * @param {object[]} items
 * @returns {object | undefined}
 */
export function pickAutoTarget(items) {
  const list = Array.isArray(items) ? items : [];
  const running = list.filter((item) => item.running === true);
  if (running.length === 1) return running[0];
  if (list.length === 1) return list[0];
  return undefined;
}

/** Render one notification flag as 开/关. */
function flag(value) {
  return value === true ? '开' : '关';
}

/** The `/help` body. */
export const HELP_TEXT = [
  '日常只用这三条:',
  '  直接发文字      发给当前会话（没选时会自动接入正在跑的那个）',
  '  /t              看当前会话正在做什么（进度快照）',
  '  /ls 然后 /open 2  换个会话',
  '',
  '其它:',
  '  /ws list|use|create   工作区',
  '  /new [标题]           新建会话',
  '  /watch [序号|off]     订阅/取消进展推送',
  '  /close                断开当前会话',
  '  /stop                 停止当前任务',
  '  /status               状态与开关',
  '  /notify <键> <on|off> turn/error/approval/progress/stream',
  '  /help                 本帮助',
].join('\n');
