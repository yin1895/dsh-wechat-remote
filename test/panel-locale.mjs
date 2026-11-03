/**
 * Offline locale check: the shipped client bundle inlines its dictionaries, so
 * nothing at runtime reads `locale/*.json`. That makes the JSON copies pure
 * documentation unless something holds them to the code — this file is that
 * something.
 *
 * Three things are asserted here:
 *   1. every locale file's keys and values equal the inline dictionary exactly,
 *      so editing one without the other fails the suite instead of drifting;
 *   2. both locales carry the same key set, so a text is never half-translated;
 *   3. every key the panel asks for exists, which catches a typo in a
 *      `label('…')` call that would otherwise surface as a raw key on screen.
 *
 * Run with: node test/locale/panel-locale.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

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

/** Read one UTF-8 text file relative to the package root. */
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * Extract one `const NAME = { … }` object literal from the client bundle.
 *
 * A brace counter alone would break on a brace inside a string, so the scanner
 * tracks quotes; the dictionaries themselves are flat string maps, which keeps
 * the scan simple.
 *
 * @param {string} source client.js contents
 * @param {string} name constant to extract
 * @returns {Record<string, string>}
 */
function extractDictionary(source, name) {
  const marker = `const ${name} = {`;
  const markerAt = source.indexOf(marker);
  assert.ok(markerAt >= 0, `client.js has no ${name} dictionary`);

  const openAt = markerAt + marker.length - 1;
  let depth = 0;
  let quote = null;
  for (let index = openAt; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(openAt, index + 1);
        // The literal is our own source text, not user input.
        return new Function(`return (${literal});`)();
      }
    }
  }
  throw new Error(`${name} dictionary literal is not terminated`);
}

/** Sorted key list, for stable assertions in messages. */
function keysOf(dictionary) {
  return Object.keys(dictionary).sort();
}

const clientSource = read('client.js');
const inlineZh = extractDictionary(clientSource, 'ZH');
const inlineEn = extractDictionary(clientSource, 'EN');
const fileZh = JSON.parse(read('locale/zh.json'));
const fileEn = JSON.parse(read('locale/en.json'));

// ---- 1. inline copy equals the JSON copy ----

test('zh dictionary matches locale/zh.json', () => {
  assert.deepEqual(inlineZh, fileZh);
});

test('en dictionary matches locale/en.json', () => {
  assert.deepEqual(inlineEn, fileEn);
});

// ---- 2. bilingual balance ----

test('zh and en declare the same keys', () => {
  assert.deepEqual(keysOf(inlineZh), keysOf(inlineEn));
});

test('no dictionary value is empty', () => {
  for (const [key, value] of Object.entries(inlineZh)) {
    assert.ok(value.length > 0, `zh.${key} is empty`);
  }
  for (const [key, value] of Object.entries(inlineEn)) {
    assert.ok(value.length > 0, `en.${key} is empty`);
  }
});

// ---- 3. the panel only asks for keys that exist ----

/** Every key the panel resolves through `label('…')` or `t('…')`. */
function usedKeys(source) {
  const found = new Set();
  for (const pattern of [/label\('([A-Za-z0-9_]+)'/gu, /\bt\('([A-Za-z0-9_]+)'/gu]) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

test('every requested key exists in both dictionaries', () => {
  const missingZh = [];
  const missingEn = [];
  for (const key of usedKeys(clientSource)) {
    if (!(key in inlineZh)) missingZh.push(key);
    if (!(key in inlineEn)) missingEn.push(key);
  }
  assert.deepEqual(missingZh, [], `missing from zh: ${missingZh.join(', ')}`);
  assert.deepEqual(missingEn, [], `missing from en: ${missingEn.join(', ')}`);
});

test('the panel requests the tab label', () => {
  assert.ok(usedKeys(clientSource).includes('nav'));
});

test('no dictionary key is unused', () => {
  const used = new Set(usedKeys(clientSource));
  const unused = keysOf(inlineZh).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], `unused keys: ${unused.join(', ')}`);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;