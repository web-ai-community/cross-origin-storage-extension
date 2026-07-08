// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Wrapped in an IIFE so top-level const/function declarations don't collide
// if this content script is ever injected more than once into the same
// document (a classic, non-module script re-executed in an existing global
// throws "Can't create duplicate variable" on a repeated top-level const —
// confirmed happening in Safari).
(() => {

// Blob structured-clone across the MAIN-world/isolated-world content script
// boundary isn't part of the DOM spec (isolated worlds are a
// WebExtensions-only construct) and isn't reliably supported by every
// engine, so anything crossing that boundary goes as a transferred
// ArrayBuffer instead. Chrome's offscreen-doc blobURL needs fetching and
// chunking here first; Firefox sends a raw Blob directly from the
// background page and that's chunked directly.
const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB

// Safari doesn't reliably preserve Blob or ArrayBuffer across
// chrome.runtime.sendMessage between the background page and this content
// script — only JSON-safe values survive that specific channel intact
// (confirmed by background.js's pre-existing getResourceForViewer dataURL
// path, which has always worked). So, for Safari only, file bytes are
// pushed/pulled via background.js's storeFileDataChunk/getFileDataMeta/
// getFileDataChunk actions as a sequence of small base64-encoded chunks,
// rather than relying on a single message carrying the whole (potentially
// multi-GiB) payload. Chrome and Firefox are unaffected and keep using the
// path above unchanged.
const IS_SAFARI = chrome.runtime.getURL('').startsWith('safari-web-extension://');
const SAFARI_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB pre-encode -- must match background.js

function sendRuntimeMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const SUBCHUNK = 0x8000; // String.fromCharCode.apply's practical arg limit
  for (let i = 0; i < bytes.length; i += SUBCHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SUBCHUNK));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Pushes dataChunks (real ArrayBuffers, already chunked for the
// window.postMessage hop from the MAIN world) to background.js in bounded,
// base64-encoded pieces.
async function safariStoreFileData({ hash, dataChunks, mimeType }) {
  const blob = new Blob(dataChunks);
  const totalChunks = Math.max(1, Math.ceil(blob.size / SAFARI_CHUNK_SIZE));
  const transferId = crypto.randomUUID();
  let result;
  for (let i = 0; i < totalChunks; i++) {
    const slice = blob.slice(i * SAFARI_CHUNK_SIZE, (i + 1) * SAFARI_CHUNK_SIZE);
    const base64 = arrayBufferToBase64(await slice.arrayBuffer());
    const resp = await sendRuntimeMessage({
      action: 'storeFileDataChunk',
      data: { transferId, hash, mimeType, chunkIndex: i, totalChunks, base64, totalSize: blob.size },
    });
    if (resp?.error) return { error: resp.error, errorName: resp.errorName };
    result = resp?.data;
  }
  return result;
}

// Pulls a cached resource's bytes from background.js by hash, in bounded,
// base64-encoded pieces, decoding each into a real ArrayBuffer here (in this
// realm) for the subsequent window.postMessage hop to the MAIN world.
async function safariFetchDataChunksByHash(hash) {
  const meta = await sendRuntimeMessage({ action: 'getFileDataMeta', data: { hash } });
  if (!meta?.data?.found) return null;
  const { totalChunks, mimeType } = meta.data;
  const dataChunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const resp = await sendRuntimeMessage({
      action: 'getFileDataChunk',
      data: { hash, chunkIndex: i },
    });
    dataChunks.push(base64ToArrayBuffer(resp.data.base64));
  }
  return { dataChunks, mimeType };
}

// Accepts either a blob: URL (Chrome's offscreen doc) or a real Blob
// (Firefox's background page) and slices it into transferable ArrayBuffer
// chunks sized for the window.postMessage hop to the MAIN world.
async function toTransferChunks(source) {
  const blob = typeof source === 'string' ? await fetch(source).then((r) => r.blob()) : source;
  const chunks = [];
  for (let offset = 0; offset < blob.size; offset += TRANSFER_CHUNK_SIZE) {
    chunks.push(
      await blob.slice(offset, offset + TRANSFER_CHUNK_SIZE).arrayBuffer()
    );
  }
  return { chunks, mimeType: blob.type };
}

// getFileData responses carry either an offscreen-doc blob URL (Chrome) or a
// Blob sent directly by the background page (Firefox); normalize both to
// transferable ArrayBuffer chunks before crossing into the MAIN world.
// (Safari never reaches here — see finalizeResponseData below.)
async function normalizeFileDataForMainWorld(payload) {
  // blobURL is `false` (not absent) when background.js found no cached
  // resource for the hash — a falsy check, not a nullish one, is required
  // to treat that "not found" sentinel as "nothing to normalize".
  const source =
    payload?.blobURL || (payload?.data instanceof Blob ? payload.data : undefined);
  if (!source) return;
  const { chunks } = await toTransferChunks(source);
  payload.dataChunks = chunks;
  delete payload.data;
  delete payload.blobURL;
}

function collectTransferables(payload) {
  const transferables = [];
  for (const chunk of payload?.dataChunks || []) {
    if (chunk instanceof ArrayBuffer) transferables.push(chunk);
  }
  for (const font of payload?.fonts || []) {
    for (const chunk of font.dataChunks || []) {
      if (chunk instanceof ArrayBuffer) transferables.push(chunk);
    }
  }
  return transferables;
}

// For each font in a rewriteStylesheet response, resolves the offscreen-doc
// blob URL (Chrome) or the Blob sent directly by the background page
// (Firefox) into transferable ArrayBuffer chunks. (Safari never reaches
// here — see finalizeResponseData below.)
async function resolveFontBlobs(responseData) {
  const fonts = responseData?.fonts;
  if (!fonts?.length) return;
  await Promise.all(
    fonts.map(async (font) => {
      const source = font.blobURL ?? font.blob;
      if (source == null) return;
      const { chunks, mimeType } = await toTransferChunks(source);
      font.dataChunks = chunks;
      font.mimeType = mimeType;
      delete font.blobURL;
      delete font.blob;
    })
  );
}

// Dispatches to the Safari chunked-pull path or the Chrome/Firefox
// single-message path, depending on the browser, for a getFileData or
// resolveDeclarativeResource response, or a rewriteStylesheet response's
// fonts.
async function finalizeResponseData(action, payload) {
  if (!IS_SAFARI) {
    await normalizeFileDataForMainWorld(payload);
    await resolveFontBlobs(payload);
    return;
  }
  if (
    (action === 'getFileData' || action === 'resolveDeclarativeResource') &&
    payload?.hash
  ) {
    const result = await safariFetchDataChunksByHash(payload.hash);
    if (result) {
      payload.dataChunks = result.dataChunks;
      payload.mimeType = payload.mimeType ?? result.mimeType;
    }
    delete payload.data;
    delete payload.blobURL;
  }
  if (payload?.fonts?.length) {
    await Promise.all(
      payload.fonts.map(async (font) => {
        if (!font.hash) return;
        const result = await safariFetchDataChunksByHash(font.hash);
        if (result) {
          font.dataChunks = result.dataChunks;
          font.mimeType = result.mimeType;
        }
        delete font.blob;
        delete font.blobURL;
        delete font.hash;
      })
    );
  }
}

// Expose the extension relay URL so test.html can use an always-cross-origin iframe.
document.documentElement.dataset.cosRelayUrl = chrome.runtime.getURL('relay-extension.html');

// Allow pages to query extension settings (e.g. whether PHL is enabled).
// A page posts { source: 'cos-settings-query', action: '<action>', id: '<uuid>' }
// and receives back { source: 'cos-settings-reply', id, ...responseFields }.
// Times out silently when the extension is absent (native API or no extension).
window.addEventListener('message', (event) => {
  if (
    event.source !== window ||
    event.data?.source !== 'cos-settings-query' ||
    !event.data?.id
  ) return;
  const { id, action } = event.data;
  chrome.runtime.sendMessage({ action }, (response) => {
    if (chrome.runtime.lastError) return;
    window.postMessage({ source: 'cos-settings-reply', id, ...response.data }, '*');
  });
});

window.addEventListener('message', async (event) => {
  if (
    event.source !== window ||
    event.data.source !== 'cos-polyfill-main' ||
    !event.data.id
  ) {
    return;
  }
  const { id, action } = event.data;
  // Shallow-clone the page-origin data payload before mutating — Firefox wraps
  // postMessage data from the main world in Xray Vision, which disallows
  // assigning content-script objects as properties on page-owned objects.
  const data = event.data.data != null ? { ...event.data.data } : event.data.data;

  if (IS_SAFARI && action === 'storeFileData' && data?.dataChunks) {
    // Bypass the generic single-message path entirely: push the file to
    // background.js via storeFileDataChunk instead (see the comment on
    // IS_SAFARI above for why).
    const result = await safariStoreFileData(data);
    window.postMessage(
      { source: 'cos-polyfill-isolated', id, data: result },
      event.origin
    );
    return;
  }

  if (data && data.dataChunks) {
    // data.dataChunks arrives as an array of transferred ArrayBuffer slices
    // (zero-copy from the main world, sliced there to keep peak memory
    // bounded for large files) — reassemble into a Blob.
    const mimeType = data.mimeType?.['content-type'] || 'application/octet-stream';
    const blob = new Blob(data.dataChunks, { type: mimeType });
    delete data.dataChunks;
    if (!chrome.runtime.getURL('').startsWith('chrome-extension://')) {
      // Firefox: blob URLs created in content scripts carry the page's
      // origin (blob:http://...) which the moz-extension:// background page
      // cannot fetch. Send the Blob directly via structured clone instead.
      data.data = blob;
    } else {
      data.blobURL = URL.createObjectURL(blob);
    }
  }
  chrome.runtime.sendMessage({ action, data }, async (response) => {
    if (chrome.runtime.lastError || !response) {
      // Background service worker was unloaded mid-request; retry once after it
      // restarts (sending a new message wakes it up automatically).
      chrome.runtime.sendMessage({ action, data }, async (retryResponse) => {
        if (chrome.runtime.lastError || !retryResponse) {
          window.postMessage(
            { source: 'cos-polyfill-isolated', id, data: null },
            event.origin
          );
          return;
        }
        await finalizeResponseData(action, retryResponse.data);
        window.postMessage(
          { source: 'cos-polyfill-isolated', id, data: retryResponse.data },
          event.origin,
          collectTransferables(retryResponse.data)
        );
      });
      return;
    }
    await finalizeResponseData(action, response.data);
    window.postMessage(
      {
        source: 'cos-polyfill-isolated',
        id: id,
        data: response.data,
      },
      event.origin,
      collectTransferables(response.data)
    );
  });
});

})();
