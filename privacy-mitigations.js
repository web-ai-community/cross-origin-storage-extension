// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// The privacy mitigations Chrome plans to ship with Cross-Origin Storage, on
// top of the sharing scopes, the Public Hash List gate, and the top-level-site
// keying that background.js and resource-manager.js already apply:
//
//   - a budget of cross-site lookups per top-level site and time window,
//   - GREASE'ing of small entries read through the global scope,
//   - user interaction before a "*" write becomes visible to other sites,
//   - a write budget on files and bytes per top-level site, and a cap on the
//     bytes a site holds in COS.
//
// See https://wicg.github.io/cross-origin-storage/#availability-gating,
// https://wicg.github.io/cross-origin-storage/#greaseing, and
// https://wicg.github.io/cross-origin-storage/#storage-limits.
//
// Each mitigation can be switched off in options.html. The limits are the
// defaults below, which `mitigationLimits` in `chrome.storage.local` can
// override (the test suites use that to give themselves room).

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_LIMITS = {
  // Cross-site lookups per top-level site and window: 16 per week is the top
  // of the 8 to 16 the explainer suggests.
  lookupBudget: 16,
  lookupWindowMs: 7 * DAY_MS,
  // How often a global-scope read of a small entry is answered as a miss, and
  // the size above which it never is, since a spurious re-download of a large
  // file costs the user far more than the noise is worth.
  greaseRate: 1 / 10,
  greaseMaxBytes: 10 * 1024 * 1024,
  // New files and bytes a site may write per window. One large AI model
  // barely touches the file count; dozens of tiny marker files exhaust it.
  writeFiles: 64,
  writeBytes: 16 * 1024 ** 3,
  writeWindowMs: DAY_MS,
  // Bytes a site may hold in COS in total, through the entries it stored.
  siteBytes: 32 * 1024 ** 3,
};

export const DEFAULT_SWITCHES = {
  lookupBudget: true,
  grease: true,
  activationGate: true,
  writeLimits: true,
};

// How long a disclosed hash stays readable through its handle's getFile()
// without a new lookup (see rememberDisclosure()).
const DISCLOSURE_TTL_MS = 60 * 60 * 1000;
const DISCLOSURES_MAX = 2000;

const LOOKUP_KEY = 'cosLookupBudgets';
const WRITE_KEY = 'cosWriteBudgets';
const SESSION_KEY = 'cosMitigationSession';
const PENDING_KEY = 'cosPendingGlobal';

// Answers and stores everything the mitigations keep. Only background.js has
// an instance; every handler there runs in the same worker, so the in-memory
// copies are the source of truth once loaded, and each change is saved.
export class PrivacyMitigations {
  constructor({ siteOf }) {
    // Computes a schemeful site from an origin.
    this.siteOf = siteOf;
    this.switches = { ...DEFAULT_SWITCHES };
    this.limits = { ...DEFAULT_LIMITS };
    // top-level site -> { start, used }
    this.lookups = {};
    // top-level site -> { start, files, bytes }
    this.writes = {};
    // top-level site -> [hash], "*" writes waiting for the user to interact
    // with a page of that site. Kept in local storage, since a later visit
    // releases them too.
    this.pendingGlobal = {};
    // Kept in session storage, so a worker restart keeps them and a browser
    // restart drops them:
    //   activatedTabs: tabId -> true once the user interacted with its page.
    //   disclosures: `${origin}|${partition}|${hash}` -> expiry.
    this.session = { activatedTabs: {}, disclosures: {} };
    this._ready = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.mitigations) this._applySwitches(changes.mitigations.newValue);
      if (changes.mitigationLimits) this._applyLimits(changes.mitigationLimits.newValue);
      // The budgets are only ever written here, so a change to them is this
      // instance's own and already in memory. Applying it would let a slower
      // save overwrite a newer charge.
    });
  }

  ready() {
    this._ready ??= (async () => {
      const local = await chrome.storage.local.get([
        'mitigations',
        'mitigationLimits',
        LOOKUP_KEY,
        WRITE_KEY,
        PENDING_KEY,
      ]);
      this._applySwitches(local.mitigations);
      this._applyLimits(local.mitigationLimits);
      this.lookups = local[LOOKUP_KEY] || {};
      this.writes = local[WRITE_KEY] || {};
      this.pendingGlobal = local[PENDING_KEY] || {};
      const session = (await chrome.storage.session?.get(SESSION_KEY))?.[SESSION_KEY];
      if (session) this.session = { ...this.session, ...session };
      // Versions that kept waiting writes per tab, in the session.
      delete this.session.pendingGlobal;
    })();
    return this._ready;
  }

  _applySwitches(value) {
    this.switches = { ...DEFAULT_SWITCHES, ...(value || {}) };
  }

  _applyLimits(value) {
    this.limits = { ...DEFAULT_LIMITS, ...(value || {}) };
  }

  _saveSession() {
    return chrome.storage.session?.set({ [SESSION_KEY]: this.session });
  }

  // ── Cross-site lookup budget ──────────────────────────────────────────────

  /**
   * Charges one lookup to the top-level site `partition`, the way every frame
   * on its pages shares one budget. Returns false, charging nothing, once the
   * budget for the current window is spent: the caller then answers as a miss.
   */
  async chargeLookup(partition) {
    await this.ready();
    if (!this.switches.lookupBudget) return true;
    const key = partition || 'unknown';
    const now = Date.now();
    let entry = this.lookups[key];
    if (!entry || now - entry.start >= this.limits.lookupWindowMs) {
      entry = { start: now, used: 0 };
    }
    if (entry.used >= this.limits.lookupBudget) return false;
    entry.used++;
    this.lookups[key] = entry;
    this._pruneWindows(this.lookups, this.limits.lookupWindowMs, now);
    await chrome.storage.local.set({ [LOOKUP_KEY]: this.lookups });
    return true;
  }

  /** What is left of a top-level site's budget, for the popup and tests. */
  async lookupBudgetState(partition) {
    await this.ready();
    const entry = this.lookups[partition || 'unknown'];
    const fresh = !entry || Date.now() - entry.start >= this.limits.lookupWindowMs;
    return {
      enabled: this.switches.lookupBudget,
      limit: this.limits.lookupBudget,
      used: fresh ? 0 : entry.used,
      resetsAt: fresh ? null : entry.start + this.limits.lookupWindowMs,
    };
  }

  _pruneWindows(map, windowMs, now) {
    for (const [key, entry] of Object.entries(map)) {
      if (now - entry.start >= windowMs) delete map[key];
    }
  }

  // ── GREASE'ing ────────────────────────────────────────────────────────────

  /**
   * Whether to answer a global-scope read of an entry of `size` bytes as a
   * miss although it would be disclosed. Decided afresh for every lookup, and
   * every lookup is charged, so repeating one to see through the noise costs
   * budget each time.
   */
  shouldGrease(size) {
    if (!this.switches.grease) return false;
    if (typeof size !== 'number' || size > this.limits.greaseMaxBytes) return false;
    const [random] = crypto.getRandomValues(new Uint32Array(1));
    return random / 2 ** 32 < this.limits.greaseRate;
  }

  // ── User interaction before global visibility ─────────────────────────────

  /**
   * Whether a "*" write from `tabId`, under the top-level site `partition`,
   * may make its entry globally disclosable now: only once the user has
   * interacted with that tab's page. When it may not, the hash waits in
   * `pendingGlobal` under `partition` until the user interacts with any page
   * of that site, in this visit or a later one (see `activate()`).
   */
  async admitGlobalWrite(tabId, partition, hash) {
    await this.ready();
    if (!this.switches.activationGate) return true;
    if (tabId != null && this.session.activatedTabs[tabId]) return true;
    if (!partition) return false;
    const pending = (this.pendingGlobal[partition] ??= []);
    if (!pending.includes(hash)) {
      pending.push(hash);
      await chrome.storage.local.set({ [PENDING_KEY]: this.pendingGlobal });
    }
    return false;
  }

  /**
   * Records a user interaction with the page in `tabId`, whose top-level site
   * is `partition`, and returns the hashes that were waiting for one on that
   * site.
   */
  async activate(tabId, partition) {
    await this.ready();
    if (tabId != null && !this.session.activatedTabs[tabId]) {
      this.session.activatedTabs[tabId] = true;
      await this._saveSession();
    }
    const released = (partition && this.pendingGlobal[partition]) || [];
    if (released.length) {
      delete this.pendingGlobal[partition];
      await chrome.storage.local.set({ [PENDING_KEY]: this.pendingGlobal });
    }
    return released;
  }

  /**
   * Forgets a tab's interaction when its page is replaced (a navigation or a
   * reload) or closed, the way a new document starts without user activation.
   * A reload chain or a popup therefore never inherits an interaction. Writes
   * waiting on the tab's site stay waiting, for the next interaction there.
   */
  async resetTab(tabId) {
    await this.ready();
    if (!this.session.activatedTabs[tabId]) return;
    delete this.session.activatedTabs[tabId];
    await this._saveSession();
  }

  // ── Reads through a handle ────────────────────────────────────────────────

  /**
   * Remembers that `origin` under `partition` was told `hash` is there, so the
   * handle's getFile() reads the bytes without a second lookup, which would be
   * charged and could be GREASE'd differently. Learning the bytes of a file
   * an origin was already told about discloses nothing new.
   */
  async rememberDisclosure(origin, partition, hash) {
    await this.ready();
    const now = Date.now();
    const map = this.session.disclosures;
    for (const [key, expiry] of Object.entries(map)) {
      if (expiry <= now) delete map[key];
    }
    const key = `${origin}|${partition}|${hash}`;
    delete map[key];
    map[key] = now + DISCLOSURE_TTL_MS;
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length - DISCLOSURES_MAX; i++) delete map[keys[i]];
    await this._saveSession();
  }

  async wasDisclosed(origin, partition, hash) {
    await this.ready();
    return (this.session.disclosures[`${origin}|${partition}|${hash}`] ?? 0) > Date.now();
  }

  // ── Write budget and storage cap ──────────────────────────────────────────

  /**
   * Throws a QuotaExceededError when storing `size` bytes as a new file for
   * `origin` under the top-level site `partition` would exceed that top-level
   * site's write budget, or the total cap of the writer's site. The write
   * budget belongs to the top-level site, so every origin and frame on its
   * pages draws from one budget. `heldBytes` is what the writer's site already
   * holds in COS. A write that adds no new storing grant (`isNew` false) costs
   * nothing: the origin already stored these bytes under this top-level site.
   */
  async checkWrite(origin, { size, isNew, partition, heldBytes }) {
    await this.ready();
    if (!this.switches.writeLimits || !isNew) return;
    const writerSite = (await this.siteOf(origin)) || origin;
    const budgetKey = partition || writerSite;
    const entry = this._writeEntry(budgetKey);
    const { writeFiles, writeBytes, siteBytes, writeWindowMs } = this.limits;
    let reason = null;
    if (entry.files + 1 > writeFiles) {
      reason = `Pages on ${budgetKey} have already stored ${entry.files} new files in Cross-Origin Storage in this ${formatWindow(writeWindowMs)}, its maximum.`;
    } else if (entry.bytes + size > writeBytes) {
      reason = `Pages on ${budgetKey} have already stored ${formatBytes(entry.bytes)} in Cross-Origin Storage in this ${formatWindow(writeWindowMs)}, and this file of ${formatBytes(size)} would exceed their ${formatBytes(writeBytes)}.`;
    } else if (heldBytes + size > siteBytes) {
      reason = `${writerSite} holds ${formatBytes(heldBytes)} in Cross-Origin Storage, and this file of ${formatBytes(size)} would exceed its maximum of ${formatBytes(siteBytes)}.`;
    }
    if (reason) {
      console.warn(`[COS] ${reason}`);
      const err = new Error(reason);
      err.cosErrorName = 'QuotaExceededError';
      throw err;
    }
  }

  /** Counts a write that `checkWrite()` let through, once its bytes are stored. */
  async commitWrite(origin, { size, isNew, partition }) {
    await this.ready();
    if (!this.switches.writeLimits || !isNew) return;
    const budgetKey = partition || (await this.siteOf(origin)) || origin;
    const entry = this._writeEntry(budgetKey);
    entry.files++;
    entry.bytes += size;
    this.writes[budgetKey] = entry;
    this._pruneWindows(this.writes, this.limits.writeWindowMs, Date.now());
    await chrome.storage.local.set({ [WRITE_KEY]: this.writes });
  }

  _writeEntry(key) {
    const now = Date.now();
    const entry = this.writes[key];
    if (!entry || now - entry.start >= this.limits.writeWindowMs) {
      return { start: now, files: 0, bytes: 0 };
    }
    return entry;
  }

  /** Clears both budgets, for the options page's reset button. */
  async resetBudgets() {
    await this.ready();
    this.lookups = {};
    this.writes = {};
    await chrome.storage.local.set({ [LOOKUP_KEY]: {}, [WRITE_KEY]: {} });
  }
}

function formatBytes(n) {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${units[i]}`;
}

function formatWindow(ms) {
  if (ms % DAY_MS === 0) return ms === DAY_MS ? 'day' : `${ms / DAY_MS} days`;
  return `${Math.round(ms / 1000)} seconds`;
}
