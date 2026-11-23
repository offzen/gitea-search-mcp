// SPDX-License-Identifier: Apache-2.0
/**
 * lib/zstd.mjs — Multi-frame-safe Zstandard helpers for Node.js 20+ / 22+.
 *
 * Node.js 22's built-in `zlib.zstdDecompressSync(buf)` silently stops after Frame #1
 * on concatenated multi-frame `.zstd` files (such as append-only DSH session logs).
 *
 * This module implements an exact RFC 8878 frame boundary scanner so Node 22.15+
 * decompresses every frame natively with zero external CLI dependency, while older
 * Node versions (or explicit `forceCli` mode) route through `zstd -dc` and fail
 * closed instead of ever falling back to single-frame truncation.
 */
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const ZSTD_MAGIC_LE = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
const DICT_ID_SIZES = [0, 1, 2, 4];

/**
 * Split a Zstandard buffer into exact RFC 8878 data frame slices, skipping any
 * RFC 8878 skippable frames. Throws on truncated or malformed framing.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer[]}
 */
function splitZstdFrames(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length === 0) return [];

  const frames = [];
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`Truncated zstd frame magic at byte offset ${offset}`);
    }
    const magic = buf.readUInt32LE(offset);

    // RFC 8878 §3.1.2 Skippable frame
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      if (offset + 8 > buf.length) {
        throw new Error(`Truncated zstd skippable frame header at byte offset ${offset}`);
      }
      const skipSize = buf.readUInt32LE(offset + 4);
      const end = offset + 8 + skipSize;
      if (end > buf.length) {
        throw new Error(`Truncated zstd skippable frame payload at byte offset ${offset}`);
      }
      offset = end;
      continue;
    }

    if (magic !== ZSTD_MAGIC_LE) {
      throw new Error(`Invalid zstd frame magic 0x${magic.toString(16)} at byte offset ${offset}`);
    }

    // RFC 8878 §3.1.1 Standard Zstandard frame header
    let p = offset + 4;
    if (p >= buf.length) {
      throw new Error(`Truncated zstd frame header descriptor at byte offset ${offset}`);
    }
    const fhd = buf[p];
    p += 1;

    const frameContentSizeFlag = (fhd >> 6) & 0x03;
    const singleSegmentFlag = (fhd >> 5) & 0x01;
    const reservedBit = (fhd >> 3) & 0x01;
    const contentChecksumFlag = (fhd >> 2) & 0x01;
    const dictIdFlag = fhd & 0x03;

    if (reservedBit !== 0) {
      throw new Error(`Invalid zstd frame header reserved bit at byte offset ${offset}`);
    }

    if (!singleSegmentFlag) p += 1; // Window_Descriptor
    p += DICT_ID_SIZES[dictIdFlag]; // Dictionary_ID
    if (frameContentSizeFlag === 0) {
      if (singleSegmentFlag) p += 1;
    } else if (frameContentSizeFlag === 1) {
      p += 2;
    } else if (frameContentSizeFlag === 2) {
      p += 4;
    } else {
      p += 8;
    }

    if (p > buf.length) {
      throw new Error(`Truncated zstd frame header at byte offset ${offset}`);
    }

    // RFC 8878 §3.1.1.2 Data_Blocks
    let lastBlock = 0;
    while (!lastBlock) {
      if (p + 3 > buf.length) {
        throw new Error(`Truncated zstd block header at byte offset ${p}`);
      }
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      p += 3;
      lastBlock = bh & 0x01;
      const blockType = (bh >> 1) & 0x03;
      const blockSize = bh >>> 3;

      if (blockType === 0 || blockType === 2) {
        // Raw_Block or Compressed_Block
        p += blockSize;
      } else if (blockType === 1) {
        // RLE_Block (single byte payload repeated blockSize times)
        p += 1;
      } else {
        throw new Error(`Reserved zstd block type (3) at byte offset ${p - 3}`);
      }
      if (p > buf.length) {
        throw new Error(`Truncated zstd block payload at byte offset ${p}`);
      }
    }

    if (contentChecksumFlag) {
      p += 4;
      if (p > buf.length) {
        throw new Error(`Truncated zstd content checksum at byte offset ${offset}`);
      }
    }

    frames.push(buf.subarray(offset, p));
    offset = p;
  }

  return frames;
}

function isMultiFrameZstd(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  try {
    return splitZstdFrames(buf).length > 1;
  } catch {
    return buf.length > 4 && buf.indexOf(ZSTD_MAGIC, 4) !== -1;
  }
}

/**
 * Decompress single-frame or concatenated multi-frame Zstandard payloads safely.
 * Never falls back to single-frame Node zlib on multi-frame buffers.
 *
 * @param {Buffer|Uint8Array} input
 * @param {object} [opts]
 * @param {boolean} [opts.forceCli=false]
 * @param {string} [opts.zstdBin='zstd']
 * @param {number} [opts.maxBuffer=268435456]
 * @returns {Buffer}
 */
function decompressZstd(input, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length === 0) return Buffer.alloc(0);

  const forceCli = Boolean(opts.forceCli);
  const zstdBin = opts.zstdBin || 'zstd';
  const maxBuffer = opts.maxBuffer || 256 * 1024 * 1024;
  const hasNative = typeof zlib.zstdDecompressSync === 'function';

  if (hasNative && !forceCli) {
    try {
      const frames = splitZstdFrames(buf);
      if (frames.length === 0) return Buffer.alloc(0);
      if (frames.length === 1) return zlib.zstdDecompressSync(frames[0]);
      return Buffer.concat(frames.map((frame) => zlib.zstdDecompressSync(frame)));
    } catch (nativeErr) {
      // Do NOT silently fall back to single-frame zlib.zstdDecompressSync(buf).
      // Attempt full-stream CLI decompression; if unavailable, fail closed.
      try {
        return execFileSync(zstdBin, ['-dc'], { input: buf, maxBuffer });
      } catch (cliErr) {
        const err = new Error(
          `Failed to decompress .zstd payload (native frame decoder: ${nativeErr.message}; `
          + `CLI '${zstdBin} -dc': ${cliErr.message})`,
        );
        err.cause = cliErr;
        throw err;
      }
    }
  }

  try {
    return execFileSync(zstdBin, ['-dc'], { input: buf, maxBuffer });
  } catch (cliErr) {
    const err = new Error(
      `Failed to decompress .zstd via '${zstdBin} -dc' (fail-closed; no truncated single-frame fallback): `
      + `${cliErr.message}`,
    );
    err.cause = cliErr;
    throw err;
  }
}

/**
 * Compress a buffer to Zstandard using Node native zlib when available, else `zstd -c`.
 *
 * @param {Buffer|Uint8Array} input
 * @param {object} [opts]
 * @param {boolean} [opts.forceCli=false]
 * @param {string} [opts.zstdBin='zstd']
 * @param {number} [opts.maxBuffer=268435456]
 * @returns {Buffer}
 */
function compressZstd(input, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const forceCli = Boolean(opts.forceCli);
  const zstdBin = opts.zstdBin || 'zstd';
  const maxBuffer = opts.maxBuffer || 256 * 1024 * 1024;
  if (!forceCli && typeof zlib.zstdCompressSync === 'function') {
    return zlib.zstdCompressSync(buf);
  }
  return execFileSync(zstdBin, ['-c'], { input: buf, maxBuffer });
}

export {
  ZSTD_MAGIC,
  compressZstd,
  decompressZstd,
  isMultiFrameZstd,
  splitZstdFrames,
};
