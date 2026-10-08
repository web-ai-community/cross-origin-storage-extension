// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Moves the files in the extension's COS cache into the browser's own,
// native Cross-Origin Storage, once the browser has it. The user opts in on
// migration.html, which the extension opens once the first time it finds the
// native API while its cache holds files (on install, update, or browser
// startup), and which options.html also opens on request.
//
// Who writes a file into native COS decides who may read it there: the
// storing origin, origins same-site with it, any origins list, and everyone
// for a file stored with origins '*' whose hash is on the browser's own copy
// of the Public Hash List. So:
//   - Files stored with origins '*' that are on the extension's copy of the
//     list are copied right away, from migration.html, so every site can use
//     them at once.
//   - Every file moves fully when the user next visits a site that stored
//     it: content.js writes it from that site's page, with the file's
//     recorded origins, so it keeps the same readers, and only then does the
//     extension delete its copy. This includes the files copied right away,
//     since the browser's list can be older than the extension's, which would
//     leave a file copied from the extension readable by no site.
// Inside the extension, `navigator.crossOriginStorage` can only be the
// browser's own: the polyfill runs in web pages only. In Chrome's service
// worker the attribute exists, but calls are refused, which is why the
// moving itself happens in pages.
function hasNativeCrossOriginStorage() {
  return typeof navigator !== 'undefined' && 'crossOriginStorage' in navigator;
}

const KEY_OPT_IN = 'migrationOptIn';
const KEY_OFFER_SHOWN = 'migrationOfferShown';
const KEY_MOVED_COUNT = 'migrationMovedCount';

// How long a file handed to a page for moving is kept from other pages, so
// that two tabs of the same site don't both move it. A failed move is retried
// once this has passed.
const CLAIM_MS = 60 * 60 * 1000;
const claims = new Map(); // hash -> time handed out

// The Public Hash List is about 88 MB, so a cached copy up to a month old is
// accepted, as for telemetry.
const PHL_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Opens migration.html once: the first time the browser has native COS while
 * the extension's cache holds files.
 */
async function maybeOfferMigration(cachePromise) {
  if (!hasNativeCrossOriginStorage()) return;
  const { [KEY_OFFER_SHOWN]: shown } =
    await chrome.storage.local.get(KEY_OFFER_SHOWN);
  if (shown) return;
  const cache = await cachePromise;
  if (!(await cache.keys()).length) return;
  await chrome.storage.local.set({ [KEY_OFFER_SHOWN]: true });
  await chrome.tabs.create({ url: chrome.runtime.getURL('migration.html') });
}

/**
 * Registers the listeners that offer the migration. Call synchronously at the
 * top level of the background script.
 */
function initNativeMigration({ cachePromise }) {
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install' || reason === 'update') {
      maybeOfferMigration(cachePromise);
    }
  });
  chrome.runtime.onStartup.addListener(() => {
    maybeOfferMigration(cachePromise);
  });
}

function isFromExtensionPage(sender) {
  return !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

// The origins that may move a file: those that stored it, or, for a file
// stored before the extension recorded storers, those that used it.
function movingOrigins(resourceManager, hash) {
  const storers = resourceManager.getStoringOrigins(hash);
  return storers.length ? storers : resourceManager.getOriginsByHash(hash);
}

/**
 * Handles the migration messages; returns undefined for any other action.
 * `senderOrigin` is the origin of the page a content script runs in.
 */
async function handleMigrationMessage(action, data, sender, deps) {
  const { resourceManager, publicHashList, cache, senderOrigin } = deps;
  switch (action) {
    // migration.html: what there is to move, and how.
    case 'getMigrationPlan': {
      if (!isFromExtensionPage(sender)) throw new Error('Not allowed');
      // The list is about 88 MB, so it's only downloaded when the page asks
      // (`download`), which it does with a progress display after a first
      // answer of `needsList`.
      if (!data?.download && !(await publicHashList.loadCached())) {
        return { needsList: true };
      }
      let isListed = () => false;
      try {
        await publicHashList.ensureLoaded(PHL_MAX_AGE_MS);
        isListed = (hash) => publicHashList.includes(hash);
      } catch (err) {
        // Without the list, every file moves per site, which is always safe.
        console.warn(
          '[COS] Public Hash List unavailable for the migration:',
          err,
        );
      }
      const now = [];
      let later = 0;
      let bytes = 0;
      for (const hash of resourceManager.getAllHashes()) {
        const size = resourceManager.getSizeByHash(hash) ?? 0;
        bytes += size;
        const tier = resourceManager.constructor.classifyVisibility(
          resourceManager.getVisibility(hash),
        );
        if (tier === 'global' && isListed(hash)) {
          now.push({ hash, size });
        } else {
          later++;
        }
      }
      const stored = await chrome.storage.local.get([
        KEY_OPT_IN,
        KEY_MOVED_COUNT,
      ]);
      return {
        now,
        later,
        bytes,
        optIn: !!stored[KEY_OPT_IN],
        moved: stored[KEY_MOVED_COUNT] || 0,
      };
    }
    case 'setMigrationOptIn': {
      if (!isFromExtensionPage(sender)) throw new Error('Not allowed');
      await chrome.storage.local.set({ [KEY_OPT_IN]: !!data.enabled });
      return { optIn: !!data.enabled };
    }
    // content.js: which files this page's origin may move now.
    case 'getMigrationWork': {
      const { [KEY_OPT_IN]: optIn } =
        await chrome.storage.local.get(KEY_OPT_IN);
      const origin = senderOrigin(sender);
      const files = [];
      if (optIn && origin) {
        const now = Date.now();
        for (const hash of resourceManager.getAllHashes()) {
          if (now - (claims.get(hash) ?? 0) < CLAIM_MS) continue;
          if (!movingOrigins(resourceManager, hash).includes(origin)) continue;
          claims.set(hash, now);
          files.push({
            hash: { algorithm: 'SHA-256', value: hash },
            origins: resourceManager.getVisibility(hash),
          });
        }
      }
      return { files };
    }
    // Either context: a file is now in native COS, verified, so the
    // extension's copy goes.
    case 'migrationDone': {
      const { hash } = data;
      if (
        !isFromExtensionPage(sender) &&
        !movingOrigins(resourceManager, hash).includes(senderOrigin(sender))
      ) {
        throw new Error('Not allowed');
      }
      await cache.delete(`https://cos.example.com/SHA-256_${hash}`);
      await resourceManager.deleteResourcesByHash(hash);
      claims.delete(hash);
      const { [KEY_MOVED_COUNT]: moved = 0 } =
        await chrome.storage.local.get(KEY_MOVED_COUNT);
      await chrome.storage.local.set({ [KEY_MOVED_COUNT]: moved + 1 });
      return { success: true };
    }
    default:
      return undefined;
  }
}

export {
  initNativeMigration,
  handleMigrationMessage,
  hasNativeCrossOriginStorage,
};
