// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

const HISTORY_LIMIT = 10;
const STORAGE_KEY = 'resourceManagerData';

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

  /**
   * Deletes one or more resources based on their hash value(s).
   * @param {string|string[]} hashesToDelete - A single hash string or an array of hash strings.
   */
  async deleteResourcesByHash(hashesToDelete) {
    // Standardize input to always be an array for consistent processing.
    const hashes = Array.isArray(hashesToDelete)
      ? hashesToDelete
      : [hashesToDelete];
    let itemsWereDeleted = false;

    for (const hash of hashes) {
      itemsWereDeleted = true;

      // Find all origins associated with this hash.
      const origins = this.hashToOrigins[hash];
      if (origins) {
        // Remove the hash from each associated origin's list.
        for (const origin of origins) {
          if (this.originToHashes[origin]) {
            this.originToHashes[origin] = this.originToHashes[origin].filter(
              (h) => h !== hash
            );
            // If the origin now has no hashes, remove the origin key itself.
            if (this.originToHashes[origin].length === 0) {
              delete this.originToHashes[origin];
            }
          }
          // Remove the access history for the origin-hash pair.
          delete this.accessHistory[`${origin}|${hash}`];
        }
        // Remove the hash from the central hash-to-origins map.
        delete this.hashToOrigins[hash];
      }

      delete this.hashToSize[hash];
      delete this.hashToMimeType[hash];
      delete this.hashToHitCount[hash];
    }

    // If any changes were made, persist them to storage.
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
        },
      });
    } catch (error) {
      console.error('Error saving resource manager to storage:', error);
    }
  }
}

export default ResourceManager;
