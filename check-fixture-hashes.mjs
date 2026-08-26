// Guards against SRI hashes drifting out of sync with the fixtures they name.
//
// A hardcoded `sha256-…` and the file it describes are two copies of one fact.
// Edit the file — even just reflowing a comment — and the constant silently
// becomes wrong. Nothing shouts: the COS lookup returns no bytes, the polyfill
// quietly falls back to the network, and the test fails as if the *integration*
// were broken. That is exactly how commit 07b5fff broke both
// <script type="module-cos"> tests, and it went unnoticed because the failure
// was indistinguishable from a product bug.
//
// docs/test.html now derives most of its hashes at runtime (see sriForURL), so
// only the ones that structurally cannot be derived are still literal: hashes
// written into markup, which the parser reads before any script could compute
// them. Those are what this checks, along with every other `sha256-…` in docs/.
//
// Usage: node check-fixture-hashes.mjs [--remote]
//        --remote also fetches and verifies hashes pinning third-party URLs
//        (off by default so the check stays offline and deterministic).

import { readFile, readdir } from 'fs/promises';
import { createHash } from 'crypto';
import { join, dirname, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DOCS = join(ROOT, 'docs');
const CHECK_REMOTE = process.argv.includes('--remote');

// Hashes that are deliberately wrong: tests assert that a resource with a
// mismatched hash is refused. They match no fixture on purpose.
const INTENTIONALLY_WRONG = new Map([
  ['sha256-lJyrUbO5pkHSUm6cpZGHOlSJ7J5BUKZ3lpJK2FK9swM=', 'DECL_WRONG_INTEGRITY — <link>/<script> hash-mismatch test'],
  ['sha256-eGh+30Z4WIxoIqA948RuV83ijFx26LX3nmRq2jVw6r8=', 'IMPORT_ATTR_WRONG_INTEGRITY / FETCH_WRONG_INTEGRITY — hash-mismatch tests'],
]);

const SRI_TOKEN = /sha256-[A-Za-z0-9+/]{43}=/g;
const SCANNED_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs']);

const sriOf = (buf) => `sha256-${createHash('sha256').update(buf).digest('base64')}`;
const isRemote = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url);

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

// (url, hash) pairs, so a hash pointing at the *wrong* fixture is caught too,
// not just one pointing at nothing. Covers the three shapes COS uses; bare
// constants fall through to the membership check below.
function extractPairs(text) {
  const pairs = [];
  const push = (url, hash) => url && hash && pairs.push({ url, hash });

  // <link href="…" integrity="…"> / <script src="…" integrity="…">, either order.
  for (const [tag] of text.matchAll(/<(?:link|script)\b[^>]*>/g)) {
    const hash = /\bintegrity\s*=\s*["']([^"']+)["']/.exec(tag)?.[1];
    const url = /\b(?:href|src)\s*=\s*["']([^"']+)["']/.exec(tag)?.[1];
    if (hash?.startsWith('sha256-')) push(url, hash);
  }
  // import … from "…" with { integrity: "…" }
  for (const m of text.matchAll(
    /from\s*["']([^"']+)["']\s*with\s*\{[^{}]*?integrity\s*:\s*["'](sha256-[^"']+)["']/g
  )) push(m[1], m[2]);
  // import("…", { with: { integrity: "…" } })
  for (const m of text.matchAll(
    /import\s*\(\s*["']([^"']+)["']\s*,\s*\{\s*with\s*:\s*\{[^{}]*?integrity\s*:\s*["'](sha256-[^"']+)["']/g
  )) push(m[1], m[2]);
  // CSS: url("…" integrity("…") …). The whitespace before integrity( is
  // optional — the CSS serializer emits url('…'integrity(\n  '…'\n).
  for (const m of text.matchAll(
    /url\(\s*["']([^"']+)["']\s*integrity\(\s*["'](sha256-[^"']+)["']\s*\)/g
  )) push(m[1], m[2]);

  return pairs;
}

const failures = [];
const remoteSeen = [];
let okCount = 0;

// Every file under docs/ is a potential fixture.
const allFiles = await listFiles(DOCS);
const bySri = new Map();
for (const f of allFiles) {
  const h = sriOf(await readFile(f));
  if (!bySri.has(h)) bySri.set(h, []);
  bySri.get(h).push(f);
}

// Pass 1: verify every (url, hash) pair, and record which hashes pin
// third-party URLs so pass 2 doesn't mistake them for stale fixture hashes.
const scanned = [];
for (const file of allFiles) {
  if (!SCANNED_EXTENSIONS.has(extname(file))) continue;
  const text = await readFile(file, 'utf8');
  const tokens = new Set(text.match(SRI_TOKEN) ?? []);
  if (!tokens.size) continue;
  const rel = relative(ROOT, file);

  const paired = new Set();
  scanned.push({ rel, tokens, paired });
  for (const { url, hash } of extractPairs(text)) {
    paired.add(hash);
    if (isRemote(url)) {
      remoteSeen.push({ rel, url, hash });
      continue;
    }
    const target = join(dirname(file), url.split(/[?#]/)[0]);
    let actual;
    try {
      actual = sriOf(await readFile(target));
    } catch {
      // A URL that deliberately 404s (cross-origin tests use one so a pass is
      // only possible via COS) has no file to hash; the membership check below
      // still vouches for the hash itself.
      continue;
    }
    if (actual !== hash) {
      failures.push(
        `${rel}: hash for ${url} is stale\n` +
        `    declared: ${hash}\n` +
        `    actual:   ${actual}`
      );
    } else okCount++;
  }

}

// Pass 2: every remaining bare constant must name some fixture, pin a
// third-party URL, or be a declared decoy. Anything else is unattributed —
// which is what a stale hash looks like.
const thirdPartyHashes = new Set(remoteSeen.map((r) => r.hash));
for (const { rel, tokens, paired } of scanned) {
  for (const token of tokens) {
    if (paired.has(token)) continue;
    if (bySri.has(token)) { okCount++; continue; }
    if (INTENTIONALLY_WRONG.has(token)) continue;
    if (thirdPartyHashes.has(token)) continue;
    failures.push(
      `${rel}: ${token} matches no fixture in docs/ and is not a declared decoy.\n` +
      `    Either the fixture it named changed, or add it to INTENTIONALLY_WRONG\n` +
      `    in check-fixture-hashes.mjs with the reason it must not match.`
    );
  }
}

if (CHECK_REMOTE) {
  for (const { rel, url, hash } of remoteSeen) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const actual = sriOf(Buffer.from(await res.arrayBuffer()));
      if (actual !== hash) {
        failures.push(`${rel}: third-party ${url} no longer matches\n    declared: ${hash}\n    actual:   ${actual}`);
      } else okCount++;
    } catch (err) {
      console.warn(`  ! could not verify ${url}: ${err.message}`);
    }
  }
}

console.log(`Fixture hash check: ${okCount} verified, ${remoteSeen.length} third-party${CHECK_REMOTE ? ' (fetched)' : ' (not fetched; pass --remote)'}, ${INTENTIONALLY_WRONG.size} declared decoys.`);
for (const { rel, url } of remoteSeen) console.log(`  third-party  ${rel} -> ${url.slice(0, 90)}`);

if (failures.length) {
  console.error(`\n${failures.length} stale hash${failures.length === 1 ? '' : 'es'}:\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log('All local fixture hashes are in sync.');
