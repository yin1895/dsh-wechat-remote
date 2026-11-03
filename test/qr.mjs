/**
 * QR encoder harness.
 *
 * `lib/qr.js` is what turns the iLink login *link* into the picture the phone
 * scans, so a silent defect here is a login that cannot be completed. The golden
 * matrices were produced by python-qrcode (byte mode, error level M) and the
 * rendered symbols were decoded with cv2; see `_diag/qr-oracle.py` and
 * `_diag/qr-freeze.py`. `testdata/qr-golden.json` freezes that oracle so this
 * suite stays offline.
 *
 * Run with: node test/qr.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeQr, qrDataUri, qrSvg } from '../lib/qr.js';
import { loginQrImage } from '../lib/qr-image.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const golden = JSON.parse(readFileSync(new URL('../testdata/qr-golden.json', import.meta.url), 'utf8'));

/** Polynomial remainder over GF(2), used to verify BCH-protected fields. */
function bchRemainder(value, generator, generatorDegree) {
  let rest = value;
  const top = (v) => 31 - Math.clz32(v);
  while (top(rest) >= generatorDegree) rest ^= generator << (top(rest) - generatorDegree);
  return rest;
}

/** Read the 15 format bits back out of a finished symbol (copy 1). */
function readFormatBits(rows) {
  const size = rows.length;
  const at = (row, col) => (col > size - 1 || row > size - 1 ? '0' : rows[row][col]);
  let value = 0;
  for (let i = 14; i >= 0; i -= 1) {
    const bit = i < 6 ? at(i, 8) : i < 8 ? at(i + 1, 8) : at(size - 15 + i, 8);
    value = (value << 1) | (bit === '1' ? 1 : 0);
  }
  return value;
}

/** Read the 18 version bits back out of a finished symbol (bottom-left block). */
function readVersionBits(rows) {
  const size = rows.length;
  let value = 0;
  for (let i = 17; i >= 0; i -= 1) {
    const bit = rows[(i % 3) + size - 11][Math.floor(i / 3)];
    value = (value << 1) | (bit === '1' ? 1 : 0);
  }
  return value;
}

for (const testCase of golden.cases) {
  test(`golden: ${testCase.name} matches the frozen oracle`, () => {
    const encoded = encodeQr(testCase.payload);
    assert.equal(encoded.version, testCase.version, 'version');
    assert.equal(encoded.mask, testCase.mask, 'mask');
    assert.deepEqual(encoded.rows, testCase.chosen, 'chosen symbol');
    assert.equal(encoded.size, testCase.chosen.length, 'size');
    for (const row of encoded.rows) assert.equal(row.length, encoded.size, 'rows are square');
  });

  if (testCase.masks === null) continue;
  test(`golden: ${testCase.name} matches the oracle for every mask pattern`, () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const encoded = encodeQr(testCase.payload, { mask });
      assert.deepEqual(encoded.rows, testCase.masks[mask], `mask ${mask}`);
    }
  });
}

test('finder, timing, and dark modules are present', () => {
  const { rows, size } = encodeQr(golden.cases[0].payload);
  for (const [row0, col0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = 0; dr < 7; dr += 1) {
      for (let dc = 0; dc < 7; dc += 1) {
        const expected = dr === 0 || dr === 6 || dc === 0 || dc === 6
          || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        assert.equal(rows[row0 + dr][col0 + dc] === '1', expected, `finder ${row0},${col0} ${dr},${dc}`);
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(rows[6][i] === '1', i % 2 === 0, `timing row at ${i}`);
    assert.equal(rows[i][6] === '1', i % 2 === 0, `timing column at ${i}`);
  }
  assert.equal(rows[size - 8][8], '1', 'dark module');
});

test('format information is valid BCH and names level M plus the chosen mask', () => {
  const { rows, mask } = encodeQr(golden.cases[0].payload);
  const unmasked = readFormatBits(rows) ^ 0x5412;
  assert.equal(bchRemainder(unmasked, 0x537, 10), 0, 'format field passes BCH(15,5)');
  assert.equal(unmasked >>> 13, 0b00, 'error-correction level is M');
  assert.equal((unmasked >>> 10) & 0b111, mask, 'format field carries the chosen mask');

  // The second copy must agree with the first.
  const size = rows.length;
  let second = 0;
  for (let i = 14; i >= 0; i -= 1) {
    const bit = i < 8 ? rows[8][size - i - 1] : i < 9 ? rows[8][7] : rows[8][15 - i - 1];
    second = (second << 1) | (bit === '1' ? 1 : 0);
  }
  assert.equal(second, readFormatBits(rows), 'both format copies agree');
});

test('version information is written for versions 7 and up', () => {
  const { rows, version } = encodeQr('a'.repeat(120));
  assert.equal(version, 7, 'payload picks version 7');
  const expected = (version << 12) | bchRemainder(version << 12, 0x1f25, 12);
  assert.equal(readVersionBits(rows), expected, 'bottom-left version block');

  const size = rows.length;
  let topRight = 0;
  for (let i = 17; i >= 0; i -= 1) {
    const bit = rows[Math.floor(i / 3)][(i % 3) + size - 11];
    topRight = (topRight << 1) | (bit === '1' ? 1 : 0);
  }
  assert.equal(topRight, expected, 'top-right version block');
});

test('small payloads still carry no version block', () => {
  const { rows, version } = encodeQr('short payload');
  assert.equal(version, 1);
  const expected = (version << 12) | bchRemainder(version << 12, 0x1f25, 12);
  assert.notEqual(readVersionBits(rows), expected, 'version 1 has no version block');
});

test('multi-byte payloads are sized by UTF-8 length', () => {
  const latin = encodeQr('aaaaaa');
  const cjk = encodeQr('遥控遥控');
  assert.equal(latin.version, cjk.version, 'six bytes is six bytes');
  assert.notDeepEqual(latin.rows, cjk.rows, 'payload bytes differ');
});

test('SVG output carries a quiet zone and the requested scale', () => {
  const { size } = encodeQr(golden.cases[0].payload);
  const svg = qrSvg(golden.cases[0].payload, { scale: 4, margin: 4 });
  const span = (size + 8) * 4;
  assert.ok(svg.startsWith('<svg '), 'is an SVG document');
  assert.ok(svg.includes(`width="${span}"`) && svg.includes(`height="${span}"`), 'scaled span');
  assert.ok(svg.includes('shape-rendering="crispEdges"'), 'crisp module edges');
  assert.ok(svg.includes('<rect width="' + span + '"'), 'white background');
});

test('data URI wraps the SVG for direct use in an <img>', () => {
  const uri = qrDataUri(golden.cases[0].payload);
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'), 'svg data URI');
  const decoded = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
  assert.equal(decoded, qrSvg(golden.cases[0].payload), 'round-trips to the same SVG');
});

test('the live login link shape lands on version 6', () => {
  // Worst realistic case: a longer short-link slug and a full 32-char qrcode id.
  const link = 'https://liteapp.weixin.qq.com/q/ABCDEFGH?qrcode=0123456789abcdef0123456789abcdef&bot_type=3';
  const { version, size } = encodeQr(link);
  assert.equal(version, 6, 'still one symbol away from needing version 7');
  assert.equal(size, 41);
});

test('a payload beyond version 10 is rejected instead of truncated', () => {
  assert.throws(() => encodeQr('a'.repeat(300)), /exceeds a version-10/);
});

// ---- login payload normalisation -------------------------------------------

const LIVE_LINK = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=be0e5087f0f88b30f370d3b62c1567e4&bot_type=3';

test('an iLink link becomes a rendered symbol, not a broken PNG data URL', () => {
  const qr = loginQrImage({ qrcode: 'be0e5087f0f88b30f370d3b62c1567e4', qrcodeImgContent: LIVE_LINK });
  assert.equal(qr.kind, 'link');
  assert.equal(qr.link, LIVE_LINK);
  assert.equal(qr.payload, LIVE_LINK, 'the link is the payload the phone scans');
  assert.equal(qr.image, qrDataUri(LIVE_LINK));
  assert.ok(!qr.image.startsWith('data:image/png;base64,https'), 'never prefixes a URL with a PNG header');
  const svg = Buffer.from(qr.image.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
  assert.ok(svg.startsWith('<svg '), 'decodes to real SVG');
  assert.ok(svg.includes(`width="${(41 + 8) * 8}"`), 'version 6 plus a four-module quiet zone');
});

test('a server that does send image bytes is passed through', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const qr = loginQrImage({ qrcode: 'qr-1', qrcodeImgContent: png });
  assert.equal(qr.kind, 'image');
  assert.equal(qr.image, `data:image/png;base64,${png}`);
  assert.equal(qr.link, null);

  const inline = loginQrImage({ qrcode: 'qr-1', qrcodeImgContent: 'data:image/png;base64,AAAA' });
  assert.equal(inline.kind, 'image');
  assert.equal(inline.image, 'data:image/png;base64,AAAA');
});

test('a bare qrcode id still renders when the link is missing', () => {
  const qr = loginQrImage({ qrcode: 'be0e5087f0f88b30f370d3b62c1567e4', qrcodeImgContent: '' });
  assert.equal(qr.kind, 'text');
  assert.equal(qr.payload, 'be0e5087f0f88b30f370d3b62c1567e4');
  assert.ok(qr.image.startsWith('data:image/svg+xml;base64,'));

  const empty = loginQrImage({ qrcode: '', qrcodeImgContent: '' });
  assert.equal(empty.kind, 'none');
  assert.equal(empty.image, '', 'nothing to render, so the panel shows text instead');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
