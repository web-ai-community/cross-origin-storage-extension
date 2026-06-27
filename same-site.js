// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Minimal "same-site" helper for the omitted-origins (same-site-only)
// visibility tier described in the COS explainer:
// https://wicg.github.io/cross-origin-storage/#example-making-a-resource-available-to-same-site-origins-only
//
// This deliberately does NOT bundle the full Public Suffix List (it's
// large, and keeping it in sync is its own maintenance burden for a
// browser extension). Instead it special-cases the common multi-label
// public suffixes most likely to appear among COS-using sites (the
// ccTLD/SLD combinations and a few large multi-tenant hosts), and falls
// back to "last two labels" otherwise.
//
// Consequence of this tradeoff: this can occasionally be wrong for
// obscure multi-label suffixes not in the list below. Since same-site is
// the MOST restrictive visibility tier (stricter than an explicit
// origins list, which is stricter than '*'), getting this wrong in
// either direction is low-stakes:
//   - False negative (treats same-site sites as cross-site): falls back
//     to a normal network fetch, same as any other COS miss.
//   - False positive (treats cross-site sites as same-site): could let
//     a resource leak to a sibling site under e.g. an unrecognized SLD.
//     The COMMON_MULTI_LABEL_SUFFIXES list below exists specifically to
//     minimize this case for the most popular hosting platforms.
const COMMON_MULTI_LABEL_SUFFIXES = new Set([
  // ccTLD + generic SLD combinations.
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.kr',
  'co.nz',
  'co.za',
  'co.in',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.cn',
  'com.mx',
  'com.tr',
  'com.sg',
  // Multi-tenant hosting platforms where each tenant is its own site.
  'github.io',
  'gitlab.io',
  'pages.dev',
  'vercel.app',
  'netlify.app',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'azurewebsites.net',
  'workers.dev',
]);

/**
 * Returns the "site" (eTLD+1-ish) for an https(s) origin string, for
 * the purpose of the same-site visibility tier only. Not a full Public
 * Suffix List implementation -- see module comment above.
 *
 * @param {string} origin e.g. "https://sub.example.com"
 * @returns {string|null} e.g. "example.com", or null if unparseable
 */
function getSite(origin) {
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!hostname) return null;

  // IP addresses (IPv4 or bracketed IPv6) are their own site.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return hostname;
  }

  const labels = hostname.split('.').filter(Boolean);
  if (labels.length <= 2) return hostname;

  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');
  if (COMMON_MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return lastThree;
  }
  return lastTwo;
}

/**
 * Returns true if two https(s) origins are same-site, i.e. share the
 * same eTLD+1-ish "site" per getSite() above.
 */
function isSameSite(originA, originB) {
  const siteA = getSite(originA);
  const siteB = getSite(originB);
  return siteA !== null && siteA === siteB;
}

export { getSite, isSameSite };
