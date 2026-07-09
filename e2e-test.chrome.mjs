// End-to-end test for the Cross-Origin Storage extension.
//
// Launches Chrome with the unpacked extension, starts a local HTTP server,
// seeds a mock Public Hash List, Public Suffix List, and enables both
// publicHashListEnabled and workerPatchEnabled, then drives test.html at
// http://a.test:PORT via a single "#run-all" click.  All test groups run:
//
//   • Main + singular tests
//   • Worker COS tests + worker variant tests (enabled via workerPatchEnabled)
//   • 3 GiB stress test
//   • Origins visibility tests (PHL-gated; enabled via publicHashListEnabled)
//   • Multi-origin PHL gate tests (iframes at sub.a.test and b.test)
//   • CSS tests
//
// The .test hostnames are mapped to 127.0.0.1 via --host-resolver-rules so
// the single local server answers for all three fake-TLD origins.
//
// Usage: node e2e-test.mjs

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
const PORT = 7474;

// ── Mock PHL / PSL ─────────────────────────────────────────────────────────

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Predetermined content strings — must match MOPHL_CONTENT in docs/test.html.
const MOPHL_CONTENT = {
  globalAllowed: 'phl-e2e-global-allowed',
  globalBlocked: 'phl-e2e-global-blocked',
  list:          'phl-e2e-list',
  samesite:      'phl-e2e-samesite',
  storerBypass:  'phl-e2e-storer-bypass',
};

// Content stored (via the JS API) by the declarative HTML integration tests'
// cross-origin global-visibility check -- must match DECL_XORIGIN_GLOBAL_CSS
// in docs/test.html. Needs a PHL entry because it's a 'global' (origins: '*')
// resource read by a non-storer origin (b.test), same as MOPHL_CONTENT.globalAllowed.
const DECL_XORIGIN_GLOBAL_CSS =
  '#cos-decl-xorigin-marker { color: rgb(1, 2, 3); } /* xorigin-global */';

// Same idea, for the declarative JavaScript integration tests' cross-origin
// global-visibility check -- must match DECL_JS_XORIGIN_GLOBAL_CONTENT in
// docs/test.html.
const DECL_JS_XORIGIN_GLOBAL_CONTENT = 'export default "js-xorigin-global-value";';

// Only the globalAllowed/declarative-global hashes go into the mock PHL.
const MOCK_PHL_HASHES = [
  sha256Hex(MOPHL_CONTENT.globalAllowed),
  sha256Hex(DECL_XORIGIN_GLOBAL_CSS),
  sha256Hex(DECL_JS_XORIGIN_GLOBAL_CONTENT),
];

// Mock PSL: 'test' as the sole extra TLD so a.test and b.test are separate
// eTLD+1 domains, and sub.a.test is same-site as a.test.
const MOCK_PSL_EXACT = ['test'];

// ── Local HTTP server ───────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.bin':  'application/octet-stream',
  '.woff2':'font/woff2',
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

// ── PHL + PSL storage seeder ────────────────────────────────────────────────

async function seedStorage(sw) {
  await sw.evaluate(
    async ([phlHashes, pslExact]) => {
      await chrome.storage.local.set({
        phlHashSet:            phlHashes,
        phlFetchedAt:          Date.now(),
        phlVersion:            'test-v1',
        publicHashListEnabled: true,
        workerPatchEnabled:    true,
        pslExact,
        pslWildcard:           [],
        pslException:          [],
        pslFetchedAt:          Date.now(),
      });
    },
    [MOCK_PHL_HASHES, MOCK_PSL_EXACT]
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting local server…');
  const server = await startServer();

  const userDataDir = await mkdtemp(join(tmpdir(), 'cos-e2e-'));
  console.log(`Loading extension from: ${EXT_PATH}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Route .test hostnames to the local server so the extension's
      // content script is injected and COS calls reach the right origin.
      `--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1,MAP sub.a.test 127.0.0.1`,
      // Mark the three test origins as secure so crypto.subtle etc. are
      // available (required by test.html's sha256Hex helper).
      `--unsafely-treat-insecure-origin-as-secure=http://a.test:${PORT},http://b.test:${PORT},http://sub.a.test:${PORT}`,
    ],
  });

  // Safety net: intercept any accidental PHL / PSL network refreshes so
  // _maybeRefreshInBackground() cannot overwrite the seeded mock data.
  await context.route('https://raw.githubusercontent.com/tomayac/public-hash-list/**', route =>
    route.fulfill({
      status:      200,
      contentType: 'text/plain',
      body:        `// VERSION: test-v1\n// ===BEGIN SHA-256===\n${MOCK_PHL_HASHES.join('\n')}\n// ===END SHA-256===\n`,
    })
  );
  await context.route('https://raw.githubusercontent.com/publicsuffix/list/**', route =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'test\n' })
  );

  // Wait for the extension service worker to spin up.
  await new Promise(r => setTimeout(r, 2000));

  const serviceWorkers = context.serviceWorkers();
  if (!serviceWorkers.length) {
    console.error('FAIL: extension service worker not found');
    await context.close();
    server.close();
    process.exit(1);
  }
  const sw = serviceWorkers[0];

  // Seed PHL + PSL before any page loads so the in-memory init() picks up
  // the mock data rather than hitting the network.
  console.log('Seeding extension storage (PHL + PSL)…');
  await seedStorage(sw);

  const seeded = await sw.evaluate(async () => {
    const s = await chrome.storage.local.get(['publicHashListEnabled', 'phlHashSet']);
    return { enabled: s.publicHashListEnabled, count: (s.phlHashSet || []).length };
  });
  console.log(`  PHL enabled: ${seeded.enabled}, hashes seeded: ${seeded.count}`);
  if (!seeded.enabled) {
    console.error('FAIL: publicHashListEnabled is false after seeding');
    await context.close();
    server.close();
    process.exit(1);
  }

  // Navigate to test.html at a.test so the MOPHL tests detect the
  // multi-origin setup (location.hostname === 'a.test').
  const page = await context.newPage();
  console.log(`Navigating to http://a.test:${PORT}/test.html …`);
  await page.goto(`http://a.test:${PORT}/test.html`, { waitUntil: 'load' });

  // Wait long enough for both async probes on the page to complete:
  //   • probePhlEnabled()   – 1.5 s timeout
  //   • probeWorkerCOS()    – polls up to 2 s, 5 s total timeout
  // 7 s gives a comfortable margin before we click "Run all tests".
  await new Promise(r => setTimeout(r, 7000));

  const hasCOS = await page.evaluate(() => !!navigator.crossOriginStorage);
  if (!hasCOS) {
    console.error('FAIL: navigator.crossOriginStorage not found — extension not loaded.');
    await context.close();
    server.close();
    process.exit(1);
  }
  console.log('navigator.crossOriginStorage detected ✓');

  // Forward browser console to Node stdout so test results stream in real time.
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.error(text);
    } else {
      console.log(text);
    }
  });

  // Single click runs every test group in sequence: main + singular, worker,
  // worker variants, stress (3 GiB), origins, MOPHL, CSS, declarative HTML.
  console.log('\nRunning all tests (this may take ~10–15 min for the 3 GiB stress test)…');
  await page.click('#run-all');

  // Wait for every badge in every result table to leave pending/running state.
  // Timeout: 30 minutes to accommodate the large stress test.
  // NOTE: Playwright's waitForFunction(fn, arg?, options?) — pass null as arg
  // so the options object is received in the correct (third) position.
  await page.waitForFunction(() => {
    const sel = [
      '#results .badge',
      '#worker-results .badge',
      '#variant-results .badge',
      '#stress-results .badge',
      '#origins-results .badge',
      '#mophl-results .badge',
      '#css-results .badge',
      '#declarative-results .badge',
      '#declarative-js-results .badge',
    ].join(', ');
    const badges = [...document.querySelectorAll(sel)];
    return badges.length > 0 && badges.every(b => !b.textContent.match(/pending|running/));
  }, null, { timeout: 1_800_000 });

  // ── Collect + report all results ──────────────────────────────────────────

  const results = await page.evaluate(() => {
    const selector = [
      '#results tr[id]',
      '#worker-results tr[id]',
      '#variant-results tr[id]',
      '#stress-results tr[id]',
      '#origins-results tr[id]',
      '#mophl-results tr[id]',
      '#css-results tr[id]',
      '#declarative-results tr[id]',
      '#declarative-js-results tr[id]',
    ].join(', ');
    return [...document.querySelectorAll(selector)].map(tr => ({
      label:  tr.querySelector('td:nth-child(2)')?.textContent?.trim(),
      status: tr.querySelector('.badge')?.textContent?.trim(),
      detail: tr.querySelector('.detail')?.textContent?.trim(),
    }));
  });

  console.log('\n── Test Results ──────────────────────────────────────');
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'n/a') continue;
    const icon = r.status === 'pass' ? '✅' : '❌';
    console.log(`${icon} [${r.status}] ${r.label}`);
    if (r.status !== 'pass' && r.detail) console.log(`      ${r.detail.split('\n')[0]}`);
    r.status === 'pass' ? passed++ : failed++;
  }
  console.log('─────────────────────────────────────────────────────');
  console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);

  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
