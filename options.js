// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import './input-switch-polyfill.js';

const showPromptCheckbox = document.getElementById('show-prompt');
const workerPatchCheckbox = document.getElementById('worker-patch');
const toast = document.getElementById('toast');

function showToast() {
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Load settings.
chrome.storage.local.get(['showPrompt', 'workerPatchEnabled'], (result) => {
  showPromptCheckbox.checked = !!result.showPrompt;
  workerPatchCheckbox.checked = !!result.workerPatchEnabled;
});

// Save showPrompt setting.
showPromptCheckbox.addEventListener('change', () => {
  const showPrompt = showPromptCheckbox.checked;
  chrome.storage.local.set({ showPrompt }, () => {
    showToast();
  });
  if (!showPrompt) {
    chrome.storage.local.remove('cosPermissions');
  }
});

// Save workerPatchEnabled setting.
workerPatchCheckbox.addEventListener('change', () => {
  chrome.storage.local.set(
    { workerPatchEnabled: workerPatchCheckbox.checked },
    () => {
      showToast();
    }
  );
});
