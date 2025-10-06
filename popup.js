import ResourceManager from './resource-manager.js';

async function initializePopup() {
  const resourceManager = new ResourceManager();

  // Get references to DOM elements.
  const originSelect = document.getElementById('origin-select');
  const hashSelect = document.getElementById('hash-select');
  const hashesList = document.getElementById('hashes-list');
  const originsList = document.getElementById('origins-list');
  const deleteAllBtn = document.getElementById('delete-all-btn');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const confirmationMessage = document.getElementById('confirmation-message');
  const dialogConfirmBtn = document.getElementById('dialog-confirm-btn');

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
      li.append(deleteBtn);

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
    if (!selectedHash) return;

    const origins = resourceManager.getOriginsByHash(selectedHash);
    origins.forEach((origin) => {
      const li = document.createElement('li');
      li.textContent = origin;
      originsList.append(li);
    });
  }

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
