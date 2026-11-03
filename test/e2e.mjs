/**
 * End-to-end harness: Runtime + control routes against a stub iLink server.
 * Proves the inbound loop, cursor advancement, outbound replies, and the
 * panel's HTTP surface.
 *
 * Run with: node test/e2e.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IlinkClient } from '../lib/ilink-client.js';
import { StateStore } from '../lib/state-store.js';
import { CommandRouter } from '../lib/command-router.js';
import { SessionAttach } from '../lib/session-attach.js';
import { ProgressTracker } from '../lib/progress.js';
import { Outbox } from '../lib/outbox.js';
import { Notifier } from '../lib/notification.js';
import { Runtime } from '../lib/runtime.js';
import { registerControlRoutes } from '../lib/control-routes.js';
import { PairingManager } from '../lib/pairing.js';
import { qrDataUri } from '../lib/qr.js';

/** The lite-app link iLink really answers `get_bot_qrcode` with. */
const LOGIN_LINK = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=be0e5087f0f88b30f370d3b62c1567e4&bot_type=3';

let passed = 0;
let failed = 0;

/** Throwaway Harness homes, removed when the process exits. */
const homes = [];
process.on('exit', () => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

/** One throwaway Harness home for a fake host's state record. */
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-remote-e2e-'));
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

/** Stub iLink server with scripted long-poll responses. */
async function stubIlink(script) {
  const state = { polls: 0, sent: [], typing: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://localhost');
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      switch (url.pathname) {
        case '/ilink/bot/msg/notifystart':
        case '/ilink/bot/msg/notifystop':
          return send({ ret: 0 });
        case '/ilink/bot/getupdates': {
          const batch = script[state.polls] ?? { msgs: [], cursor: body.get_updates_buf };
          state.polls++;
          return send({
            ret: 0,
            msgs: batch.msgs ?? [],
            get_updates_buf: batch.cursor ?? body.get_updates_buf,
            longpolling_timeout_ms: 35000,
          });
        }
        case '/ilink/bot/sendmessage':
          state.sent.push(body.msg);
          return send({ ret: 0 });
        case '/ilink/bot/sendtyping':
          state.typing.push(body.status);
          return send({ ret: 0 });
        case '/ilink/bot/get_bot_qrcode':
          // The real server sends a lite-app link, never image bytes.
          return send({ ret: 0, qrcode: 'qr-1', qrcode_img_content: LOGIN_LINK });
        case '/ilink/bot/get_qrcode_status':
          return send({ ret: 0, status: 'wait' });
        default:
          return send({ ret: 0 });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const WORKSPACES = [{ id: 'ws-a', path: 'D:\\p', title: 'proj', sessionIds: ['s-1'] }];
const SESSIONS = [{ sessionId: 's-1', title: '主会话', running: false }];

/** Assemble the plugin's runtime graph over a fake host. */
function buildGraph(baseUrl) {
  const sentToWechat = [];
  const prompts = [];
  const webRoutes = new Map();

  const ctx = {
    dshHomePath: tempHome(),
    get() { return undefined; },
    on() { return () => undefined; },
    workspaceRegistry: {
      list: () => WORKSPACES,
      get: (id) => WORKSPACES.find((w) => w.id === id),
    },
    workspaceController: { create: async ({ path }) => ({ workspace: { workspaceId: 'ws-new', path, title: path, sessionIds: [] }, created: true }) },
    sessionController: {
      list: async () => ({ items: SESSIONS }),
      create: async () => ({ sessionId: 's-new' }),
      rename: async () => ({}),
      prompt: async (r) => { prompts.push(r); return { accepted: true }; },
      cancel: async () => ({}),
      follow: () => (async function* empty() {})(),
    },
    webServer: {
      register(route) {
        webRoutes.set(route.path, route);
        return () => webRoutes.delete(route.path);
      },
    },
  };

  const store = new StateStore(ctx);
  const client = new IlinkClient({ baseUrl });
  const outbox = new Outbox({
    store,
    send: async (userId, text) => {
      // The stub iLink server is the real judge of whether a push can land, so
      // the queue talks to it instead of to an in-process array.
      const token = runtime === null ? undefined : runtime.contextTokens.get(userId);
      try {
        await client.sendText({ toUserId: userId, contextToken: token ?? '', text });
        sentToWechat.push({ userId, text });
        return true;
      } catch {
        return false;
      }
    },
  });
  const tracker = new ProgressTracker({ ctx });
  const attach = new SessionAttach({
    ctx, store, outbox,
    config: () => ({}),
  });
  const router = new CommandRouter({ ctx, store, attach, tracker, config: () => ({}) });
  const notifier = new Notifier({ ctx, store, outbox, config: () => ({}) });
  const pairing = new PairingManager({ client, store });
  let runtime = null;
  runtime = new Runtime({
    ctx, client, store, router, attach, notifier, outbox, config: () => ({}),
  });

  registerControlRoutes({ ctx, store, runtime: () => runtime, pairing, outbox, tracker });

  return { ctx, store, client, runtime, webRoutes, sentToWechat, prompts, outbox, tracker };
}

/** Invoke one registered route with an optional JSON body. */
async function hit(webRoutes, name, body) {
  const route = webRoutes.get(`/wechat-remote/${name}`);
  assert.ok(route !== undefined, `route ${name} registered`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        next: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: chunks[0] ?? Buffer.alloc(0) };
        },
      };
    },
  };
  let status;
  let payload;
  const response = {
    writeHead(code) { status = code; },
    end(text) { payload = JSON.parse(text); },
  };
  await route.handler(request, response);
  return { status, payload };
}

await test('relogin renders the lite-app link into a picture for the panel', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    const { status, payload } = await hit(graph.webRoutes, 'relogin');
    assert.equal(status, 200);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.value.qrcodeKind, 'link', 'recognises the link payload');
    assert.equal(payload.value.qrcodeLink, LOGIN_LINK, 'keeps the link for the fallback line');
    assert.equal(payload.value.qrcodeImgContent, LOGIN_LINK, 'passes the protocol field through');
    assert.ok(
      payload.value.qrcodeImage.startsWith('data:image/svg+xml;base64,'),
      'ships a rendered image, not a link the renderer would prefix with a PNG data URL',
    );
    assert.equal(payload.value.qrcodeImage, qrDataUri(LOGIN_LINK), 'image encodes the link');
    const svg = Buffer.from(
      payload.value.qrcodeImage.slice('data:image/svg+xml;base64,'.length),
      'base64',
    ).toString('utf8');
    assert.ok(svg.includes('shape-rendering="crispEdges"'), 'is a module-exact symbol');
    assert.ok(!svg.includes('liteapp.weixin.qq.com/q/'), 'does not paste the URL into the artwork');
  } finally {
    await stub.close();
  }
});

await test('runtime starts only when paired', async () => {
  const stub = await stubIlink([{ msgs: [], cursor: 'c1' }]);
  try {
    const graph = buildGraph(stub.baseUrl);
    const started = await graph.runtime.start();
    assert.equal(started, false, 'unpaired must not start');
    assert.equal(graph.runtime.running, false);
  } finally {
    await stub.close();
  }
});

await test('inbound text reaches command router and replies', async () => {
  const stub = await stubIlink([
    {
      msgs: [{
        from_user_id: 'u1@im.wechat',
        message_type: 1,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: '/help' } }],
      }],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    const replies = stub.state.sent.filter((m) => m.to_user_id === 'u1@im.wechat');
    assert.ok(replies.length > 0, 'a reply was sent');
    assert.ok(replies[0].item_list[0].text_item.text.includes('/ws list'), 'help body delivered');
    assert.equal(replies[0].context_token, 'ctx-1', 'context token echoed');
    await graph.runtime.stop();
  } finally {
    await stub.close();
  }
});

await test('cursor advances after each batch', async () => {
  const stub = await stubIlink([
    { msgs: [], cursor: 'c1' },
    { msgs: [], cursor: 'c2' },
    { msgs: [], cursor: 'c2' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.runtime.start();
    // Two batches need at least one throttle interval between them.
    await new Promise((r) => setTimeout(r, 1800));
    const state = await graph.store.read();
    assert.equal(state.cursor, 'c2', `cursor persisted, got ${state.cursor}`);
    await graph.runtime.stop();
  } finally {
    await stub.close();
  }
});

await test('bot echoes are ignored', async () => {
  const stub = await stubIlink([
    {
      msgs: [{
        from_user_id: 'u1@im.wechat',
        message_type: 2,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: 'echo from bot' } }],
      }],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(graph.sentToWechat.length, 0, 'no reply to an echo');
    await graph.runtime.stop();
  } finally {
    await stub.close();
  }
});

await test('media message gets one capability notice', async () => {
  const stub = await stubIlink([
    {
      msgs: [
        { from_user_id: 'u1@im.wechat', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 2, image_item: {} }] },
        { from_user_id: 'u1@im.wechat', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 2, image_item: {} }] },
      ],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    const notices = stub.state.sent.filter((m) =>
      m.item_list?.[0]?.text_item?.text?.includes('暂不支持'));
    assert.equal(notices.length, 1, 'notified exactly once');
    await graph.runtime.stop();
  } finally {
    await stub.close();
  }
});

await test('empty responses are throttled, not spun', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 1200));
    await graph.runtime.stop();
    // One poll per MIN_POLL_INTERVAL_MS (1s) at most, plus in-flight slack.
    assert.ok(stub.state.polls <= 3, `polls too high: ${stub.state.polls}`);
  } finally {
    await stub.close();
  }
});

await test('token expiry stops the loop and flags relogin', async () => {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url.includes('getupdates')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: -14 }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ret":0}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const graph = buildGraph(`http://127.0.0.1:${port}`);
    await graph.store.markPaired({ botToken: 'stale', baseUrl: `http://127.0.0.1:${port}`, accountId: 'a' });
    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(graph.runtime.needsRelogin, true, 'flagged for relogin');
    assert.equal(graph.runtime.running, false, 'loop stopped');
    await graph.runtime.stop();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test('control route: status reflects pairing', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'acct-7' });
    const { status, payload } = await hit(graph.webRoutes, 'status');
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.value.paired, true);
    assert.equal(payload.value.accountId, 'acct-7');
    assert.deepEqual(payload.value.notify, {
      turnEnd: true,
      error: true,
      approval: true,
      progress: true,
      stream: true,
    });
    assert.equal(payload.value.runningSessionCount, 0);
    assert.equal(payload.value.pendingOutCount, 0);
  } finally {
    await stub.close();
  }
});

await test('control route: status reports the current session and its subscriptions', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.store.setCurrent('u1@im.wechat', 's-1');
    const { payload } = await hit(graph.webRoutes, 'status');
    assert.equal(payload.value.currentSessionId, 's-1');
    assert.equal(payload.value.watchedSessionCount, 1);
    assert.equal(payload.value.attachedSessionCount, 1);
  } finally {
    await stub.close();
  }
});

await test('held pushes are delivered as a backlog on the next inbound message', async () => {
  const stub = await stubIlink([
    {
      msgs: [{
        from_user_id: 'u1@im.wechat',
        message_type: 1,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: '/status' } }],
      }],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    // What the phone missed while it had no delivery window.
    await graph.store.addPendingOut('u1@im.wechat', '📡 主会话 · 运行 4 分 12 秒\n🔧 pwsh: npm test');

    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    await graph.runtime.stop();

    const bodies = stub.state.sent.map((m) => m.item_list[0].text_item.text);
    assert.ok(bodies.some((body) => body.includes('📬 补发 1 条未送达消息')), bodies.join(' | '));
    assert.ok(bodies.some((body) => body.includes('🔧 pwsh: npm test')), 'the held progress is inline');
    assert.equal(await graph.store.readPendingOut('u1@im.wechat'), null, 'backlog consumed');
  } finally {
    await stub.close();
  }
});

await test('a fresh context token is persisted so a push survives a restart', async () => {
  const stub = await stubIlink([
    {
      msgs: [{
        from_user_id: 'u1@im.wechat',
        message_type: 1,
        context_token: 'ctx-9',
        item_list: [{ type: 1, text_item: { text: '/help' } }],
      }],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    await graph.runtime.stop();
    const state = await graph.store.read();
    assert.equal(state.contextTokens['u1@im.wechat'], 'ctx-9');
  } finally {
    await stub.close();
  }
});

await test('control route: test push reaches a user the bridge has seen', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    const missing = await hit(graph.webRoutes, 'test-push');
    assert.equal(missing.payload.ok, false);
    assert.equal(missing.payload.error.code, 'no-recipient');

    await graph.store.setCurrent('u1@im.wechat', 's-1');
    const sent = await hit(graph.webRoutes, 'test-push');
    assert.equal(sent.payload.ok, true);
    assert.equal(sent.payload.value.recipients, 1);
    assert.equal(sent.payload.value.waitingForWindow, 1, 'no window opened yet, so it will be held');
    await new Promise((r) => setTimeout(r, 100));
    const state = await graph.store.read();
    assert.ok((state.pendingOut['u1@im.wechat']?.lines.length ?? 0) >= 1, 'held for the next window');
  } finally {
    await stub.close();
  }
});

await test('control route: notify toggles persist', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    const { status, payload } = await hit(graph.webRoutes, 'notify', { key: 'approval', value: false });
    assert.equal(status, 200);
    assert.equal(payload.value.value, false);
    const state = await graph.store.read();
    assert.equal(state.notify.approval, false);
  } finally {
    await stub.close();
  }
});

await test('control route: notify rejects unknown key', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    const { status } = await hit(graph.webRoutes, 'notify', { key: 'bogus', value: true });
    assert.equal(status, 400);
  } finally {
    await stub.close();
  }
});

await test('control route: unbind clears pairing but keeps notify', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.store.setNotify('error', false);
    const { payload } = await hit(graph.webRoutes, 'unbind');
    assert.equal(payload.ok, true);
    const state = await graph.store.read();
    assert.equal(state.paired, false);
    assert.equal(state.botToken, null);
    assert.equal(state.notify.error, false, 'preference retained');
  } finally {
    await stub.close();
  }
});

await test('control route: reconnect refuses when unpaired', async () => {
  const stub = await stubIlink([]);
  try {
    const graph = buildGraph(stub.baseUrl);
    const { payload } = await hit(graph.webRoutes, 'reconnect');
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'not-paired');
  } finally {
    await stub.close();
  }
});

await test('an unacknowledged completion is repeated when the user next speaks', async () => {
  const stub = await stubIlink([
    {
      msgs: [{
        from_user_id: 'u1@im.wechat',
        message_type: 1,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: '再帮我改一下' } }],
      }],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.store.setCurrent('u1@im.wechat', 's-1');
    // A completion push that went out a minute ago and was never acknowledged.
    await graph.store.setUnconfirmed('u1@im.wechat', {
      sessionId: 's-1',
      title: '主会话',
      text: '✅ 主会话 完成了这一轮\n\n测试全绿。',
      at: Date.now() - 70_000,
    });

    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    await graph.runtime.stop();

    const bodies = stub.state.sent.map((m) => m.item_list[0].text_item.text);
    assert.ok(
      bodies.some((body) => body.includes('补一条可能没显示给你的通知')),
      bodies.join(' | '),
    );
    assert.ok(bodies.some((body) => body.includes('测试全绿。')), 'the original text is quoted');
    const state = await graph.store.read();
    assert.equal(state.unconfirmed['u1@im.wechat'], undefined, 'recapped once, then forgotten');
  } finally {
    await stub.close();
  }
});

await test('/t answers the question itself, so nothing is repeated', async () => {
  const stub = await stubIlink([
    {
      msgs: [{
        from_user_id: 'u1@im.wechat',
        message_type: 1,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: '/t' } }],
      }],
      cursor: 'c1',
    },
    { msgs: [], cursor: 'c1' },
  ]);
  try {
    const graph = buildGraph(stub.baseUrl);
    await graph.store.markPaired({ botToken: 'tok', baseUrl: stub.baseUrl, accountId: 'a' });
    await graph.store.setCurrent('u1@im.wechat', 's-1');
    await graph.store.setUnconfirmed('u1@im.wechat', {
      sessionId: 's-1',
      title: '主会话',
      text: '✅ 主会话 完成了这一轮',
      at: Date.now() - 70_000,
    });

    await graph.runtime.start();
    await new Promise((r) => setTimeout(r, 400));
    await graph.runtime.stop();

    const bodies = stub.state.sent.map((m) => m.item_list[0].text_item.text);
    assert.ok(!bodies.some((body) => body.includes('补一条')), bodies.join(' | '));
    assert.equal(
      (await graph.store.read()).unconfirmed['u1@im.wechat'],
      undefined,
      'the manual check satisfies it',
    );
  } finally {
    await stub.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
