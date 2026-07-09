// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Static script for progressive-enhancement-demo.html's declarative HTML
// integration example (<script integrity crossoriginstorage>). Whether or
// not the browser has any COS implementation, this always loads and runs
// the same way -- the crossoriginstorage attribute is simply ignored by
// browsers/engines that don't recognize it, per plain HTML attribute
// parsing rules.
document.getElementById('html-script-status').textContent =
  '✅ Script loaded and ran (via COS if available, network either way)';
