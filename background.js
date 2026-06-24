// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import ResourceManager from './resource-manager.js';

let creating; // A global promise to avoid concurrency issues

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ workerPatchEnabled: false });
  }
});

async function setupOffscreenDocument(path) {
  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // create offscreen document
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create Blob URLs',
    });
    await creating;
    creating = null;
  }
}

const resourceManager = new ResourceManager();

// Create the offscreen document for Blob operations.
// Exposed as a module-level promise so getFileData can await it before sending
// getBlobURL — the offscreen doc must exist before it can receive messages.
const offscreenSetupPromise = (async () => {
  await setupOffscreenDocument('offscreen.html');
  // Load the initial state when the extension starts.
  await resourceManager.loadManagerFromStorage();
})();

// Open the cache once when the service worker starts.
const cachePromise = caches.open('cos-storage');
let cache;

// Per-tab COS hit/miss tracking for the extension badge and popup annotations.
// Each entry is a Set of hex hash strings so the popup knows which specific
// resources were hit or missed, not just counts.
// Reset is driven by sender.documentId — a unique ID per document context
// that changes on every page load (including same-URL refreshes), avoiding
// the race between navigation events and content-script messages.
const tabHitHashes = {};
const tabMissHashes = {};
// Per-tab origin tracking — which origins (including iframe origins) triggered
// COS hits or misses. Used by the popup to detect and pre-select iframe origins.
const tabHitOrigins = {};
const tabMissOrigins = {};
const tabDocumentIds = {};

function maybeResetForNewPage(tabId, documentId) {
  if (!tabId || !documentId) return;
  if (tabDocumentIds[tabId] !== documentId) {
    tabDocumentIds[tabId] = documentId;
    delete tabHitHashes[tabId];
    delete tabMissHashes[tabId];
    delete tabHitOrigins[tabId];
    delete tabMissOrigins[tabId];
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

function formatBadgeCount(n) {
  return n < 1000 ? String(n) : `${Math.floor(n / 1000)}K`;
}

function updateBadge(tabId) {
  if (!tabId) return;
  const hits = tabHitHashes[tabId]?.size || 0;
  const misses = tabMissHashes[tabId]?.size || 0;
  if (hits > 0) {
    chrome.action.setBadgeText({ text: formatBadgeCount(hits), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#2e7d32', tabId });
    chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
  } else if (misses > 0) {
    chrome.action.setBadgeText({ text: formatBadgeCount(misses), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e65100', tabId });
    chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabHitHashes[tabId];
  delete tabMissHashes[tabId];
  delete tabHitOrigins[tabId];
  delete tabMissOrigins[tabId];
  delete tabDocumentIds[tabId];
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    cache = await cachePromise;
    let responseData;
    const { action, data, target } = message;
    if (target && target === 'offscreen-doc') {
      return;
    }
    try {
      switch (action) {
        case 'requestFileHandles': {
          const { origin, hashes, create } = data;
          const tabId = sender.tab?.id;
          maybeResetForNewPage(tabId, sender.documentId);
          const success = [];
          await resourceManager.loadManagerFromStorage();
          for (const hash of hashes) {
            const handle = await getFileHandle(hash, create);
            if (!handle) {
              if (!create) {
                resourceManager.recordMiss();
                if (tabId) {
                  if (!tabMissHashes[tabId]) tabMissHashes[tabId] = new Set();
                  tabMissHashes[tabId].add(hash.value);
                  if (!tabMissOrigins[tabId]) tabMissOrigins[tabId] = new Set();
                  tabMissOrigins[tabId].add(origin);
                  updateBadge(tabId);
                }
              }
              await resourceManager.saveManagerToStorage();
              responseData = { hashes, success };
              sendResponse({ data: responseData });
              return;
            }
            success.push(handle);
            resourceManager.recordAccess(origin, hash.value);
            if (!create) {
              resourceManager.recordHit(hash.value);
              if (tabId) {
                if (!tabHitHashes[tabId]) tabHitHashes[tabId] = new Set();
                tabHitHashes[tabId].add(hash.value);
                if (!tabHitOrigins[tabId]) tabHitOrigins[tabId] = new Set();
                tabHitOrigins[tabId].add(origin);
                updateBadge(tabId);
              }
            }
          }
          await resourceManager.saveManagerToStorage();
          responseData = { hashes, success };
          break;
        }
        case 'getFileData': {
          const { hash } = data;
          let blobURL = await getFileData(hash);
          const size = resourceManager.getSizeByHash(hash.value);
          const mimeType = resourceManager.getMimeTypeByHash(hash.value);
          responseData = { hash, blobURL, size, mimeType };
          break;
        }
        case 'storeFileData': {
          let { hash, blobURL, mimeType } = data;
          const blob = await fetch(blobURL).then((response) => response.blob());
          await storeFileData(hash, blob, mimeType);
          resourceManager.recordSize(hash.value, blob.size);
          resourceManager.recordMimeType(
            hash.value,
            mimeType['content-type'] || 'application/octet-stream'
          );
          responseData = { hash };
          break;
        }
        case 'deleteResource': {
          const { hash } = data;
          const offscreenResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                action: 'deleteResource',
                target: 'offscreen-doc',
                data: { hash: hash.value },
              },
              resolve
            );
          });
          if (offscreenResp?.data?.success) {
            await resourceManager.loadManagerFromStorage();
            await resourceManager.deleteResourcesByHash(hash.value);
          }
          responseData = { success: !!offscreenResp?.data?.success };
          break;
        }
        case 'getWorkerPatchSetting': {
          const result = await chrome.storage.local.get('workerPatchEnabled');
          responseData = { workerPatchEnabled: !!result.workerPatchEnabled };
          break;
        }
        case 'rewriteStylesheet': {
          const tabId = sender.tab?.id;
          maybeResetForNewPage(tabId, sender.documentId);
          let { cssText, url, origin } = data;
          if (!cssText && url) {
            try {
              const resp = await fetch(url, { cache: 'no-cache' });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              cssText = await resp.text();
            } catch (e) {
              responseData = { cssText: null, error: e.message };
              break;
            }
          }
          if (!cssText || !cssText.includes('cross-origin-storage')) {
            responseData = { cssText: cssText || null, changed: false };
            break;
          }
          const matches = findCOSMatches(cssText);
          await resourceManager.loadManagerFromStorage();
          let rewritten = cssText;
          const fonts = [];
          let fontIdx = 0;
          for (const fm of matches) {
            const trimmed = fm.originsStr.trim();
            let allowed = trimmed === '*' ? '*' : [];
            if (allowed !== '*') {
              const oRe = /["']([^"']+)["']/g;
              let om;
              while ((om = oRe.exec(trimmed)) !== null) allowed.push(om[1]);
            }
            if (allowed !== '*' && !allowed.includes(origin)) {
              rewritten = rewritten.replace(fm.full, `url("${fm.fontUrl}")`);
              continue;
            }
            const hash = sriToHashObj(fm.sriHash);
            let blobURL = await getFileData(hash);
            const alreadyCached = !!blobURL;
            if (!blobURL) {
              resourceManager.recordMiss();
              if (tabId) {
                if (!tabMissHashes[tabId]) tabMissHashes[tabId] = new Set();
                tabMissHashes[tabId].add(hash.value);
                if (!tabMissOrigins[tabId]) tabMissOrigins[tabId] = new Set();
                tabMissOrigins[tabId].add(origin);
                updateBadge(tabId);
              }
              try {
                const fontResp = await fetch(fm.fontUrl);
                if (!fontResp.ok) throw new Error(`HTTP ${fontResp.status}`);
                const fontBlob = await fontResp.blob();
                const mimeType =
                  fontResp.headers.get('content-type') || 'font/woff2';
                await storeFileData(hash, fontBlob, {
                  'content-type': mimeType,
                });
                resourceManager.recordSize(hash.value, fontBlob.size);
                resourceManager.recordMimeType(hash.value, mimeType);
                blobURL = await getFileData(hash);
              } catch (e) {
                rewritten = rewritten.replace(fm.full, `url("${fm.fontUrl}")`);
                continue;
              }
            }
            if (blobURL) {
              if (alreadyCached) {
                resourceManager.recordHit(hash.value);
                if (tabId) {
                  if (!tabHitHashes[tabId]) tabHitHashes[tabId] = new Set();
                  tabHitHashes[tabId].add(hash.value);
                  if (!tabHitOrigins[tabId]) tabHitOrigins[tabId] = new Set();
                  tabHitOrigins[tabId].add(origin);
                  updateBadge(tabId);
                }
              }
              const placeholder = `__COS_FONT_${fontIdx++}__`;
              rewritten = rewritten.replace(fm.full, `url("${placeholder}")`);
              fonts.push({ placeholder, blobURL });
              resourceManager.recordAccess(origin, hash.value);
            } else {
              rewritten = rewritten.replace(fm.full, `url("${fm.fontUrl}")`);
            }
          }
          await resourceManager.saveManagerToStorage();
          responseData = {
            cssText: rewritten,
            fonts,
            changed: rewritten !== cssText,
          };
          break;
        }
        case 'getResourceForViewer': {
          const { hash } = data;
          await resourceManager.loadManagerFromStorage();
          const hashObj = { algorithm: 'SHA-256', value: hash };
          const key = generateCacheKey(hashObj);
          const match = await cache.match(key);
          if (!match) {
            responseData = { error: 'Resource not found in cache' };
            break;
          }
          const mimeType = (
            match.headers.get('content-type') || 'application/octet-stream'
          )
            .split(';')[0]
            .trim();
          const size = resourceManager.getSizeByHash(hash);
          const isText =
            mimeType.startsWith('text/') ||
            [
              'application/javascript',
              'application/json',
              'application/xml',
              'application/xhtml+xml',
            ].includes(mimeType);
          const origins = resourceManager.getOriginsByHash(hash);
          const accessHistory = {};
          for (const origin of origins) {
            accessHistory[origin] =
              resourceManager.accessHistory[`${origin}|${hash}`] || [];
          }
          if (isText) {
            const text = await match.text();
            responseData = {
              mimeType,
              text,
              size: size ?? null,
              origins,
              accessHistory,
            };
          } else {
            const ab = await match.arrayBuffer();
            const bytes = new Uint8Array(ab);
            const CHUNK = 0x8000;
            let binary = '';
            for (let i = 0; i < bytes.length; i += CHUNK) {
              binary += String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + CHUNK)
              );
            }
            responseData = {
              mimeType,
              dataURL: `data:${mimeType};base64,${btoa(binary)}`,
              size: size ?? ab.byteLength,
              origins,
              accessHistory,
            };
          }
          break;
        }
        case 'getTabStats': {
          const { tabId } = data;
          responseData = {
            hitHashes: [...(tabHitHashes[tabId] || [])],
            missHashes: [...(tabMissHashes[tabId] || [])],
            hitOrigins: [...(tabHitOrigins[tabId] || [])],
            missOrigins: [...(tabMissOrigins[tabId] || [])],
          };
          break;
        }
        default:
          console.warn('Unknown action:', action);
          responseData = { error: `Unknown action: ${action}` };
          break;
      }

      if (responseData) {
        sendResponse({ data: responseData });
      }
    } catch (error) {
      console.error(`Error processing action "${action}":`, error);
      sendResponse({ error: error.message });
    }
  })();

  return true;
});

function generateCacheKey(hash) {
  return `https://cos.example.com/${hash.algorithm}_${hash.value}`;
}

// Returns all url() blocks in cssText that carry both integrity() and
// cross-origin-storage() modifiers, normalized to { full, fontUrl, sriHash,
// originsStr } regardless of which modifier appears first.
function findCOSMatches(cssText) {
  const matches = [];
  // integrity() before cross-origin-storage()
  const RE_INT_FIRST =
    /url\s*\(\s*["']([^"']+)["']\s*integrity\s*\(\s*["'](sha(?:256|384|512)-[A-Za-z0-9+/=]+)["']\s*\)\s*cross-origin-storage\s*\(\s*([^)]*?)\s*\)\s*\)/g;
  // cross-origin-storage() before integrity()
  const RE_COS_FIRST =
    /url\s*\(\s*["']([^"']+)["']\s*cross-origin-storage\s*\(\s*([^)]*?)\s*\)\s*integrity\s*\(\s*["'](sha(?:256|384|512)-[A-Za-z0-9+/=]+)["']\s*\)\s*\)/g;
  let m;
  while ((m = RE_INT_FIRST.exec(cssText)) !== null)
    matches.push({
      full: m[0],
      fontUrl: m[1],
      sriHash: m[2],
      originsStr: m[3],
    });
  while ((m = RE_COS_FIRST.exec(cssText)) !== null)
    matches.push({
      full: m[0],
      fontUrl: m[1],
      sriHash: m[3],
      originsStr: m[2],
    });
  return matches;
}

function sriToHashObj(sriHash) {
  const dashIdx = sriHash.indexOf('-');
  const algo = sriHash.slice(0, dashIdx);
  const b64 = sriHash.slice(dashIdx + 1);
  const algorithm =
    { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[algo] ||
    'SHA-256';
  const binary = atob(b64);
  let hex = '';
  for (let i = 0; i < binary.length; i++)
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  return { algorithm, value: hex };
}

async function storeFileData(hash, blob, mimeType) {
  const key = generateCacheKey(hash);
  await cache.put(
    key,
    new Response(blob, {
      headers: {
        'content-type': mimeType['content-type'] || 'application/octet-stream',
      },
    })
  );
}

async function getFileData(hash) {
  const key = generateCacheKey(hash);
  const match = await cache.match(key);
  if (!match) {
    return false;
  }
  // Wait for the offscreen document to be ready. When the service worker
  // restarts after inactivity, setupOffscreenDocument runs asynchronously;
  // sending getBlobURL before it completes would get no listener and hang.
  await offscreenSetupPromise;
  return new Promise((resolve) => {
    // Data comes as Blob out of Cache, but send as Blob URL.
    chrome.runtime.sendMessage(
      {
        action: 'getBlobURL',
        target: 'offscreen-doc',
        data: {
          key,
        },
      },
      (response) => {
        resolve(response?.data?.blobURL ?? false);
      }
    );
  });
}

async function getFileHandle(hash, create) {
  const key = generateCacheKey(hash);
  if (!create) {
    return !!(await cache.match(key));
  }
  return true;
}
