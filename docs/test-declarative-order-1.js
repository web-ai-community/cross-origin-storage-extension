// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// First of two parser-inserted <script integrity crossoriginstorage> elements
// in test.html, with an inline script between them. Records its position so
// the order test can check all three ran in document order.
(window.__cosDeclOrder = window.__cosDeclOrder || []).push('order-1');
window.__cosDeclOrder1Ran = true;
