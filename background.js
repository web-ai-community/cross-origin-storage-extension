// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import ResourceManager from './resource-manager.js';
import { PublicHashList } from './public-hash-list.js';
import { isSameSite } from './same-site.js';

let creating; // A global promise to avoid concurrency issues

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({
      workerPatchEnabled: false,
      // Public Hash List gating is opt-in: off by default so existing
      // COS availability behavior doesn't change unless a user
      // explicitly enables it in options.html.
      publicHashListEnabled: false,
    });
  }
});

const publicHashList = new PublicHashList();

/**
 * Resolves whether `requestingOrigin` may learn about a stored hash at
 * all, and -- separately -- whether that resolution counts as
 * "globally reachable" for the purposes of Public Hash List gating.
 *
 * Per https://wicg.github.io/cross-origin-storage/#resource-visibility-upgrades
 * a resource's visibility is one of three tiers, set at creation time:
 *   - 'global'    (origins: '*')      reachable by any origin
 *   - 'list'      (origins: [...])    reachable only by listed origins
 *   - 'same-site' (origins omitted)   reachable only by same-site origins
 *
 * The Public Hash List exists to stop a hash from being globally
 * "probeable" by an arbitrary site. A 'list' or 'same-site' resource is
 * already not globally probeable by construction -- only origins the
 * storer explicitly chose (or same-site siblings) can ever get a hit,
 * regardless of PHL membership. So the PHL gate only needs to apply to
 * the 'global' tier; gating 'list'/'same-site' resources too would add
 * no privacy benefit while breaking legitimate restricted-sharing use
 * cases (e.g. a company's own proprietary, same-site-shared model).
 *
 * @param {string} hash
 * @param {string} requestingOrigin
 * @returns {{reachable: boolean, isGlobal: boolean}}
 */
async function resolveVisibility(hash, requestingOrigin) {
  const visibility = resourceManager.getVisibility(hash);
  const tier = ResourceManager.classifyVisibility(visibility);

  if (tier === 'global') {
    return { reachable: true, isGlobal: true };
  }
  if (tier === 'list') {
    const allowed = Array.isArray(visibility)
      ? visibility.includes(requestingOrigin)
      : false;
    return { reachable: allowed, isGlobal: false };
  }
  // 'same-site': no explicit storer recorded yet (hash never stored
  // with create:true through this gate), or stored same-site-only.
  // Without a recorded storer origin we can't compute same-siteness, so
  // fall back to the access-history origins already tracked for this
  // hash and check same-site against any of them.
  const knownOrigins = resourceManager.getOriginsByHash(hash);
  const checks = await Promise.all(
    knownOrigins.map((origin) => isSameSite(origin, requestingOrigin))
  );
  const allowed = checks.some(Boolean);
  return { reachable: allowed, isGlobal: false };
}

/**
 * Returns true if the PHL gate should block this hash: the setting is
 * enabled, the resolved visibility for this (hash, requestingOrigin)
 * pair is 'global', AND the hash is not on the Public Hash List. Logs
 * the reason when blocking so the decision is debuggable from the
 * service worker's console.
 */
async function isBlockedByPublicHashList(hashValue, requestingOrigin) {
  const { publicHashListEnabled } = await chrome.storage.local.get(
    'publicHashListEnabled'
  );
  if (!publicHashListEnabled) return false;

  const { isGlobal } = await resolveVisibility(hashValue, requestingOrigin);
  if (!isGlobal) {
    // Restricted (list or same-site) resources are not globally
    // probeable by construction -- the origins check below in the
    // caller already governs access, independent of the PHL.
    return false;
  }

  const allowed = await publicHashList.has(hashValue);
  if (!allowed) {
    console.warn(
      `[COS] Blocked: hash ${hashValue} not in Public Hash List`
    );
    return true;
  }
  return false;
}

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
  if (chrome.offscreen) {
    await setupOffscreenDocument('offscreen.html');
  }
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
      if (chrome.offscreen) return; // Chrome: offscreen document handles it
      // Firefox: no offscreen document — handle cache operations directly.
      const cosCache = await caches.open('cos-storage');
      switch (action) {
        case 'getResourceMetadata': {
          const metaResp = await cosCache.match(
            `https://cos.example.com/SHA-256_${data.hash}`
          );
          if (metaResp) {
            const blob = await metaResp.blob();
            sendResponse({ data: { size: blob.size, mimeType: metaResp.headers.get('content-type') } });
          } else {
            sendResponse({ data: { size: null, mimeType: null } });
          }
          break;
        }
        case 'deleteResource':
          await cosCache.delete(`https://cos.example.com/SHA-256_${data.hash}`);
          sendResponse({ data: { success: true } });
          break;
        case 'deleteAllResources': {
          for (const key of await cosCache.keys()) await cosCache.delete(key);
          sendResponse({ data: { success: true } });
          break;
        }
        case 'getBlobURL': {
          const r = await cosCache.match(data.key);
          const blobURL = URL.createObjectURL(await r.blob());
          sendResponse({ data: { blobURL } });
          break;
        }
      }
      return;
    }
    try {
      switch (action) {
        // Internal wire action. The payload carries a 'hashes' array; callers
        // using the singular API pass exactly one element. See WICG/cross-origin-storage#61.
        case 'requestFileHandle': {
          const { origin, hashes, create, origins: requestedOrigins } = data;
          const tabId = sender.tab?.id;
          maybeResetForNewPage(tabId, sender.documentId);
          const success = [];
          await resourceManager.loadManagerFromStorage();
          for (const hash of hashes) {
            // The original storer always has access to a resource it stored,
            // regardless of PHL or visibility tier.
            const isStorer =
              !create && resourceManager.isStoringOrigin(hash.value, origin);

            // Public Hash List gate: when enabled, a hash that isn't on
            // the allowlist is treated as unavailable before the COS
            // cache is even queried, regardless of what's actually
            // cached locally. Only applies to 'global' resources --
            // see resolveVisibility() for why list/same-site resources
            // are exempt.
            if (
              !create &&
              !isStorer &&
              (await isBlockedByPublicHashList(hash.value, origin))
            ) {
              resourceManager.recordMiss();
              if (tabId) {
                if (!tabMissHashes[tabId]) tabMissHashes[tabId] = new Set();
                tabMissHashes[tabId].add(hash.value);
                if (!tabMissOrigins[tabId]) tabMissOrigins[tabId] = new Set();
                tabMissOrigins[tabId].add(origin);
                updateBadge(tabId);
              }
              await resourceManager.saveManagerToStorage();
              responseData = { hashes, success };
              sendResponse({ data: responseData });
              return;
            }
            // For reads (create is falsy), a non-global resource must
            // also pass the origins/same-site check before being
            // revealed -- a hash not on the PHL was already rejected
            // above, but a hash that IS allowed past the PHL gate (or
            // isn't gated because it's 'list'/'same-site') still needs
            // this check, since resolveVisibility() determines whether
            // the requesting origin itself is allowed to see this hash.
            if (!create && !isStorer) {
              const { reachable } = await resolveVisibility(hash.value, origin);
              if (!reachable) {
                resourceManager.recordMiss();
                if (tabId) {
                  if (!tabMissHashes[tabId])
                    tabMissHashes[tabId] = new Set();
                  tabMissHashes[tabId].add(hash.value);
                  if (!tabMissOrigins[tabId])
                    tabMissOrigins[tabId] = new Set();
                  tabMissOrigins[tabId].add(origin);
                  updateBadge(tabId);
                }
                await resourceManager.saveManagerToStorage();
                responseData = { hashes, success };
                sendResponse({ data: responseData });
                return;
              }
            }
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
            if (create) {
              // Apply the requested origins value to this hash's stored
              // visibility tier (global/list/same-site), enforcing the
              // spec's upgrade-only rule. requestedOrigins is undefined
              // when the page omitted `origins` entirely (same-site).
              resourceManager.setVisibility(hash.value, requestedOrigins);
              resourceManager.addStoringOrigin(hash.value, origin);
            }
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
          const fileResult = await getFileData(hash);
          const size = resourceManager.getSizeByHash(hash.value);
          const mimeType = resourceManager.getMimeTypeByHash(hash.value);
          responseData = fileResult instanceof Blob
            ? { hash, data: fileResult, size, mimeType }
            : { hash, blobURL: fileResult, size, mimeType };
          break;
        }
        case 'storeFileData': {
          let { hash, blobURL, mimeType } = data;
          const blob = blobURL
            ? await fetch(blobURL).then((response) => response.blob())
            : data.data instanceof Blob
              ? data.data
              : new Blob([data.data], {
                  type: mimeType?.['content-type'] || 'application/octet-stream',
                });
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
          let deleteSuccess;
          if (chrome.offscreen) {
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
            deleteSuccess = !!offscreenResp?.data?.success;
          } else {
            await cache.delete(`https://cos.example.com/SHA-256_${hash.value}`);
            deleteSuccess = true;
          }
          if (deleteSuccess) {
            await resourceManager.loadManagerFromStorage();
            await resourceManager.deleteResourcesByHash(hash.value);
          }
          responseData = { success: deleteSuccess };
          break;
        }
        case 'getWorkerPatchSetting': {
          const result = await chrome.storage.local.get('workerPatchEnabled');
          responseData = { workerPatchEnabled: !!result.workerPatchEnabled };
          break;
        }
        case 'getPublicHashListSetting': {
          const result = await chrome.storage.local.get(
            'publicHashListEnabled'
          );
          responseData = {
            publicHashListEnabled: !!result.publicHashListEnabled,
          };
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
            // Public Hash List gate: if this hash isn't allowlisted,
            // treat it as not available in the COS cache — even if it
            // actually is — and fall through to the normal network-fetch
            // path below, same as a genuine cache miss. Only applies to
            // 'global' resources -- see resolveVisibility().
            // The original storer is always exempt from the PHL gate.
            const isStorer = resourceManager.isStoringOrigin(hash.value, origin);
            const phlBlocked =
              !isStorer &&
              (await isBlockedByPublicHashList(hash.value, origin));
            let fileResult = phlBlocked ? false : await getFileData(hash);
            const alreadyCached = !phlBlocked && !!fileResult;
            if (!fileResult) {
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
                // Persist this hash's visibility from the CSS
                // cross-origin-storage() modifier's own origins list,
                // using the same upgrade-only resourceManager state as
                // the JS requestFileHandle() path, so a hash stored via
                // CSS is governed by the same rules either way.
                resourceManager.setVisibility(
                  hash.value,
                  allowed === '*' ? '*' : allowed
                );
                resourceManager.addStoringOrigin(hash.value, origin);
                fileResult = await getFileData(hash);
              } catch (e) {
                rewritten = rewritten.replace(fm.full, `url("${fm.fontUrl}")`);
                continue;
              }
            }
            if (fileResult) {
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
              fonts.push(
                fileResult instanceof Blob
                  ? { placeholder, blob: fileResult }
                  : { placeholder, blobURL: fileResult }
              );
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
  const RE_INT_FIRST =
    /url\s*\(\s*["']([^"']+)["']\s*integrity\s*\(\s*["'](sha(?:256|384|512)-[A-Za-z0-9+/=]+)["']\s*\)\s*cross-origin-storage\s*\(\s*([^)]*?)\s*\)\s*\)/g;
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
  if (!chrome.offscreen) {
    // Background page context: return the Blob directly.
    // blob:moz-extension:// URLs cannot be fetched by content scripts in Firefox.
    return match.blob();
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
