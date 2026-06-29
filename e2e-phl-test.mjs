// End-to-end tests for the Public Hash List (PHL) gate and the three
// `origins` visibility tiers ('global', 'list', 'same-site').
//
// Strategy overview
// -----------------
// Chrome is launched with:
//   --host-resolver-rules="MAP a.test 127.0.0.1,MAP b.test 127.0.0.1,MAP sub.a.test 127.0.0.1"
// so the single local HTTP server answers for three distinct eTLD+1 origins:
//   http://a.test:PORT     → site "a.test"
//   http://sub.a.test:PORT → site "a.test"  (same-site as a.test)
//   http://b.test:PORT     → site "b.test"  (cross-site from a.test)
//
// The extension's content_scripts now also match http://*.test/* and
// http://*.a.test/* so the COS API is injected into those fake-TLD pages.
//
// PHL and PSL are pre-seeded directly into the extension's chrome.storage.local
// via service-worker evaluation — no real network calls are made. Playwright's
// context.route() is used as a safety net to intercept any accidental refresh
// attempts from _maybeRefreshInBackground().
//
// All four test resources are stored from a.test at the start.  Reads are
// then attempted from multiple origins; the expected outcomes are:
//
//  Resource         origins arg          In PHL?  a.test  sub.a.test  b.test
//  ───────────────  ───────────────────  ───────  ──────  ──────────  ──────
//  GLOBAL_ALLOWED   '*'                  yes      ✅      ✅          ✅
//  GLOBAL_BLOCKED   '*'                  no       ❌      ❌          ❌
//  LIST             ['http://a.test:P']  no       ✅      ❌          ❌
//  SAMESITE         (omitted)            no       ✅      ✅          ❌
//
// Usage: node e2e-phl-test.mjs

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { extname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXT_PATH = __dirname;
const DOCS_PATH = join(__dirname, 'docs');
const PORT = 7475; // distinct from e2e-test.mjs (7474)

// ── Pre-computed test hashes ────────────────────────────────────────────────

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Unique content strings so hashes never collide with the main e2e test.
const CONTENT = {
  globalAllowed: 'phl-e2e-global-allowed',
  globalBlocked: 'phl-e2e-global-blocked',
  list:          'phl-e2e-list',
  samesite:      'phl-e2e-samesite',
};
const HASH = Object.fromEntries(
  Object.entries(CONTENT).map(([k, v]) => [k, sha256Hex(v)])
);

// Mock PSL: 'test' as the sole TLD → a.test and b.test are separate sites;
// sub.a.test has eTLD+1 = a.test (same-site as a.test).
const MOCK_PSL_EXACT = ['test'];

// Mock PHL: only the GLOBAL_ALLOWED hash is on the list.
const MOCK_PHL_HASHES = [HASH.globalAllowed];

// ── Local HTTP server ────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.bin':  'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const fp = join(DOCS_PATH, url.pathname === '/' ? 'test.html' : url.pathname);
      try {
        const data = await readFile(fp);
        res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Open a page at the given hostname (served by our local server) and wait for
// the COS polyfill to be injected. Returns the Playwright Page object.
async function openOrigin(context, hostname) {
  const page = await context.newPage();
  await page.goto(`http://${hostname}:${PORT}/test.html`, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 800));
  const hasCOS = await page.evaluate(() => !!navigator.crossOriginStorage);
  if (!hasCOS) {
    console.warn(`  ⚠️  navigator.crossOriginStorage not injected at ${hostname} — check manifest matches`);
  }
  return page;
}

// Seed the extension's PHL and PSL storage from the service-worker context.
// Sets publicHashListEnabled: true. Must be called before any COS operation.
async function seedStorage(sw) {
  await sw.evaluate(
    async ([phlHashes, pslExact]) => {
      await chrome.storage.local.set({
        phlHashSet:          phlHashes,
        phlFetchedAt:        Date.now(),
        phlVersion:          'test-v1',
        publicHashListEnabled: true,
        pslExact,
        pslWildcard:         [],
        pslException:        [],
        pslFetchedAt:        Date.now(),
      });
    },
    [MOCK_PHL_HASHES, MOCK_PSL_EXACT]
  );
}

// Store a resource via the COS API. `originsArg` is passed as the `origins`
// option: '*', an array of origin strings, or undefined (= same-site, omitted).
// undefined cannot survive page.evaluate serialization intact, so we use
// a sentinel string to signal "omit origins entirely".
const OMIT_ORIGINS = '__SAMESITE__';
async function storeResource(page, content, originsArg) {
  const hex = sha256Hex(content);
  await page.evaluate(
    async ([content, hex, origins, OMIT]) => {
      const hash = { algorithm: 'SHA-256', value: hex };
      const opts = origins === OMIT ? { create: true } : { create: true, origins };
      const handle = await navigator.crossOriginStorage.requestFileHandle(hash, opts);
      const writable = await handle.createWritable();
      await writable.write(new Blob([content], { type: 'text/plain' }));
      await writable.close();
    },
    [content, hex, originsArg === undefined ? OMIT_ORIGINS : originsArg, OMIT_ORIGINS]
  );
}

// Attempt to read a resource. Returns { ok: true, text } or { ok: false, error }.
async function readResource(page, hexHash) {
  return page.evaluate(async (hex) => {
    const hash = { algorithm: 'SHA-256', value: hex };
    try {
      const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
      const file = await handle.getFile();
      const text = await file.text();
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: `${err.name}: ${err.message}` };
    }
  }, hexHash);
}

// ── Test runner ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting local server…');
  const server = await startServer();

  const userDataDir = await mkdtemp(join(tmpdir(), 'cos-phl-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Route .test hostnames to 127.0.0.1 so our local server answers for them.
      '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1,MAP sub.a.test 127.0.0.1',
      // Treat the three test origins as secure so that crypto.randomUUID(),
      // crypto.subtle, etc. are available (these APIs require a secure context).
      `--unsafely-treat-insecure-origin-as-secure=http://a.test:${PORT},http://b.test:${PORT},http://sub.a.test:${PORT}`,
    ],
  });

  // Safety net: intercept any accidental PHL/PSL network refreshes.
  await context.route('https://raw.githubusercontent.com/tomayac/public-hash-list/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `// VERSION: test-v1\n// ===BEGIN SHA-256===\n${MOCK_PHL_HASHES.join('\n')}\n// ===END SHA-256===\n`,
    })
  );
  await context.route('https://raw.githubusercontent.com/publicsuffix/list/**', route =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'test\n' })
  );

  // Wait for the extension's service worker to start.
  await new Promise(r => setTimeout(r, 2000));

  const serviceWorkers = context.serviceWorkers();
  if (!serviceWorkers.length) {
    console.error('FAIL: extension service worker not found');
    await context.close();
    server.close();
    process.exit(1);
  }
  const sw = serviceWorkers[0];

  // Forward service-worker console output to Node stdout so PHL decisions
  // (e.g. "[COS] Blocked: hash … not in Public Hash List") are visible.
  sw.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[COS]') || text.includes('PHL') || text.includes('hash')) {
      console.log(`  [sw] ${text}`);
    }
  });

  // Pre-seed PHL + PSL data. This must happen before any COS operation so
  // the in-memory init() reads our controlled data rather than hitting the network.
  console.log('Seeding extension storage (PHL + PSL)…');
  await seedStorage(sw);

  // Confirm the seeded values are actually visible to the service worker
  // before any COS call, so a lost race against onInstalled would surface here.
  const seeded = await sw.evaluate(async () => {
    const s = await chrome.storage.local.get(['publicHashListEnabled', 'phlHashSet']);
    return { enabled: s.publicHashListEnabled, phlCount: (s.phlHashSet || []).length };
  });
  console.log(`  PHL enabled: ${seeded.enabled}, hashes in mock PHL: ${seeded.phlCount}`);
  if (!seeded.enabled) {
    console.error('FAIL: publicHashListEnabled is false after seeding — onInstalled may have overwritten it');
    await context.close();
    server.close();
    process.exit(1);
  }

  // ── Phase 1: store all resources from a.test ────────────────────────────

  console.log('Storing test resources from a.test…');
  const pageA = await openOrigin(context, 'a.test');
  await storeResource(pageA, CONTENT.globalAllowed, '*');
  await storeResource(pageA, CONTENT.globalBlocked, '*');
  await storeResource(pageA, CONTENT.list, [`http://a.test:${PORT}`]);
  await storeResource(pageA, CONTENT.samesite, undefined);

  // ── Phase 2: open reader pages ──────────────────────────────────────────

  console.log('Opening reader pages…');
  const pageSubA = await openOrigin(context, 'sub.a.test');
  const pageB    = await openOrigin(context, 'b.test');

  // ── Phase 3: run read assertions ────────────────────────────────────────

  const results = [];
  function check(label, pass, detail = '') {
    results.push({ label, pass });
    console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail ? `\n      ${detail}` : ''}`);
  }

  console.log('\n── Scenario 1: origins: \'*\' (global) + PHL gate ───────────────────');

  // Hash IS in PHL → all three origins can read.
  const g1a = await readResource(pageA,    HASH.globalAllowed);
  const g1b = await readResource(pageSubA, HASH.globalAllowed);
  const g1c = await readResource(pageB,    HASH.globalAllowed);
  check('global (in PHL): a.test reads',     g1a.ok, g1a.error);
  check('global (in PHL): sub.a.test reads', g1b.ok, g1b.error);
  check('global (in PHL): b.test reads',     g1c.ok, g1c.error);

  // Hash NOT in PHL → all three origins are blocked.
  const g2a = await readResource(pageA,    HASH.globalBlocked);
  const g2b = await readResource(pageSubA, HASH.globalBlocked);
  const g2c = await readResource(pageB,    HASH.globalBlocked);
  check('global (not in PHL): a.test blocked',     !g2a.ok, g2a.ok ? 'expected block' : '');
  check('global (not in PHL): sub.a.test blocked', !g2b.ok, g2b.ok ? 'expected block' : '');
  check('global (not in PHL): b.test blocked',     !g2c.ok, g2c.ok ? 'expected block' : '');

  console.log('\n── Scenario 2: origins: [list] — PHL does not gate ────────────────');

  // Listed origin (a.test) can read; unlisted origins cannot. PHL is NOT consulted.
  const l1 = await readResource(pageA,    HASH.list);
  const l2 = await readResource(pageSubA, HASH.list);
  const l3 = await readResource(pageB,    HASH.list);
  check('list: a.test (listed) reads',        l1.ok,  l1.error);
  check('list: sub.a.test (unlisted) blocked', !l2.ok, l2.ok ? 'expected block' : '');
  check('list: b.test (unlisted) blocked',    !l3.ok,  l3.ok ? 'expected block' : '');

  console.log('\n── Scenario 3: origins omitted (same-site) — PHL does not gate ───');

  // a.test and sub.a.test are same-site → allowed; b.test is cross-site → blocked.
  const s1 = await readResource(pageA,    HASH.samesite);
  const s2 = await readResource(pageSubA, HASH.samesite);
  const s3 = await readResource(pageB,    HASH.samesite);
  check('same-site: a.test (storing origin) reads',      s1.ok,  s1.error);
  check('same-site: sub.a.test (same-site sibling) reads', s2.ok, s2.error);
  check('same-site: b.test (cross-site) blocked',        !s3.ok, s3.ok ? 'expected block' : '');

  // ── Summary ─────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n── PHL/Origins test results ${'─'.repeat(40)}`);
  console.log(`Total: ${results.length}  Passed: ${passed}  Failed: ${failed}`);

  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
