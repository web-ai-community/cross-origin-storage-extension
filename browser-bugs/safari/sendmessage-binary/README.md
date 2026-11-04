<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# Web extensions: no binary channel between a content script and the background

**Component:** WebKit, Web Extensions

**Status:** draft. Run it in Safari and fill in "Actual" before filing.

## Steps

1. Run `node browser-bugs/serve.mjs`.
2. Load `extension-background-page/` as a temporary extension (Develop > Add
   Temporary Extension) and allow it on `localhost`.
3. Open `http://localhost:8123/safari/sendmessage-binary/`. The content script
   prints its results on the page.
4. Remove the extension, load `extension-service-worker/`, and repeat. The two
   extensions share `background.js` and `content.js`; only the manifests differ.

The content script sends an `ArrayBuffer`, a `Uint8Array`, and a `Blob` of 16
bytes and of 8 MiB to the background with `runtime.sendMessage()`, and has the
background send the same three back. Each side reports what arrived and whether
the bytes are intact. It then fetches a `blob:` URL the background created, and
has the background fetch one the content script created.

## Expected

At least one way to hand a few hundred MiB from the background to a content
script, and back, without encoding it as a string:

- `runtime.sendMessage()` uses the structured clone algorithm, as Firefox does,
  so all three types arrive intact.
- Failing that, a content script can fetch a `blob:` URL the background page
  created. That's how Chrome extensions do it, through an offscreen document.

## Actual

Not yet run in Safari. For reference, Chrome 159 with the service worker
variant:

```
content -> background, ArrayBuffer(16)        arrived as [object Object] {}
content -> background, Uint8Array(16)         arrived as [object Object] {"0":7,"1":7,...
content -> background, Blob(16)               arrived as [object Object] {}
background -> content, (the same three)       (the same)
content -> background, Uint8Array(8388608)    Message exceeded maximum allowed size of 64MiB.
background blob: URL, fetched by content      URL.createObjectURL() is not available
content blob: URL, fetched by background      [object Blob] of 16 bytes, intact
```

## Notes

The Cross-Origin Storage extension found that, in Safari, only JSON-safe values
survive this channel. It moves every file through it as 4 MiB pieces encoded in
base64, one round trip per piece, in three separate protocols: storing, reading,
and staging bytes the page fetched. That adds a third to every transfer, and a 2
GiB file takes 512 round trips each way.
