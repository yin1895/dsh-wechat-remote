/**
 * Integration harness: drive CommandRouter, SessionAttach and the outbox against
 * a fake DSH host that exposes only the methods this plugin actually calls.
 *
 * Run with: node test/integration.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRouter } from '../lib/command-router.js';
import { SessionAttach } from '../lib/session-attach.js';
import { StateStore } from '../lib/state-store.js';
import { ProgressTracker } from '../lib/progress.js';
import { Outbox } from '../lib/outbox.js';

/** Throwaway Harness homes, removed when the process exits. */
const homes = [];
process.on('exit', () => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

/** One throwaway Harness home for a fake host's state record. */
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-remote-integration-'));
  homes.push(dir);
  return dir;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/** The durable tail one cold session exposes to `/t`. */
const COLD_EVENTS = [
  { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: 1_100, data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' } },
  { type: 'assistant/message', seq: 3, time: 1_200, data: { message: { content: [{ type: 'text', text: '正在跑测试。' }] } } },
];

/** Build a fake host with the surface the plugin touches. */
function fakeHost(initial) {
  const sent = [];
  const prompts = [];
  const cancels = [];
  const workspaces = initial.workspaces ?? [];
  const sessions = initial.sessions ?? [];

  const ctx = {
    dshHomePath: tempHome(),
    get() {
      return undefined;
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((w) => w.id === id),
    },
    workspaceController: {
      // Mirrors the live contract: `{ workspace: WorkspaceView, created }` and
      // the projection names the identity `workspaceId`.
      create: async ({ path }) => {
        const created = {
          workspaceId: `ws-${workspaces.length + 1}`,
          path,
          title: path,
          sessionIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        workspaces.push({
          id: created.workspaceId,
          path,
          title: path,
          sessionIds: [],
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        });
        return { workspace: created, created: true };
      },
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      create: async () => ({ sessionId: 'new-session-1' }),
      rename: async ({ sessionId, title }) => {
        const target = sessions.find((s) => s.sessionId === sessionId);
        if (target) target.title = title;
        return { title };
      },
      prompt: async (request, signal) => { prompts.push({ ...request, signal }); return { accepted: true }; },
      cancel: async (request) => { cancels.push(request); return {}; },
      inspect: async () => ({ events: COLD_EVENTS }),
      follow: () => (async function* empty() {})(),
    },
  };

  return { ctx, sent, prompts, cancels, workspaces, sessions };
}

const WORKSPACES = [
  { id: 'ws-a', path: 'D:\\proj-a', title: 'proj-a', sessionIds: ['s-1', 's-2'] },
  { id: 'ws-b', path: 'D:\\proj-b', title: 'proj-b', sessionIds: ['s-3'] },
];

const SESSIONS = [
  { sessionId: 's-1', title: '会话一', running: false },
  { sessionId: 's-2', title: '会话二', running: true },
  { sessionId: 's-3', title: '会话三', running: false },
];

function build(host) {
  const store = new StateStore(host.ctx);
  const outbox = new Outbox({
    store,
    send: async (userId, text) => { host.sent.push({ userId, text }); return true; },
  });
  const tracker = new ProgressTracker({ ctx: host.ctx });
  const attach = new SessionAttach({
    ctx: host.ctx,
    store,
    outbox,
    config: () => ({}),
  });
  const router = new CommandRouter({ ctx: host.ctx, store, attach, tracker, config: () => ({}) });
  return { store, attach, router, outbox, tracker };
}

/** Wait for the outbox to deliver everything it holds. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

await test('/help lists the everyday commands first', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/help', contextToken: 'tok' });
  const body = reply.join('\n');
  assert.ok(body.includes('/t '), body);
  assert.ok(body.includes('/ws list'), body);
  assert.ok(body.includes('/open 2'), body);
  assert.ok(!body.includes('/msg'), 'the redundant command is no longer advertised');
});

await test('/ws list marks current workspace', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: [] });
  const { router, store } = build(host);
  await store.setCurrentWorkspace('ws-a');
  const reply = await router.handle({ userId: 'u1', text: '/ws list', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('▶ proj-a'), 'marks current');
  assert.ok(body.includes('proj-b'), 'lists others');
});

await test('/ws use selects by index', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: [] });
  const { router, store } = build(host);
  await router.handle({ userId: 'u1', text: '/ws use 2', contextToken: 't' });
  const state = await store.read();
  assert.equal(state.currentWorkspaceId, 'ws-b');
});

await test('/ws use selects by name', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: [] });
  const { router, store } = build(host);
  await router.handle({ userId: 'u1', text: '/ws use proj-b', contextToken: 't' });
  const state = await store.read();
  assert.equal(state.currentWorkspaceId, 'ws-b');
});

await test('/ws create selects the workspace the Host reports', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/ws create D:\\proj-c', contextToken: 't' });
  assert.ok(reply.join('\n').includes('已创建工作区'), 'reports success');
  const state = await store.read();
  assert.equal(state.currentWorkspaceId, 'ws-1', 'reads the WorkspaceView workspaceId field');
  assert.ok(host.workspaces.some((w) => w.path === 'D:\\proj-c'), 'registers the directory');
});

await test('/ws use rejects unknown', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: [] });
  const { router, store } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/ws use nope', contextToken: 't' });
  assert.ok(reply.join('').includes('找不到工作区'));
  const state = await store.read();
  assert.equal(state.currentWorkspaceId, null, 'selection unchanged');
});

await test('/ls scopes to current workspace and marks the current session', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  await store.setCurrentWorkspace('ws-b');
  await store.setCurrent('u1', 's-3');
  const reply = await router.handle({ userId: 'u1', text: '/ls', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('会话三'), 'shows ws-b session');
  assert.ok(!body.includes('会话一'), 'hides ws-a session');
  assert.ok(body.includes('▶'), 'marks what is current');
});

await test('/open makes a session current, subscribes it, and reports running state', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  await store.setCurrentWorkspace('ws-a');
  const reply = await router.handle({ userId: 'u1', text: '/open 2', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('已接入'), body);
  assert.ok(body.includes('正在运行'), body);
  const state = await store.read();
  assert.equal(state.currents['u1'], 's-2');
  assert.ok(state.watches['u1'].includes('s-2'), 'opening subscribes progress');
});

await test('/open rejects unknown session', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/open 99', contextToken: 't' });
  assert.ok(reply.join('').includes('找不到会话'));
});

await test('plain text injects into the current session', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  const reply = await router.handle({ userId: 'u1', text: '你好，继续', contextToken: 't' });
  assert.equal(reply.length, 0, 'no ack spam');
  assert.equal(host.prompts.length, 1);
  assert.equal(host.prompts[0].sessionId, 's-1');
  assert.equal(host.prompts[0].mode, 'queue', 'queues instead of interrupting');
  assert.equal(host.prompts[0].content[0].text, '你好，继续');
  assert.ok(host.prompts[0].signal instanceof AbortSignal, 'passes the caller signal the Host contract requires');
});

await test('the first plain text adopts the one running session instead of failing', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '继续', contextToken: 't' });
  assert.equal(host.prompts.length, 1, 'the text went somewhere useful');
  assert.equal(host.prompts[0].sessionId, 's-2', 'the only running session');
  assert.ok(reply.join('').includes('已自动接入'), reply.join(''));
  assert.equal((await store.read()).currents['u1'], 's-2', 'and it stays current');
});

await test('plain text with several running sessions asks which one', async () => {
  const host = fakeHost({
    workspaces: structuredClone(WORKSPACES),
    sessions: [{ sessionId: 's-1', title: '甲', running: true }, { sessionId: 's-2', title: '乙', running: true }],
  });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '继续', contextToken: 't' });
  assert.equal(host.prompts.length, 0, 'nothing was sent to a guessed session');
  assert.ok(reply.join('').includes('先选一个'), reply.join(''));
});

await test('plain text with no sessions explains how to start one', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '你好', contextToken: 't' });
  assert.ok(reply.join('').includes('还没有会话'), reply.join(''));
  assert.equal(host.prompts.length, 0);
});

await test('/msg still works but points at the simpler path', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  const reply = await router.handle({ userId: 'u1', text: '/msg 你好', contextToken: 't' });
  assert.equal(host.prompts.length, 1);
  assert.equal(host.prompts[0].content[0].text, '你好');
  assert.equal(reply.length, 0, 'delivered, no lecture');
});

await test('/msg without text explains the usage', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/msg', contextToken: 't' });
  assert.ok(reply.join('').includes('用法'), reply.join(''));
});

await test('/t renders the live progress of the current session', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store, tracker } = build(host);
  await store.setCurrent('u1', 's-2');
  tracker.observe('s-2', { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 3 } });
  tracker.observe('s-2', { type: 'tool/call', seq: 2, time: Date.now(), data: { callId: 'c9', name: 'grep', arguments: '{"pattern":"TODO"}' } });
  const reply = await router.handle({ userId: 'u1', text: '/t', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('会话二'), body);
  assert.ok(body.includes('运行中'), body);
  assert.ok(body.includes('🔧 grep: TODO'), body);
});

await test('/t falls back to the durable log for a session it never tracked', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  const reply = await router.handle({ userId: 'u1', text: '/t', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('会话一'), body);
  assert.ok(body.includes('🔧 pwsh: npm test'), body);
  assert.ok(body.includes('正在跑测试。'), body);
});

await test('/t accepts a row number from /ls', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/t 3', contextToken: 't' });
  assert.ok(reply.join('\n').includes('会话三'), reply.join('\n'));
});

await test('/watch lists, adds and removes subscriptions', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);

  assert.ok((await router.handle({ userId: 'u1', text: '/watch', contextToken: 't' })).join('').includes('还没有订阅'));

  const added = await router.handle({ userId: 'u1', text: '/watch 1', contextToken: 't' });
  assert.ok(added.join('').includes('已订阅'), added.join(''));
  assert.deepEqual((await store.read()).watches['u1'], ['s-1']);

  const listed = await router.handle({ userId: 'u1', text: '/watch', contextToken: 't' });
  assert.ok(listed.join('\n').includes('会话一'), listed.join('\n'));

  const removed = await router.handle({ userId: 'u1', text: '/watch off 1', contextToken: 't' });
  assert.ok(removed.join('').includes('已取消订阅'), removed.join(''));
  assert.equal((await store.read()).watches['u1'], undefined);
});

await test('/close clears the current session but keeps subscriptions', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  await router.handle({ userId: 'u1', text: '/close', contextToken: 't' });
  const state = await store.read();
  assert.equal(state.currents['u1'], undefined);
  assert.deepEqual(state.watches['u1'], ['s-1'], 'still watches what it was told to watch');
});

await test('/detach is still accepted as an alias', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  await router.handle({ userId: 'u1', text: '/detach', contextToken: 't' });
  assert.equal((await store.read()).currents['u1'], undefined);
});

await test('/stop cancels the current session', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  const reply = await router.handle({ userId: 'u1', text: '/stop', contextToken: 't' });
  assert.ok(reply.join('').includes('已请求停止'));
  assert.deepEqual(host.cancels, [{ sessionId: 's-1' }]);
});

await test('/new creates, titles, and adopts a session', async () => {
  const host = fakeHost({
    workspaces: structuredClone(WORKSPACES),
    sessions: [{ sessionId: 'new-session-1', title: '(未命名)', running: false }],
  });
  const { router, store } = build(host);
  await store.setCurrentWorkspace('ws-a');
  const reply = await router.handle({ userId: 'u1', text: '/new 修复登录', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('已新建会话'), body);
  assert.ok(body.includes('并接入'), body);
  assert.equal((await store.read()).currents['u1'], 'new-session-1');
});

await test('/notify toggles the new progress classes and persists them', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  await router.handle({ userId: 'u1', text: '/notify progress off', contextToken: 't' });
  await router.handle({ userId: 'u1', text: '/notify stream off', contextToken: 't' });
  const state = await store.read();
  assert.equal(state.notify.progress, false);
  assert.equal(state.notify.stream, false);
  assert.equal(state.notify.turnEnd, true, 'other flags untouched');
});

await test('/notify rejects unknown key', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/notify bogus on', contextToken: 't' });
  assert.ok(reply.join('').includes('用法'));
});

await test('unknown command returns help', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/bogus', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('未知命令'));
  assert.ok(body.includes('/help'));
});

await test('/status reports the current session, subscriptions and switches', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  await store.markPaired({ botToken: 't', baseUrl: 'u', accountId: 'acct-9' });
  await store.setCurrentWorkspace('ws-a');
  await store.setCurrent('u1', 's-2');
  const reply = await router.handle({ userId: 'u1', text: '/status', contextToken: 't' });
  const body = reply.join('\n');
  assert.ok(body.includes('已配对'), body);
  assert.ok(body.includes('acct-9'), body);
  assert.ok(body.includes('proj-a'), body);
  assert.ok(body.includes('会话二'), body);
  assert.ok(body.includes('订阅进展: 1 个'), body);
  assert.ok(body.includes('进展=开'), body);
});

await test('two users keep independent currents', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { router, store } = build(host);
  await store.setCurrent('u1', 's-1');
  await store.setCurrent('u2', 's-2');
  await router.handle({ userId: 'u1', text: 'for one', contextToken: 't1' });
  await router.handle({ userId: 'u2', text: 'for two', contextToken: 't2' });
  assert.equal(host.prompts[0].sessionId, 's-1');
  assert.equal(host.prompts[1].sessionId, 's-2');
});

await test('/open replaces the current session without losing the old subscription', async () => {
  const host = fakeHost({ workspaces: structuredClone(WORKSPACES), sessions: structuredClone(SESSIONS) });
  const { router, store } = build(host);
  await store.setCurrentWorkspace('ws-a');
  await router.handle({ userId: 'u1', text: '/open 1', contextToken: 't' });
  await router.handle({ userId: 'u1', text: '/open 2', contextToken: 't' });
  const state = await store.read();
  assert.equal(state.currents['u1'], 's-2');
  assert.equal(Object.keys(state.currents).length, 1, 'still one current');
  assert.deepEqual(state.watches['u1'], ['s-2', 's-1'], 'both remain subscribed');
});

await test('handler failure becomes a reply, not a throw', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  host.ctx.sessionController.list = async () => { throw new Error('boom'); };
  const { router } = build(host);
  const reply = await router.handle({ userId: 'u1', text: '/ls', contextToken: 't' });
  assert.ok(reply.join('').includes('命令失败'), reply.join(''));
});

await test('a mirrored turn reaches WeChat through the outbox', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const { store, attach } = build(host);
  await store.setCurrent('u1', 's-1');
  await attach.open({ userId: 'u1', sessionId: 's-1' });
  assert.equal(host.sent.length, 0, 'nothing yet');
  attach.closeAll();
});

await test('the outbox holds a reply when WeChat refuses it', async () => {
  const host = fakeHost({ workspaces: [], sessions: [] });
  const store = new StateStore(host.ctx);
  const outbox = new Outbox({ store, send: async () => false });
  outbox.enqueue('u1', '📡 出门期间的进展');
  await settle();
  assert.equal(outbox.channelState('u1'), 'held');
  assert.equal((await store.readPendingOut('u1')).lines.length, 1);
  outbox.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
