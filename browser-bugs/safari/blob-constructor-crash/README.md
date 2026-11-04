<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# `new Blob()` of more than ~1.4 GiB crashes the web content process

**Component:** WebKit, DOM / File API

## Steps

1. Run `node browser-bugs/serve.mjs`, or open `index.html` from any local
   server.
2. Open `http://localhost:8123/safari/blob-constructor-crash/` in a fresh tab
   and click one button. Use a new tab for each button.

## Expected

Each Blob is built and its size printed, as in Chrome 159. If WebKit can't
allocate the Blob, the constructor throws (for example a `RangeError`), and the
page keeps running.

## Actual

| Parts                               | Total     | Result |
| ----------------------------------- | --------- | ------ |
| 22 × 64 MiB (the same `Uint8Array`) | 1,408 MiB | works  |
| 23 × 64 MiB (the same `Uint8Array`) | 1,472 MiB | crash  |
| 1 × 1,536 MiB                       | 1,536 MiB | works  |
| 1 × 2,049 MiB                       | 2,049 MiB | crash  |

The crash kills the web content process (`EXC_BREAKPOINT`, `SIGKILL`) in:

```
WebCore::BlobBuilder::append(Ref<JSC::ArrayBufferView>)
WebCore::Blob::Blob(ScriptExecutionContext&, std::optional<Vector<variant<Ref<ArrayBufferView>, ...>>>, ...)
WebCore::Blob::create(...)
WebCore::JSDOMConstructor<WebCore::JSBlob>::construct(...)
```

A single part fits more than many parts, which suggests that appending to the
builder's buffer grows it past a 32-bit limit before the total reaches 2 GiB.

## Environment

Safari Technology Preview 27.0 (WebKit 21627.1.4.19.1), macOS 26 on a 16 GiB
Mac. Not yet checked in Safari 27.2.
