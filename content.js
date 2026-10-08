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
async function safariStoreFileData({ hash, blob: fileBlob, dataChunks, mimeType }) {
  const blob = fileBlob ?? new Blob(dataChunks);
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
// (Firefox's background page) and returns the file as `dataChunks` for the
// MAIN world. That's normally the Blob itself, which shares the file's data
// (from a blob: URL, the fetched Blob still points at the cached file):
// ArrayBuffer chunks hold a whole copy in this script's memory, and the page
// then copies them again into a Blob of its own. main-world.js builds a
// Blob from `dataChunks` either way, so it takes both. `asChunks` asks for
// transferable ArrayBuffer chunks, sized for the window.postMessage hop,
// which main-world.js requests if a Blob ever fails to reach it intact.
async function toPageChunks(source, asChunks) {
  let blob = source;
  if (typeof source === 'string') {
    blob = await fetch(source).then((r) => r.blob());
    // The offscreen document's URL keeps the file referenced until revoked.
    chrome.runtime.sendMessage({
      action: 'revokeBlobURL',
      target: 'offscreen-doc',
      data: { url: source },
    });
  }
  if (!asChunks) return { chunks: [blob], mimeType: blob.type };
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
async function normalizeFileDataForMainWorld(payload, asChunks) {
  // blobURL is `false` (not absent) when background.js found no cached
  // resource for the hash — a falsy check, not a nullish one, is required
  // to treat that "not found" sentinel as "nothing to normalize".
  const source =
    payload?.blobURL || (payload?.data instanceof Blob ? payload.data : undefined);
  if (!source) return;
  const { chunks } = await toPageChunks(source, asChunks);
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
async function resolveFontBlobs(responseData, asChunks) {
  const fonts = responseData?.fonts;
  if (!fonts?.length) return;
  await Promise.all(
    fonts.map(async (font) => {
      const source = font.blobURL ?? font.blob;
      if (source == null) return;
      const { chunks, mimeType } = await toPageChunks(source, asChunks);
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
async function finalizeResponseData(action, payload, asChunks) {
  if (!IS_SAFARI) {
    await normalizeFileDataForMainWorld(payload, asChunks);
    await resolveFontBlobs(payload, asChunks);
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

// The actions a page may send the background through the relays below: the
// ones main-world.js uses. Anything else the background handles is for the
// extension's own pages, or for this script (the Safari chunk transfers and
// the move to native storage), and the background trusts those callers, so
// no page may reach them.
const PAGE_ACTIONS = new Set([
  'requestFileHandle',
  'getFileData',
  'storeFileData',
  'deleteResource',
  'resolveDeclarativeResource',
  'rewriteStylesheet',
  'getWorkerPatchSetting',
  'getFetchPatchSetting',
  'getPublicHashListSetting',
]);
const SETTINGS_ACTIONS = new Set([
  'getWorkerPatchSetting',
  'getFetchPatchSetting',
  'getPublicHashListSetting',
]);

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
  if (!SETTINGS_ACTIONS.has(action)) return;
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

  if (!PAGE_ACTIONS.has(action)) {
    window.postMessage(
      {
        source: 'cos-polyfill-isolated',
        id,
        data: { error: `Unknown action: ${action}`, errorName: 'NotAllowedError' },
      },
      event.origin
    );
    return;
  }
  // The file of a store reaches the background only as this script builds it
  // below. A page could otherwise name any URL for the background to fetch.
  if (action === 'storeFileData' && data) {
    delete data.blobURL;
    delete data.data;
  }

  if (action === 'storeFileData' && data && 'blob' in data) {
    // main-world.js posts the file as a Blob, which shares its data. Engines
    // that don't carry a Blob across the MAIN-world boundary intact get a
    // reply that makes main-world.js fall back to transferred chunks.
    // Wrapping it in a Blob of our own copies no bytes, and gives later code
    // an object from this realm (Firefox hands the page's own object over
    // behind an Xray wrapper).
    let blob = null;
    try {
      if (Object.prototype.toString.call(data.blob) === '[object Blob]') {
        blob = new Blob([data.blob], { type: data.blob.type });
      }
    } catch {
      blob = null;
    }
    if (!blob) {
      window.postMessage(
        {
          source: 'cos-polyfill-isolated',
          id,
          data: {
            error: 'The file did not reach the extension as a Blob.',
            // Must match BLOB_NOT_RECEIVED in main-world.js.
            errorName: 'COSBlobNotReceived',
          },
        },
        event.origin
      );
      return;
    }
    data.blob = blob;
  }

  if (IS_SAFARI && action === 'storeFileData' && (data?.blob || data?.dataChunks)) {
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

  if (data && (data.blob || data.dataChunks)) {
    // The file arrives as a Blob, or as an array of transferred ArrayBuffer
    // slices (zero-copy from the main world, sliced there to keep peak memory
    // bounded for large files) to reassemble into one.
    const mimeType = data.mimeType?.['content-type'] || 'application/octet-stream';
    const blob = data.blob
      ? new Blob([data.blob], { type: mimeType })
      : new Blob(data.dataChunks, { type: mimeType });
    delete data.blob;
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

  // Answers the page. A failure must reach it as `{ error, errorName }`, so
  // the page's promise rejects: resolving with no data looks like success,
  // and a failed store would then pass for a stored file.
  const reply = async (response) => {
    // The blob: URL keeps a whole copy of the file alive in Chrome's blob
    // storage until the page unloads. That storage is small (2 GiB of memory
    // when the disk is nearly full), so a store that leaves it behind can
    // make the next large store fail.
    if (data?.blobURL) URL.revokeObjectURL(data.blobURL);
    if (!response) {
      window.postMessage(
        {
          source: 'cos-polyfill-isolated',
          id,
          data: {
            error: 'The Cross-Origin Storage extension did not respond.',
            errorName: 'UnknownError',
          },
        },
        event.origin
      );
      return;
    }
    if (response.error) {
      window.postMessage(
        {
          source: 'cos-polyfill-isolated',
          id,
          data: { error: response.error, errorName: response.errorName },
        },
        event.origin
      );
      return;
    }
    await finalizeResponseData(action, response.data, !!data?.transferAsChunks);
    window.postMessage(
      { source: 'cos-polyfill-isolated', id, data: response.data },
      event.origin,
      collectTransferables(response.data)
    );
  };

  chrome.runtime.sendMessage({ action, data }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Background service worker was unloaded mid-request; retry once after it
      // restarts (sending a new message wakes it up automatically).
      chrome.runtime.sendMessage({ action, data }, (retryResponse) => {
        reply(chrome.runtime.lastError ? null : retryResponse);
      });
      return;
    }
    reply(response);
  });
});

// Moving files into the browser's own Cross-Origin Storage, for a browser
// that has it (see native-migration.js). In this isolated world,
// `navigator.crossOriginStorage` can only be the browser's own, since the
// polyfill lives in the MAIN world, and a file written from here is stored
// under this page's origin, which is what keeps its readers the same. Page
// scripts can't see or affect any of it.

// The explainer renamed `requestFileHandle()` to `getFileHandle()`;
// implementations built before that still have the old name.
function nativeFileHandle(hash, options) {
  const cos = navigator.crossOriginStorage;
  const get = cos.getFileHandle ?? cos.requestFileHandle;
  return get.call(cos, hash, options);
}

// Writes a file into native COS and reads it back, so the extension's copy is
// only deleted once the browser verifiably has it. Must match
// copyIntoNativeCOS() in migration.js.
async function copyIntoNativeCOS(hash, blob, origins) {
  const options = { create: true };
  if (origins !== undefined) options.origins = origins;
  const writable = await (await nativeFileHandle(hash, options)).createWritable();
  await writable.write(blob);
  await writable.close();
  const stored = await (await nativeFileHandle(hash)).getFile();
  if (stored.size !== blob.size) {
    throw new Error(`Stored ${stored.size} of ${blob.size} bytes`);
  }
}

async function moveFilesIntoNativeCOS() {
  const work = await sendRuntimeMessage({ action: 'getMigrationWork' });
  // One at a time: files can be gigabytes, and this runs behind the page.
  // Every file is written from this page even if the page can already read
  // it (say, one migration.html copied right away): only a write records
  // this origin as a storer, and a successful read proves nothing, since the
  // browser may disclose a file it doesn't share to a random few reads
  // (GREASE'ing) to keep probing unreliable.
  for (const { hash, origins } of work?.data?.files || []) {
    try {
      const response = await sendRuntimeMessage({
        action: 'getFileData',
        data: { hash },
      });
      if (!response?.data) throw new Error(response?.error || 'No response');
      const payload = response.data;
      await finalizeResponseData('getFileData', payload, false);
      if (!payload.dataChunks) throw new Error('Not in the extension cache');
      const blob = new Blob(payload.dataChunks, { type: payload.mimeType || '' });
      await copyIntoNativeCOS(hash, blob, origins);
      await sendRuntimeMessage({ action: 'migrationDone', data: { hash: hash.value } });
    } catch (err) {
      // The file stays in the extension's cache and is tried again on a later
      // visit.
      console.warn(`[COS] Could not move ${hash.value} into the browser's storage:`, err);
    }
  }
}

if ('crossOriginStorage' in navigator) {
  // Behind the page's own loading, so it never competes with it.
  const start = () => setTimeout(() => moveFilesIntoNativeCOS().catch(() => {}), 3000);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

})();
