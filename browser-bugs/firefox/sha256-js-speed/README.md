<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# SHA-256 written in JavaScript runs at a fraction of V8's speed

**Component:** Core, JavaScript Engine: JIT

**Status:** draft. Measure it in Firefox and fill in "Actual" before filing.

## Steps

1. Run `node browser-bugs/serve.mjs`.
2. Open `http://localhost:8123/firefox/sha256-js-speed/?autorun`.

The page hashes 64, 256, and 512 MiB of in-memory bytes, 4 MiB at a time, with
`createSha256()` from `sha256.js`: Int32Array state and round constants, a
64-entry Int32Array message schedule, and rotations built from `>>>`, `<<`, and
`|`. No I/O is involved. `crypto.subtle.digest()` on the same bytes is the
baseline, and both digests must match.

## Expected

Throughput comparable to other engines on the same machine:

| Browser                        | JavaScript       | `crypto.subtle.digest()` |
| ------------------------------ | ---------------- | ------------------------ |
| Chrome 159                     | 250 to 270 MiB/s | 1,700 to 2,400 MiB/s     |
| Safari Technology Preview 27.0 | 230 to 240 MiB/s | 1,800 to 2,000 MiB/s     |

## Actual

Not yet measured. The Cross-Origin Storage extension measured about 33 MiB/s in
Firefox, and hashes files up to 1 GiB with `crypto.subtle.digest()` on one
buffer in place of the JavaScript loop because of it.
