/**
 * Progress harness: event → phone line, live tracking, and the `/tail` body,
 * including the cold-session replay path that runs when the plugin loaded after
 * the session did.
 *
 * Run with: node test/progress.mjs
 */

import assert from 'node:assert/strict';
import {
  ProgressTracker,
  briefArguments,
  describeEvent,
  formatElapsed,
  renderFromEvents,
  sessionIdOf,
} from '../lib/progress.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

// ---- argument briefing ----

test('brief picks the path out of a read call', () => {
  assert.equal(
    briefArguments(JSON.stringify({ file_path: 'D:\\proj\\lib\\index.js', offset: 1 })),
    'D:\\proj\\lib\\index.js',
  );
});

test('brief prefers an explicit description', () => {
  assert.equal(
    briefArguments(JSON.stringify({ description: 'run the suite', command: 'npm test' })),
    'run the suite',
  );
});

test('brief falls back to the command', () => {
  assert.equal(briefArguments(JSON.stringify({ command: 'npm run build' })), 'npm run build');
});

test('brief collapses whitespace and truncates', () => {
  const raw = JSON.stringify({ command: `echo ${'x'.repeat(200)}` });
  const brief = briefArguments(raw);
  assert.ok(brief.length <= 70, `too long: ${brief.length}`);
  assert.ok(!brief.includes('\n'));
});

test('brief survives non-JSON arguments', () => {
  assert.equal(briefArguments('not json at all'), 'not json at all');
});

test('brief of empty arguments is empty', () => {
  assert.equal(briefArguments(''), '');
  assert.equal(briefArguments('{}'), '');
});

test('briefs mask credentials instead of publishing them', () => {
  const brief = briefArguments(JSON.stringify({
    command: 'curl -H "Authorization: Bearer abcdef1234567890ghij" https://api.example.com',
  }));
  assert.ok(!brief.includes('abcdef1234567890ghij'), brief);
  assert.ok(brief.includes('***'), brief);

  const keyed = briefArguments(JSON.stringify({ command: 'deploy --api_key=sk-live-9f2b7c1d4e6a8b0c' }));
  assert.ok(!keyed.includes('9f2b7c1d4e6a8b0c'), keyed);

  const hex = briefArguments(JSON.stringify({ command: 'git push https://x:deadbeefdeadbeefdeadbeefdeadbeef@github.com/a/b' }));
  assert.ok(!hex.includes('deadbeefdeadbeefdeadbeefdeadbeef'), hex);
});

test('ordinary briefs are left alone', () => {
  assert.equal(briefArguments(JSON.stringify({ command: 'npm test' })), 'npm test');
  assert.equal(briefArguments(JSON.stringify({ file_path: 'D:\\p\\lib\\index.js' })), 'D:\\p\\lib\\index.js');
});

// ---- event description ----

test('tool call becomes one activity line', () => {
  const line = describeEvent({
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem' }) },
  });
  assert.equal(line.kind, 'tool');
  assert.equal(line.text, '🔧 pwsh: Get-ChildItem');
});

test('a failed tool result names the tool that failed', () => {
  const line = describeEvent(
    { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true }, error: { code: 'exit 1' } } },
    (callId) => (callId === 'c1' ? 'pwsh' : undefined),
  );
  assert.equal(line.kind, 'error');
  assert.ok(line.text.includes('pwsh'), line.text);
  assert.ok(line.text.includes('exit 1'), line.text);
});

test('a successful tool result is silent', () => {
  assert.equal(
    describeEvent({ type: 'tool/result', data: { message: { toolCallId: 'c1' } } }, () => 'pwsh'),
    undefined,
  );
});

test('turn boundaries and failures are described', () => {
  assert.ok(describeEvent({ type: 'turn/start', data: { turn: 3 } }).text.includes('第 3 轮开始'));
  assert.ok(describeEvent({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }).text.includes('完成'));
  assert.equal(
    describeEvent({ type: 'turn/end', data: { turn: 4, reason: { kind: 'error', error: { message: 'boom' } } } }).kind,
    'error',
  );
  assert.ok(describeEvent({ type: 'turn/end', data: { turn: 5, reason: { kind: 'aborted' } } }).text.includes('中止'));
  assert.ok(describeEvent({ type: 'turn/end', data: { turn: 6, reason: { kind: 'blocked' } } }).text.includes('阻塞'));
});

test('a user message is shown but attributed', () => {
  const line = describeEvent({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '帮我把测试跑一遍' }] },
  });
  assert.equal(line.kind, 'user');
  assert.ok(line.text.startsWith('👤'));
});

test('bookkeeping events stay invisible', () => {
  for (const type of ['step/start', 'step/end', 'assistant/attempt', 'request/header', 'system/message']) {
    assert.equal(describeEvent({ type, data: {} }), undefined, `${type} should be silent`);
  }
});

// ---- session identity extraction ----

test('session id is read from either shape', () => {
  assert.equal(sessionIdOf({ id: 's-1' }), 's-1');
  assert.equal(sessionIdOf({ sessionId: 's-2' }), 's-2');
  assert.equal(sessionIdOf({ header: { id: 's-3' } }), 's-3');
  assert.equal(sessionIdOf({}), undefined);
  assert.equal(sessionIdOf(null), undefined);
});

// ---- elapsed formatting ----

test('elapsed time reads naturally', () => {
  assert.equal(formatElapsed(1_500), '1 秒');
  assert.equal(formatElapsed(64_000), '1 分 04 秒');
  assert.equal(formatElapsed(3_720_000), '1 小时 02 分');
  assert.equal(formatElapsed(-1), '—');
});

// ---- live tracker ----

/** A tracker with a controllable clock. */
function tracker(clock = { at: 0 }) {
  return new ProgressTracker({
    ctx: { on: () => () => undefined },
    now: () => clock.at,
  });
}

test('tracker follows a turn from start to end', () => {
  const progress = tracker();
  progress.observe('s-1', { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } });
  let state = progress.peek('s-1');
  assert.equal(state.running, true);
  assert.equal(state.turn, 1);

  progress.observe('s-1', { type: 'step/start', seq: 2, time: 1_100, data: { turn: 1, step: 2 } });
  progress.observe('s-1', { type: 'tool/call', seq: 3, time: 1_200, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' } });
  progress.observe('s-1', { type: 'tool/call', seq: 4, time: 1_300, data: { callId: 'c2', name: 'pwsh', arguments: '{"command":"npm test"}' } });
  state = progress.peek('s-1');
  assert.equal(state.step, 2);
  assert.equal(state.actions, 2);

  progress.observe('s-1', { type: 'assistant/message', seq: 5, time: 1_400, data: { message: { content: [{ type: 'text', text: '测试全绿。' }] } } });
  progress.observe('s-1', { type: 'turn/end', seq: 6, time: 1_500, data: { turn: 1, reason: { kind: 'completed' } } });
  state = progress.peek('s-1');
  assert.equal(state.running, false);
  assert.equal(state.lastText, '测试全绿。');
  assert.equal(state.lines.at(-1).text, '✅ 第 1 轮完成');
});

test('seq cursors deliver each line exactly once', () => {
  const progress = tracker();
  progress.observe('s-1', { type: 'tool/call', seq: 10, time: 1, data: { name: 'read', arguments: '{"file_path":"a"}' } });
  progress.observe('s-1', { type: 'tool/call', seq: 11, time: 2, data: { name: 'read', arguments: '{"file_path":"b"}' } });

  const first = progress.since('s-1', 0);
  assert.equal(first.lines.length, 2);
  assert.equal(first.cursor, 11);
  assert.deepEqual(progress.since('s-1', first.cursor).lines, []);
});

test('running sessions are listed for the auto-follow rule', () => {
  const progress = tracker();
  progress.observe('s-1', { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } });
  progress.observe('s-2', { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } });
  progress.observe('s-2', { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.deepEqual(progress.runningSessions().map((state) => state.sessionId), ['s-1']);
});

test('render describes a running session with its recent actions', () => {
  const clock = { at: 2_500 };
  const progress = tracker(clock);
  progress.observe('s-1', { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 2 } });
  progress.observe('s-1', { type: 'tool/call', seq: 2, time: 2_000, data: { name: 'pwsh', arguments: '{"command":"npm test"}' } });
  progress.observe('s-1', { type: 'assistant/message', seq: 3, time: 2_500, data: { message: { content: [{ type: 'text', text: '正在等待测试结果。' }] } } });

  const body = progress.render('s-1', { title: '主会话', limit: 5, now: 61_000 });
  assert.ok(body.includes('📡 主会话 · 运行中'), body);
  assert.ok(body.includes('1 分 00 秒'), body);
  assert.ok(body.includes('第 2 轮'), body);
  assert.ok(body.includes('最后动作 58 秒前'), body);
  assert.ok(body.includes('🔧 pwsh: npm test'), body);
  assert.ok(body.includes('正在等待测试结果。'), body);
});

test('a turn already in flight still reads as running', () => {
  const clock = { at: 5_000 };
  const progress = tracker(clock);
  // No turn/start: the plugin loaded after the turn began.
  progress.observe('s-1', { type: 'tool/call', seq: 40, time: 4_000, data: { name: 'pwsh', arguments: '{"command":"npm test"}' } });
  const state = progress.peek('s-1');
  assert.equal(state.running, true, 'work with no recorded start means running');
  assert.equal(state.startedAt, 4_000, 'starts counting at the first observed event');
  const body = progress.render('s-1', { title: '中途接入', now: 5_000 });
  assert.ok(body.includes('运行中'), body);
  assert.ok(!body.includes('已结束'), body);

  progress.observe('s-1', { type: 'turn/end', seq: 41, time: 4_500, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(progress.peek('s-1').running, false, 'a turn end still finishes it');
});

test('cold replay also treats an unfinished turn as running', () => {
  const body = renderFromEvents([
    { type: 'tool/call', seq: 1, time: 1_000, data: { name: 'read', arguments: '{"file_path":"a"}' } },
  ], { title: 'T', now: 2_000 });
  assert.ok(body.includes('运行中'), body);
});

test('render says idle for a finished session', () => {
  const clock = { at: 2_000 };
  const progress = tracker(clock);
  progress.observe('s-1', { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } });
  progress.observe('s-1', { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } });
  const body = progress.render('s-1', { title: 'T', now: 5_000 });
  assert.ok(body.includes('空闲'), body);
});

test('render of an unknown session answers nothing', () => {
  assert.equal(tracker().render('nope'), undefined);
});

// ---- cold replay ----

test('cold replay reconstructs a running session from its event log', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 1_100, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"lib/index.js"}' } },
    { type: 'tool/result', seq: 3, time: 1_200, data: { message: { toolCallId: 'c1' } } },
    { type: 'tool/call', seq: 4, time: 1_300, data: { callId: 'c2', name: 'pwsh', arguments: '{"command":"npm test"}' } },
    { type: 'assistant/message', seq: 5, time: 1_400, data: { message: { content: [{ type: 'text', text: '跑完了，2 个失败。' }] } } },
  ];
  const body = renderFromEvents(events, { title: '旧会话', now: 2_000 });
  assert.ok(body.includes('📡 旧会话 · 运行中'), body);
  assert.ok(body.includes('第 1 轮'), body);
  assert.ok(body.includes('2 个动作'), body);
  assert.ok(body.includes('🔧 read: lib/index.js'), body);
  assert.ok(body.includes('🔧 pwsh: npm test'), body);
  assert.ok(body.includes('跑完了，2 个失败。'), body);
});

test('cold replay marks a session that already ended', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const body = renderFromEvents(events, { title: 'T', now: 10_000 });
  assert.ok(body.includes('空闲'), body);
  assert.ok(body.includes('✅ 第 1 轮完成'), body);
});

test('cold replay of an empty log still answers', () => {
  const body = renderFromEvents([], { title: '空会话' });
  assert.ok(body.includes('空会话'), body);
  assert.ok(body.includes('还没有动作记录'), body);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
