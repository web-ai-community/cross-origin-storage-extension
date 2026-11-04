// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Declares nothing at the top level, so it runs every time it is injected.
// lexical.js, injected right after it, has a top-level `const` and throws
// "Can't create duplicate variable" on a second run in the same world.
globalThis.__isolatedRuns = (globalThis.__isolatedRuns || 0) + 1;
document.documentElement.dataset.isolatedRuns = globalThis.__isolatedRuns;
console.log(
  `[repro] isolated content script run #${globalThis.__isolatedRuns} in ${location.href}`,
);
