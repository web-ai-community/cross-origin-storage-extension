// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// A top-level lexical declaration, like the extension's content.js had before
// it was wrapped in an IIFE. A second injection into the same world throws
// before this line runs, so `lexicalRuns` stays behind `isolatedRuns`.
const LEXICAL_MARKER = (globalThis.__lexicalRuns || 0) + 1;
globalThis.__lexicalRuns = LEXICAL_MARKER;
document.documentElement.dataset.lexicalRuns = LEXICAL_MARKER;
