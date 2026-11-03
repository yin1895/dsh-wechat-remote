/**
 * Delivery harness: the outbound queue and the progress pusher.
 *
 * These two own the difference between "the feature exists" and "the phone
 * actually showed me something", so they are tested on their own: ordering,
 * merging, the held-back backlog, what a digest contains, and the silence alarm.
 *
 * Run with: node test/delivery.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../lib/state-store.js';
import { Outbox } from '../lib/outbox.js';
import { Notifier } from '../lib/notification.js';
import { ProgressTracker } from '../lib/progress.js';
import { ProgressPusher, DEFAULT_PROGRESS_INTERVAL_MS, DEFAULT_PROGRESS_GAP_MS } from '../lib/pusher.js';

let passed = 0;
let failed = 0;

/** Throwaway Harness homes, removed when the process exits. */
const homes = [];
process.on('exit', () => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-remote-delivery-'));
  homes.push(dir);
  return dir;
}

function store() {
  return new StateStore({ dshHomePath: tempHome(), get: () => undefined });
}

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

/** Wait until `check` is true, or give up. */
async function until(check, timeoutMs = 2_000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

// ---- outbox ----

await test('queued messages are delivered in order', async () => {
  const state = store();
  const sent = [];
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push({ userId, text }); return true; },
  });
  outbox.enqueue('u1', '第一条');
  outbox.enqueue('u1', '第二条');
  assert.ok(await until(() => sent.length === 2), 'both delivered');
  assert.deepEqual(sent.map((item) => item.text), ['第一条', '第二条']);
  outbox.stop();
});

await test('bursty progress with one tag merges into one message', async () => {
  const state = store();
  const sent = [];
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push(text); return true; },
    now: () => Date.now(),
  });
  outbox.enqueue('u1', '🔧 read: a.js', { tag: 'progress:s-1' });
  outbox.enqueue('u1', '🔧 read: b.js', { tag: 'progress:s-1' });
  outbox.enqueue('u1', '🔧 pwsh: npm test', { tag: 'progress:s-1' });
  assert.ok(await until(() => sent.length === 1), 'merged into one body');
  assert.equal(sent[0].split('\n').length, 3);
  outbox.stop();
});

await test('different tags are not merged', async () => {
  const state = store();
  const sent = [];
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push(text); return true; },
  });
  outbox.enqueue('u1', '进展 A', { tag: 'progress:s-1' });
  outbox.enqueue('u1', '进展 B', { tag: 'progress:s-2' });
  assert.ok(await until(() => sent.length === 2), 'two bodies');
  outbox.stop();
});

await test('a refused send is held and re-sent when the window opens', async () => {
  const state = store();
  const sent = [];
  let reachable = false;
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => {
      if (!reachable) return false;
      sent.push(text);
      return true;
    },
  });

  outbox.enqueue('u1', '📡 进展 1');
  outbox.enqueue('u1', '📡 进展 2');
  const held = await until(async () => (await state.readPendingOut('u1'))?.lines.length === 2);
  assert.ok(held, 'both bodies persisted for a later window');
  assert.equal(outbox.channelState('u1'), 'held');

  reachable = true;
  const flushed = await outbox.flushPending('u1');
  assert.equal(flushed, 2);
  assert.ok(await until(() => sent.length === 1), 'backlog delivered as one body');
  assert.ok(sent[0].startsWith('📬 补发 2 条未送达消息'), sent[0]);
  assert.ok(sent[0].includes('📡 进展 1') && sent[0].includes('📡 进展 2'));
  assert.equal(await state.readPendingOut('u1'), null, 'backlog cleared');
  outbox.stop();
});

await test('a held backlog survives a restart', async () => {
  const ctx = { dshHomePath: tempHome(), get: () => undefined };
  const first = new Outbox({
    store: new StateStore(ctx),
    send: async () => false,
  });
  first.enqueue('u1', '📡 出门期间做的事');
  assert.ok(await until(() => first.channelState('u1') === 'held'));
  first.stop();

  const sent = [];
  const second = new Outbox({
    store: new StateStore(ctx),
    send: async (userId, text) => { sent.push(text); return true; },
  });
  assert.equal(await second.flushPending('u1'), 1);
  assert.ok(await until(() => sent.length === 1));
  assert.ok(sent[0].includes('📡 出门期间做的事'));
  second.stop();
});

// ---- pusher ----

/**
 * A pusher over a controllable tracker and clock.
 *
 * The clock runs on real time with a settable offset, so delivery gaps behave
 * like production while a test can still jump five minutes forward.
 */
function pusherFixture(options = {}) {
  const state = store();
  const sent = [];
  const clock = { offset: 0, now: () => Date.now() + clock.offset };
  const tracker = new ProgressTracker({ ctx: { on: () => () => undefined }, now: () => clock.now() });
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push({ userId, text }); return true; },
    now: () => clock.now(),
  });
  const pusher = new ProgressPusher({
    ctx: {},
    store: state,
    tracker,
    outbox,
    config: () => ({ progressIntervalMs: DEFAULT_PROGRESS_INTERVAL_MS }),
    titleOf: async (sessionId) => options.titles?.[sessionId],
    now: () => clock.now(),
  });
  return { state, sent, clock, tracker, outbox, pusher };
}

await test('a running session pushes its actions without being opened', async () => {
  const fixture = pusherFixture({ titles: { 's-1': '主会话' } });
  await fixture.state.markPaired({ botToken: 'tok', baseUrl: 'u', accountId: 'a' });
  await fixture.state.setWatch('u1', 's-2', true);

  fixture.tracker.observe('s-1', { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } });
  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 2, time: 1_100, data: { name: 'pwsh', arguments: '{"command":"npm test"}' } });

  const queued = await fixture.pusher.tick();
  assert.ok(queued >= 1, 'the busy session was reported even though u1 never opened it');
  assert.ok(await until(() => fixture.sent.length >= 1));
  const body = fixture.sent.map((item) => item.text).join('\n');
  assert.ok(body.includes('主会话'), body);
  assert.ok(body.includes('🔧 pwsh: npm test'), body);
  fixture.outbox.stop();
});

await test('each activity line is pushed exactly once', async () => {
  const fixture = pusherFixture({ titles: { 's-1': 'T' } });
  await fixture.state.markPaired({ botToken: 't', baseUrl: 'u', accountId: 'a' });
  await fixture.state.setWatch('u1', 's-1', true);

  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 1, time: 1_000, data: { name: 'read', arguments: '{"file_path":"a"}' } });
  await fixture.pusher.tick();
  await until(() => fixture.sent.length === 1);
  await fixture.pusher.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.sent.length, 1, 'no repeat on the next tick');

  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 2, time: 2_000, data: { name: 'read', arguments: '{"file_path":"b"}' } });
  fixture.clock.offset = DEFAULT_PROGRESS_GAP_MS + 1_000;
  await fixture.pusher.tick();
  assert.ok(await until(() => fixture.sent.length === 2), 'the new line is delivered');
  assert.ok(fixture.sent[1].text.includes('b'), fixture.sent[1].text);
  fixture.outbox.stop();
});

await test('digests are rate limited per user and accumulate instead of dropping', async () => {
  const fixture = pusherFixture({ titles: { 's-1': 'T' } });
  await fixture.state.markPaired({ botToken: 't', baseUrl: 'u', accountId: 'a' });
  await fixture.state.setWatch('u1', 's-1', true);

  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 1, time: 1_000, data: { name: 'read', arguments: '{"file_path":"a"}' } });
  assert.equal(await fixture.pusher.tick(), 1, 'the first digest goes out');

  // Two more actions inside the gap: looking again must not speak again.
  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 2, time: 2_000, data: { name: 'read', arguments: '{"file_path":"b"}' } });
  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 3, time: 3_000, data: { name: 'read', arguments: '{"file_path":"c"}' } });
  fixture.clock.offset = 20_000;
  assert.equal(await fixture.pusher.tick(), 0, 'inside the gap nothing is sent');

  fixture.clock.offset = DEFAULT_PROGRESS_GAP_MS + 2_000;
  assert.equal(await fixture.pusher.tick(), 1, 'after the gap the accumulated lines go out together');
  assert.ok(await until(() => fixture.sent.length === 2), 'two bodies total, not four');
  assert.ok(fixture.sent[1].text.includes('b') && fixture.sent[1].text.includes('c'), fixture.sent[1].text);
  fixture.outbox.stop();
});

await test('progress pushes obey the progress toggle', async () => {
  const fixture = pusherFixture();
  await fixture.state.markPaired({ botToken: 't', baseUrl: 'u', accountId: 'a' });
  await fixture.state.setWatch('u1', 's-1', true);
  await fixture.state.setNotify('progress', false);
  fixture.tracker.observe('s-1', { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } });
  fixture.tracker.observe('s-1', { type: 'tool/call', seq: 2, time: 1_100, data: { name: 'read', arguments: '{"file_path":"a"}' } });
  assert.equal(await fixture.pusher.tick(), 0);
  fixture.outbox.stop();
});

await test('a silent running session is reported as alive once', async () => {
  const fixture = pusherFixture({ titles: { 's-1': '长跑' } });
  await fixture.state.markPaired({ botToken: 't', baseUrl: 'u', accountId: 'a' });
  await fixture.state.setWatch('u1', 's-1', true);

  fixture.tracker.observe('s-1', { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } });
  // Five quiet minutes, with no event after the turn opened.
  fixture.clock.offset = 5 * 60_000;

  assert.ok(await fixture.pusher.tick() >= 1, 'the alarm fired');
  assert.ok(await until(() => fixture.sent.some((item) => item.text.includes('还在运行'))), 'alarm delivered');
  const alarms = () => fixture.sent.filter((item) => item.text.includes('还在运行')).length;
  assert.equal(alarms(), 1);

  await fixture.pusher.tick();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(alarms(), 1, 'the alarm does not repeat while the same turn is quiet');
  fixture.outbox.stop();
});

// ---- notifications ----

/** A minimal event bus standing in for the host context. */
function bus() {
  const handlers = new Map();
  return {
    ctx: {
      on(name, fn) {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
    },
    fire(name, payload) {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`no listener for ${name}`);
      return handler(payload);
    },
  };
}

await test('a completion push names the session and quotes the closing message', async () => {
  const state = store();
  const sent = [];
  const events = bus();
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push(text); return true; },
  });
  const notifier = new Notifier({
    ctx: events.ctx,
    store: state,
    outbox,
    config: () => ({}),
    summarize: async () => ({ title: '主会话', lastText: '测试全绿，两个文件改了。' }),
  });
  notifier.start();
  await state.setCurrent('u1', 's-1');

  events.fire('agent/status', { agent: { id: 's-1' }, status: 'running' });
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  events.fire('agent/status', { agent: { id: 's-1' }, status: 'idle' });

  assert.ok(await until(() => sent.length === 1), 'one completion push');
  assert.ok(sent[0].includes('主会话'), sent[0]);
  assert.ok(sent[0].includes('测试全绿，两个文件改了。'), sent[0]);
  assert.ok(sent[0].includes('/t'), 'points at the pull path');

  const record = (await state.read()).unconfirmed.u1;
  assert.equal(record.sessionId, 's-1', 'recorded as unacknowledged until the user speaks');
  assert.ok(record.text.includes('主会话'));

  notifier.stop();
  outbox.stop();
});

await test('a short turn is not worth a notification', async () => {
  const state = store();
  const sent = [];
  const events = bus();
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push(text); return true; },
  });
  const notifier = new Notifier({ ctx: events.ctx, store: state, outbox, config: () => ({}) });
  notifier.start();
  await state.setCurrent('u1', 's-1');
  events.fire('agent/status', { agent: { id: 's-1' }, status: 'running' });
  events.fire('agent/status', { agent: { id: 's-1' }, status: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sent.length, 0);
  notifier.stop();
  outbox.stop();
});

await test('an unrelated session does not notify this user', async () => {
  const state = store();
  const sent = [];
  const events = bus();
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push(text); return true; },
  });
  const notifier = new Notifier({ ctx: events.ctx, store: state, outbox, config: () => ({}) });
  notifier.start();
  await state.setCurrent('u1', 's-1');
  events.fire('agent/error', { agent: { id: 's-other' }, error: new Error('boom') });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sent.length, 0, 'no cross-talk between sessions');
  notifier.stop();
  outbox.stop();
});

await test('an error reaches every user subscribed to the session', async () => {
  const state = store();
  const sent = [];
  const events = bus();
  const outbox = new Outbox({
    store: state,
    send: async (userId, text) => { sent.push({ userId, text }); return true; },
  });
  const notifier = new Notifier({ ctx: events.ctx, store: state, outbox, config: () => ({}) });
  notifier.start();
  await state.setCurrent('u1', 's-1');
  await state.setWatch('u2', 's-1', true);
  events.fire('agent/error', { agent: { id: 's-1' }, error: new Error('boom') });
  assert.ok(await until(() => sent.length === 2), 'both watchers told');
  assert.deepEqual(sent.map((item) => item.userId).sort(), ['u1', 'u2']);
  notifier.stop();
  outbox.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
