/**
 * Streaming harness: prove that a bound session's assistant prose reaches
 * WeChat, through the outbox that now owns delivery.
 *
 * Run with: node test/stream.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAttach } from '../lib/session-attach.js';
import { StateStore } from '../lib/state-store.js';
import { Outbox } from '../lib/outbox.js';

let passed = 0;
let failed = 0;

/** Throwaway Harness homes, removed when the process exits. */
const homes = [];
process.on('exit', () => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

/** One throwaway Harness home for a fake host's state record. */
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-remote-stream-'));
  homes.push(dir);
  return dir;
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

/**
 * Build a host whose follow() replays a scripted frame list and then blocks
 * until aborted, mirroring a live session.
 */
function streamHost(frames, options = {}) {
  const sent = [];
  let aborted = 0;

  const ctx = {
    dshHomePath: tempHome(),
    get: () => undefined,
    sessionController: {
      list: async () => ({ items: options.sessions ?? [{ sessionId: 's-1', title: 'T', running: true }] }),
      prompt: async () => ({ accepted: true }),
      follow: (request, signal) => {
        const iterator = (async function* replay() {
          for (const frame of frames) {
            if (signal.aborted) return;
            yield frame;
          }
          // Stay open like a live stream until the binding closes.
          await new Promise((resolve) => {
            signal.addEventListener('abort', () => { aborted++; resolve(); }, { once: true });
          });
        })();
        return iterator;
      },
    },
  };

  const store = new StateStore(ctx);
  const outbox = new Outbox({
    store,
    send: async (userId, text) => { sent.push({ userId, text }); return true; },
  });
  const attach = new SessionAttach({ ctx, store, outbox, config: () => ({}) });

  return { ctx, store, outbox, attach, sent, abortedCount: () => aborted };
}

/** Give the outbox time to deliver, including the tagged-burst settle. */
function settle(ms = 600) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await test('durable assistant message is forwarded', async () => {
  const host = streamHost([
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '任务完成了。' }] } },
      },
    },
  ]);
  const opened = await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  assert.equal(opened.ok, true);
  await settle();
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0].text, '任务完成了。');
  assert.equal(host.sent[0].userId, 'u1');
  host.attach.closeAll();
  host.outbox.stop();
});

await test('live deltas use the real chunk shape', async () => {
  const host = streamHost([
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '真实增量。' } } },
    { type: 'event', event: { type: 'turn/end' } },
  ]);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await settle();
  const joined = host.sent.map((m) => m.text).join('');
  assert.ok(joined.includes('真实增量。'), joined);
  host.attach.closeAll();
  host.outbox.stop();
});

await test('tool-call deltas stay out of the prose mirror', async () => {
  const host = streamHost([
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'tool-call-delta', index: 0, id: 't1', name: 'bash', argumentsDelta: '{}' } } },
    { type: 'event', event: { type: 'turn/end' } },
  ]);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await settle();
  assert.equal(host.sent.length, 0, 'the mirror carries prose only; progress lines come from the tracker');
  host.attach.closeAll();
  host.outbox.stop();
});

await test('live deltas are buffered then emitted at turn end', async () => {
  const host = streamHost([
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '第一段。' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '第二段。' } } },
    { type: 'event', event: { type: 'turn/end' } },
  ]);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await settle();
  const joined = host.sent.map((m) => m.text).join('');
  assert.ok(joined.includes('第一段。'), joined);
  assert.ok(joined.includes('第二段。'), joined);
  host.attach.closeAll();
  host.outbox.stop();
});

await test('a long stream is chunked instead of waiting for the turn to end', async () => {
  const long = 'x'.repeat(700);
  const host = streamHost([
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: long } } },
  ]);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await settle();
  assert.equal(host.sent.length, 1, 'the first chunk left before the turn finished');
  assert.ok(host.sent[0].text.length >= 700);
  host.attach.closeAll();
  host.outbox.stop();
});

await test('the prose mirror respects the stream toggle', async () => {
  const host = streamHost([
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '不该出现的文字。' } } },
    { type: 'event', event: { type: 'turn/end' } },
  ]);
  await host.store.setNotify('stream', false);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await settle();
  assert.equal(host.sent.length, 0, 'muted');
  host.attach.closeAll();
  host.outbox.stop();
});

await test('non-text frames are ignored', async () => {
  const host = streamHost([
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'block-start', index: 0 } } },
    { type: 'assistant-stream', frame: { type: 'start' } },
    { type: 'event', event: { type: 'tool/result', data: { message: { content: [] } } } },
  ]);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await settle();
  assert.equal(host.sent.length, 0, 'no noise on the phone');
  host.attach.closeAll();
  host.outbox.stop();
});

await test('close aborts the stream and clears the current session', async () => {
  const host = streamHost([]);
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await host.attach.close('u1');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(host.abortedCount() >= 1, 'stream aborted');
  const state = await host.store.read();
  assert.equal(state.currents['u1'], undefined, 'current cleared');
  host.outbox.stop();
});

await test('open rejects an unknown session', async () => {
  const host = streamHost([], { sessions: [{ sessionId: 'other', title: 'X' }] });
  const result = await host.attach.open({ userId: 'u1', sessionId: 'missing' });
  assert.ok(result.error !== undefined);
  assert.ok(result.error.includes('会话不存在'));
  const state = await host.store.read();
  assert.equal(state.currents['u1'], undefined, 'no binding on failure');
  host.outbox.stop();
});

await test('re-opening switches the stream target', async () => {
  const host = streamHost(
    [{
      type: 'event',
      event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'from s-1' }] } } },
    }],
    { sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }] },
  );
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await host.attach.open({ userId: 'u1', sessionId: 's-2' });
  const state = await host.store.read();
  assert.equal(state.currents['u1'], 's-2');
  assert.equal(host.attach.streams.size, 1, 'only one stream per user');
  host.attach.closeAll();
  host.outbox.stop();
});

await test('two users mirror the same session independently', async () => {
  const host = streamHost(
    [{
      type: 'event',
      event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'shared' }] } } },
    }],
    { sessions: [{ sessionId: 's-1' }] },
  );
  await host.attach.open({ userId: 'u1', sessionId: 's-1' });
  await host.attach.open({ userId: 'u2', sessionId: 's-1' });
  await settle();
  const users = new Set(host.sent.map((m) => m.userId));
  assert.ok(users.has('u1') && users.has('u2'), 'both receive');
  host.attach.closeAll();
  host.outbox.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
