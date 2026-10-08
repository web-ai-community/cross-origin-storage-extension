// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// The page that offers to move the extension's files into the browser's own
// Cross-Origin Storage. See native-migration.js for the overall design: this
// page moves the files shared with all sites that are on the Public Hash
// List, and turns on the per-site moving that content.js does for the rest.

const $ = (id) => document.getElementById(id);

const files = (count) => `${count} ${count === 1 ? 'file' : 'files'}`;

function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

// The explainer renamed `requestFileHandle()` to `getFileHandle()`;
// implementations built before that still have the old name.
function nativeFileHandle(hash, options) {
  const cos = navigator.crossOriginStorage;
  const get = cos.getFileHandle ?? cos.requestFileHandle;
  return get.call(cos, hash, options);
}

// Must match copyIntoNativeCOS() in content.js.
async function copyIntoNativeCOS(hash, blob, origins) {
  const options = { create: true };
  if (origins !== undefined) options.origins = origins;
  const writable = await (
    await nativeFileHandle(hash, options)
  ).createWritable();
  await writable.write(blob);
  await writable.close();
  const stored = await (await nativeFileHandle(hash)).getFile();
  if (stored.size !== blob.size) {
    throw new Error(`Stored ${stored.size} of ${blob.size} bytes`);
  }
}

// Copies the files shared with all sites that are on the Public Hash List,
// so they're available right away. The extension keeps its copy: whether
// sites may read a file stored this way depends on the browser's own copy of
// the list, which can be older than the extension's, so the copy is only
// deleted once a site that stored the file confirms it can read it there
// (see moveFilesIntoNativeCOS() in content.js). Extension pages share the
// background's origin, so they can read its Cache Storage directly.
async function copyNow(files) {
  const cache = await caches.open('cos-storage');
  const progress = $('progress');
  const text = $('progress-text');
  progress.max = files.length;
  progress.value = 0;
  progress.hidden = false;
  text.hidden = false;
  let failed = 0;
  for (const [i, { hash }] of files.entries()) {
    text.textContent = `Copying file ${i + 1} of ${files.length}…`;
    try {
      const response = await cache.match(
        `https://cos.example.com/SHA-256_${hash}`,
      );
      if (response) {
        await copyIntoNativeCOS(
          { algorithm: 'SHA-256', value: hash },
          await response.blob(),
          '*',
        );
      }
    } catch (err) {
      // It still moves per site, like every other file.
      failed++;
      console.warn(`[COS] Could not copy ${hash}:`, err);
    }
    progress.value = i + 1;
  }
  return failed;
}

async function sendMessage(action, data) {
  // The extension opens this page while it's being updated, and the new
  // background can take a moment to start listening.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ action, data });
      if (response?.error) throw new Error(response.error);
      return response.data;
    } catch (err) {
      if (attempt >= 10 || !/Receiving end does not exist/.test(err.message)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function main() {
  if (!('crossOriginStorage' in navigator)) {
    $('status').textContent =
      "Your browser doesn't support Cross-Origin Storage itself yet, so there is nowhere to move the files to. The extension keeps serving them.";
    return;
  }
  let plan = await sendMessage('getMigrationPlan');
  if (plan.needsList) {
    // Only files on the Public Hash List can move right away, and checking
    // means downloading the list once (about 88 MB).
    const timer = setInterval(async () => {
      const progress = await sendMessage('getPublicHashListProgress').catch(
        () => null,
      );
      if (progress?.phase === 'downloading' && progress.receivedBytes) {
        $('status').textContent =
          `Downloading the Public Hash List, to see which files can move right away: ${formatBytes(progress.receivedBytes)}${progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ''}…`;
      } else if (progress?.phase && progress.phase !== 'idle') {
        $('status').textContent = 'Checking the Public Hash List…';
      }
    }, 500);
    try {
      plan = await sendMessage('getMigrationPlan', { download: true });
    } finally {
      clearInterval(timer);
    }
  }
  const total = plan.now.length + plan.later;
  if (!total) {
    $('status').textContent = plan.moved
      ? `All done: ${files(plan.moved)} moved to your browser's storage.`
      : "The extension's storage is empty, so there is nothing to move.";
    return;
  }
  $('status').hidden = true;
  $('plan').hidden = false;
  $('total-count').textContent = files(total);
  $('total-size').textContent = formatBytes(plan.bytes);
  $('now-item').textContent =
    `${files(plan.now.length)} shared with all sites and on the Public Hash List ${plan.now.length === 1 ? 'is' : 'are'} copied right away, so every site can use ${plan.now.length === 1 ? 'it' : 'them'}.`;
  $('now-item').hidden = !plan.now.length;
  if (plan.optIn) {
    $('actions').hidden = true;
    $('progress-text').hidden = false;
    $('progress-text').textContent =
      `Moving is on: ${files(plan.moved)} moved so far, ${total} left. Each moves the next time you visit a site that stored it.`;
    return;
  }

  $('not-now').addEventListener('click', () => window.close());
  $('move').addEventListener('click', async () => {
    $('move').disabled = true;
    $('not-now').disabled = true;
    await sendMessage('setMigrationOptIn', { enabled: true });
    const failed = await copyNow(plan.now);
    const copied = plan.now.length - failed;
    $('progress-text').textContent = [
      copied
        ? `${files(copied)} ${copied === 1 ? 'is' : 'are'} now available to all sites.`
        : '',
      'Each file moves fully, and the extension deletes its copy, the next time you visit a site that stored it.',
    ]
      .filter(Boolean)
      .join(' ');
    $('actions').hidden = true;
  });
}

main().catch((err) => {
  $('status').hidden = false;
  $('status').textContent = `Something went wrong: ${err.message}`;
});
