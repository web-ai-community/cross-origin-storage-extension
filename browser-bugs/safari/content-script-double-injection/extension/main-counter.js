// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// The same count for the MAIN world script.
globalThis.__mainRuns = (globalThis.__mainRuns || 0) + 1;
document.documentElement.dataset.mainRuns = globalThis.__mainRuns;
