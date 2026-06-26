// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Optional gate that checks a requested resource hash against the
// Public Hash List (PHL) — https://github.com/tomayac/public-hash-list —
// before the extension reveals whether that hash is available in the
// local COS cache. Off by default; see options.html.
//
// The PHL is a flat, Public-Suffix-List-style text file. Parsing rules,
// per the PHL README:
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
  'https://raw.githubusercontent.com/tomayac/public-hash-list/main/data/public-hash-list.dat';

// Stale-while-revalidate: serve whatever is cached immediately (even if
// stale), and kick off a background refetch once the cache is older than
// this. A failed background refetch just leaves the existing cache in
// place, so a transient network/GitHub outage degrades gracefully rather
// than blocking lookups.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

const STORAGE_KEY_HASHES = 'phlHashSet';
const STORAGE_KEY_FETCHED_AT = 'phlFetchedAt';
const STORAGE_KEY_VERSION = 'phlVersion';

const SECTION_RE = /^\/\/\s*===(BEGIN|END)\s+(SHA-256(?:\s+[A-Z-]+)?)\s*===/;

function parsePublicHashList(text) {
  const hashes = new Set();
  let version = null;
  let currentSection = null;
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
      }
      continue;
    }

    // Bare hash line. Only accept inside a recognized section, and only
    // well-formed 64-char lowercase hex — anything else is ignored rather
    // than rejecting the whole file, so one malformed line can't zero out
    // the allowlist.
    if (currentSection && HEX64_RE.test(line)) {
      hashes.add(line);
    }
  }

  return { hashes, version };
}

class PublicHashList {
  constructor() {
    this._hashes = null; // Set<string> | null until first load
    this._fetchedAt = 0;
    this._version = null;
    this._refreshPromise = null; // de-dupes concurrent background refreshes
  }

  /**
   * Ensures the in-memory hash set is populated from storage, then
   * triggers a stale-while-revalidate background refresh if needed.
   * Does not block on the network: a fully empty cache (first run) does
   * do a blocking initial fetch, since there is nothing to serve yet.
   */
  async init() {
    if (this._hashes) return;

    const stored = await chrome.storage.local.get([
      STORAGE_KEY_HASHES,
      STORAGE_KEY_FETCHED_AT,
      STORAGE_KEY_VERSION,
    ]);

    if (stored[STORAGE_KEY_HASHES]?.length) {
      this._hashes = new Set(stored[STORAGE_KEY_HASHES]);
      this._fetchedAt = stored[STORAGE_KEY_FETCHED_AT] || 0;
      this._version = stored[STORAGE_KEY_VERSION] || null;
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
    this._refreshPromise = this._refresh()
      .catch((error) => {
        // Stale data stays in place; just log and try again next time
        // init()/has() is called after the interval has elapsed.
        console.warn('[COS] Public Hash List background refresh failed:', error);
      })
      .finally(() => {
        this._refreshPromise = null;
      });
  }

  async _refresh() {
    const response = await fetch(PHL_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching Public Hash List`);
    }
    const text = await response.text();
    const { hashes, version } = parsePublicHashList(text);
    if (hashes.size === 0) {
      // Parsed-but-empty almost certainly means a format change upstream
      // rather than a genuinely empty list. Treat it as a failed refresh
      // so we keep serving the last known-good cached set.
      throw new Error('Parsed Public Hash List contained no entries');
    }
    this._hashes = hashes;
    this._fetchedAt = Date.now();
    this._version = version;
    await chrome.storage.local.set({
      [STORAGE_KEY_HASHES]: [...hashes],
      [STORAGE_KEY_FETCHED_AT]: this._fetchedAt,
      [STORAGE_KEY_VERSION]: version,
    });
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

export { PublicHashList, parsePublicHashList, PHL_URL, REFRESH_INTERVAL_MS };
