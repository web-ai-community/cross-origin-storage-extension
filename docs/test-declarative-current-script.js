// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Records the URL this script sees for itself, the way loaders such as
// Prebid.js read a `?callback=` parameter from `document.currentScript.src`.
// test.html checks it's the URL the page asked for.
window.__cosDeclCurrentScriptSrc = document.currentScript && document.currentScript.src;
