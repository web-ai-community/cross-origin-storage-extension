// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Classic (non-module) worker loaded via an HTTP URL.
// Used by the worker-variants section of test.html to verify that the
// extension injects navigator.crossOriginStorage into a same-origin HTTP
// classic worker.

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hashObj(value) {
  return { algorithm: 'SHA-256', value };
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  if (!self.navigator?.crossOriginStorage) {
    self.postMessage({
      type: 'result',
      pass: false,
      detail: 'navigator.crossOriginStorage is undefined',
    });
    return;
  }
  try {
    const content = `cos-variant-${data.label}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const hash = hashObj(await sha256Hex(content));
    const [wh] = await navigator.crossOriginStorage.requestFileHandles([hash], {
      create: true,
    });
    const writable = await wh.createWritable();
    await writable.write(blob);
    await writable.close();
    const [rh] = await navigator.crossOriginStorage.requestFileHandles([hash]);
    const text = await (await rh.getFile()).text();
    const pass = text === content;
    self.postMessage({
      type: 'result',
      pass,
      detail: pass
        ? `Stored and read back correctly: "${text}"`
        : `Expected "${content}", got "${text}"`,
    });
  } catch (err) {
    self.postMessage({
      type: 'result',
      pass: false,
      detail: `${err.name}: ${err.message}`,
    });
  }
};
