// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Optional gate that checks a requested resource hash against the
// Public Hash List (PHL) before the extension reveals whether that hash is
// available in the local COS cache. Off by default; see options.html. Design
// rationale, governance model, and reference implementation:
// https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/phl-explainer.md
//
// The PHL is a flat, Public-Suffix-List-style text file. Parsing rules,
// per the PHL explainer's Data format section:
//   - Lines starting with `//` are comments and are ignored, EXCEPT for
//     the `===BEGIN <SECTION>===` / `===END <SECTION>===` delimiters,
//     which mark section boundaries.
//   - All other non-blank lines are bare lowercase 64-char hex SHA-256
//     digests, one per line.
//   - The `SHA-256` and `SHA-256 MANUAL` sections MUST be treated as
//     eligible by user agents. The `SHA-256 HUGGING-FACE` section is
//     optional (SHOULD include, MAY omit) — this extension includes it,
//     since AI model weights are a primary COS use case.

const PHL_URL =
  'https://media.githubusercontent.com/media/WICG/cross-origin-storage/main/public-hash-list/implementation/data/public-hash-list.dat';

// The repo publishes a `sha256sum`-format sidecar next to the data file;
// verifying against it catches a corrupted or tampered download before it
// ever reaches parsePublicHashList().
const PHL_SHA256_URL = `${PHL_URL}.sha256`;

// Stale-while-revalidate: serve whatever is cached immediately (even if
// stale), and kick off a background refetch once the cache is older than
// this. A failed background refetch just leaves the existing cache in
// place, so a transient network/GitHub outage degrades gracefully rather
// than blocking lookups.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// The downloaded file is kept as it came, so the provenance comments for a
// resource stored later can be read without downloading it again (GitHub
// allows the browser only five minutes of caching, so its own cache is no
// help). It costs the size of the list on disk, next to the parsed hash set.
const RAW_CACHE_NAME = 'phl-raw';

const STORAGE_KEY_HASHES = 'phlHashSet';
const STORAGE_KEY_FETCHED_AT = 'phlFetchedAt';
const STORAGE_KEY_VERSION = 'phlVersion';
const STORAGE_KEY_HEADER = 'phlHeader';
const STORAGE_KEY_PROVENANCE = 'phlProvenance';

const SECTION_RE = /^\/\/\s*===(BEGIN|END)\s+(SHA-256(?:\s+[A-Z-]+)?)\s*===/;

// The file's opening comments (version, commit, license) are worth keeping;
// the rest are per-hash provenance, kept only for the hashes asked about.
const MAX_HEADER_LINES = 40;

/**
 * @param {string} text
 * @param {{provenanceFor?: Set<string>}} [options] Hashes whose preceding
 *   provenance comment and section should be kept. Keeping them for all
 *   ~440,000 entries would cost tens of megabytes; the caller passes the
 *   handful it can actually show.
 */
function parsePublicHashList(text, { provenanceFor } = {}) {
  const hashes = new Set();
  const header = [];
  const provenance = {};
  let version = null;
  let currentSection = null;
  let lastComment = null;
  let sawFirstHash = false;
  const HEX64_RE = /^[a-f0-9]{64}$/;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('//')) {
      const versionMatch = line.match(/VERSION:\s*(\S+)/);
      if (versionMatch) {
        version = versionMatch[1];
      }
      const sectionMatch = line.match(SECTION_RE);
      if (sectionMatch) {
        const [, kind, name] = sectionMatch;
        currentSection = kind === 'BEGIN' ? name : null;
        lastComment = null;
        continue;
      }
      if (!sawFirstHash && header.length < MAX_HEADER_LINES) {
        header.push(line.replace(/^\/\/\s?/, ''));
      }
      lastComment = line;
      continue;
    }

    // Bare hash line. Only accept inside a recognized section, and only
    // well-formed 64-char lowercase hex — anything else is ignored rather
    // than rejecting the whole file, so one malformed line can't zero out
    // the allowlist.
    if (currentSection && HEX64_RE.test(line)) {
      hashes.add(line);
      sawFirstHash = true;
      if (provenanceFor?.has(line) && !provenance[line]) {
        provenance[line] = { comment: lastComment, section: currentSection };
      }
    }
    lastComment = null;
  }

  return { hashes, version, header, provenance };
}

/**
 * The downloaded list exactly as it arrived, or null if no copy is kept.
 * @returns {Promise<Response|null>}
 */
async function readRawPublicHashList() {
  try {
    const cache = await caches.open(RAW_CACHE_NAME);
    return (await cache.match(PHL_URL)) ?? null;
  } catch (error) {
    console.warn('[COS] Reading the stored Public Hash List failed:', error);
    return null;
  }
}

/**
 * Keeps `buffer` as the stored copy of the list. Failing here (out of disk,
 * say) only costs a download later, so it never fails the refresh.
 */
async function storeRawPublicHashList(buffer) {
  try {
    const cache = await caches.open(RAW_CACHE_NAME);
    await cache.put(
      PHL_URL,
      new Response(buffer, { headers: { 'content-type': 'text/plain' } })
    );
  } catch (error) {
    console.warn('[COS] Storing the Public Hash List failed:', error);
  }
}

/**
 * Adds provenance entries for hashes that had none, leaving the rest alone.
 * @param {Record<string, {comment: string|null, section: string|null}>} entries
 */
async function mergeStoredProvenance(entries) {
  const stored = await chrome.storage.local.get(STORAGE_KEY_PROVENANCE);
  await chrome.storage.local.set({
    [STORAGE_KEY_PROVENANCE]: { ...(stored[STORAGE_KEY_PROVENANCE] || {}), ...entries },
  });
}

/**
 * The parts of the stored list that describe it: the opening comments, and
 * the provenance kept for the resources in COS. Small enough to read from an
 * extension page, unlike the hash set itself.
 */
async function readStoredPublicHashListMeta() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_FETCHED_AT,
    STORAGE_KEY_VERSION,
    STORAGE_KEY_HEADER,
    STORAGE_KEY_PROVENANCE,
  ]);
  return {
    fetchedAt: stored[STORAGE_KEY_FETCHED_AT] || 0,
    version: stored[STORAGE_KEY_VERSION] || null,
    header: stored[STORAGE_KEY_HEADER] || [],
    provenance: stored[STORAGE_KEY_PROVENANCE] || {},
  };
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

class PublicHashList {
  constructor() {
    this._hashes = null; // Set<string> | null until first load
    this._fetchedAt = 0;
    this._version = null;
    this._refreshPromise = null; // de-dupes concurrent refreshes
    // How far along a refresh is, for the popup to display. The list is tens
    // of megabytes, so a download is worth showing progress for.
    this._progress = { phase: 'idle' };
    // Optional: returns the hashes whose provenance comments are worth
    // keeping while parsing (the resources in COS). Set by the background.
    this.provenanceHashes = null;
  }

  get version() {
    return this._version;
  }

  get progress() {
    return this._progress;
  }

  get fetchedAt() {
    return this._fetchedAt;
  }

  /**
   * Populates the in-memory hash set from storage, without touching the
   * network. Resolves to true if a cached copy is now in memory, false if
   * the PHL has never been downloaded.
   */
  async loadCached() {
    if (this._hashes) return true;

    const stored = await chrome.storage.local.get([
      STORAGE_KEY_HASHES,
      STORAGE_KEY_FETCHED_AT,
      STORAGE_KEY_VERSION,
    ]);
    // A refresh may have completed while storage was being read; its data
    // is at least as new as what was just read, so keep it.
    if (this._hashes) return true;
    if (!stored[STORAGE_KEY_HASHES]?.length) return false;

    this._hashes = new Set(stored[STORAGE_KEY_HASHES]);
    this._fetchedAt = stored[STORAGE_KEY_FETCHED_AT] || 0;
    this._version = stored[STORAGE_KEY_VERSION] || null;
    return true;
  }

  /**
   * Ensures the in-memory hash set is populated from storage, then
   * triggers a stale-while-revalidate background refresh if needed.
   * Does not block on the network: a fully empty cache (first run) does
   * do a blocking initial fetch, since there is nothing to serve yet.
   */
  async init() {
    if (await this.loadCached()) {
      this._maybeRefreshInBackground();
    } else {
      // Nothing cached yet — block once so the very first gated lookup
      // has real data instead of failing closed against an empty set.
      await this._refresh();
    }
  }

  _maybeRefreshInBackground() {
    const age = Date.now() - this._fetchedAt;
    if (age < REFRESH_INTERVAL_MS) return;
    if (this._refreshPromise) return;
    this._refresh().catch((error) => {
      // Stale data stays in place; just log and try again next time
      // init()/has() is called after the interval has elapsed.
      console.warn('[COS] Public Hash List background refresh failed:', error);
    });
  }

  // The list is tens of megabytes, so callers that race (a gated lookup
  // and the popup, say) share one download instead of starting their own.
  _refresh() {
    this._refreshPromise ??= this._fetchAndStore().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _fetchAndStore() {
    try {
      return await this._fetchAndStoreTracked();
    } catch (error) {
      this._progress = { phase: 'failed', message: error.message };
      throw error;
    }
  }

  async _fetchAndStoreTracked() {
    this._progress = { phase: 'downloading', receivedBytes: 0, totalBytes: null };
    const [datResponse, sha256Response] = await Promise.all([
      fetch(PHL_URL, { cache: 'no-cache' }),
      fetch(PHL_SHA256_URL, { cache: 'no-cache' }),
    ]);
    if (!datResponse.ok) {
      throw new Error(`HTTP ${datResponse.status} fetching Public Hash List`);
    }
    if (!sha256Response.ok) {
      throw new Error(
        `HTTP ${sha256Response.status} fetching Public Hash List checksum`
      );
    }

    // Read the body in chunks rather than with arrayBuffer(), so the popup
    // can show how much of the list has arrived. Content-Length is absent on
    // a chunked response, which just leaves the total unknown.
    const totalBytes = Number(datResponse.headers.get('content-length')) || null;
    const reader = datResponse.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.length;
      this._progress = { phase: 'downloading', receivedBytes, totalBytes };
    }
    const buffer = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    this._progress = { phase: 'verifying', receivedBytes, totalBytes };
    const sha256Text = await sha256Response.text();
    const expectedHash = sha256Text.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error('Malformed Public Hash List checksum file');
    }
    const actualHash = await sha256Hex(buffer);
    if (actualHash !== expectedHash) {
      throw new Error(
        `Public Hash List checksum mismatch: expected ${expectedHash}, got ${actualHash}`
      );
    }

    // Parsing runs to completion without yielding, so a caller polling for
    // progress rarely catches this phase; it goes from verifying to saving.
    this._progress = { phase: 'parsing', receivedBytes, totalBytes };
    const text = new TextDecoder('utf-8').decode(buffer);
    // Keep the provenance comments for the resources in COS while the file is
    // in hand, so showing where they came from needs no second download.
    const provenanceFor = await this.provenanceHashes?.();
    const { hashes, version, header, provenance } = parsePublicHashList(text, {
      provenanceFor,
    });
    if (hashes.size === 0) {
      // Parsed-but-empty almost certainly means a format change upstream
      // rather than a genuinely empty list. Treat it as a failed refresh
      // so we keep serving the last known-good cached set.
      throw new Error('Parsed Public Hash List contained no entries');
    }
    this._progress = { phase: 'saving', receivedBytes, totalBytes };
    this._hashes = hashes;
    this._fetchedAt = Date.now();
    this._version = version;
    await chrome.storage.local.set({
      [STORAGE_KEY_HASHES]: [...hashes],
      [STORAGE_KEY_FETCHED_AT]: this._fetchedAt,
      [STORAGE_KEY_VERSION]: version,
      [STORAGE_KEY_HEADER]: header,
      [STORAGE_KEY_PROVENANCE]: provenance,
    });
    await storeRawPublicHashList(buffer);
    this._progress = { phase: 'idle' };
  }

  /**
   * Returns true if `hashValue` (lowercase hex SHA-256) is present in the
   * Public Hash List. Triggers a background refresh as a side effect if
   * the cached copy is older than REFRESH_INTERVAL_MS.
   */
  async has(hashValue) {
    await this.init();
    this._maybeRefreshInBackground();
    return this._hashes.has(hashValue);
  }
}

export {
  PublicHashList,
  parsePublicHashList,
  readStoredPublicHashListMeta,
  readRawPublicHashList,
  storeRawPublicHashList,
  mergeStoredProvenance,
  PHL_URL,
  PHL_SHA256_URL,
  REFRESH_INTERVAL_MS,
};
