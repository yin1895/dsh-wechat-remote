/**
 * Client-half smoke test.
 *
 * `client.js` is served to the browser as one module and is otherwise never
 * executed outside the renderer, so a typo in it only surfaces as a blank panel
 * in the GUI. This harness runs it under the documented loader contract
 * (`window.__ModuleLoader__.load({ id, factory })`), applies the returned
 * `{ inject, apply }` module against fake Host surfaces, and then renders the
 * panel component — including the QR modal, which is driven through a stateful
 * React stand-in and a fetch stub for the control routes.
 *
 * Run with: node test/client-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { qrDataUri } from '../lib/qr.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/** The lite-app link iLink answers `get_bot_qrcode` with. */
const LOGIN_LINK = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=be0e5087f0f88b30f370d3b62c1567e4&bot_type=3';

/**
 * A React stand-in whose elements are plain descriptors, with `useState` cells
 * that survive a manual re-render and `useEffect` bodies that run on the spot.
 * `suspend`/`resume` park hook bookkeeping so the panel under test owns the hook
 * slots even though the component that wraps it also uses hooks.
 */
function createReact() {
  const cells = [];
  let cursor = 0;
  let suspended = false;
  return {
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
      cursor = 0;
    },
    api: {
      createElement(type, props, ...children) {
        return {
          type,
          props: props ?? {},
          children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
        };
      },
      Fragment: Symbol('Fragment'),
      useState(initial) {
        const value = typeof initial === 'function' ? initial() : initial;
        if (suspended) return [value, () => {}];
        const index = cursor;
        cursor += 1;
        if (cells.length <= index) cells[index] = value;
        return [
          cells[index],
          (next) => {
            cells[index] = typeof next === 'function' ? next(cells[index]) : next;
          },
        ];
      },
      useEffect(fn) {
        fn();
      },
      useCallback(fn) {
        return fn;
      },
      useRef(initial) {
        return { current: initial };
      },
      useId() {
        return 'test-id';
      },
    },
  };
}

/** Collect every string in a rendered element tree. */
function texts(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  for (const child of node.children ?? []) texts(child, out);
  return out;
}

/**
 * Every readable string in a tree, including the props of child components.
 *
 * The harness never expands a component element such as `InfoRow`, so a value
 * passed as `props.value` is invisible to {@link texts}; the panel's rows are
 * exactly that shape.
 */
function allText(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  for (const value of Object.values(node.props ?? {})) {
    if (typeof value === 'string') out.push(value);
  }
  for (const child of node.children ?? []) allText(child, out);
  return out;
}

/** Find the first element in a tree matching a predicate. */
function find(node, predicate) {
  if (node === null || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

/** Load client.js through a fake module loader and return its registered module. */
function loadClient(react, fetchImpl) {
  const specs = [];
  const appendedStyles = [];
  const document = {
    head: { appendChild: (tag) => appendedStyles.push(tag) },
    querySelector: () => null,
    createElement: (tagName) => ({
      tagName,
      dataset: {},
      textContent: '',
      remove() {},
    }),
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => specs.push(spec) } },
    document,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: fetchImpl ?? (async () => {
      throw new Error('network is not available in this harness');
    }),
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.equal(specs.length, 1, 'client.js registers exactly one module');
  const spec = specs[0];
  assert.equal(spec.id, 'dsh-wechat-remote', 'module id equals the package name');
  const module_ = spec.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  });
  return { module: module_, document, appendedStyles };
}

/** Apply the client module against fake client services. */
function applyClient(module_) {
  const dictionaries = [];
  const slotEntries = [];
  const effects = [];
  const subscribers = [];
  const injected = [];
  const ctx = {
    locale: {
      register(ns, lang, dict) {
        dictionaries.push({ ns, lang, dict });
        return () => {};
      },
      bind(ns) {
        return (key) => {
          const found = dictionaries.find((entry) => entry.ns === ns && entry.lang === 'zh');
          return found?.dict?.[key] ?? key;
        };
      },
      subscribe(fn) {
        subscribers.push(fn);
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        injected.push(name);
        return callback();
      },
      register(options, component) {
        slotEntries.push({ options, component });
        return () => {};
      },
    },
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  module_.apply(ctx);
  return { dictionaries, slotEntries, effects, subscribers, injected };
}

/** A fetch stub serving the panel's control routes from one fake world. */
function controlRouteFetch(world) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const name = String(url).replace('/wechat-remote/', '');
      calls.push({ name, method: init?.method ?? 'GET' });
      if (!(name in world)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, value: world[name] }) };
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const STATUS = {
  paired: false,
  accountId: null,
  connectionStatus: 'offline',
  currentWorkspaceId: null,
  currentWorkspaceName: null,
  currentSessionId: null,
  currentSessionName: null,
  watchedSessionCount: 0,
  runningSessionCount: 0,
  attachedSessionCount: 0,
  pendingQuestionCount: 0,
  lastHeartbeat: 0,
  longPollingActive: false,
  needsRelogin: false,
  lastError: null,
  pairedAt: null,
  pushReachable: false,
  pendingOutCount: 0,
  heldChannelCount: 0,
  notify: { turnEnd: true, error: true, approval: true, progress: true, stream: true },
};

/** Render the registered panel component through the fake React. */
function renderPanel(react, slotEntries) {
  const Panel = slotEntries[0].component;
  react.suspend();
  const wrapper = Panel({});
  react.resume();
  return wrapper.type({ t: (key) => (key === 'title' ? '微信遥控' : key) });
}

await test('module declares the client services it uses', () => {
  const react = createReact();
  const { module: module_ } = loadClient(react.api);
  // The module body runs in its own vm realm, so compare a primitive, not the array.
  assert.equal(module_.inject.join(','), 'slots,locale');
  assert.equal(typeof module_.apply, 'function');
});

await test('apply registers both dictionaries and the settings tab', () => {
  const react = createReact();
  const { module: module_ } = loadClient(react.api);
  const { dictionaries, slotEntries, injected } = applyClient(module_);
  assert.deepEqual(dictionaries.map((d) => d.lang), ['zh', 'en']);
  assert.equal(dictionaries[0].ns, 'wechatRemote');
  assert.deepEqual(injected, ['settings.plugins.tab']);
  assert.equal(slotEntries.length, 1);
  assert.deepEqual(
    Object.keys(slotEntries[0].options).sort(),
    ['id', 'label', 'name', 'order'],
    'registers only the options the slot contract documents',
  );
  assert.equal(slotEntries[0].options.name, 'settings.plugins.tab');
  assert.equal(slotEntries[0].options.id, 'wechat-remote', 'tab id equals the plugin row id');
  assert.equal(slotEntries[0].options.label(), '微信遥控');
});

await test('panel renders its first paint without a live Host', () => {
  const react = createReact();
  const { module: module_ } = loadClient(react.api);
  const { slotEntries } = applyClient(module_);
  const tree = renderPanel(react, slotEntries);
  const body = texts(tree);
  assert.ok(body.includes('微信遥控'), 'renders the panel title');
  assert.ok(body.includes('加载中…'), 'renders the loading state before the first status read');
  assert.ok(body.some((line) => line.includes('/t')), 'the intro teaches the progress command');
});

await test('the status cards describe the phone-side experience', async () => {
  const react = createReact();
  const world = {
    status: {
      ...STATUS,
      paired: true,
      accountId: null,
      connectionStatus: 'online',
      longPollingActive: true,
      lastHeartbeat: 1_700_000_000_000,
      currentWorkspaceName: 'proj-a',
      currentSessionId: 's-1',
      currentSessionName: '主会话',
      attachedSessionCount: 1,
      watchedSessionCount: 2,
      runningSessionCount: 1,
      pendingQuestionCount: 1,
      pushReachable: false,
      pendingOutCount: 3,
    },
  };
  const stub = controlRouteFetch(world);
  const { module: module_ } = loadClient(react.api, stub.fetch);
  const { slotEntries } = applyClient(module_);

  renderPanel(react, slotEntries);
  await settle();
  const ready = renderPanel(react, slotEntries);
  const body = allText(ready);

  assert.ok(body.includes('主会话'), `names the current session: ${body.join(' | ')}`);
  assert.ok(body.includes('订阅进展的会话'), 'labels subscriptions in plain words');
  assert.ok(body.includes('正在运行的会话'), 'shows how many sessions are busy');
  assert.ok(body.includes('接收中'), 'says receiving instead of long-polling');
  assert.ok(body.includes('等你先发一条微信消息'), 'tells the truth about an unopened push window');
  assert.ok(body.includes('待补发消息'), 'surfaces the held backlog');
  assert.ok(body.includes('运行中的进展推送'), 'offers the progress switch');
  assert.ok(body.includes('助手实时文字'), 'offers the live-text switch');
  assert.equal(body.includes('长轮询'), false, 'no internal protocol jargon on screen');
});

await test('the test push reports whether a delivery window is open', async () => {
  const react = createReact();
  const world = {
    status: { ...STATUS, paired: true },
    'test-push': { recipients: 1, waitingForWindow: 1 },
  };
  const stub = controlRouteFetch(world);
  const { module: module_ } = loadClient(react.api, stub.fetch);
  const { slotEntries } = applyClient(module_);

  renderPanel(react, slotEntries);
  await settle();
  const ready = renderPanel(react, slotEntries);
  const button = find(ready, (node) => node.type === 'button' && texts(node).includes('发一条测试消息到微信'));
  assert.ok(button !== null, 'the test button exists');

  await button.props.onClick();
  await settle();
  const after = texts(renderPanel(react, slotEntries)).join(' | ');
  assert.ok(stub.calls.some((c) => c.name === 'test-push' && c.method === 'POST'), 'calls the route');
  assert.ok(after.includes('已排队 1 条'), after);
  assert.ok(after.includes('等你先发一条微信消息'), 'explains the hold instead of pretending it worked');
});

await test('the test push names an unpaired-looking failure plainly', async () => {
  const react = createReact();
  const world = {
    status: { ...STATUS, paired: true },
    'test-push': null,
  };
  const stub = controlRouteFetch(world);
  stub.fetch = async (url, init) => {
    const name = String(url).replace('/wechat-remote/', '');
    stub.calls.push({ name, method: init?.method ?? 'GET' });
    if (name === 'test-push') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: { code: 'no-recipient', message: 'no recipient' } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: world.status }) };
  };
  const { module: module_ } = loadClient(react.api, stub.fetch);
  const { slotEntries } = applyClient(module_);

  renderPanel(react, slotEntries);
  await settle();
  const ready = renderPanel(react, slotEntries);
  const button = find(ready, (node) => node.type === 'button' && texts(node).includes('发一条测试消息到微信'));
  await button.props.onClick();
  await settle();
  const after = texts(renderPanel(react, slotEntries)).join(' | ');
  assert.ok(after.includes('还没有微信联系人给这个机器人发过消息'), after);
});

await test('panel styles are injected once and disposed with their effect', () => {
  const react = createReact();
  const { module: module_, document } = loadClient(react.api);
  const { effects } = applyClient(module_);
  const styles = document.head.appendChild ? effects.filter((e) => e.label === 'wechat-remote: panel styles') : [];
  assert.equal(styles.length, 1, 'one style effect');
  assert.equal(typeof styles[0].dispose, 'function', 'registers a disposer');
});

await test('the QR modal renders the image the Host generated for the link', async () => {
  const react = createReact();
  const world = {
    status: STATUS,
    relogin: {
      qrcode: 'be0e5087f0f88b30f370d3b62c1567e4',
      qrcodeImgContent: LOGIN_LINK,
      qrcodeKind: 'link',
      qrcodeImage: qrDataUri(LOGIN_LINK),
      qrcodeLink: LOGIN_LINK,
    },
    'qrcode-status': { status: 'wait' },
  };
  const stub = controlRouteFetch(world);
  const { module: module_ } = loadClient(react.api, stub.fetch);
  const { slotEntries } = applyClient(module_);

  renderPanel(react, slotEntries);
  await settle();
  const ready = renderPanel(react, slotEntries);
  const button = find(ready, (node) => node.type === 'button' && texts(node).includes('重新登录'));
  assert.ok(button !== null, 'the relogin button exists once status has loaded');

  await button.props.onClick();
  await settle();
  const modal = renderPanel(react, slotEntries);
  const image = find(modal, (node) => node.type === 'img');
  assert.ok(image !== null, 'the modal shows a picture');
  assert.equal(image.props.src, qrDataUri(LOGIN_LINK), 'the picture encodes the lite-app link');
  assert.ok(image.props.src.startsWith('data:image/svg+xml;base64,'), 'not a PNG data URL around a URL');
  assert.ok(texts(modal).includes(LOGIN_LINK), 'shows the link as a scannable fallback');
  assert.ok(stub.calls.some((c) => c.name === 'relogin' && c.method === 'POST'), 'asks the Host to begin');
});

await test('a broken QR image falls back to the link instead of a blank square', async () => {
  const react = createReact();
  const world = {
    status: STATUS,
    relogin: { qrcode: 'qr-1', qrcodeImgContent: LOGIN_LINK, qrcodeKind: 'link', qrcodeImage: 'data:image/svg+xml;base64,not-an-image', qrcodeLink: LOGIN_LINK },
    'qrcode-status': { status: 'wait' },
  };
  const { module: module_ } = loadClient(react.api, controlRouteFetch(world).fetch);
  const { slotEntries } = applyClient(module_);

  renderPanel(react, slotEntries);
  await settle();
  const ready = renderPanel(react, slotEntries);
  const button = find(ready, (node) => node.type === 'button' && texts(node).includes('重新登录'));
  await button.props.onClick();
  await settle();
  const modal = renderPanel(react, slotEntries);
  const image = find(modal, (node) => node.type === 'img');
  image.props.onError();
  const broken = renderPanel(react, slotEntries);
  assert.equal(find(broken, (node) => node.type === 'img'), null, 'drops the unusable image');
  assert.ok(texts(broken).includes(LOGIN_LINK), 'shows the link so the login is still reachable');
});

await test('an image payload from another server still renders as before', async () => {
  const react = createReact();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const world = {
    status: STATUS,
    relogin: { qrcode: 'qr-1', qrcodeImgContent: png, qrcodeKind: 'image', qrcodeImage: `data:image/png;base64,${png}`, qrcodeLink: null },
    'qrcode-status': { status: 'wait' },
  };
  const { module: module_ } = loadClient(react.api, controlRouteFetch(world).fetch);
  const { slotEntries } = applyClient(module_);

  renderPanel(react, slotEntries);
  await settle();
  const ready = renderPanel(react, slotEntries);
  const button = find(ready, (node) => node.type === 'button' && texts(node).includes('重新登录'));
  await button.props.onClick();
  await settle();
  const modal = renderPanel(react, slotEntries);
  const image = find(modal, (node) => node.type === 'img');
  assert.equal(image.props.src, `data:image/png;base64,${png}`, 'honours a real image payload');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
