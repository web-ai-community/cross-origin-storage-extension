// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

const HISTORY_LIMIT = 10;
const STORAGE_KEY = 'resourceManagerData';

// Maximum number of origins allowed in an explicit `origins` list passed
// to getFileHandle({ create: true, origins: [...] }). Inspired by
// Related Website Sets' associated-domain cap (5 + 1 primary = 6) --
// see https://github.com/GoogleChrome/related-website-sets -- which
// settled on a small number specifically to discourage using a
// declared-relationship list as a general-purpose tracking/identity
// mechanism. COS's `origins` list is solving a different problem
// (read access to a stored resource, not cookie/storage sharing), but
// the same incentive applies: an unbounded list lets a site enumerate
// "related" origins by probing hashes, so a small cap is kept here too.
const MAX_ORIGINS_PER_RESOURCE = 6;

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
    // The three grants of a COS entry, as in the spec
    // (https://wicg.github.io/cross-origin-storage/#cos-entries). Each grant
    // is { origin, partition }, where `partition` is the schemeful site of
    // the top-level page the write ran under.
    //
    // hash -> grants for the origins that wrote the entry. A storing origin,
    // and the origins same-site with it, read the entry under its partition.
    this.hashToStoringGrants = {};
    // hash -> grants for the `origins` list, each also { firstParty }: a
    // list written first-party (by a top-level page, or a frame same-site
    // with it) also admits the listed origins wherever they run first-party.
    this.hashToListGrants = {};
    // hash -> true once written with `origins: '*'`. Never keyed.
    this.hashToGlobal = {};
    // Computes a schemeful site from an origin. Only the background's
    // instance has one, and it's what migrates records from before grants.
    this.siteOf = null;
  }

  /**
   * Classifies a legacy `origins` value (see getVisibility()) into one of
   * the three visibility tiers from the COS explainer.
   * @returns {'global'|'list'|'same-site'}
   */
  static classifyVisibility(origins) {
    if (origins === '*') return 'global';
    if (Array.isArray(origins)) return 'list';
    return 'same-site';
  }

  /**
   * The widest grant a hash carries, in the shape of an `origins` value: '*'
   * if it's globally disclosable, the listed origins if it has a list, and
   * undefined (same-site) otherwise. Used for reporting and for migrating to
   * native COS, which re-declares it.
   */
  getVisibility(hash) {
    if (this.hashToGlobal[hash]) return '*';
    const listed = this.hashToListGrants[hash];
    if (listed?.length) return [...new Set(listed.map((g) => g.origin))];
    return undefined;
  }

  /**
   * Applies a requested `origins` value to a hash's grants. Grants only ever
   * add up: '*' sets the global grant on top of any list, and a list merges
   * into the existing one, up to MAX_ORIGINS_PER_RESOURCE grants.
   * https://wicg.github.io/cross-origin-storage/#resource-visibility-upgrades
   *
   * @param {string} hash
   * @param {'*'|string[]|undefined} requestedOrigins
   * @param {string} partition - The writer's partition.
   * @param {boolean} firstParty - Whether the write ran first-party.
   */
  upgradeVisibility(hash, requestedOrigins, partition, firstParty) {
    if (requestedOrigins === '*') {
      this.hashToGlobal[hash] = true;
      return;
    }
    if (!Array.isArray(requestedOrigins) || !requestedOrigins.length) return;
    if (requestedOrigins.length > MAX_ORIGINS_PER_RESOURCE) {
      console.warn(
        `[COS] Rejected origins list of ${requestedOrigins.length} entries ` +
          `for hash ${hash}: exceeds the maximum of ${MAX_ORIGINS_PER_RESOURCE}.`
      );
      return;
    }
    const grants = (this.hashToListGrants[hash] ??= []);
    for (const origin of requestedOrigins) {
      if (
        grants.some(
          (g) =>
            g.origin === origin &&
            g.partition === partition &&
            g.firstParty === firstParty
        )
      ) {
        continue;
      }
      if (grants.length >= MAX_ORIGINS_PER_RESOURCE) {
        console.warn(
          `[COS] The origins list of hash ${hash} is full; ${origin} was not added.`
        );
        break;
      }
      grants.push({ origin, partition, firstParty });
    }
  }

  /** Records that `origin` wrote this hash's bytes under `partition`. */
  addStoringGrant(hash, origin, partition) {
    const grants = (this.hashToStoringGrants[hash] ??= []);
    if (!grants.some((g) => g.origin === origin && g.partition === partition)) {
      grants.push({ origin, partition });
    }
  }

  getStoringGrants(hash) {
    return this.hashToStoringGrants[hash] ?? [];
  }

  getListGrants(hash) {
    return this.hashToListGrants[hash] ?? [];
  }

  isGloballyDisclosable(hash) {
    return !!this.hashToGlobal[hash];
  }

  /** Returns true if `origin` wrote this hash under `partition`. */
  isStoringOrigin(hash, origin, partition) {
    return this.getStoringGrants(hash).some(
      (g) => g.origin === origin && g.partition === partition
    );
  }

  /** Returns all origins that have successfully written this hash, or []. */
  getStoringOrigins(hash) {
    return [...new Set(this.getStoringGrants(hash).map((g) => g.origin))];
  }

  /** Returns the first origin to store this hash, or null if unknown. */
  getStorer(hash) {
    return this.getStoringGrants(hash)[0]?.origin ?? null;
  }

  /**
   * Turns records from before grants were keyed into grants. A storing origin
   * gets its own site as the partition, as for a top-level write; one that
   * pre-dates storing-origin tracking at all is the origin with the earliest
   * recorded access, the most likely original writer. A list is treated as
   * written first-party by the entry's first storing origin. Runs once, on records without grants, and always
   * returns true so the caller saves the result.
   */
  async _migrateLegacyGrants(stored) {
    const storers = { ...(stored.hashToStoringOrigins || {}) };
    for (const [hash, origin] of Object.entries(stored.hashToStorer || {})) {
      storers[hash] ??= [origin];
    }
    for (const hash of Object.keys(this.hashToOrigins)) {
      if (storers[hash]?.length || this.hashToStoringGrants[hash]) continue;
      let earliestOrigin = null;
      let earliestTime = null;
      for (const origin of this.hashToOrigins[hash]) {
        const history = this.accessHistory[`${origin}|${hash}`];
        if (!history || !history.length) continue;
        // accessHistory is newest-first (unshift), so oldest entry is last.
        const oldest = history[history.length - 1];
        if (!earliestTime || oldest < earliestTime) {
          earliestTime = oldest;
          earliestOrigin = origin;
        }
      }
      if (earliestOrigin) storers[hash] = [earliestOrigin];
    }
    for (const [hash, origins] of Object.entries(storers)) {
      if (this.hashToStoringGrants[hash]) continue;
      for (const origin of origins) {
        this.addStoringGrant(hash, origin, await this.siteOf(origin));
      }
    }
    for (const [hash, origins] of Object.entries(stored.hashToVisibility || {})) {
      if (this.hashToGlobal[hash] || this.hashToListGrants[hash]) continue;
      const storer = this.getStorer(hash);
      this.upgradeVisibility(
        hash,
        origins,
        storer && (await this.siteOf(storer)),
        true
      );
    }
    return true;
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
    const prevCount = Number(this.hashToHitCount[hash]) || 0;
    this.hashToHitCount[hash] = prevCount + 1;
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
      (s, n) => s + (Number(n) || 0),
      0
    );
    const totalMisses = this.totalMissCount;
    const totalRequests = totalHits + totalMisses;

    let bytesServed = 0;
    for (const [hash, count] of Object.entries(this.hashToHitCount)) {
      bytesServed += (Number(count) || 0) * (this.hashToSize[hash] || 0);
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
      delete this.hashToStoringGrants[hash];
      delete this.hashToListGrants[hash];
      delete this.hashToGlobal[hash];
    }

    if (itemsWereDeleted) {
      await this.saveManagerToStorage();
    }
  }

  /**
   * Loads the stored state the first time it's called, and resolves once it
   * is in memory. The background's instance is the only one that writes the
   * stored state (pages send their changes to it as messages), so from then
   * on its in-memory state is the source of truth. Reloading it would throw
   * away changes that concurrent message handlers haven't saved yet.
   */
  ready() {
    this._ready ??= this.loadManagerFromStorage();
    return this._ready;
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
        this.hashToStoringGrants = stored.hashToStoringGrants || {};
        this.hashToListGrants = stored.hashToListGrants || {};
        this.hashToGlobal = stored.hashToGlobal || {};
      }
      const migrated =
        this.siteOf &&
        data[STORAGE_KEY] &&
        !('hashToStoringGrants' in data[STORAGE_KEY])
          ? await this._migrateLegacyGrants(data[STORAGE_KEY])
          : false;
      const sanitized = this._sanitizeHitCounts();
      if (migrated || sanitized) {
        await this.saveManagerToStorage();
      }
    } catch (error) {
      console.error('Error loading resource manager from storage:', error);
    }
  }

  // Repairs hit counts that were previously corrupted into non-numeric
  // strings (e.g. by a `+=` on an unset value going through a code path
  // that produced a string instead of a number). Returns true if anything
  // was changed, so the caller knows to persist the repair.
  _sanitizeHitCounts() {
    let changed = false;
    for (const [hash, count] of Object.entries(this.hashToHitCount)) {
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        this.hashToHitCount[hash] = Number(count) || 0;
        changed = true;
      }
    }
    return changed;
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
          hashToStoringGrants: this.hashToStoringGrants,
          hashToListGrants: this.hashToListGrants,
          hashToGlobal: this.hashToGlobal,
        },
      });
    } catch (error) {
      console.error('Error saving resource manager to storage:', error);
    }
  }
}

export default ResourceManager;
