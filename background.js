// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import ResourceManager from './resource-manager.js';

let creating; // A global promise to avoid concurrency issues

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    await chrome.storage.local.set({ showPrompt: false });
    await chrome.storage.local.remove('cosPermissions');
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
(async () => {
  await setupOffscreenDocument('offscreen.html');
  // Load the initial state when the extension starts.
  await resourceManager.loadManagerFromStorage();
})();

// Open the cache once when the service worker starts.
const cachePromise = caches.open('cos-storage');
let cache;

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
          const success = [];
          // Log access statistics.
          await resourceManager.loadManagerFromStorage();
          for (const hash of hashes) {
            const handle = await getFileHandle(hash, create);
            if (!handle) {
              responseData = { hashes, success };
              sendResponse({ data: responseData });
              return;
            }
            success.push(handle);
            resourceManager.recordAccess(origin, hash.value);
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
        case 'getPermission': {
          const { origin } = data;
          const permissions = await chrome.storage.local.get('cosPermissions');
          const hostPermission =
            (permissions.cosPermissions || {})[origin] || false;
          responseData = { permission: hostPermission };
          break;
        }
        case 'storePermission': {
          const { origin, permission } = data;
          const result = await chrome.storage.local.get('cosPermissions');
          const permissions = result.cosPermissions || {};
          permissions[origin] = permission;
          await chrome.storage.local.set({ cosPermissions: permissions });
          responseData = { success: true };
          break;
        }
        case 'getShowPromptSetting': {
          const result = await chrome.storage.local.get('showPrompt');
          responseData = { showPrompt: !!result.showPrompt };
          break;
        }
        case 'rewriteStylesheet': {
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
            if (!blobURL) {
              try {
                const fontResp = await fetch(fm.fontUrl);
                if (!fontResp.ok) throw new Error(`HTTP ${fontResp.status}`);
                const fontBlob = await fontResp.blob();
                const mimeType =
                  fontResp.headers.get('content-type') || 'font/woff2';
                await storeFileData(hash, fontBlob, { 'content-type': mimeType });
                resourceManager.recordSize(hash.value, fontBlob.size);
                resourceManager.recordMimeType(hash.value, mimeType);
                await resourceManager.saveManagerToStorage();
                blobURL = await getFileData(hash);
              } catch (e) {
                rewritten = rewritten.replace(fm.full, `url("${fm.fontUrl}")`);
                continue;
              }
            }
            if (blobURL) {
              const placeholder = `__COS_FONT_${fontIdx++}__`;
              rewritten = rewritten.replace(fm.full, `url("${placeholder}")`);
              fonts.push({ placeholder, blobURL });
              resourceManager.recordAccess(origin, hash.value);
            } else {
              rewritten = rewritten.replace(fm.full, `url("${fm.fontUrl}")`);
            }
          }
          if (fonts.length) {
            await resourceManager.saveManagerToStorage();
          }
          responseData = {
            cssText: rewritten,
            fonts,
            changed: rewritten !== cssText,
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
    /url\s*\(\s*["']([^"']+)["']\s+integrity\s*\(\s*["'](sha(?:256|384|512)-[A-Za-z0-9+/=]+)["']\s*\)\s+cross-origin-storage\s*\(\s*([^)]*?)\s*\)\s*\)/g;
  // cross-origin-storage() before integrity()
  const RE_COS_FIRST =
    /url\s*\(\s*["']([^"']+)["']\s+cross-origin-storage\s*\(\s*([^)]*?)\s*\)\s+integrity\s*\(\s*["'](sha(?:256|384|512)-[A-Za-z0-9+/=]+)["']\s*\)\s*\)/g;
  let m;
  while ((m = RE_INT_FIRST.exec(cssText)) !== null)
    matches.push({ full: m[0], fontUrl: m[1], sriHash: m[2], originsStr: m[3] });
  while ((m = RE_COS_FIRST.exec(cssText)) !== null)
    matches.push({ full: m[0], fontUrl: m[1], sriHash: m[3], originsStr: m[2] });
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
        resolve(response.data.blobURL);
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
