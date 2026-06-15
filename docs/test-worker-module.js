// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// ES-module worker loaded via an HTTP URL.
// Used by the worker-variants section of test.html to verify that:
//  1. navigator.crossOriginStorage is available in a same-origin HTTP module worker.
//  2. Relative-path imports are resolved against this file's URL, not the
//     extension's wrapper blob URL (which would make the import below fail).
import { sha256Hex, hashObj } from './test-worker-module-helper.js';

// Variant type is passed as data.variant: 'plural' (deprecated) | 'singular'.
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
    if (data.variant === 'singular') {
      // New singular API (requestFileHandle).
      const wh = await navigator.crossOriginStorage.requestFileHandle(hash, {
        create: true,
      });
      const writable = await wh.createWritable();
      await writable.write(blob);
      await writable.close();
      const rh = await navigator.crossOriginStorage.requestFileHandle(hash);
      const text = await (await rh.getFile()).text();
      const pass = text === content;
      self.postMessage({
        type: 'result',
        pass,
        detail: pass
          ? `[singular] Stored and read back correctly: "${text}"`
          : `[singular] Expected "${content}", got "${text}"`,
      });
    } else {
      // Deprecated plural API (requestFileHandles).
      const [wh] = await navigator.crossOriginStorage.requestFileHandles(
        [hash],
        { create: true }
      );
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
          ? `[plural — deprecated] Stored and read back correctly: "${text}"`
          : `[plural — deprecated] Expected "${content}", got "${text}"`,
      });
    }
  } catch (err) {
    self.postMessage({
      type: 'result',
      pass: false,
      detail: `${err.name}: ${err.message}`,
    });
  }
};
