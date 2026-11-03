/**
 * Self-contained QR encoder (ISO/IEC 18004) used to render the login QR.
 *
 * The iLink server does *not* send QR image bytes: `get_bot_qrcode` answers with
 *
 *   { "qrcode": "be0e…", "qrcode_img_content": "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=be0e…&bot_type=3" }
 *
 * `qrcode_img_content` is the WeChat "lite app" link the phone opens after the
 * scan, so the picture has to be built on this side. Encoding it here keeps the
 * plugin's zero-third-party-dependency rule: byte mode, error-correction level
 * M, versions 1-10 (level M holds 216 data codewords at version 10, far beyond
 * a login link).
 *
 * Verified against a frozen oracle: `qr.mjs` replays `testdata/qr-golden.json`,
 * whose matrices were produced by segno 1.6.6 (see `_diag/qr-oracle.py`).
 */

/** Error-correction level (and its two-bit format field) used for every symbol. */
const EC_LEVEL_BITS = 0b00; // level M

/** Level-M block layout: version -> [[blockCount, totalCodewords, dataCodewords], …]. */
const BLOCK_LAYOUT = {
  1: [[1, 26, 16]],
  2: [[1, 44, 28]],
  3: [[1, 70, 44]],
  4: [[2, 50, 32]],
  5: [[2, 67, 43]],
  6: [[4, 43, 27]],
  7: [[4, 49, 31]],
  8: [[2, 60, 38], [2, 61, 39]],
  9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]],
};

/** Alignment-pattern centre coordinates per version (ISO/IEC 18004 Annex E). */
const ALIGNMENT_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** Largest version this encoder builds. */
export const MAX_VERSION = 10;

/** Field tables for GF(256) with the QR primitive polynomial 0x11d. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

/** Galois-field multiplication. */
function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords, highest term first. */
function generatorPolynomial(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let k = 0; k < poly.length; k += 1) {
      next[k] ^= poly[k];
      next[k + 1] ^= gfMultiply(poly[k], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data · xᵈᵉᵍʳᵉᵉ` divided by the generator polynomial. */
function errorCorrectionCodewords(data, degree) {
  const poly = generatorPolynomial(degree);
  const buffer = new Uint8Array(data.length + degree);
  buffer.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i];
    if (factor === 0) continue;
    for (let k = 0; k < poly.length; k += 1) buffer[i + k] ^= gfMultiply(poly[k], factor);
  }
  return buffer.slice(data.length);
}

/** Data codewords available at level M for one version. */
function dataCodewordCount(version) {
  return BLOCK_LAYOUT[version].reduce((sum, [count, , data]) => sum + count * data, 0);
}

/** Smallest supported version holding `byteLength` bytes in one byte-mode segment. */
function chooseVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCodewordCount(version) * 8) return version;
  }
  throw new Error(
    `payload of ${byteLength} bytes exceeds a version-${MAX_VERSION} level-M symbol`,
  );
}

/** Build the final data codeword sequence: header, payload, terminator, padding. */
function encodeDataCodewords(bytes, version) {
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCodewordCount(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | bits[i + k];
    codewords[i / 8] = byte;
  }

  const pads = [0xec, 0x11];
  let pad = 0;
  const out = new Uint8Array(dataCodewordCount(version));
  out.set(codewords, 0);
  for (let i = codewords.length; i < out.length; i += 1) {
    out[i] = pads[pad];
    pad = 1 - pad;
  }
  return out;
}

/** Split into blocks, add error correction, then interleave data and ECC codewords. */
function interleave(dataCodewords, version) {
  const blocks = [];
  let offset = 0;
  for (const [count, total, dataLength] of BLOCK_LAYOUT[version]) {
    for (let i = 0; i < count; i += 1) {
      const data = dataCodewords.slice(offset, offset + dataLength);
      offset += dataLength;
      blocks.push({ data, ecc: errorCorrectionCodewords(data, total - dataLength) });
    }
  }

  const out = [];
  const longestData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longestData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  const longestEcc = Math.max(...blocks.map((block) => block.ecc.length));
  for (let i = 0; i < longestEcc; i += 1) {
    for (const block of blocks) if (i < block.ecc.length) out.push(block.ecc[i]);
  }
  return Uint8Array.from(out);
}

/** Mask condition for one module, per mask pattern 0-7. */
function maskApplies(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** 18-bit version information (BCH(18,6) with generator 0x1f25), for versions 7 and up. */
function versionInformation(version) {
  let bch = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if (((bch >>> (i + 12)) & 1) === 1) bch ^= 0x1f25 << i;
  }
  return (version << 12) | bch;
}

/** The 3x6 / 6x3 version-information blocks, in bit order 0-17. */
function versionInfoPositions(size) {
  const positions = [];
  for (let i = 0; i < 18; i += 1) {
    positions.push([[Math.floor(i / 3), (i % 3) + size - 11], [(i % 3) + size - 11, Math.floor(i / 3)]]);
  }
  return positions;
}

/** 15-bit format information (5 data bits, BCH(15,5), masked with 0x5412). */
function formatInformation(mask) {
  const data = (EC_LEVEL_BITS << 3) | mask;
  let bch = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (((bch >>> (i + 10)) & 1) === 1) bch ^= 0x537 << i;
  }
  return ((data << 10) | bch) ^ 0x5412;
}

/** Where the two format-information copies live, in bit order 0-14. */
function formatPositions(size) {
  const first = [];
  const second = [];
  for (let i = 0; i < 15; i += 1) {
    first.push(i < 6 ? [i, 8] : i < 8 ? [i + 1, 8] : [size - 15 + i, 8]);
    second.push(i < 8 ? [8, size - i - 1] : i < 9 ? [8, 7] : [8, 15 - i - 1]);
  }
  return { first, second };
}

/**
 * Build one complete symbol for a fixed mask pattern.
 *
 * @returns {{ size: number, modules: Uint8Array }} `modules` is row-major, 1 = dark
 */
function buildSymbol(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const place = (row, col, dark, isFunction = true) => {
    modules[row * size + col] = dark ? 1 : 0;
    if (isFunction) reserved[row * size + col] = 1;
  };

  // Finder patterns and their separators.
  for (const [row0, col0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const row = row0 + dr;
        const col = col0 + dc;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inRing
          && (dr === 0 || dr === 6 || dc === 0 || dc === 6
            || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        place(row, col, dark);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    place(6, i, i % 2 === 0);
    place(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three finder corners.
  const centers = ALIGNMENT_CENTERS[version];
  for (const row of centers) {
    for (const col of centers) {
      const corner = (row === 6 && col === 6)
        || (row === 6 && col === size - 7)
        || (row === size - 7 && col === 6);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          place(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format areas, the version areas (v7+), and the always-dark module
  // before data placement.
  const { first, second } = formatPositions(size);
  for (const [row, col] of [...first, ...second]) reserved[row * size + col] = 1;
  reserved[(size - 8) * size + 8] = 1;
  const versionCells = version >= 7 ? versionInfoPositions(size) : [];
  for (const pair of versionCells) {
    for (const [row, col] of pair) reserved[row * size + col] = 1;
  }

  // Data placement: two-module columns, right to left, alternating direction.
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k += 1) {
        const target = col - k;
        const index = row * size + target;
        if (reserved[index] === 1) continue;
        const bit = bitIndex < codewords.length * 8
          ? (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
          : 0;
        bitIndex += 1;
        place(row, target, (bit ^ (maskApplies(mask, row, target) ? 1 : 0)) === 1, false);
      }
    }
    upward = !upward;
  }

  // Format information, both copies, then the fixed dark module.
  const format = formatInformation(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((format >>> i) & 1) === 1;
    const [rowA, colA] = first[i];
    place(rowA, colA, dark);
    const [rowB, colB] = second[i];
    place(rowB, colB, dark);
  }
  place(size - 8, 8, true);

  // Version information, for the versions whose size no longer implies it.
  if (version >= 7) {
    const info = versionInformation(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((info >>> i) & 1) === 1;
      for (const [row, col] of versionCells[i]) place(row, col, dark);
    }
  }

  return { size, modules };
}

/** Standard penalty score for one finished symbol (rules N1-N4). */
function penalty({ size, modules }) {
  const at = (row, col) => modules[row * size + col];
  let score = 0;

  // N1: runs of five or more identical modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        const previous = horizontal ? at(i, j - 1) : at(j - 1, i);
        const current = horizontal ? at(i, j) : at(j, i);
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // N2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const colour = at(row, col);
      if (colour === at(row, col + 1) && colour === at(row + 1, col) && colour === at(row + 1, col + 1)) {
        score += 3;
      }
    }
  }

  // N3: 1:1:3:1:1 finder-like patterns preceded or followed by four light modules.
  const needles = ['10111010000', '00001011101'];
  for (let i = 0; i < size; i += 1) {
    let rowText = '';
    let colText = '';
    for (let j = 0; j < size; j += 1) {
      rowText += at(i, j) === 1 ? '1' : '0';
      colText += at(j, i) === 1 ? '1' : '0';
    }
    for (const needle of needles) {
      for (let start = rowText.indexOf(needle); start !== -1; start = rowText.indexOf(needle, start + 1)) {
        score += 40;
      }
      for (let start = colText.indexOf(needle); start !== -1; start = colText.indexOf(needle, start + 1)) {
        score += 40;
      }
    }
  }

  // N4: deviation of the dark-module share from 50%.
  let dark = 0;
  for (let i = 0; i < modules.length; i += 1) dark += modules[i];
  const percent = (dark * 100) / modules.length;
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` as one QR symbol.
 *
 * @param {string} text payload to encode (UTF-8 byte mode)
 * @param {{ mask?: number }} [options] force a mask pattern instead of scoring all eight
 * @returns {{ version: number, size: number, mask: number, rows: string[] }}
 */
export function encodeQr(text, options = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeDataCodewords(bytes, version), version);

  const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  let best = null;
  for (const mask of candidates) {
    const symbol = buildSymbol(version, codewords, mask);
    const score = penalty(symbol);
    if (best === null || score < best.score) best = { mask, symbol, score };
  }

  const { size, modules } = best.symbol;
  const rows = [];
  for (let row = 0; row < size; row += 1) {
    let line = '';
    for (let col = 0; col < size; col += 1) line += modules[row * size + col] === 1 ? '1' : '0';
    rows.push(line);
  }
  return { version, size, mask: best.mask, rows };
}

/**
 * Render `text` as a standalone SVG document.
 *
 * @param {string} text payload to encode
 * @param {{ scale?: number, margin?: number, dark?: string, light?: string, mask?: number }} [options]
 * @returns {string} SVG markup
 */
export function qrSvg(text, options = {}) {
  const { scale = 8, margin = 4, dark = '#000000', light = '#ffffff' } = options;
  const { rows, size } = encodeQr(text, options);
  const span = (size + margin * 2) * scale;
  const path = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (rows[row][col] !== '1') continue;
      path.push(`M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${span}" height="${span}" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="WeChat login QR code"><rect width="${span}" height="${span}" fill="${light}"/><path d="${path.join('')}" fill="${dark}"/></svg>`;
}

/**
 * Render `text` as a `data:` URI the panel can put straight into an `<img>`.
 *
 * @param {string} text payload to encode
 * @param {object} [options] forwarded to {@link qrSvg}
 * @returns {string} base64 SVG data URI
 */
export function qrDataUri(text, options = {}) {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options), 'utf8').toString('base64')}`;
}
