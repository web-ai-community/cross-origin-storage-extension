// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import './input-switch-polyfill.js';

const workerPatchCheckbox = document.getElementById('worker-patch');
const toast = document.getElementById('toast');

function showToast() {
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Load setting.
chrome.storage.local.get('workerPatchEnabled', ({ workerPatchEnabled }) => {
  workerPatchCheckbox.checked = !!workerPatchEnabled;
});

// Save setting.
workerPatchCheckbox.addEventListener('change', () => {
  chrome.storage.local.set(
    { workerPatchEnabled: workerPatchCheckbox.checked },
    () => {
      showToast();
    }
  );
});
