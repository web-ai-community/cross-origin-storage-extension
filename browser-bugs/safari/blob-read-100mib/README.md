<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# Reading a Blob of more than 100 MiB fails with `NotReadableError`

**Component:** WebKit, DOM / File API

## Steps

1. Run `node browser-bugs/serve.mjs`.
2. Open `http://localhost:8123/safari/blob-read-100mib/?autorun`.

The page builds Blobs of 64, 127, 128, and 256 MiB from four sources (the `Blob`
constructor, `fetch()`, Cache Storage, and `new Response().blob()`), and reads
each one whole with `blob.arrayBuffer()`, `blob.bytes()`,
`new Response(blob).arrayBuffer()`, and `FileReader.readAsArrayBuffer()`. As a
control, it reads the same Blob in 4 MiB slices.

The exact threshold, in the console of the same page:

```js
const read = (n) => new Blob([new Uint8Array(n)]).arrayBuffer();
await read(104857600); // resolves
await read(104857601); // rejects
```

## Expected

Every read resolves with all the bytes, as it does in Chrome 159 for the same
sources at 101 and 256 MiB.

## Actual

At 64 MiB everything works. Above 104,857,600 bytes (100 MiB), whatever the
source, every whole-Blob read fails:

- `blob.arrayBuffer()`, `blob.bytes()`, and `FileReader`:
  `NotReadableError: The I/O read operation failed.`
- `new Response(blob).arrayBuffer()`: `TypeError: Blob loading failed`

Reading the same Blob in 4 MiB slices always works, so the data itself is
readable.

## Environment

Safari Technology Preview 27.0 (WebKit 21627.1.4.19.1), macOS 26. Not yet
checked in Safari 27.2.

## Notes

The Cross-Origin Storage extension reads Blobs in 4 MiB slices into one buffer
in three places to work around this (`readBlobInSlices()` in `sha256.js` and
`main-world.js`).
