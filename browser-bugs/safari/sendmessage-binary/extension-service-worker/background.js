// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Describes what arrived from the content script, and sends binary values
// back to it. Identical in both extension folders; only the manifests differ.

const IN_SERVICE_WORKER = typeof window === 'undefined';

function make(kind, size) {
  const bytes = new Uint8Array(size).fill(7);
  if (kind === 'ArrayBuffer') return bytes.buffer;
  if (kind === 'Uint8Array') return bytes;
  return new Blob([bytes], { type: 'application/octet-stream' });
}

// Names what `value` turned into, and whether its bytes survived (all 7s).
async function describe(value) {
  const tag = Object.prototype.toString.call(value);
  let bytes = null;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer);
  else if (value instanceof Blob) {
    bytes = new Uint8Array(await value.arrayBuffer());
  }
  if (!bytes) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch {
      json = '(not JSON)';
    }
    return `${tag} ${String(json).slice(0, 60)}`;
  }
  const intact = bytes.every((b) => b === 7);
  return `${tag} of ${bytes.length} bytes, ${intact ? 'intact' : 'CORRUPTED'}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'context':
          sendResponse({
            context: IN_SERVICE_WORKER ? 'service worker' : 'background page',
          });
          break;
        case 'describe':
          sendResponse({ description: await describe(message.value) });
          break;
        case 'make':
          sendResponse({ value: make(message.kind, message.size) });
          break;
        case 'makeBlobURL':
          if (typeof URL.createObjectURL !== 'function') {
            sendResponse({ error: 'URL.createObjectURL() is not available' });
            break;
          }
          sendResponse({
            url: URL.createObjectURL(make('Blob', message.size)),
          });
          break;
        case 'fetchURL': {
          const blob = await (await fetch(message.url)).blob();
          sendResponse({ description: await describe(blob) });
          break;
        }
      }
    } catch (err) {
      sendResponse({ error: `${err.name}: ${err.message}` });
    }
  })();
  return true;
});
