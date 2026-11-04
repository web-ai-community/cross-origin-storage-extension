<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# Web extensions: a content script runs twice in the same document

**Component:** WebKit, Web Extensions

**Status:** draft. The trigger is not known yet. Find one with the steps below
before filing.

## Steps

1. Run `node browser-bugs/serve.mjs`.
2. Load `extension/` as a temporary extension (Develop > Add Temporary
   Extension).
3. Open `http://localhost:8123/safari/content-script-double-injection/`.
4. Try each of these, watching the table:
   - reload the page;
   - follow the link on the page, then go back and forward;
   - turn the extension off and on in Settings > Extensions with the tab open;
   - load the page before allowing the extension on `localhost`, then allow it;
   - remove and re-add the temporary extension with the tab open.

The extension's manifest mirrors the Cross-Origin Storage extension's: a MAIN
world script and an isolated world script, both at `document_start` with
`all_frames`. `counter.js` and `main-counter.js` count their runs per world;
`lexical.js` declares a top-level `const`.

## Expected

Every count in the table stays 1 for each document, top frame and frames alike.

## Actual

Not reproduced yet. In Safari Technology Preview 27.0, every count stayed 1
after each of these:

- allowing the extension on `localhost` with the page already open (Safari
  injected the scripts into the open page and its same-origin frame, once);
- reloading the page;
- navigating to `?next`.

Back and forward, turning the extension off and on, and removing and re-adding
it are still untested.

The Cross-Origin Storage extension saw its content script, a classic script with
top-level `const` declarations, throw "Can't create duplicate variable" in
Safari, which means it ran a second time in a world where it had already run.
The extension now wraps the whole script in a function. When the bug reproduces
here, `isolatedRuns` reads 2 while `lexicalRuns` stays 1, and the console shows
the error.
