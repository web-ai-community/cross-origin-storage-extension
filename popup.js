// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import ResourceManager from './resource-manager.js';
import { streamingHexDigest } from './sha256.js';

async function initializePopup() {
  const resourceManager = new ResourceManager();

  // Get references to DOM elements.
  const originSelectLabel = document.getElementById('origin-select-label');
  const originSelect = document.getElementById('origin-select');
  const hashSelect = document.getElementById('hash-select');
  const hashesList = document.getElementById('hashes-list');
  const originsList = document.getElementById('origins-list');
  const deleteAllBtn = document.getElementById('delete-all-btn');
  const pickFileBtn = document.getElementById('pick-file-btn');
  const addResourceStatus = document.getElementById('add-resource-status');
  const toast = document.getElementById('toast');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const confirmationMessage = document.getElementById('confirmation-message');
  const dialogConfirmBtn = document.getElementById('dialog-confirm-btn');
  const deleteExclusiveBtn = document.getElementById('delete-exclusive-btn');
  const deleteOriginBtn = document.getElementById('delete-origin-btn');
  const sortSelect = document.getElementById('sort-select');
  const hashSearch = document.getElementById('hash-search');
  const hashSearchResult = document.getElementById('hash-search-result');
  const statsDl = document.getElementById('stats-dl');
  const statsDlStatic = document.getElementById('stats-dl-static');
  const resetStatsBtn = document.getElementById('reset-stats-btn');
  const chartsGrid = document.getElementById('charts-grid');
  const chartsSection = document.getElementById('charts-section');
  const mimeFilterBar = document.getElementById('mime-filter');

  // Current-page hit/miss state — populated before the first render so
  // updateHashesDisplay can annotate and re-order resources immediately.
  let currentPageHitHashes = new Set();
  let currentPageMissHashes = new Set();
  // Origins (including iframe origins) that triggered COS activity this page load.
  let currentPageHitOrigins = new Set();
  let currentPageMissOrigins = new Set();
  let currentTabOrigin = null;

  // Active MIME type filters. Empty = no filter (show all). Reset whenever
  // the selected origin changes or the UI does a full refresh.
  let activeMimeFilters = new Set();

  let selectHighlightTimer;
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

  function showChecklistDialog(
    title,
    subtitle,
    items,
    confirmText = 'Delete Selected'
  ) {
    return new Promise((resolve) => {
      confirmationMessage.innerHTML = '';

      const h1 = document.createElement('h1');
      h1.textContent = title;
      confirmationMessage.append(h1);

      const sub = document.createElement('p');
      sub.textContent = subtitle;
      confirmationMessage.append(sub);

      const ul = document.createElement('ul');
      ul.className = 'checklist';
      for (const { value, label, sublabel } of items) {
        const li = document.createElement('li');
        const labelEl = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = value;
        checkbox.checked = true;
        const span = document.createElement('span');
        span.textContent = label;
        labelEl.append(checkbox, ' ', span);
        if (sublabel) {
          const small = document.createElement('small');
          small.className = 'checklist-sublabel';
          small.textContent = sublabel;
          labelEl.append(document.createElement('br'), small);
        }
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = 'Copy hash';
        copyBtn.className = 'copy-btn';
        copyBtn.addEventListener('click', async () => {
          await navigator.clipboard.writeText(value);
          showToast('Hash copied to clipboard.');
        });
        li.append(labelEl, copyBtn);
        ul.append(li);
      }
      confirmationMessage.append(ul);

      dialogConfirmBtn.textContent = confirmText;

      const closeListener = () => {
        confirmationDialog.removeEventListener('close', closeListener);
        if (confirmationDialog.returnValue !== 'confirm') {
          resolve(null);
          return;
        }
        const checked = [
          ...confirmationMessage.querySelectorAll(
            'input[type="checkbox"]:checked'
          ),
        ].map((cb) => cb.value);
        resolve(checked);
      };

      confirmationDialog.addEventListener('close', closeListener);
      confirmationDialog.showModal();
    });
  }

  function showSingleDeleteDialog(resourceName, hash, origins) {
    return new Promise((resolve) => {
      confirmationMessage.innerHTML = '';

      const h1 = document.createElement('h1');
      h1.textContent = `Are you sure you want to delete ${resourceName}?`;
      confirmationMessage.append(h1);

      if (origins.length > 0) {
        const p = document.createElement('p');
        p.textContent = `This resource is used on the following ${origins.length === 1 ? 'origin' : 'origins'}:`;
        const ul = document.createElement('ul');
        for (const origin of origins) {
          const li = document.createElement('li');
          li.textContent = origin;
          ul.append(li);
        }
        confirmationMessage.append(p, ul);
      } else {
        const p = document.createElement('p');
        p.textContent = 'No origins on record.';
        confirmationMessage.append(p);
      }

      const hashLine = document.createElement('p');
      const code = document.createElement('code');
      code.textContent = `${hash.slice(0, 8)}…`;
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy hash';
      copyBtn.className = 'copy-btn';
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(hash);
        showToast('Hash copied to clipboard.');
      });
      hashLine.append('Hash: ', code, ' ', copyBtn);
      confirmationMessage.append(hashLine);

      dialogConfirmBtn.textContent = 'Delete';

      const closeListener = () => {
        confirmationDialog.removeEventListener('close', closeListener);
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
  function formatTimestamp(tsString) {
    return new Date(tsString).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    if (bytes === undefined || bytes === null) return '';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  // Decimal (SI) byte formatter for bucket boundary labels — keeps powers of 10
  // as round numbers (e.g. 1 000 bytes → "1 kB", not "976.56 KB").
  function formatBytesDecimal(bytes) {
    if (bytes < 1_000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${bytes / 1_000} kB`;
    if (bytes < 1_000_000_000) return `${bytes / 1_000_000} MB`;
    return `${bytes / 1_000_000_000} GB`;
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

  function isViewable(mimeType) {
    if (!mimeType) return false;
    const base = mimeType.split(';')[0].trim().toLowerCase();
    return (
      base.startsWith('text/') ||
      base.startsWith('image/') ||
      base.startsWith('font/') ||
      [
        'application/javascript',
        'application/json',
        'application/xml',
        'application/xhtml+xml',
        'application/font-woff',
        'application/font-woff2',
        'application/x-font-ttf',
        'application/x-font-otf',
      ].includes(base)
    );
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

  async function getResourcesWithMetadata(hashes) {
    return Promise.all(
      hashes.map(async (hash) => {
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
  }

  async function deleteHashesFromStorage(hashes) {
    for (const hash of hashes) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'deleteResource',
            target: 'offscreen-doc',
            data: { hash },
          },
          resolve
        );
      });
    }
    await resourceManager.deleteResourcesByHash(hashes);
    await refreshUI();
  }

  function buildResourceItem(
    hash,
    size,
    mimeType,
    selectedOrigin,
    resourceName,
    pageBadge = null
  ) {
    const typeStr = (mimeType || 'unknown type').split(';')[0];
    const label = resourceName
      ? `${resourceName} (${typeStr}) - ${formatBytes(size)}`
      : `${typeStr} — ${formatBytes(size)}`;

    const li = document.createElement('li');
    li.className = pageBadge
      ? `resource-item resource-item--${pageBadge}`
      : 'resource-item';
    li.title = `Hash: ${hash}`;

    const textContent = document.createElement('div');
    textContent.className = 'resource-text';

    const hashDiv = document.createElement('div');
    hashDiv.className = 'hash-value';
    if (pageBadge) {
      hashDiv.append(label, ' ');
      const badge = document.createElement('span');
      badge.className = `resource-page-badge resource-page-badge--${pageBadge}`;
      badge.textContent = pageBadge === 'hit' ? 'Cache hit' : 'Cache miss';
      hashDiv.append(badge);
    } else {
      hashDiv.textContent = label;
    }
    textContent.append(hashDiv);

    if (selectedOrigin) {
      const history = resourceManager.getAccessHistory(selectedOrigin, hash);
      if (history.length > 0) {
        const accessDetails = document.createElement('details');
        accessDetails.className = 'access-times-details';
        const accessSummary = document.createElement('summary');
        const n = history.length;
        accessSummary.textContent = `Accessed ${n} time${n !== 1 ? 's' : ''}`;
        const timesUl = document.createElement('ul');
        timesUl.className = 'access-times';
        history.forEach((tsString) => {
          const timeLi = document.createElement('li');
          const originBtn = document.createElement('button');
          originBtn.type = 'button';
          originBtn.className = 'origin-link-btn';
          originBtn.textContent = selectedOrigin;
          originBtn.addEventListener('click', () => {
            originSelect.value = selectedOrigin;
            originSelect.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
            });
            originSelect.classList.add('select-highlight');
            clearTimeout(selectHighlightTimer);
            selectHighlightTimer = setTimeout(
              () => originSelect.classList.remove('select-highlight'),
              2000
            );
            updateHashesDisplay();
          });
          timeLi.append(`${formatTimestamp(tsString)} — `, originBtn);
          timesUl.append(timeLi);
        });
        accessDetails.append(accessSummary, timesUl);
        textContent.append(accessDetails);
      }
    }

    const allOrigins = resourceManager.getOriginsByHash(hash);
    const displayOrigins = selectedOrigin
      ? allOrigins.filter((o) => o !== selectedOrigin)
      : allOrigins;
    if (allOrigins.length === 0) {
      const note = document.createElement('p');
      note.className = 'never-accessed-note';
      note.textContent = 'Manually added — no access recorded yet.';
      textContent.append(note);
    } else if (displayOrigins.length > 0) {
      const n = displayOrigins.length;
      const details = document.createElement('details');
      details.className = 'other-origins-details';
      const summary = document.createElement('summary');
      summary.textContent = selectedOrigin
        ? `Also used on ${n} other origin${n !== 1 ? 's' : ''}`
        : `Used on ${n} origin${n !== 1 ? 's' : ''}`;
      const originUl = document.createElement('ul');
      for (const origin of displayOrigins) {
        const originLi = document.createElement('li');
        const originBtn = document.createElement('button');
        originBtn.type = 'button';
        originBtn.className = 'origin-link-btn';
        originBtn.textContent = origin;
        originBtn.addEventListener('click', () => {
          originSelect.value = origin;
          originSelect.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          originSelect.classList.add('select-highlight');
          clearTimeout(selectHighlightTimer);
          selectHighlightTimer = setTimeout(
            () => originSelect.classList.remove('select-highlight'),
            2000
          );
          updateHashesDisplay();
        });
        originLi.append(originBtn);
        const originHistory = resourceManager.getAccessHistory(origin, hash);
        if (originHistory.length > 0) {
          const tsList = document.createElement('ul');
          tsList.className = 'access-times';
          for (const tsString of originHistory) {
            const tsLi = document.createElement('li');
            tsLi.textContent = formatTimestamp(tsString);
            tsList.append(tsLi);
          }
          originLi.append(tsList);
        }
        originUl.append(originLi);
      }
      details.append(summary, originUl);
      textContent.append(details);
    }

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy hash';
    copyBtn.className = 'copy-btn';
    copyBtn.title = 'Copy SHA-256 hash to clipboard';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(hash);
      showToast('Hash copied to clipboard.');
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'save-btn';
    saveBtn.title = 'Save resource to disk';
    saveBtn.addEventListener('click', () => saveResourceToFile(hash));

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'delete-btn';
    deleteBtn.title = 'Delete resource';
    deleteBtn.addEventListener('click', async () => {
      const confirmed = await showSingleDeleteDialog(
        label,
        hash,
        resourceManager.getOriginsByHash(hash)
      );
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

    const btnGroup = document.createElement('div');
    btnGroup.className = 'item-actions';
    const buttons = [copyBtn, saveBtn, deleteBtn];
    if (isViewable(mimeType)) {
      const viewBtn = document.createElement('button');
      viewBtn.textContent = 'View';
      viewBtn.className = 'view-btn';
      viewBtn.title = 'View resource in new tab';
      viewBtn.addEventListener('click', () => {
        chrome.tabs.create({
          url: chrome.runtime.getURL(`viewer.html?hash=${hash}`),
        });
      });
      buttons.unshift(viewBtn);
    }
    btnGroup.append(...buttons);

    li.append(textContent, btnGroup);
    return li;
  }

  function getSelectedOriginValues() {
    if (originSelect.multiple) {
      return Array.from(originSelect.selectedOptions)
        .map((o) => o.value)
        .filter((v) => v && v !== '*');
    }
    const val = originSelect.value;
    return val ? [val] : [];
  }

  /**
   * Updates the list of hashes based on the selected origin(s).
   */
  async function updateHashesDisplay() {
    const selectedValues = getSelectedOriginValues();
    const isAllOrigins = !originSelect.multiple && originSelect.value === '*';
    const isMultiOrigin = originSelect.multiple && selectedValues.length > 1;
    const selectedOrigin =
      !isAllOrigins && !isMultiOrigin && selectedValues.length === 1
        ? selectedValues[0]
        : null;

    hashesList.innerHTML = '';
    if (!isAllOrigins && selectedValues.length === 0) {
      deleteExclusiveBtn.disabled = true;
      deleteOriginBtn.disabled = true;
      sortSelect.disabled = true;
      return;
    }

    const hashes = isAllOrigins
      ? resourceManager
          .getAllHashes()
          .filter((h) => resourceManager.getOriginsByHash(h).length > 0)
      : isMultiOrigin
        ? [
            ...new Set(
              selectedValues.flatMap((o) =>
                resourceManager.getHashesByOrigin(o)
              )
            ),
          ]
        : resourceManager.getHashesByOrigin(selectedValues[0]);

    const noResources = hashes.length === 0;
    deleteExclusiveBtn.disabled = isAllOrigins || isMultiOrigin || noResources;
    deleteOriginBtn.disabled = isAllOrigins || isMultiOrigin || noResources;
    sortSelect.disabled = noResources;

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

    // Build and render MIME filter chips from the discovered types.
    const allMimeTypes = [
      ...new Set(
        resourcesWithSize.map((r) =>
          (r.mimeType || 'application/octet-stream').split(';')[0].trim()
        )
      ),
    ].sort();

    mimeFilterBar.innerHTML = '';
    if (allMimeTypes.length > 0) {
      mimeFilterBar.hidden = false;
      const legend = document.createElement('legend');
      const hint = document.createElement('small');
      const div = document.createElement('div');
      div.ariaHidden = 'true';
      div.classList.add('mime-filter-label');
      legend.append('Resource filter (select multiple)');
      mimeFilterBar.append(legend);
      hint.textContent = ' (select multiple)';
      div.append('Resource filter', hint);
      mimeFilterBar.append(div);
      const chipsDiv = document.createElement('div');
      chipsDiv.className = 'mime-chips';
      for (const mime of allMimeTypes) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.title = mime;
        const subtype = mime.split('/')[1] || mime;
        chip.textContent = subtype;
        chip.className =
          activeMimeFilters.size > 0 && activeMimeFilters.has(mime)
            ? 'mime-chip mime-chip--active'
            : 'mime-chip';
        chip.addEventListener('click', () => {
          if (activeMimeFilters.has(mime)) {
            activeMimeFilters.delete(mime);
          } else {
            activeMimeFilters.add(mime);
          }
          updateHashesDisplay();
        });
        chipsDiv.append(chip);
      }
      mimeFilterBar.append(chipsDiv);
    } else {
      mimeFilterBar.hidden = true;
    }

    // Apply MIME filter (empty set = no filter = show all).
    const visibleResources =
      activeMimeFilters.size === 0
        ? resourcesWithSize
        : resourcesWithSize.filter((r) =>
            activeMimeFilters.has(
              (r.mimeType || 'application/octet-stream').split(';')[0].trim()
            )
          );

    const getAccessData = (hash) => {
      if (isAllOrigins || isMultiOrigin) {
        const originsForHash = isAllOrigins
          ? resourceManager.getOriginsByHash(hash)
          : selectedValues.filter((o) =>
              resourceManager.getOriginsByHash(hash).includes(o)
            );
        let mostRecent = null;
        let totalCount = 0;
        for (const origin of originsForHash) {
          const history = resourceManager.getAccessHistory(origin, hash);
          totalCount += history.length;
          if (history.length > 0) {
            const ts = new Date(history[0]).getTime();
            if (mostRecent === null || ts > mostRecent) mostRecent = ts;
          }
        }
        return { mostRecent, totalCount };
      }
      const history = resourceManager.getAccessHistory(selectedOrigin, hash);
      return {
        mostRecent: history.length > 0 ? new Date(history[0]).getTime() : null,
        totalCount: history.length,
      };
    };

    switch (sortSelect.value) {
      case 'size-asc':
        visibleResources.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
        break;
      case 'origins-desc':
        visibleResources.sort(
          (a, b) =>
            resourceManager.getOriginsByHash(b.hash).length -
              resourceManager.getOriginsByHash(a.hash).length ||
            (b.size ?? 0) - (a.size ?? 0)
        );
        break;
      case 'origins-asc':
        visibleResources.sort(
          (a, b) =>
            resourceManager.getOriginsByHash(a.hash).length -
              resourceManager.getOriginsByHash(b.hash).length ||
            (b.size ?? 0) - (a.size ?? 0)
        );
        break;
      case 'recent-desc':
        visibleResources.sort(
          (a, b) =>
            (getAccessData(b.hash).mostRecent ?? 0) -
              (getAccessData(a.hash).mostRecent ?? 0) ||
            (b.size ?? 0) - (a.size ?? 0)
        );
        break;
      case 'recent-asc':
        visibleResources.sort(
          (a, b) =>
            (getAccessData(a.hash).mostRecent ?? Infinity) -
              (getAccessData(b.hash).mostRecent ?? Infinity) ||
            (b.size ?? 0) - (a.size ?? 0)
        );
        break;
      case 'freq-desc':
        visibleResources.sort(
          (a, b) =>
            getAccessData(b.hash).totalCount -
              getAccessData(a.hash).totalCount || (b.size ?? 0) - (a.size ?? 0)
        );
        break;
      case 'freq-asc':
        visibleResources.sort(
          (a, b) =>
            getAccessData(a.hash).totalCount -
              getAccessData(b.hash).totalCount || (b.size ?? 0) - (a.size ?? 0)
        );
        break;
      case 'mime-asc':
        visibleResources.sort((a, b) => {
          const ma = (a.mimeType || '').split(';')[0].trim();
          const mb = (b.mimeType || '').split(';')[0].trim();
          return ma.localeCompare(mb) || (b.size ?? 0) - (a.size ?? 0);
        });
        break;
      case 'mime-desc':
        visibleResources.sort((a, b) => {
          const ma = (a.mimeType || '').split(';')[0].trim();
          const mb = (b.mimeType || '').split(';')[0].trim();
          return mb.localeCompare(ma) || (b.size ?? 0) - (a.size ?? 0);
        });
        break;
      default: // 'size-desc'
        visibleResources.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    }

    // When the selected origin(s) overlap with the origins that had COS
    // activity on this page load, float hit/miss resources to the top and
    // annotate them with Cache hit / Cache miss badges.
    const pageOriginSet = new Set([
      ...currentPageHitOrigins,
      ...currentPageMissOrigins,
    ]);
    const showPageBadges =
      !isAllOrigins &&
      currentPageHitHashes.size + currentPageMissHashes.size > 0 &&
      (isMultiOrigin
        ? selectedValues.some((o) => pageOriginSet.has(o))
        : pageOriginSet.size > 0
          ? pageOriginSet.has(selectedOrigin)
          : selectedOrigin === currentTabOrigin);
    if (showPageBadges) {
      const active = visibleResources.filter(
        (r) =>
          currentPageHitHashes.has(r.hash) || currentPageMissHashes.has(r.hash)
      );
      const inactive = visibleResources.filter(
        (r) =>
          !currentPageHitHashes.has(r.hash) &&
          !currentPageMissHashes.has(r.hash)
      );
      visibleResources.splice(
        0,
        visibleResources.length,
        ...active,
        ...inactive
      );
    }

    if (visibleResources.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent =
        activeMimeFilters.size > 0
          ? 'No resources match the selected MIME type filter.'
          : isMultiOrigin
            ? 'No resources from the selected origins are stored in COS.'
            : 'No resources from this origin are stored in COS.';
      hashesList.append(p);
    }

    for (const [
      index,
      { hash, size, mimeType },
    ] of visibleResources.entries()) {
      const pageBadge = showPageBadges
        ? currentPageHitHashes.has(hash)
          ? 'hit'
          : currentPageMissHashes.has(hash)
            ? 'miss'
            : null
        : null;
      hashesList.append(
        buildResourceItem(
          hash,
          size,
          mimeType,
          isAllOrigins ? null : selectedOrigin,
          `Resource #${index + 1}`,
          pageBadge
        )
      );
    }
  }

  async function updateOriginsDisplay() {
    const selectedHash = hashSelect.value;
    originsList.innerHTML = '';
    if (!selectedHash) return;

    let size = resourceManager.getSizeByHash(selectedHash);
    let mimeType = resourceManager.getMimeTypeByHash(selectedHash);
    if (size === undefined || mimeType === undefined) {
      const response = await chrome.runtime.sendMessage({
        action: 'getResourceMetadata',
        target: 'offscreen-doc',
        data: { hash: selectedHash },
      });
      size = response.data.size ?? size;
      mimeType = response.data.mimeType ?? mimeType;
      if (response.data.size !== undefined)
        resourceManager.recordSize(selectedHash, size);
      if (response.data.mimeType !== undefined)
        resourceManager.recordMimeType(selectedHash, mimeType);
    }

    originsList.append(
      buildResourceItem(selectedHash, size, mimeType, null, null)
    );
  }

  deleteExclusiveBtn.addEventListener('click', async () => {
    const selectedOrigin = originSelect.value;
    if (!selectedOrigin) return;

    const allHashes = resourceManager.getHashesByOrigin(selectedOrigin);
    const exclusiveHashes = allHashes.filter(
      (h) => resourceManager.getOriginsByHash(h).length === 1
    );

    if (exclusiveHashes.length === 0) {
      showToast('No resources are exclusively used by this origin.');
      return;
    }

    const resourcesData = await getResourcesWithMetadata(exclusiveHashes);
    resourcesData.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    const items = resourcesData.map(({ hash, size, mimeType }) => ({
      value: hash,
      label: `${(mimeType || 'unknown type').split(';')[0]} — ${formatBytes(size)} (${hash.slice(0, 8)}…)`,
    }));

    const hashesToDelete = await showChecklistDialog(
      `Delete exclusive resources for ${selectedOrigin}?`,
      'Uncheck resources you want to keep.',
      items,
      'Delete Selected'
    );

    if (!hashesToDelete || hashesToDelete.length === 0) {
      if (hashesToDelete !== null)
        showToast('No resources selected for deletion.');
      return;
    }

    await deleteHashesFromStorage(hashesToDelete);
    showToast(
      `${hashesToDelete.length} resource${hashesToDelete.length !== 1 ? 's' : ''} deleted.`
    );
  });

  deleteOriginBtn.addEventListener('click', async () => {
    const selectedOrigin = originSelect.value;
    if (!selectedOrigin) return;

    const allHashes = resourceManager.getHashesByOrigin(selectedOrigin);
    if (allHashes.length === 0) {
      showToast('No resources for this origin.');
      return;
    }

    const resourcesData = await getResourcesWithMetadata(allHashes);
    resourcesData.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    const items = resourcesData.map(({ hash, size, mimeType }) => {
      const otherOrigins = resourceManager
        .getOriginsByHash(hash)
        .filter((o) => o !== selectedOrigin);
      const label = `${(mimeType || 'unknown type').split(';')[0]} — ${formatBytes(size)} (${hash.slice(0, 8)}…)`;
      const sublabel =
        otherOrigins.length > 0
          ? `Also used by: ${otherOrigins.join(', ')}`
          : 'Only used by this origin';
      return { value: hash, label, sublabel };
    });

    const hashesToDelete = await showChecklistDialog(
      `Delete resources for ${selectedOrigin}?`,
      'Uncheck resources you want to keep.',
      items,
      'Delete Selected'
    );

    if (!hashesToDelete || hashesToDelete.length === 0) {
      if (hashesToDelete !== null)
        showToast('No resources selected for deletion.');
      return;
    }

    await deleteHashesFromStorage(hashesToDelete);
    showToast(
      `${hashesToDelete.length} resource${hashesToDelete.length !== 1 ? 's' : ''} deleted.`
    );
  });

  /**
   * A central function to completely refresh the UI from storage data.
   */
  async function refreshUI() {
    activeMimeFilters = new Set();

    // Reload the latest data from storage.
    await resourceManager.loadManagerFromStorage();

    // Clear current selections and lists.
    originSelect.innerHTML = '';
    hashSelect.innerHTML = '';
    hashesList.innerHTML = '';
    originsList.innerHTML = '';

    const currentTab = await getCurrentTab();
    let currentOrigin;
    if (currentTab?.url) {
      try {
        const parsed = new URL(currentTab.url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          currentOrigin = parsed.origin;
        }
      } catch (_) {}
    }

    // Populate origin dropdown.
    const allOrigins = resourceManager.getAllOrigins();
    const currentOriginHasResources =
      currentOrigin && allOrigins.includes(currentOrigin);

    // Detect iframe scenario: COS activity from origins other than (or in
    // addition to) the top-level tab URL. When this happens we switch the
    // select to multi-select and pre-select all active iframe origins so the
    // popup immediately shows the right resources instead of showing "no
    // resources" for the hosting origin.
    const pageActiveOrigins = new Set([
      ...currentPageHitOrigins,
      ...currentPageMissOrigins,
    ]);
    const knownActiveOrigins = [...pageActiveOrigins].filter((o) =>
      allOrigins.includes(o)
    );
    // Use multi-select unless the only active origin is the top-level URL itself.
    const useMultiSelect =
      knownActiveOrigins.length > 0 &&
      !(
        knownActiveOrigins.length === 1 &&
        knownActiveOrigins[0] === currentTabOrigin
      );

    if (!currentOrigin && allOrigins.length === 0) {
      originSelect.add(new Option('No origins found', ''));
    } else {
      // Pin the current HTTP/HTTPS origin at the top, whether or not it has
      // stored resources. If it has none, label it so the user isn't confused.
      if (currentOrigin) {
        const label = currentOriginHasResources
          ? currentOrigin
          : `${currentOrigin} — no resources`;
        originSelect.add(new Option(label, currentOrigin));
        if (allOrigins.length > 0) {
          originSelect.appendChild(document.createElement('hr'));
        }
      }
      if (allOrigins.length > 0) {
        if (!useMultiSelect) {
          // "All origins" only makes sense in single-select mode.
          originSelect.add(new Option('All origins', '*'));
          originSelect.appendChild(document.createElement('hr'));
        }
        // Omit the current origin from the alphabetical list — it's already pinned.
        for (const origin of allOrigins) {
          if (origin !== currentOrigin) {
            originSelect.add(new Option(origin, origin));
          }
        }
      }

      if (useMultiSelect) {
        originSelect.multiple = true;
        originSelect.size = Math.min(originSelect.options.length, 8);
        // Pre-select every origin that had COS activity on this page load.
        for (const option of originSelect.options) {
          option.selected = knownActiveOrigins.includes(option.value);
        }
        originSelectLabel.textContent =
          'Iframe origins with COS activity detected. Select one or more to inspect.';
      } else {
        originSelect.multiple = false;
        originSelect.removeAttribute('size');
        if (currentOrigin) {
          originSelect.value = currentOrigin;
        }
        originSelectLabel.textContent =
          'Select an origin to see its shared resources and last access times.';
      }
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
    await updateOriginsDisplay();
    await updateHashSearch();
    renderStats();
  }

  function renderStats() {
    const s = resourceManager.getStats();

    const resettable = [
      [
        'Cache hit ratio',
        s.hitRatio !== null ? `${(s.hitRatio * 100).toFixed(1)}%` : '—',
      ],
      ['Cache hits', s.totalHits.toLocaleString()],
      ['Cache misses', s.totalMisses.toLocaleString()],
      [
        'Bytes served from cache',
        s.bytesServed > 0 ? formatBytes(s.bytesServed) : '—',
      ],
    ];
    const permanent = [
      [
        'Saved by deduplication',
        s.deduplicationSavings > 0 ? formatBytes(s.deduplicationSavings) : '—',
      ],
      [
        'COS cache used',
        s.totalStorage > 0 ? formatBytes(s.totalStorage) : '—',
      ],
      ['Unique resources', s.resourceCount.toLocaleString()],
      ['Unique origins', s.originCount.toLocaleString()],
    ];

    const populate = (dl, rows) => {
      dl.innerHTML = '';
      for (const [label, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dl.append(dt, dd);
      }
    };
    populate(statsDl, resettable);
    populate(statsDlStatic, permanent);

    // MIME type distribution bar chart
    const mimeData = {};
    for (const hash of resourceManager.getAllHashes()) {
      const mime = (resourceManager.getMimeTypeByHash(hash) || 'unknown')
        .split(';')[0]
        .trim();
      const size = resourceManager.getSizeByHash(hash) || 0;
      if (!mimeData[mime]) mimeData[mime] = { count: 0, bytes: 0 };
      mimeData[mime].count++;
      mimeData[mime].bytes += size;
    }
    const mimeEntries = Object.entries(mimeData)
      .sort((a, b) => b[1].count - a[1].count || b[1].bytes - a[1].bytes)
      .map(([mime, { count }]) => ({ label: mime, count, value: count }));
    const maxMimeCount = mimeEntries[0]?.count ?? 0;

    chartsGrid.innerHTML = '';

    // Size distribution chart — buckets are derived dynamically from the data.
    // Boundaries follow a log₁₀ scale (powers of 10 in bytes), so the chart
    // stays readable whether the store holds tiny JSON configs or multi-GB
    // model weights. Only buckets that contain at least one resource are shown.
    const allSizes = resourceManager
      .getAllHashes()
      .map((h) => resourceManager.getSizeByHash(h) || 0)
      .filter((sz) => sz > 0);
    let sizeEntries = [];
    if (allSizes.length > 0) {
      const minExp = Math.floor(Math.log10(Math.min(...allSizes)));
      const maxExp = Math.floor(Math.log10(Math.max(...allSizes)));
      // Build one bucket per decade that the data actually spans.
      const boundaries = [];
      for (let e = minExp; e <= maxExp; e++) {
        boundaries.push(Math.pow(10, e));
      }
      boundaries.push(Infinity);
      const sizeBuckets = boundaries.map((upper, i) => {
        const lower = i === 0 ? 0 : boundaries[i - 1];
        const label =
          upper === Infinity
            ? `≥ ${formatBytesDecimal(lower)}`
            : lower === 0
              ? `< ${formatBytesDecimal(upper)}`
              : `${formatBytesDecimal(lower)} – ${formatBytesDecimal(upper)}`;
        return { label, lower, upper, count: 0, bytes: 0 };
      });
      for (const sz of allSizes) {
        const bucket =
          sizeBuckets.find((b) => sz < b.upper) ??
          sizeBuckets[sizeBuckets.length - 1];
        bucket.count++;
        bucket.bytes += sz;
      }
      // Also bucket the zero-size resources in a leading "0 B" bin if any exist.
      const zeroCount = resourceManager.getAllHashes().length - allSizes.length;
      if (zeroCount > 0)
        sizeBuckets.unshift({ label: '0 B', count: zeroCount, bytes: 0 });
      const activeSizeBuckets = sizeBuckets.filter((b) => b.count > 0);
      sizeEntries = activeSizeBuckets.map((b) => ({
        label: b.label,
        count: b.count,
        value: b.count,
      }));
    }
    const maxSizeCount =
      sizeEntries.length > 0 ? Math.max(...sizeEntries.map((e) => e.count)) : 0;

    // Sharing factor chart — also derived dynamically.
    // When the max sharing count is low (≤ 10) every value gets its own row.
    // Once it grows beyond that we switch to log₂ buckets (1, 2, 3–4, 5–8,
    // 9–16, …) so a resource shared by 100 origins still fits neatly.
    const sharingCounts = {};
    for (const hash of resourceManager.getAllHashes()) {
      const n = resourceManager.getOriginsByHash(hash).length;
      sharingCounts[n] = (sharingCounts[n] || 0) + 1;
    }
    const maxSharing = Math.max(...Object.keys(sharingCounts).map(Number), 0);
    let sharingEntries;
    if (maxSharing <= 10) {
      // Discrete rows — one per exact origin count.
      sharingEntries = Object.entries(sharingCounts)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([n, count]) => ({
          label:
            Number(n) === 0
              ? 'No origins'
              : Number(n) === 1
                ? '1 origin'
                : `${n} origins`,
          count,
          value: count,
        }));
    } else {
      // Log₂ buckets: 0, 1, 2, 3–4, 5–8, 9–16, …
      const logBuckets = [
        { lower: 0, upper: 0, label: 'No origins', count: 0 },
      ];
      for (let exp = 0; Math.pow(2, exp) <= maxSharing; exp++) {
        const lower = Math.pow(2, exp);
        const upper = Math.pow(2, exp + 1) - 1;
        const label =
          lower === upper
            ? `${lower} origin${lower === 1 ? '' : 's'}`
            : `${lower}–${upper} origins`;
        logBuckets.push({ lower, upper, label, count: 0 });
      }
      for (const [n, count] of Object.entries(sharingCounts)) {
        const num = Number(n);
        const bucket =
          num === 0
            ? logBuckets[0]
            : logBuckets.find(
                (b) => b.lower !== 0 && num >= b.lower && num <= b.upper
              );
        if (bucket) bucket.count += count;
      }
      sharingEntries = logBuckets
        .filter((b) => b.count > 0)
        .map(({ label, count }) => ({ label, count, value: count }));
    }
    const maxSharingCount = Math.max(...sharingEntries.map((e) => e.count), 0);

    if (mimeEntries.length > 0)
      appendChartSection(chartsGrid, 'By MIME type', mimeEntries, maxMimeCount);
    if (sizeEntries.length > 0)
      appendChartSection(
        chartsGrid,
        'By size bucket',
        sizeEntries,
        maxSizeCount
      );
    if (sharingEntries.length > 0)
      appendChartSection(
        chartsGrid,
        'By origins',
        sharingEntries,
        maxSharingCount
      );

    chartsSection.hidden = chartsGrid.children.length === 0;
  }

  function appendChartSection(container, heading, entries, maxValue) {
    const h = document.createElement('p');
    h.className = 'mime-chart-heading';
    h.textContent = heading;
    container.append(h);

    const hLabel = document.createElement('span');
    const hBar = document.createElement('div');
    const hRight = document.createElement('span');
    hRight.className = 'mime-bar-header';
    hRight.textContent = 'Resources';
    container.append(hLabel, hBar, hRight);

    for (const { label, count, value } of entries) {
      const barLabel = document.createElement('span');
      barLabel.className = 'mime-bar-label';
      barLabel.textContent = label;
      barLabel.title = label;

      const track = document.createElement('div');
      track.className = 'mime-bar-track';
      const fill = document.createElement('div');
      fill.className = 'mime-bar-fill';
      fill.style.width = maxValue > 0 ? `${(value / maxValue) * 100}%` : '100%';
      track.append(fill);

      const rightVal = document.createElement('span');
      rightVal.className = 'mime-bar-value';
      rightVal.textContent = String(count);

      container.append(barLabel, track, rightVal);
    }
  }

  async function updateHashSearch() {
    const query = hashSearch.value.trim().toLowerCase();
    hashSearchResult.innerHTML = '';
    if (!query) return;

    const matches = resourceManager
      .getAllHashes()
      .filter((h) => h.startsWith(query));

    if (matches.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No resource found.';
      hashSearchResult.append(p);
      return;
    }

    const resourcesData = await getResourcesWithMetadata(matches);
    resourcesData.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    const ul = document.createElement('ul');
    for (const { hash, size, mimeType } of resourcesData) {
      ul.append(buildResourceItem(hash, size, mimeType, null, null));
    }
    hashSearchResult.append(ul);
  }

  async function addResourcesFromFiles() {
    let fileHandles;
    try {
      fileHandles = await showOpenFilePicker({ multiple: true });
    } catch (err) {
      if (err.name === 'AbortError') return;
      addResourceStatus.hidden = false;
      addResourceStatus.innerHTML = `<span class="status-error">Error: ${err.message}</span>`;
      return;
    }

    pickFileBtn.disabled = true;
    addResourceStatus.hidden = false;

    const total = fileHandles.length;
    const successes = [];
    const errors = [];

    for (const [i, fileHandle] of fileHandles.entries()) {
      const file = await fileHandle.getFile();
      addResourceStatus.textContent =
        `[${i + 1}/${total}] Computing SHA-256 for "${file.name}" ` +
        `(${formatBytes(file.size)})…`;

      try {
        const hashHex = await streamingHexDigest('SHA-256', file);
        const mimeType = file.type || 'application/octet-stream';
        // Use the File directly — no intermediate ArrayBuffer copy.
        const blobURL = URL.createObjectURL(file);

        addResourceStatus.textContent = `[${i + 1}/${total}] Storing "${file.name}"…`;

        await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              action: 'storeFileData',
              data: {
                hash: { algorithm: 'SHA-256', value: hashHex },
                blobURL,
                mimeType: { 'content-type': mimeType },
              },
            },
            (response) => {
              URL.revokeObjectURL(blobURL);
              if (response?.error) {
                errors.push({ name: file.name, message: response.error });
              } else {
                successes.push({ name: file.name, hashHex });
              }
              resolve();
            }
          );
        });
      } catch (err) {
        errors.push({ name: file.name, message: err.message });
      }
    }

    pickFileBtn.disabled = false;
    addResourceStatus.textContent = '';

    if (successes.length > 0) {
      const heading = document.createElement('div');
      heading.textContent = `Stored ${successes.length} resource${successes.length > 1 ? 's' : ''}:`;
      addResourceStatus.append(heading);
      for (const { name, hashHex } of successes) {
        const row = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = name;
        const code = document.createElement('code');
        code.textContent = hashHex;
        row.append(strong, document.createElement('br'), 'Hash: ', code);
        addResourceStatus.append(row);
      }
    }

    for (const { name, message } of errors) {
      const errSpan = document.createElement('span');
      errSpan.className = 'status-error';
      errSpan.textContent = `Error storing "${name}": ${message}`;
      addResourceStatus.append(errSpan, document.createElement('br'));
    }

    if (successes.length > 0) {
      await refreshUI();
      showToast(
        `${successes.length} resource${successes.length > 1 ? 's' : ''} stored successfully.`
      );
    }
  }

  pickFileBtn.addEventListener('click', addResourcesFromFiles);

  resetStatsBtn.addEventListener('click', async () => {
    await resourceManager.resetStats();
    renderStats();
    showToast('Statistics reset.');
  });

  originSelect.addEventListener('change', () => {
    activeMimeFilters = new Set();
    updateHashesDisplay();
  });
  sortSelect.addEventListener('change', () => {
    chrome.storage.local.set({ sortOrder: sortSelect.value });
    updateHashesDisplay();
  });
  hashSelect.addEventListener('change', updateOriginsDisplay);
  hashSearch.addEventListener('input', updateHashSearch);

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

  // Restore saved sort order before first render.
  const { sortOrder } = await chrome.storage.local.get('sortOrder');
  if (sortOrder) sortSelect.value = sortOrder;

  // Fetch current-page hit/miss data BEFORE the first render so
  // updateHashesDisplay can annotate and sort resources on first paint.
  const activeTab = await getCurrentTab();
  if (activeTab?.url) {
    try {
      const parsed = new URL(activeTab.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        currentTabOrigin = parsed.origin;
      }
    } catch (_) {}
  }
  if (activeTab?.id) {
    const resp = await chrome.runtime.sendMessage({
      action: 'getTabStats',
      data: { tabId: activeTab.id },
    });
    if (resp?.data) {
      currentPageHitHashes = new Set(resp.data.hitHashes || []);
      currentPageMissHashes = new Set(resp.data.missHashes || []);
      currentPageHitOrigins = new Set(resp.data.hitOrigins || []);
      currentPageMissOrigins = new Set(resp.data.missOrigins || []);
    }
  }

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
