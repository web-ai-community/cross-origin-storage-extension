// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Second of the two ordered declarative scripts in test.html. Depends on the
// first having run, the way a library and the code using it do.
(window.__cosDeclOrder = window.__cosDeclOrder || []).push(
  window.__cosDeclOrder1Ran ? 'order-2' : 'order-2 (before order-1)'
);
