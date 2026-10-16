// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Same-site helper backed by the Public Suffix List (see public-suffix-list.js).

import { PublicSuffixList } from './public-suffix-list.js';

const _psl = new PublicSuffixList();

/**
 * Returns the site (registrable domain / eTLD+1 per the PSL) for an origin.
 * @param {string} origin - e.g. "https://sub.example.co.uk"
 * @returns {Promise<string|null>} - e.g. "example.co.uk"
 */
async function getSite(origin) {
  await _psl.init();
  return _psl.getSite(origin);
}

/**
 * Returns true if two origins are same-site per the PSL.
 * @param {string} originA
 * @param {string} originB
 * @returns {Promise<boolean>}
 */
async function isSameSite(originA, originB) {
  return _psl.isSameSite(originA, originB);
}

/**
 * Returns the schemeful site for an origin, as HTML's "obtain a site" does:
 * the scheme plus the registrable domain, or plus the host when it has none.
 * @param {string} origin - e.g. "https://sub.example.co.uk"
 * @returns {Promise<string|null>} - e.g. "https://example.co.uk"
 */
async function getSchemefulSite(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  await _psl.init();
  return `${url.protocol}//${_psl.getSite(origin) || url.hostname}`;
}

export { getSite, getSchemefulSite, isSameSite };
