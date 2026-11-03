/**
 * Protocol harness: run IlinkClient against a local server that mimics the
 * iLink Bot API contract, proving request shape, cursor handling, token
 * expiry, and context-token round-tripping.
 *
 * Run with: node test/protocol.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IlinkClient, IlinkError, messageText } from '../lib/ilink-client.js';

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

/** Start a stub iLink server that records every request. */
async function stubServer(handlers) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://localhost');
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
      calls.push(record);
      const handler = handlers[url.pathname];
      if (handler === undefined) {
        res.writeHead(404).end('{}');
        return;
      }
      const { status = 200, payload } = handler(record) ?? { payload: {} };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

await test('QR request carries bot_type and base_info', async () => {
  const stub = await stubServer({
    '/ilink/bot/get_bot_qrcode': () => ({ payload: { qrcode: 'qr-1', qrcode_img_content: 'IMG' } }),
  });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    const code = await client.getBotQrcode();
    assert.equal(code.qrcode, 'qr-1');
    assert.equal(code.qrcodeImgContent, 'IMG');
    const call = stub.calls[0];
    assert.equal(call.query.bot_type, '3');
    assert.equal(call.headers['authorizationtype'], 'ilink_bot_token');
    assert.equal(call.headers['ilink-app-id'], 'bot');
    assert.ok(call.body.base_info.channel_version.length > 0);
  } finally {
    await stub.close();
  }
});

await test('X-WECHAT-UIN is per-request base64', async () => {
  const stub = await stubServer({
    '/ilink/bot/get_bot_qrcode': () => ({ payload: { qrcode: 'q', qrcode_img_content: '' } }),
  });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    await client.getBotQrcode();
    await client.getBotQrcode();
    const first = stub.calls[0].headers['x-wechat-uin'];
    const second = stub.calls[1].headers['x-wechat-uin'];
    assert.ok(first.length > 0);
    // Decoded value must be a decimal uint32.
    assert.match(Buffer.from(first, 'base64').toString('utf8'), /^\d+$/);
    assert.notEqual(first, second, 'value changes per request');
  } finally {
    await stub.close();
  }
});

await test('confirmed status yields token, baseurl, account', async () => {
  const stub = await stubServer({
    '/ilink/bot/get_qrcode_status': () => ({
      payload: { status: 'confirmed', bot_token: 'tok-abc', baseurl: 'https://node.example', account_id: 'acct-1' },
    }),
  });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    const state = await client.getQrcodeStatus('qr-1');
    assert.equal(state.status, 'confirmed');
    assert.equal(state.botToken, 'tok-abc');
    assert.equal(state.baseUrl, 'https://node.example');
    assert.equal(state.accountId, 'acct-1');
  } finally {
    await stub.close();
  }
});

await test('getUpdates sends cursor and returns next', async () => {
  const stub = await stubServer({
    '/ilink/bot/getupdates': () => ({
      payload: {
        ret: 0,
        msgs: [{ from_user_id: 'u@im.wechat', message_type: 1, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
        get_updates_buf: 'cursor-2',
        longpolling_timeout_ms: 35000,
      },
    }),
  });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    client.adopt({ botToken: 'tok' });
    const result = await client.getUpdates({ cursor: 'cursor-1' });
    assert.equal(result.cursor, 'cursor-2');
    assert.equal(result.messages.length, 1);
    assert.equal(stub.calls[0].body.get_updates_buf, 'cursor-1');
    assert.equal(stub.calls[0].headers['authorization'], 'Bearer tok');
  } finally {
    await stub.close();
  }
});

await test('sendmessage round-trips context_token verbatim', async () => {
  const stub = await stubServer({
    '/ilink/bot/sendmessage': () => ({ payload: { ret: 0 } }),
  });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    client.adopt({ botToken: 'tok' });
    await client.sendText({ toUserId: 'u@im.wechat', contextToken: 'ctx-xyz', text: 'reply' });
    const msg = stub.calls[0].body.msg;
    assert.equal(msg.to_user_id, 'u@im.wechat');
    assert.equal(msg.context_token, 'ctx-xyz');
    assert.equal(msg.message_type, 2);
    assert.equal(msg.message_state, 2);
    assert.equal(msg.item_list[0].text_item.text, 'reply');
    assert.ok(msg.client_id.length > 0, 'client_id present');
  } finally {
    await stub.close();
  }
});

await test('client_id differs across sends', async () => {
  const stub = await stubServer({ '/ilink/bot/sendmessage': () => ({ payload: { ret: 0 } }) });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    client.adopt({ botToken: 'tok' });
    await client.sendText({ toUserId: 'u', contextToken: 'c', text: 'a' });
    await client.sendText({ toUserId: 'u', contextToken: 'c', text: 'b' });
    assert.notEqual(stub.calls[0].body.msg.client_id, stub.calls[1].body.msg.client_id);
  } finally {
    await stub.close();
  }
});

await test('HTTP 200 with ret=-14 raises token-invalid', async () => {
  const stub = await stubServer({
    '/ilink/bot/getupdates': () => ({ payload: { ret: -14, msgs: [] } }),
  });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    client.adopt({ botToken: 'stale' });
    await assert.rejects(
      () => client.getUpdates({ cursor: '' }),
      (error) => error instanceof IlinkError && error.isTokenInvalid,
    );
  } finally {
    await stub.close();
  }
});

await test('unpaired authenticated call fails fast', async () => {
  const client = new IlinkClient({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => client.getUpdates({ cursor: '' }),
    (error) => error instanceof IlinkError && error.isTokenInvalid,
  );
});

await test('non-JSON response is a clear transport error', async () => {
  const server = createServer((req, res) => res.writeHead(200).end('<html>nope</html>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${port}` });
    client.adopt({ botToken: 'tok' });
    await assert.rejects(
      () => client.getUpdates({ cursor: '' }),
      (error) => error instanceof IlinkError && /non-JSON/.test(error.message),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('unreachable host is retryable', async () => {
  const client = new IlinkClient({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 500 });
  client.adopt({ botToken: 'tok' });
  await assert.rejects(
    () => client.getUpdates({ cursor: '' }),
    (error) => error instanceof IlinkError && error.retryable === true,
  );
});

await test('messageText extracts the first text part', async () => {
  assert.equal(messageText({ item_list: [{ type: 1, text_item: { text: 'hello' } }] }), 'hello');
  assert.equal(messageText({ item_list: [{ type: 2, image_item: {} }] }), undefined);
  assert.equal(messageText({}), undefined);
});

await test('typing sends the documented status numbers', async () => {
  const stub = await stubServer({ '/ilink/bot/sendtyping': () => ({ payload: { ret: 0 } }) });
  try {
    const client = new IlinkClient({ baseUrl: stub.baseUrl });
    client.adopt({ botToken: 'tok' });
    await client.sendTyping({ status: 1 });
    await client.sendTyping({ status: 2 });
    assert.equal(stub.calls[0].body.status, 1);
    assert.equal(stub.calls[1].body.status, 2);
  } finally {
    await stub.close();
  }
});

await test('forget drops the token so calls fail fast', async () => {
  const client = new IlinkClient({ baseUrl: 'http://127.0.0.1:1' });
  client.adopt({ botToken: 'tok' });
  assert.equal(client.paired, true);
  client.forget();
  assert.equal(client.paired, false);
  await assert.rejects(() => client.getUpdates({ cursor: '' }), /requires a bot token/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
