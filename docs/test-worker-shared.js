// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// SharedWorker script used by the worker-variants section of test.html.
// Works as both a classic and a module SharedWorker (no top-level imports).
// Communication goes through the MessagePort supplied by the onconnect event.

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

self.onconnect = (e) => {
  const port = e.ports[0];
  port.start();
  port.onmessage = async ({ data }) => {
    if (data.type !== 'run') return;
    if (!self.navigator?.crossOriginStorage) {
      port.postMessage({
        type: 'result',
        pass: null,
        detail: 'navigator.crossOriginStorage not available',
      });
      return;
    }
    try {
      const content = `cos-variant-${data.label}`;
      const blob = new Blob([content], { type: 'text/plain' });
      const hash = hashObj(await sha256Hex(content));
      const wh = await navigator.crossOriginStorage.requestFileHandle(hash, {
        create: true,
      });
      const writable = await wh.createWritable();
      await writable.write(blob);
      await writable.close();
      const rh = await navigator.crossOriginStorage.requestFileHandle(hash);
      const text = await (await rh.getFile()).text();
      const pass = text === content;
      port.postMessage({
        type: 'result',
        pass,
        detail: pass
          ? `Stored and read back correctly: "${text}"`
          : `Expected "${content}", got "${text}"`,
      });
    } catch (err) {
      port.postMessage({
        type: 'result',
        pass: false,
        detail: `${err.name}: ${err.message}`,
      });
    }
  };
};
