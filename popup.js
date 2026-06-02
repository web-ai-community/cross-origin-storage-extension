// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import ResourceManager from './resource-manager.js';

async function initializePopup() {
  const resourceManager = new ResourceManager();

  // Get references to DOM elements.
  const originSelect = document.getElementById('origin-select');
  const hashSelect = document.getElementById('hash-select');
  const hashesList = document.getElementById('hashes-list');
  const originsList = document.getElementById('origins-list');
  const deleteAllBtn = document.getElementById('delete-all-btn');
  const hashCopyBtn = document.getElementById('hash-copy-btn');
  const hashSaveBtn = document.getElementById('hash-save-btn');
  const hashDeleteBtn = document.getElementById('hash-delete-btn');
  const pickFileBtn = document.getElementById('pick-file-btn');
  const addResourceStatus = document.getElementById('add-resource-status');
  const toast = document.getElementById('toast');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const confirmationMessage = document.getElementById('confirmation-message');
  const dialogConfirmBtn = document.getElementById('dialog-confirm-btn');

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  /**
   * Shows a custom confirmation dialog.
   * @param {string} message The message to display in the dialog.
   * @param {string} confirmText The text for the confirm button.
   * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false otherwise.
   */
  function showConfirmationDialog(message, confirmText = 'Confirm') {
    return new Promise((resolve) => {
      confirmationMessage.innerHTML = message;
      dialogConfirmBtn.textContent = confirmText;

      const closeListener = () => {
        // Clean up the event listener to prevent memory leaks.
        confirmationDialog.removeEventListener('close', closeListener);
        // The returnValue is 'confirm' if the confirm button was clicked.
        resolve(confirmationDialog.returnValue === 'confirm');
      };

      confirmationDialog.addEventListener('close', closeListener);
      confirmationDialog.showModal();
    });
  }

  /**
   * Formats bytes into a human-readable string (KB, MB, GB, etc.).
   * @param {number} bytes The number of bytes.
   * @param {number} [decimals=2] The number of decimal places.
   * @returns {string} The formatted file size.
   */
  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    if (bytes === undefined || bytes === null) return '';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  /**
   * Generates a friendly name from a MIME type.
   * @param {string} mimeType The MIME type string.
   * @returns {string} A capitalized, friendly name (e.g., "Image", "Model").
   */
  function getFriendlyNameFromMimeType(mimeType = 'Resource') {
    if (!mimeType || typeof mimeType !== 'string') {
      return 'Resource';
    }
    let name = mimeType.split('/')[0]; // "image/jpeg" -> "image"
    if (name === 'application' && mimeType.includes('octet-stream')) {
      name = 'Model'; // Or "Binary", "Data", etc.
    }
    // Capitalize the first letter
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function getExtensionFromMimeType(mimeType) {
    const base = (mimeType || '').split(';')[0].trim().toLowerCase();
    const overrides = {
      'image/jpeg': '.jpg',
      'image/svg+xml': '.svg',
      'audio/mpeg': '.mp3',
      'application/octet-stream': '.bin',
      'text/javascript': '.js',
    };
    if (overrides[base]) return overrides[base];
    const subtype = base.split('/')[1] || '';
    return subtype ? `.${subtype}` : '';
  }

  async function saveResourceToFile(hash) {
    const cosCache = await caches.open('cos-storage');
    const response = await cosCache.match(
      `https://cos.example.com/SHA-256_${hash}`
    );
    if (!response) {
      showToast('Resource not found in cache.');
      return;
    }

    const blob = await response.blob();
    const mimeType = (
      response.headers.get('content-type') || 'application/octet-stream'
    )
      .split(';')[0]
      .trim();
    const ext = getExtensionFromMimeType(mimeType);

    const pickerOpts = { suggestedName: `resource-${hash.slice(0, 8)}${ext}` };
    if (ext) {
      pickerOpts.types = [
        { description: 'Resource file', accept: { [mimeType]: [ext] } },
      ];
    }

    try {
      const fileHandle = await showSaveFilePicker(pickerOpts);
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast('Resource saved to disk.');
    } catch (err) {
      if (err.name !== 'AbortError') {
        showToast(`Error saving file: ${err.message}`);
      }
    }
  }

  /**
   * Updates the list of hashes based on the selected origin.
   */
  async function updateHashesDisplay() {
    const selectedOrigin = originSelect.value;
    hashesList.innerHTML = '';
    if (!selectedOrigin) return;

    const hashes = resourceManager.getHashesByOrigin(selectedOrigin);

    // Create an array of objects with hash and size to facilitate sorting.
    const resourcesWithSize = await Promise.all(
      hashes.map(async (hash) => {
        let size = resourceManager.getSizeByHash(hash);
        let mimeType = resourceManager.getMimeTypeByHash(hash);
        // If metadata is not in the manager, query it from the offscreen document.
        if (size === undefined || mimeType === undefined) {
          const response = await chrome.runtime.sendMessage({
            action: 'getResourceMetadata',
            target: 'offscreen-doc',
            data: { hash },
          });
          size = response.data.size ?? size;
          mimeType = response.data.mimeType ?? mimeType;
          // Record the metadata in the manager for future use.
          if (response.data.size !== undefined)
            resourceManager.recordSize(hash, size);
          if (response.data.mimeType !== undefined)
            resourceManager.recordMimeType(hash, mimeType);
        }
        return { hash, size, mimeType };
      })
    );

    // Sort resources by size in descending order.
    resourcesWithSize.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    for (const [
      index,
      { hash, size, mimeType },
    ] of resourcesWithSize.entries()) {
      const history = resourceManager.getAccessHistory(selectedOrigin, hash);
      const resourceName = `Resource #${index + 1}`;

      const li = document.createElement('li');
      li.className = 'resource-item';
      li.title = `Hash: ${hash}`;

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy hash';
      copyBtn.className = 'copy-btn';
      copyBtn.title = `Copy SHA-256 hash to clipboard`;
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(hash);
        showToast('Hash copied to clipboard.');
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.className = 'delete-btn';
      deleteBtn.title = `Delete ${resourceName}`;
      deleteBtn.addEventListener('click', async () => {
        const originsUsingResource = resourceManager.getOriginsByHash(hash);
        const message = `<h1>Are you sure you want to delete ${resourceName}?</h1><p>It's used by the following origins:<ul><li>${originsUsingResource.join('</li><li>')}</li></ul><p>Hash: <code>${hash}</code></p>`;

        const confirmed = await showConfirmationDialog(message, 'Delete');
        if (confirmed) {
          chrome.runtime.sendMessage(
            {
              action: 'deleteResource',
              target: 'offscreen-doc',
              data: {
                hash,
              },
            },
            async (response) => {
              if (!response.data.success) {
                console.error(`Deleting resource with hash ${hash} failed.`);
                return;
              }
              await resourceManager.deleteResourcesByHash(hash);
              await refreshUI(); // Refresh the entire UI after deletion
            }
          );
        }
      });
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.className = 'save-btn';
      saveBtn.title = 'Save resource to disk';
      saveBtn.addEventListener('click', () => saveResourceToFile(hash));

      const btnGroup = document.createElement('div');
      btnGroup.className = 'item-actions';
      btnGroup.append(copyBtn);
      btnGroup.append(saveBtn);
      btnGroup.append(deleteBtn);
      li.append(btnGroup);

      const hashDiv = document.createElement('div');
      hashDiv.className = 'hash-value';
      hashDiv.textContent = `${resourceName} (${
        (mimeType || 'unknown type').split(';')[0]
      }) - ${formatBytes(size)}`;
      li.append(hashDiv);

      if (history.length > 0) {
        const timesUl = document.createElement('ul');
        timesUl.className = 'access-times';
        history.forEach((tsString) => {
          const timestamp = new Date(tsString);
          const timeLi = document.createElement('li');
          timeLi.textContent = `Accessed on: ${timestamp.toLocaleString(
            'en-US',
            {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }
          )}`;
          timesUl.append(timeLi);
        });
        li.append(timesUl);
      }
      hashesList.append(li);
    }
  }

  /**
   * Updates the list of origins based on the selected hash.
   */
  function updateOriginsDisplay() {
    const selectedHash = hashSelect.value;
    originsList.innerHTML = '';
    const hasSelection = !!selectedHash;
    hashCopyBtn.disabled = !hasSelection;
    hashSaveBtn.disabled = !hasSelection;
    hashDeleteBtn.disabled = !hasSelection;
    if (!selectedHash) return;

    const origins = resourceManager.getOriginsByHash(selectedHash);
    origins.forEach((origin) => {
      const li = document.createElement('li');
      li.textContent = origin;
      originsList.append(li);
    });
  }

  hashCopyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(hashSelect.value);
    showToast('Hash copied to clipboard.');
  });

  hashSaveBtn.addEventListener('click', () => saveResourceToFile(hashSelect.value));

  hashDeleteBtn.addEventListener('click', async () => {
    const hash = hashSelect.value;
    if (!hash) return;
    const resourceName =
      hashSelect.options[hashSelect.selectedIndex]?.text ?? 'this resource';
    const originsUsingResource = resourceManager.getOriginsByHash(hash);
    const originList =
      originsUsingResource.length > 0
        ? `<ul><li>${originsUsingResource.join('</li><li>')}</li></ul>`
        : '<p>No origins on record.</p>';
    const message = `<h1>Are you sure you want to delete ${resourceName}?</h1>${originList}<p>Hash: <code>${hash}</code></p>`;

    const confirmed = await showConfirmationDialog(message, 'Delete');
    if (confirmed) {
      chrome.runtime.sendMessage(
        { action: 'deleteResource', target: 'offscreen-doc', data: { hash } },
        async (response) => {
          if (!response.data.success) {
            console.error(`Deleting resource with hash ${hash} failed.`);
            return;
          }
          await resourceManager.deleteResourcesByHash(hash);
          await refreshUI();
        }
      );
    }
  });

  /**
   * A central function to completely refresh the UI from storage data.
   */
  async function refreshUI() {
    // Reload the latest data from storage.
    await resourceManager.loadManagerFromStorage();

    // Clear current selections and lists.
    originSelect.innerHTML = '';
    hashSelect.innerHTML = '';
    hashesList.innerHTML = '';
    originsList.innerHTML = '';

    const currentTab = await getCurrentTab();
    let currentOrigin;
    if (currentTab) {
      currentOrigin = new URL(currentTab.url).origin;
    }

    // Populate origin dropdown.
    const allOrigins = resourceManager.getAllOrigins();
    if (allOrigins.length === 0) {
      originSelect.add(new Option('No origins found', ''));
    } else {
      allOrigins.forEach((origin) => {
        originSelect.add(new Option(origin, origin));
        if (origin === currentOrigin) {
          originSelect.value = origin;
        }
      });
    }

    // Populate hash dropdown.
    const allHashes = resourceManager.getAllHashes();
    const hashesOfCurrentOrigin =
      resourceManager.getHashesByOrigin(currentOrigin);
    if (allHashes.length === 0) {
      hashSelect.add(new Option('No resources found', ''));
    } else {
      let hashSelected = false;

      const resourcesWithSize = await Promise.all(
        allHashes.map(async (hash) => {
          let size = resourceManager.getSizeByHash(hash);
          let mimeType = resourceManager.getMimeTypeByHash(hash);
          if (size === undefined || mimeType === undefined) {
            const response = await chrome.runtime.sendMessage({
              action: 'getResourceMetadata',
              target: 'offscreen-doc',
              data: { hash },
            });
            size = response.data.size ?? size;
            mimeType = response.data.mimeType ?? mimeType;
            if (response.data.size !== undefined)
              resourceManager.recordSize(hash, size);
            if (response.data.mimeType !== undefined)
              resourceManager.recordMimeType(hash, mimeType);
          }
          return { hash, size, mimeType };
        })
      );

      // Sort resources by size in descending order.
      resourcesWithSize.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

      for (const [
        index,
        { hash, size, mimeType },
      ] of resourcesWithSize.entries()) {
        const resourceName = `Resource #${index + 1}`;
        const optionText = `${resourceName} (${
          (mimeType || 'unknown type').split(';')[0]
        }) - ${formatBytes(size)}`;

        hashSelect.add(new Option(optionText, hash));
        if (hashesOfCurrentOrigin.includes(hash)) {
          if (!hashSelected) {
            hashSelected = true;
            hashSelect.value = hash;
          }
        }
      }
    }

    // Redraw the lists.
    updateHashesDisplay();
    updateOriginsDisplay();
  }

  async function addResourceFromFile() {
    let fileHandle;
    try {
      [fileHandle] = await showOpenFilePicker();
    } catch (err) {
      // User cancelled the picker — not an error.
      if (err.name === 'AbortError') return;
      addResourceStatus.hidden = false;
      addResourceStatus.innerHTML = `<span class="status-error">Error: ${err.message}</span>`;
      return;
    }

    const file = await fileHandle.getFile();
    pickFileBtn.disabled = true;
    addResourceStatus.hidden = false;
    addResourceStatus.textContent = `Computing hash for "${file.name}" (${formatBytes(file.size)})…`;

    try {
      const arrayBuffer = await file.arrayBuffer();

      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');

      const mimeType = file.type || 'application/octet-stream';
      const blob = new Blob([arrayBuffer], { type: mimeType });
      const blobURL = URL.createObjectURL(blob);

      addResourceStatus.textContent = `Storing "${file.name}"…`;

      chrome.runtime.sendMessage(
        {
          action: 'storeFileData',
          data: {
            hash: { algorithm: 'SHA-256', value: hashHex },
            blobURL,
            mimeType: { 'content-type': mimeType },
          },
        },
        async (response) => {
          URL.revokeObjectURL(blobURL);
          pickFileBtn.disabled = false;
          if (response?.error) {
            addResourceStatus.innerHTML = `<span class="status-error">Error: ${response.error}</span>`;
            return;
          }
          addResourceStatus.textContent = '';
          const storedStrong = document.createElement('strong');
          storedStrong.textContent = file.name;
          const storedCode = document.createElement('code');
          storedCode.textContent = hashHex;
          addResourceStatus.append(
            'Stored ',
            storedStrong,
            '.',
            document.createElement('br'),
            'Hash: ',
            storedCode
          );
          await refreshUI();
          showToast('Resource stored successfully.');
        }
      );
    } catch (err) {
      pickFileBtn.disabled = false;
      addResourceStatus.innerHTML = `<span class="status-error">Error: ${err.message}</span>`;
    }
  }

  pickFileBtn.addEventListener('click', addResourceFromFile);

  originSelect.addEventListener('change', () => updateHashesDisplay());
  hashSelect.addEventListener('change', updateOriginsDisplay);

  deleteAllBtn.addEventListener('click', async () => {
    const allHashes = resourceManager.getAllHashes();
    if (allHashes.length === 0) {
      alert('There are no resources to remove.');
      return;
    }

    const message =
      '<h1>Are you sure you want to delete all resources?</h1><p>This action cannot be undone.</p>';
    const confirmed = await showConfirmationDialog(message, 'Delete All');

    if (confirmed) {
      chrome.runtime.sendMessage(
        {
          action: 'deleteAllResources',
          target: 'offscreen-doc',
          data: {
            hashes: allHashes,
          },
        },
        async (response) => {
          if (!response.data.success) {
            console.error('Deleting all resources failed.');
            return;
          }
          await resourceManager.deleteResourcesByHash(allHashes);
          await refreshUI();
        }
      );
    }
  });

  // Initial population of the UI.
  await refreshUI();
}

async function getCurrentTab() {
  let queryOptions = { active: true, lastFocusedWindow: true };
  // `tab` will either be a `tabs.Tab` instance or `undefined`.
  let [tab] = await chrome.tabs.query(queryOptions);
  return tab;
}

// Run the main function when the popup is opened.
initializePopup();
