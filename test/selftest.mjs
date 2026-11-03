/**
 * Offline self-test: exercise the pure logic paths without a DSH host.
 * Run with: node test/selftest.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { splitReply, parseCommand, pickSession, pickAutoTarget } from '../lib/command-router.js';
import { StateStore } from '../lib/state-store.js';
import { PairingManager } from '../lib/pairing.js';

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

function asyncTest(name, fn) {
  return fn().then(
    () => { passed++; console.log(`PASS ${name}`); },
    (error) => { failed++; console.log(`FAIL ${name}: ${error.message}`); },
  );
}

// ---- command parsing ----

test('parse simple command', () => {
  const c = parseCommand('/help');
  assert.equal(c.name, 'help');
  assert.equal(c.args, '');
});

test('parse command with args', () => {
  const c = parseCommand('/open abc123');
  assert.equal(c.name, 'open');
  assert.equal(c.args, 'abc123');
});

test('parse command with spaced args', () => {
  const c = parseCommand('/ws use 我的 项目');
  assert.equal(c.name, 'ws');
  assert.equal(c.args, 'use 我的 项目');
});

test('non-command returns undefined', () => {
  assert.equal(parseCommand('hello'), undefined);
});

test('bare slash is not a command', () => {
  assert.equal(parseCommand('/'), undefined);
});

test('uppercase is not a command', () => {
  assert.equal(parseCommand('/Help'), undefined);
});

test('command with underscores and digits', () => {
  const c = parseCommand('/cmd_2 x');
  assert.equal(c.name, 'cmd_2');
  assert.equal(c.args, 'x');
});

test('the short progress command parses', () => {
  assert.equal(parseCommand('/t').name, 't');
  assert.equal(parseCommand('/tail 3').args, '3');
});

// ---- session selectors ----

const ROWS = [
  { sessionId: 'session-aaa111', running: false },
  { sessionId: 'session-bbb222', running: true },
];

test('selector accepts a row number', () => {
  assert.equal(pickSession(ROWS, '2').sessionId, 'session-bbb222');
  assert.equal(pickSession(ROWS, '9'), undefined);
  assert.equal(pickSession(ROWS, '0'), undefined);
});

test('selector accepts a full id or a unique prefix', () => {
  assert.equal(pickSession(ROWS, 'session-aaa111').sessionId, 'session-aaa111');
  assert.equal(pickSession(ROWS, 'session-bbb').sessionId, 'session-bbb222');
});

test('an ambiguous prefix selects nothing', () => {
  assert.equal(pickSession(ROWS, 'session-'), undefined);
});

test('auto target prefers the one running session', () => {
  assert.equal(pickAutoTarget(ROWS).sessionId, 'session-bbb222');
});

test('auto target refuses to guess between two running sessions', () => {
  assert.equal(pickAutoTarget([
    { sessionId: 'a', running: true },
    { sessionId: 'b', running: true },
  ]), undefined);
});

test('auto target adopts a lone idle session', () => {
  assert.equal(pickAutoTarget([{ sessionId: 'only', running: false }]).sessionId, 'only');
});

// ---- reply splitting ----

test('short reply is one part', () => {
  assert.deepEqual(splitReply('hi'), ['hi']);
});

test('empty reply becomes placeholder', () => {
  assert.deepEqual(splitReply(''), ['(空)']);
});

test('long reply splits under the limit', () => {
  const text = 'x'.repeat(5000);
  const parts = splitReply(text);
  assert.ok(parts.length > 1, 'should split');
  for (const part of parts) {
    assert.ok(part.length <= 1900, `part too long: ${part.length}`);
  }
});

test('long reply prefers newline boundaries', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const parts = splitReply(lines);
  assert.ok(parts.length >= 1);
});

test('runaway reply is capped', () => {
  const text = 'y'.repeat(200000);
  const parts = splitReply(text);
  assert.ok(parts.length <= 8, `too many parts: ${parts.length}`);
  assert.ok(parts.at(-1).includes('已截断'), 'should mark truncation');
});

// ---- state store ----

/** Throwaway Harness homes, removed when the process exits. */
const homes = [];
process.on('exit', () => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

/** Minimal context exposing one throwaway Harness home and no services. */
function fakeContext() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-remote-selftest-'));
  homes.push(dir);
  return { dshHomePath: dir, get: () => undefined };
}

await asyncTest('state starts empty', async () => {
  const store = new StateStore(fakeContext());
  const state = await store.read();
  assert.equal(state.paired, false);
  assert.equal(state.botToken, null);
  assert.deepEqual(state.currents, {});
  assert.deepEqual(state.watches, {});
  assert.deepEqual(state.contextTokens, {});
  assert.deepEqual(state.notify, {
    turnEnd: true,
    error: true,
    approval: true,
    progress: true,
    stream: true,
  });
});

await asyncTest('state persists pairing', async () => {
  const ctx = fakeContext();
  const store = new StateStore(ctx);
  await store.markPaired({ botToken: 'tok', baseUrl: 'https://x', accountId: 'acct' });
  const reloaded = new StateStore(ctx);
  const state = await reloaded.read();
  assert.equal(state.paired, true);
  assert.equal(state.botToken, 'tok');
  assert.equal(state.accountId, 'acct');
});

await asyncTest('setCurrent replaces the current session and subscribes it', async () => {
  const store = new StateStore(fakeContext());
  await store.setCurrent('user-a', 'session-1');
  await store.setCurrent('user-a', 'session-2');
  const state = await store.read();
  assert.equal(state.currents['user-a'], 'session-2');
  assert.equal(Object.keys(state.currents).length, 1);
  assert.deepEqual(state.watches['user-a'], ['session-2', 'session-1'], 'both stay subscribed');
});

await asyncTest('clearCurrent keeps the progress subscription', async () => {
  const store = new StateStore(fakeContext());
  await store.setCurrent('user-a', 'session-1');
  await store.clearCurrent('user-a');
  const state = await store.read();
  assert.equal(state.currents['user-a'], undefined);
  assert.deepEqual(state.watches['user-a'], ['session-1']);
});

await asyncTest('watch adds, and off removes one subscription', async () => {
  const store = new StateStore(fakeContext());
  await store.setWatch('user-a', 's-1', true);
  await store.setWatch('user-a', 's-2', true);
  assert.deepEqual((await store.read()).watches['user-a'], ['s-2', 's-1']);
  await store.setWatch('user-a', 's-2', false);
  assert.deepEqual((await store.read()).watches['user-a'], ['s-1']);
  await store.clearWatches('user-a');
  assert.equal((await store.read()).watches['user-a'], undefined);
});

await asyncTest('context tokens survive a reload', async () => {
  const ctx = fakeContext();
  const store = new StateStore(ctx);
  await store.saveContextToken('user-a', 'token-1');
  const reloaded = new StateStore(ctx);
  assert.equal((await reloaded.read()).contextTokens['user-a'], 'token-1');
});

await asyncTest('held push bodies are bounded and taken once', async () => {
  const store = new StateStore(fakeContext());
  for (let index = 0; index < 25; index += 1) {
    await store.addPendingOut('user-a', `body-${index}`);
  }
  const held = await store.readPendingOut('user-a');
  assert.equal(held.lines.length, 20, 'capped');
  assert.equal(held.dropped, 5, 'reports the drops');
  assert.equal(held.lines[0], 'body-5', 'keeps the newest');

  const taken = await store.takePendingOut('user-a');
  assert.equal(taken.lines.length, 20);
  assert.equal(await store.readPendingOut('user-a'), null, 'cleared on take');
});

await asyncTest('a v1 record migrates to the v2 shape', async () => {
  const ctx = fakeContext();
  const store = new StateStore(ctx);
  mkdirSync(dirname(store.file), { recursive: true });
  writeFileSync(store.file, JSON.stringify({
    version: 1,
    botToken: 'tok',
    paired: true,
    cursor: 'c1',
    attachedSessions: { 'user-a': 'session-9' },
    notify: { turnEnd: false },
  }));
  const state = await new StateStore(ctx).read();
  assert.equal(state.version, 2);
  assert.equal(state.currents['user-a'], 'session-9', 'binding becomes the current session');
  assert.deepEqual(state.watches['user-a'], ['session-9'], 'and stays subscribed');
  assert.equal(state.notify.turnEnd, false, 'an explicit false survives migration');
  assert.equal(state.notify.progress, true, 'a new flag defaults on');
  assert.equal(state.paired, true);
  assert.equal(state.cursor, 'c1');
});

await asyncTest('cursor persists across reload', async () => {
  const ctx = fakeContext();
  const store = new StateStore(ctx);
  await store.setCursor('cursor-42');
  const reloaded = new StateStore(ctx);
  const state = await reloaded.read();
  assert.equal(state.cursor, 'cursor-42');
});

await asyncTest('clearPairing keeps notification prefs', async () => {
  const store = new StateStore(fakeContext());
  await store.markPaired({ botToken: 'tok', baseUrl: 'https://x', accountId: 'acct' });
  await store.setNotify('error', false);
  await store.setCurrent('user-a', 'session-1');
  await store.setWatch('user-a', 'session-2', true);
  await store.saveContextToken('user-a', 'tok-1');
  await store.addPendingOut('user-a', 'held');
  await store.clearPairing();
  const state = await store.read();
  assert.equal(state.paired, false);
  assert.equal(state.botToken, null);
  assert.deepEqual(state.currents, {});
  assert.deepEqual(state.watches, {});
  assert.deepEqual(state.contextTokens, {}, 'a stale window is not reused after unbind');
  assert.deepEqual(state.pendingOut, {});
  assert.equal(state.notify.error, false, 'notify preference survives');
});

await asyncTest('concurrent writes do not lose updates', async () => {
  const store = new StateStore(fakeContext());
  await Promise.all([
    store.setNotify('turnEnd', false),
    store.setNotify('error', false),
    store.setNotify('approval', false),
    store.setNotify('progress', false),
  ]);
  const state = await store.read();
  assert.equal(state.notify.turnEnd, false);
  assert.equal(state.notify.error, false);
  assert.equal(state.notify.approval, false);
  assert.equal(state.notify.progress, false);
});

await asyncTest('corrupt state falls back to empty', async () => {
  const ctx = fakeContext();
  const store = new StateStore(ctx);
  mkdirSync(dirname(store.file), { recursive: true });
  writeFileSync(store.file, '{not json');
  const state = await store.read();
  assert.equal(state.paired, false);
});

await asyncTest('state record lives under the Harness home', async () => {
  const ctx = fakeContext();
  const store = new StateStore(ctx);
  assert.equal(store.file, `${ctx.dshHomePath}${sep}wechat-remote${sep}state.json`);
  // No storage service is required, and no mounted form is assumed.
  assert.equal((await store.read()).paired, false);
});

await asyncTest('an unwritable state path rejects the write instead of the process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-remote-selftest-'));
  homes.push(dir);
  // Point the home at a regular file so the state directory cannot be created.
  const blocked = join(dir, 'not-a-directory');
  writeFileSync(blocked, 'x');
  const store = new StateStore({ dshHomePath: blocked, get: () => undefined });
  await assert.rejects(() => store.setCursor('c'), /ENOTDIR|EEXIST|EACCES|EPERM/);
});

// ---- pairing ----

await asyncTest('pairing delivers the typed pairing code on the next poll, once', async () => {
  const calls = [];
  const client = {
    botToken: null,
    getBotQrcode: async () => ({ qrcode: 'QR-1', qrcodeImgContent: 'img' }),
    getQrcodeStatus: async (qrcode, _signal, verifyCode) => {
      calls.push({ qrcode, verifyCode });
      return verifyCode === undefined
        ? { status: 'need_verifycode' }
        : { status: 'confirmed', botToken: 'tok', baseUrl: 'https://node.example', accountId: 'acct' };
    },
    adopt() {},
  };
  const store = new StateStore(fakeContext());
  const pairing = new PairingManager({ client, store });

  await pairing.begin();
  assert.equal((await pairing.poll()).status, 'need_verifycode');
  assert.deepEqual(calls[0], { qrcode: 'QR-1', verifyCode: undefined }, 'no code on a plain poll');

  assert.equal(pairing.submitVerifyCode('7788').submitted, true);
  const confirmed = await pairing.poll();
  assert.equal(confirmed.paired, true);
  assert.equal(calls[1].verifyCode, '7788', 'code rides the next poll');

  const state = await store.read();
  assert.equal(state.paired, true);
  assert.equal(state.accountId, 'acct');
  assert.equal(state.baseUrl, 'https://node.example');

  assert.deepEqual(pairing.submitVerifyCode('0000'), { submitted: false, reason: 'not-pairing' });
  assert.deepEqual(pairing.submitVerifyCode('  '), { submitted: false, reason: 'not-pairing' });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
