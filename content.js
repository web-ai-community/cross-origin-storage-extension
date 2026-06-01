// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

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
          ).then((r) => r.arrayBuffer());
        }
        window.postMessage(
          { source: 'cos-polyfill-isolated', id, data: retryResponse.data },
          event.origin
        );
      });
      return;
    }
    if (response.data && response.data.blobURL) {
      // Send Blob URL as ArrayBuffer.
      response.data.data = await fetch(response.data.blobURL).then((r) =>
        r.arrayBuffer()
      );
    }
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
