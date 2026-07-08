// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Classic worker loaded via an HTTP(S) URL on cdn.jsdelivr.net. A classic
// worker's global scope takes the origin of its own script URL, not the
// origin of the document that spawned it, so this worker genuinely runs as
// https://cdn.jsdelivr.net — a real, unrelated origin from the page that
// created it (GitHub Pages, localhost, etc.).
//
// Used by test.html's origins-tests section to verify that a resource
// stored by one real origin is actually readable from a second, distinct
// real origin, rather than only same-site .test subdomains or the
// extension's own relay page.

self.onmessage = async ({ data }) => {
  if (data.type !== 'read') return;
  if (!self.navigator?.crossOriginStorage) {
    self.postMessage({
      type: 'result',
      pass: null,
      detail: 'navigator.crossOriginStorage not available',
    });
    return;
  }
  try {
    const rh = await navigator.crossOriginStorage.requestFileHandle(
      data.hash
    );
    const text = await (await rh.getFile()).text();
    const pass = text === data.expected;
    self.postMessage({
      type: 'result',
      pass,
      origin: self.location.origin,
      detail: pass
        ? `Read back correctly from ${self.location.origin}: "${text}"`
        : `Expected "${data.expected}", got "${text}"`,
    });
  } catch (err) {
    self.postMessage({
      type: 'result',
      pass: false,
      origin: self.location.origin,
      detail: `${err.name}: ${err.message}`,
    });
  }
};
