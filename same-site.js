// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Same-site helper backed by the real Public Suffix List (PSL).
// Replaces the previous hand-rolled COMMON_MULTI_LABEL_SUFFIXES approximation
// with a full PSL implementation (see public-suffix-list.js) that uses the
// same stale-while-revalidate infrastructure as the Public Hash List.

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

export { getSite, isSameSite };
