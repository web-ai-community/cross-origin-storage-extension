// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Static script served for the declarative HTML integration tests in
// test.html (<script integrity crossoriginstorage>). Increments a global
// counter so tests can tell "ran exactly once" apart from "ran twice"
// (which would indicate the polyfill double-executed the script).
window.__cosDeclarativeRunCount = (window.__cosDeclarativeRunCount || 0) + 1;
