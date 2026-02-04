const showPromptCheckbox = document.getElementById('show-prompt');
const toast = document.getElementById('toast');

function showToast() {
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Load setting.
chrome.storage.local.get('showPrompt', ({ showPrompt }) => {
  // Default to false (not showing).
  showPromptCheckbox.checked = !!showPrompt;
});

// Save setting.
showPromptCheckbox.addEventListener('change', () => {
  const showPrompt = showPromptCheckbox.checked;
  chrome.storage.local.set({ showPrompt }, () => {
    showToast();
  });
  if (!showPrompt) {
    chrome.storage.local.remove('cosPermissions');
  }
});
