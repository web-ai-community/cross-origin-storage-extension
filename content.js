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

// Listen for messages from the MAIN world script.
window.addEventListener('message', async (event) => {
  // Only accept messages from the extension itself.
  if (
    event.source !== window ||
    event.data.source !== 'cos-polyfill-main' ||
    !event.data.id
  ) {
    return;
  }
  const { id, action, data } = event.data;

  if (data && data.data) {
    // data.data arrives as a transferred ArrayBuffer (zero-copy from the main
    // world) or, for legacy callers, as a structured-cloned Blob.  Either way,
    // convert to a blob URL so the background can fetch it without another copy.
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
    data.blobURL = URL.createObjectURL(blob);
    delete data.data;
  }
  // Forward the message to the background script
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
