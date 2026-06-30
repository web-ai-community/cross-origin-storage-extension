// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

const HISTORY_LIMIT = 10;
const STORAGE_KEY = 'resourceManagerData';

// Maximum number of origins allowed in an explicit `origins` list passed
// to requestFileHandle({ create: true, origins: [...] }). Inspired by
// Related Website Sets' associated-domain cap (5 + 1 primary = 6) --
// see https://github.com/GoogleChrome/related-website-sets -- which
// settled on a small number specifically to discourage using a
// declared-relationship list as a general-purpose tracking/identity
// mechanism. COS's `origins` list is solving a different problem
// (read access to a stored resource, not cookie/storage sharing), but
// the same incentive applies: an unbounded list lets a site enumerate
// "related" origins by probing hashes, so a small cap is kept here too.
const MAX_ORIGINS_PER_RESOURCE = 6;

// Visibility permissiveness ranks, used to enforce the spec's
// upgrade-only rule (a resource's visibility can only become MORE
// permissive over time, never less):
// https://wicg.github.io/cross-origin-storage/#resource-visibility-upgrades
const VISIBILITY_RANK = {
  'same-site': 0,
  list: 1,
  global: 2,
};

class ResourceManager {
  constructor() {
    this.historyLimit = HISTORY_LIMIT;
    this.originToHashes = {};
    this.hashToOrigins = {};
    this.accessHistory = {};
    this.hashToSize = {};
    this.hashToMimeType = {};
    this.hashToHitCount = {};
    this.totalMissCount = 0;
    // hash -> '*' (global) | string[] (origins list) | undefined (absent
    // entry means same-site-only, the spec's default when `origins` is
    // omitted at creation time).
    this.hashToVisibility = {};
  }

  /**
   * Classifies a stored `origins` value (or its absence) into one of
   * the three visibility tiers from the COS explainer.
   * @returns {'global'|'list'|'same-site'}
   */
  static classifyVisibility(origins) {
    if (origins === '*') return 'global';
    if (Array.isArray(origins)) return 'list';
    return 'same-site';
  }

  /**
   * Returns the current visibility for a hash: '*' (global), a string[]
   * of allowed origins, or undefined (same-site-only, the default when
   * no resource has been stored under this hash with an explicit
   * `origins` value yet).
   */
  getVisibility(hash) {
    return this.hashToVisibility[hash];
  }

  /**
   * Applies a requested `origins` value (from `create: true`) to a
   * hash's stored visibility, enforcing the spec's upgrade-only rule:
   * visibility can become more permissive (same-site -> list -> global)
   * but never more restrictive. A request to move to a less-or-equally
   * permissive tier is ignored, and a warning is logged -- mirroring
   * "the user agent should log a warning to the console to inform the
   * developer that the restriction was not applied" from the explainer.
   *
   * @param {string} hash
   * @param {'*'|string[]|undefined} requestedOrigins
   * @returns {{applied: boolean, visibility: '*'|string[]|undefined}}
   */
  setVisibility(hash, requestedOrigins) {
    const current = this.hashToVisibility[hash];
    const currentTier = ResourceManager.classifyVisibility(current);
    const requestedTier = ResourceManager.classifyVisibility(requestedOrigins);

    if (
      requestedTier === 'list' &&
      Array.isArray(requestedOrigins) &&
      requestedOrigins.length > MAX_ORIGINS_PER_RESOURCE
    ) {
      console.warn(
        `[COS] Rejected origins list of ${requestedOrigins.length} entries ` +
          `for hash ${hash}: exceeds the maximum of ${MAX_ORIGINS_PER_RESOURCE}. ` +
          `The resource's visibility was not changed.`
      );
      return { applied: false, visibility: current };
    }

    if (VISIBILITY_RANK[requestedTier] <= VISIBILITY_RANK[currentTier]) {
      // No-op (same tier) or a downgrade attempt -- both are ignored per
      // spec. Only warn for genuine downgrade attempts, since
      // re-requesting the same tier (e.g. the same list) is a normal,
      // expected no-op rather than a developer mistake.
      if (VISIBILITY_RANK[requestedTier] < VISIBILITY_RANK[currentTier]) {
        console.warn(
          `[COS] Ignored attempt to restrict hash ${hash} from '${currentTier}' ` +
            `to '${requestedTier}' visibility. Visibility can only become more ` +
            `permissive, never more restrictive; the resource remains '${currentTier}'.`
        );
      }
      return { applied: false, visibility: current };
    }

    this.hashToVisibility[hash] = requestedOrigins;
    return { applied: true, visibility: requestedOrigins };
  }

  recordAccess(origin, hash, timestamp = new Date()) {
    if (!this.originToHashes[origin]) {
      this.originToHashes[origin] = [];
    }
    if (!this.originToHashes[origin].includes(hash)) {
      this.originToHashes[origin].push(hash);
    }
    if (!this.hashToOrigins[hash]) {
      this.hashToOrigins[hash] = [];
    }
    if (!this.hashToOrigins[hash].includes(origin)) {
      this.hashToOrigins[hash].push(origin);
    }
    const key = `${origin}|${hash}`;
    if (!this.accessHistory[key]) {
      this.accessHistory[key] = [];
    }
    this.accessHistory[key].unshift(timestamp.toISOString());
    if (this.accessHistory[key].length > this.historyLimit) {
      this.accessHistory[key].length = this.historyLimit;
    }
  }

  recordSize(hash, size) {
    if (typeof size === 'number') {
      this.hashToSize[hash] = size;
      this.saveManagerToStorage();
    }
  }

  recordMimeType(hash, mimeType) {
    if (typeof mimeType === 'string') {
      this.hashToMimeType[hash] = mimeType;
      this.saveManagerToStorage();
    }
  }

  getHashesByOrigin(origin) {
    return this.originToHashes[origin]
      ? [...this.originToHashes[origin]].sort()
      : [];
  }

  getOriginsByHash(hash) {
    return this.hashToOrigins[hash] ? [...this.hashToOrigins[hash]].sort() : [];
  }

  getAllOrigins() {
    return Object.keys(this.originToHashes).sort();
  }

  getAllHashes() {
    const allHashes = new Set([
      ...Object.keys(this.hashToOrigins),
      ...Object.keys(this.hashToSize),
      ...Object.keys(this.hashToMimeType),
    ]);
    return [...allHashes].sort();
  }

  getAccessHistory(origin, hash) {
    return this.accessHistory[`${origin}|${hash}`] || [];
  }

  getSizeByHash(hash) {
    return this.hashToSize[hash];
  }

  getMimeTypeByHash(hash) {
    return this.hashToMimeType[hash];
  }

  recordHit(hash) {
    this.hashToHitCount[hash] = (this.hashToHitCount[hash] || 0) + 1;
  }

  recordMiss() {
    this.totalMissCount++;
  }

  async resetStats() {
    this.hashToHitCount = {};
    this.totalMissCount = 0;
    await this.saveManagerToStorage();
  }

  getStats() {
    const totalHits = Object.values(this.hashToHitCount).reduce(
      (s, n) => s + n,
      0
    );
    const totalMisses = this.totalMissCount;
    const totalRequests = totalHits + totalMisses;

    let bytesServed = 0;
    for (const [hash, count] of Object.entries(this.hashToHitCount)) {
      bytesServed += count * (this.hashToSize[hash] || 0);
    }

    let deduplicationSavings = 0;
    for (const [hash, size] of Object.entries(this.hashToSize)) {
      const n = (this.hashToOrigins[hash] || []).length;
      if (n > 1) deduplicationSavings += (n - 1) * size;
    }

    const totalStorage = Object.values(this.hashToSize).reduce(
      (s, n) => s + n,
      0
    );

    return {
      totalHits,
      totalMisses,
      hitRatio: totalRequests > 0 ? totalHits / totalRequests : null,
      bytesServed,
      deduplicationSavings,
      totalStorage,
      resourceCount: this.getAllHashes().length,
      originCount: this.getAllOrigins().length,
    };
  }

  async deleteResourcesByHash(hashesToDelete) {
    const hashes = Array.isArray(hashesToDelete)
      ? hashesToDelete
      : [hashesToDelete];
    let itemsWereDeleted = false;

    for (const hash of hashes) {
      itemsWereDeleted = true;

      const origins = this.hashToOrigins[hash];
      if (origins) {
        for (const origin of origins) {
          if (this.originToHashes[origin]) {
            this.originToHashes[origin] = this.originToHashes[origin].filter(
              (h) => h !== hash
            );
            if (this.originToHashes[origin].length === 0) {
              delete this.originToHashes[origin];
            }
          }
          delete this.accessHistory[`${origin}|${hash}`];
        }
        delete this.hashToOrigins[hash];
      }

      delete this.hashToSize[hash];
      delete this.hashToMimeType[hash];
      delete this.hashToHitCount[hash];
    }

    if (itemsWereDeleted) {
      await this.saveManagerToStorage();
    }
  }

  async loadManagerFromStorage() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      if (data[STORAGE_KEY]) {
        const stored = data[STORAGE_KEY];
        this.originToHashes = stored.originToHashes || {};
        this.hashToOrigins = stored.hashToOrigins || {};
        this.accessHistory = stored.accessHistory || {};
        this.hashToSize = stored.hashToSize || {};
        this.hashToMimeType = stored.hashToMimeType || {};
        this.hashToHitCount = stored.hashToHitCount || {};
        this.totalMissCount = stored.totalMissCount || 0;
        this.hashToVisibility = stored.hashToVisibility || {};
      }
    } catch (error) {
      console.error('Error loading resource manager from storage:', error);
    }
  }

  async saveManagerToStorage() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          originToHashes: this.originToHashes,
          hashToOrigins: this.hashToOrigins,
          accessHistory: this.accessHistory,
          hashToSize: this.hashToSize,
          hashToMimeType: this.hashToMimeType,
          hashToHitCount: this.hashToHitCount,
          totalMissCount: this.totalMissCount,
          hashToVisibility: this.hashToVisibility,
        },
      });
    } catch (error) {
      console.error('Error saving resource manager to storage:', error);
    }
  }
}

export default ResourceManager;
