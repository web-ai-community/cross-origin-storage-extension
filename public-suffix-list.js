// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Public Suffix List (PSL) implementation for the same-site visibility tier.
// Mirrors the stale-while-revalidate infrastructure used by public-hash-list.js:
// the PSL is fetched from raw.githubusercontent.com (already in host_permissions),
// cached in chrome.storage.local, and re-fetched in the background every 24 hours.
//
// Parsing follows the PSL format (https://wiki.mozilla.org/Public_Suffix_List):
//   - Lines starting with // are comments and are ignored.
//   - Blank lines are ignored.
//   - !exception lines override a wildcard parent rule.
//   - *.foo lines mean every direct subdomain of foo is itself a public suffix.
//   - All other non-blank, non-comment lines are exact public suffix entries.
//
// Matching algorithm per https://wiki.mozilla.org/Public_Suffix_List/Algorithm:
//   Try suffixes from longest to shortest; exception rules beat wildcards beat
//   exact matches. The registrable domain (eTLD+1) is the matched public suffix
//   plus one additional label to its left.

const PSL_URL =
  'https://raw.githubusercontent.com/publicsuffix/list/master/public_suffix_list.dat';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

const STORAGE_KEY_EXACT = 'pslExact';
const STORAGE_KEY_WILDCARD = 'pslWildcard';
const STORAGE_KEY_EXCEPTION = 'pslException';
const STORAGE_KEY_FETCHED_AT = 'pslFetchedAt';

/**
 * Parses a PSL text file into three Sets used for O(1) matching.
 *
 * @param {string} text - Raw PSL file contents.
 * @returns {{ exact: Set<string>, wildcardParent: Set<string>, exceptions: Set<string> }}
 *   exact        — entries that are themselves public suffixes (e.g. "com", "co.uk")
 *   wildcardParent — X where "*.X" appears in the PSL (e.g. "ck" for "*.ck")
 *   exceptions   — Y where "!Y" appears in the PSL (e.g. "www.ck" for "!www.ck")
 */
function parsePublicSuffixList(text) {
  const exact = new Set();
  const wildcardParent = new Set();
  const exceptions = new Set();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().toLowerCase();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('!')) {
      exceptions.add(line.slice(1));
    } else if (line.startsWith('*.')) {
      wildcardParent.add(line.slice(2));
    } else {
      exact.add(line);
    }
  }

  return { exact, wildcardParent, exceptions };
}

class PublicSuffixList {
  constructor() {
    this._exact = null;          // Set<string> — exact PSL entries
    this._wildcardParent = null; // Set<string> — X for each "*.X" rule
    this._exceptions = null;     // Set<string> — Y for each "!Y" rule
    this._fetchedAt = 0;
    this._refreshPromise = null; // de-dupes concurrent background refreshes
  }

  /**
   * Ensures the in-memory sets are populated from storage, then
   * triggers a stale-while-revalidate background refresh if needed.
   * Blocks only on the very first call when nothing is cached yet.
   */
  async init() {
    if (this._exact) return;

    const stored = await chrome.storage.local.get([
      STORAGE_KEY_EXACT,
      STORAGE_KEY_WILDCARD,
      STORAGE_KEY_EXCEPTION,
      STORAGE_KEY_FETCHED_AT,
    ]);

    if (stored[STORAGE_KEY_EXACT]?.length) {
      this._exact = new Set(stored[STORAGE_KEY_EXACT]);
      this._wildcardParent = new Set(stored[STORAGE_KEY_WILDCARD] || []);
      this._exceptions = new Set(stored[STORAGE_KEY_EXCEPTION] || []);
      this._fetchedAt = stored[STORAGE_KEY_FETCHED_AT] || 0;
      this._maybeRefreshInBackground();
    } else {
      // Nothing cached yet — block once so the first same-site check has
      // real data rather than producing incorrect results.
      await this._refresh();
    }
  }

  _maybeRefreshInBackground() {
    const age = Date.now() - this._fetchedAt;
    if (age < REFRESH_INTERVAL_MS) return;
    if (this._refreshPromise) return;
    this._refreshPromise = this._refresh()
      .catch((error) => {
        console.warn('[COS] Public Suffix List background refresh failed:', error);
      })
      .finally(() => {
        this._refreshPromise = null;
      });
  }

  async _refresh() {
    const response = await fetch(PSL_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching Public Suffix List`);
    }
    const text = await response.text();
    const { exact, wildcardParent, exceptions } = parsePublicSuffixList(text);
    if (exact.size === 0) {
      throw new Error('Parsed Public Suffix List contained no entries');
    }
    this._exact = exact;
    this._wildcardParent = wildcardParent;
    this._exceptions = exceptions;
    this._fetchedAt = Date.now();
    await chrome.storage.local.set({
      [STORAGE_KEY_EXACT]: [...exact],
      [STORAGE_KEY_WILDCARD]: [...wildcardParent],
      [STORAGE_KEY_EXCEPTION]: [...exceptions],
      [STORAGE_KEY_FETCHED_AT]: this._fetchedAt,
    });
  }

  /**
   * Returns the registrable domain (eTLD+1) for a hostname using the PSL.
   * Requires init() to have been called first. Returns null if the hostname
   * is itself a public suffix or shorter (i.e. there is no eTLD+1).
   *
   * Matching proceeds from longest suffix to shortest:
   *   1. Exception rules (!Y) — effective public suffix is Y minus its
   *      leftmost label; the eTLD+1 is Y itself.
   *   2. Exact rules — the suffix IS the public suffix.
   *   3. Wildcard rules (*.parent) — the suffix is covered by the wildcard.
   *   4. Fallback — treat the last label as the sole TLD.
   *
   * @param {string} hostname - e.g. "sub.example.co.uk"
   * @returns {string|null} - e.g. "example.co.uk"
   */
  getRegistrableDomain(hostname) {
    hostname = hostname.toLowerCase().replace(/\.$/, ''); // strip trailing dot
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length === 0) return null;

    // Single-label hostnames (e.g. "localhost") — treat as their own site.
    if (labels.length === 1) return hostname;

    // IP addresses (IPv4 or bracketed IPv6) are their own site.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) {
      return hostname;
    }

    // Try each suffix from the longest (= entire hostname) to the shortest.
    let matchedSuffixLabelCount = 1; // fallback: last single label is the TLD

    for (let start = 0; start < labels.length; start++) {
      const suffix = labels.slice(start).join('.');

      if (this._exceptions.has(suffix)) {
        // Exception !suffix means "suffix" is NOT a public suffix; the
        // effective public suffix is suffix minus its leftmost label, so
        // the eTLD+1 is suffix itself.
        matchedSuffixLabelCount = labels.length - start - 1;
        break;
      }

      if (this._exact.has(suffix)) {
        matchedSuffixLabelCount = labels.length - start;
        break;
      }

      const parent = labels.slice(start + 1).join('.');
      if (parent && this._wildcardParent.has(parent)) {
        // *.parent covers suffix, so suffix is a public suffix.
        matchedSuffixLabelCount = labels.length - start;
        break;
      }
    }

    const etld1Start = labels.length - matchedSuffixLabelCount - 1;
    if (etld1Start < 0) return null; // hostname is the public suffix or shorter
    return labels.slice(etld1Start).join('.');
  }

  /**
   * Returns the registrable domain for an origin string.
   * Requires init() to have been called first.
   *
   * @param {string} origin - e.g. "https://sub.example.co.uk"
   * @returns {string|null} - e.g. "example.co.uk"
   */
  getSite(origin) {
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return null;
    }
    if (!hostname) return null;
    return this.getRegistrableDomain(hostname);
  }

  /**
   * Returns true if two origins are same-site per the PSL.
   * Awaits init() on first call; subsequent calls are synchronous lookups.
   *
   * @param {string} originA
   * @param {string} originB
   * @returns {Promise<boolean>}
   */
  async isSameSite(originA, originB) {
    await this.init();
    this._maybeRefreshInBackground();
    const siteA = this.getSite(originA);
    const siteB = this.getSite(originB);
    return siteA !== null && siteA === siteB;
  }
}

export { PublicSuffixList, parsePublicSuffixList, PSL_URL, REFRESH_INTERVAL_MS };
