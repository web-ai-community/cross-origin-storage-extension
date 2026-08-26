// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import './input-switch-polyfill.js';

const workerPatchCheckbox = document.getElementById('worker-patch');
const fetchPatchCheckbox = document.getElementById('fetch-patch');
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
  ['workerPatchEnabled', 'fetchPatchEnabled', 'publicHashListEnabled'],
  ({ workerPatchEnabled, fetchPatchEnabled, publicHashListEnabled }) => {
    workerPatchCheckbox.checked = !!workerPatchEnabled;
    fetchPatchCheckbox.checked = !!fetchPatchEnabled;
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

fetchPatchCheckbox.addEventListener('change', () => {
  chrome.storage.local.set(
    { fetchPatchEnabled: fetchPatchCheckbox.checked },
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
