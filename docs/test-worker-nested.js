// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0
//
// Outer worker for the "nested worker" variant test.
// Spawns test-worker-classic.js as an inner worker via a same-origin HTTP URL
// to verify that the extension injects navigator.crossOriginStorage into
// workers that are themselves created from inside another worker.

self.onmessage = ({ data }) => {
  if (data.type !== 'run') return;

  // When the COS extension inlines this script into a wrapper blob, self.location.href
  // becomes the blob URL (blob:…) from which relative paths cannot be resolved.
  // The extension injects __cosWorkerBaseURL with the original HTTP URL so we can
  // build a correct absolute URL for the inner worker.
  const baseURL =
    typeof __cosWorkerBaseURL !== 'undefined'
      ? __cosWorkerBaseURL
      : self.location.href;

  const inner = new Worker(new URL('./test-worker-classic.js', baseURL).href);
  inner.onmessage = ({ data: result }) => {
    if (result.type !== 'result') return;
    inner.terminate();
    self.postMessage(result);
  };
  inner.onerror = (err) => {
    inner.terminate();
    self.postMessage({
      type: 'result',
      pass: false,
      detail: `Nested inner worker error: ${err.message}`,
    });
  };
  inner.postMessage({ type: 'run', label: data.label });
};
