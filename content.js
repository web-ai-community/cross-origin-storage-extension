// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// For each font in a rewriteStylesheet response, fetches the offscreen-doc
// blob URL into a Blob so it can be postMessage'd to the MAIN world.
// Blobs survive structured-clone ref-counted (no byte copy in Chrome).
async function resolveFontBlobs(responseData) {
  const fonts = responseData?.fonts;
  if (!fonts?.length) return;
  await Promise.all(
    fonts.map(async (font) => {
      if (font.blobURL) {
        font.blob = await fetch(font.blobURL).then((r) => r.blob());
        delete font.blobURL;
      }
    })
  );
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

  if (data && data.data) {
    // data.data arrives as a transferred ArrayBuffer (zero-copy from the main
    // world) or, for legacy callers, as a structured-cloned Blob.  Either way,
    // normalize to a Blob.
    const raw = data.data;
    const mimeType =
      (raw instanceof Blob ? raw.type : data.mimeType?.['content-type']) ||
      'application/octet-stream';
    const blob =
      raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)
        ? new Blob([raw], { type: mimeType })
        : raw instanceof Blob
          ? raw
          : new Blob([raw], { type: mimeType });
    if (typeof browser !== 'undefined') {
      // Firefox: blob URLs created in content scripts carry the page's origin
      // (blob:http://...) which the moz-extension:// background page cannot
      // fetch. Send the Blob directly via structured clone instead.
      data.data = blob;
    } else {
      data.blobURL = URL.createObjectURL(blob);
      delete data.data;
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
        if (retryResponse.data && retryResponse.data.blobURL) {
          retryResponse.data.data = await fetch(
            retryResponse.data.blobURL
          ).then((r) => r.blob());
        }
        await resolveFontBlobs(retryResponse.data);
        window.postMessage(
          { source: 'cos-polyfill-isolated', id, data: retryResponse.data },
          event.origin
        );
      });
      return;
    }
    if (response.data && response.data.blobURL) {
      // Fetch as Blob — structured-clone across postMessage is ref-counted
      // in Chrome (no byte copy), avoiding a full ArrayBuffer allocation.
      response.data.data = await fetch(response.data.blobURL).then((r) =>
        r.blob()
      );
    }
    await resolveFontBlobs(response.data);
    window.postMessage(
      {
        source: 'cos-polyfill-isolated',
        id: id,
        data: response.data,
      },
      event.origin
    );
  });
});
