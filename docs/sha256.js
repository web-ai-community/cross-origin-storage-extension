// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Copy of ../sha256.js — kept as a real file rather than a symlink because
// GitHub Pages (Jekyll safe mode) does not dereference symlinks that resolve
// outside the site source directory.
//
// Below NATIVE_DIGEST_MAX_SIZE, native crypto.subtle.digest on the whole
// buffer at once is used instead of the hand-rolled streaming loop below --
// it's hardware-accelerated and consistently much faster (the hand-rolled
// loop is a poor fit for at least one JS engine's GC behavior at scale:
// observed 500 MiB taking over a minute in Safari).
const NATIVE_DIGEST_MAX_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB
export async function streamingHexDigest(algorithm, blob) {
  if (algorithm !== 'SHA-256' || blob.size <= NATIVE_DIGEST_MAX_SIZE) {
    const buf = await blob.arrayBuffer();
    return Array.from(
      new Uint8Array(await crypto.subtle.digest(algorithm, buf))
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const CHUNK = 4 * 1024 * 1024; // 4 MiB
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  let H = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  let byteCount = 0;
  let pending = new Uint8Array(0);
  const W = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function processBlock(blk) {
    for (let i = 0; i < 16; i++) {
      W[i] =
        (blk[i * 4] << 24) |
        (blk[i * 4 + 1] << 16) |
        (blk[i * 4 + 2] << 8) |
        blk[i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0],
      b = H[1],
      c = H[2],
      d = H[3],
      e = H[4],
      f = H[5],
      g = H[6],
      h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          W[i]) |
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const chunk = new Uint8Array(
      await blob.slice(offset, offset + CHUNK).arrayBuffer()
    );
    byteCount += chunk.length;
    // pending is empty whenever CHUNK is a multiple of 64 (always true here)
    // and every prior chunk was full-sized (true for all but the last) --
    // i.e. in practice on every iteration except possibly the final one.
    // Concatenating into a fresh buffer in that (common) case was a wholly
    // unnecessary multi-MiB allocation + copy on every single chunk.
    let buf;
    if (pending.length === 0) {
      buf = chunk;
    } else {
      buf = new Uint8Array(pending.length + chunk.length);
      buf.set(pending);
      buf.set(chunk, pending.length);
    }
    let i = 0;
    for (; i + 64 <= buf.length; i += 64) processBlock(buf.subarray(i, i + 64));
    pending = buf.subarray(i);
  }
  const k = Math.ceil((pending.length + 9) / 64);
  const pad = new Uint8Array(k * 64);
  pad.set(pending);
  pad[pending.length] = 0x80;
  const dv = new DataView(pad.buffer);
  dv.setUint32(k * 64 - 8, Math.floor(byteCount / 0x20000000), false);
  dv.setUint32(k * 64 - 4, (byteCount % 0x20000000) * 8, false);
  for (let i = 0; i < pad.length; i += 64)
    processBlock(pad.subarray(i, i + 64));
  return Array.from(H)
    .map((w) => (w >>> 0).toString(16).padStart(8, '0'))
    .join('');
}
