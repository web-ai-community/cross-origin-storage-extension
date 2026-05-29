// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// ES-module helper imported by test-worker-module.js via a relative path.
// Its existence as a separate file is the regression test: if the extension's
// wrapper blob were used as the module base URL instead of the original HTTP
// URL, this relative import would fail to resolve.

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hashObj(value) {
  return { algorithm: 'SHA-256', value };
}
