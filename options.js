// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import './input-switch-polyfill.js';

const workerPatchCheckbox = document.getElementById('worker-patch');
const publicHashListCheckbox = document.getElementById('public-hash-list');
const toast = document.getElementById('toast');

function showToast() {
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Load settings.
chrome.storage.local.get(
  ['workerPatchEnabled', 'publicHashListEnabled'],
  ({ workerPatchEnabled, publicHashListEnabled }) => {
    workerPatchCheckbox.checked = !!workerPatchEnabled;
    publicHashListCheckbox.checked = !!publicHashListEnabled;
  }
);

// Save settings.
workerPatchCheckbox.addEventListener('change', () => {
  chrome.storage.local.set(
    { workerPatchEnabled: workerPatchCheckbox.checked },
    () => {
      showToast();
    }
  );
});

publicHashListCheckbox.addEventListener('change', () => {
  chrome.storage.local.set(
    { publicHashListEnabled: publicHashListCheckbox.checked },
    () => {
      showToast();
    }
  );
});
