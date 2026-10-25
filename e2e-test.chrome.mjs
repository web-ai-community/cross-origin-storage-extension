// End-to-end test for the Cross-Origin Storage extension.
//
// Launches Chrome with the unpacked extension, starts a local HTTP server,
// seeds a mock Public Hash List, Public Suffix List, and enables
// publicHashListEnabled, workerPatchEnabled, and fetchPatchEnabled, then drives test.html at
// http://a.test:PORT via a single "#run-all" click.  All test groups run:
//
//   • Main + singular tests
//   • Worker COS tests + worker variant tests (enabled via workerPatchEnabled)
//   • 3 GiB stress test
//   • Origins visibility tests (PHL-gated; enabled via publicHashListEnabled)
//   • Multi-origin PHL gate tests (iframes at sub.a.test and b.test)
//   • CSS tests
//   • Declarative HTML, JavaScript import attribute, and fetch integration tests
//
// It then drives test-legacy.html the same way, which covers the deprecated
// plural requestFileHandles() API and the deprecated requestFileHandle()
// alias of getFileHandle() (main thread + Worker). Finally, it opens
// popup.html and checks the Public Hash List badges on two stored resources.
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

// Same idea, for the JavaScript import attribute integration tests'
// cross-origin global-visibility check -- must match
// IMPORT_ATTR_XORIGIN_GLOBAL_CONTENT in docs/test.html.
const IMPORT_ATTR_XORIGIN_GLOBAL_CONTENT = 'export default "js-xorigin-global-value";';

// Same idea again, for the fetch integration tests' cross-origin
// global-visibility check -- must match FETCH_XORIGIN_GLOBAL_CONTENT in
// docs/test.html.
const FETCH_XORIGIN_GLOBAL_CONTENT = 'fetch-xorigin-global-value';

// Only the globalAllowed/declarative-global hashes go into the mock PHL.
const MOCK_PHL_HASHES = [
  sha256Hex(MOPHL_CONTENT.globalAllowed),
  sha256Hex(DECL_XORIGIN_GLOBAL_CSS),
  sha256Hex(IMPORT_ATTR_XORIGIN_GLOBAL_CONTENT),
  sha256Hex(FETCH_XORIGIN_GLOBAL_CONTENT),
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
  '.txt':  'text/plain',
  '.wasm': 'application/wasm',
};

const CEILING = ['a.test', 'b.test', 'sub.a.test', 'sub.b.test', 'c.test']
  .map((host) => `http://${host}:${PORT}`)
  .concat('https://example.com')
  .join(', ');

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      // Every page may list every test origin, the way a site authorizes its
      // partners, unless the request asks for no header (?noceiling).
      if (!url.searchParams.has('noceiling')) {
        res.setHeader('Cross-Origin-Storage-Allow-Origin', CEILING);
      }
      // An empty page for the top-level-site keying tests to frame.
      if (url.pathname === '/blank.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>blank</title>');
        return;
      }
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
        fetchPatchEnabled:     true,
        pslExact,
        pslWildcard:           [],
        pslException:          [],
        pslFetchedAt:          Date.now(),
      });
    },
    [MOCK_PHL_HASHES, MOCK_PSL_EXACT]
  );
}

// ── Test-page runner ────────────────────────────────────────────────────────

// Clicks #run-all on an already-navigated `page`, waits for every badge
// under `resultIds` to leave pending/running, then collects each row's
// label/status/detail. Shared by test.html and test-legacy.html since both
// pages use the same "table of rows with a badge + Run button" convention.
async function runAllAndCollect(page, resultIds) {
  await page.click('#run-all');

  const badgeSel = resultIds.map(id => `#${id} .badge`).join(', ');
  // Timeout: 30 minutes to accommodate the large stress test on test.html.
  // NOTE: Playwright's waitForFunction(fn, arg?, options?) — pass the
  // selector as arg so the options object lands in the correct (third)
  // position.
  await page.waitForFunction((sel) => {
    const badges = [...document.querySelectorAll(sel)];
    return badges.length > 0 && badges.every(b => !b.textContent.match(/pending|running/));
  }, badgeSel, { timeout: 1_800_000 });

  const rowSel = resultIds.map(id => `#${id} tr[id]`).join(', ');
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map(tr => ({
      label:  tr.querySelector('td:nth-child(2)')?.textContent?.trim(),
      status: tr.querySelector('.badge')?.textContent?.trim(),
      detail: tr.querySelector('.detail')?.textContent?.trim(),
    }));
  }, rowSel);
}

// ── Manifest guard ──────────────────────────────────────────────────────────

// The unpacked extension is loaded from this directory, so the suite runs
// against whatever manifest.json currently is -- a copy of one of the
// per-browser manifests, swapped by `npm run use-{chrome,firefox,safari}`.
// Firefox and Safari declare a background *page* rather than a service worker,
// which Chromium refuses to load; that surfaces several steps later as
// "extension service worker not found", a failure whose cause is nowhere near
// its symptom. `npm test` runs `use-chrome` first, but this catches the paths
// that skip it -- invoking this file directly, or `npm test --ignore-scripts`.
async function assertChromeManifest() {
  const manifestPath = join(__dirname, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`FAIL: could not read ${manifestPath} — ${err.message}`);
    process.exit(1);
  }
  if (manifest.background?.service_worker) return;

  const found = Object.keys(manifest.background ?? {}).join(', ') || '<no background key>';

  // Name the browser whose manifest this is, when it matches one exactly, so
  // the message says which `use-*` was left behind rather than just "wrong".
  let flavour = null;
  for (const browser of ['firefox', 'safari']) {
    try {
      const other = JSON.parse(
        await readFile(join(__dirname, `manifest.${browser}.json`), 'utf8')
      );
      if (JSON.stringify(other) === JSON.stringify(manifest)) {
        flavour = browser;
        break;
      }
    } catch {
      // A missing or unreadable sibling manifest just means no name to report.
    }
  }
  const what = flavour
    ? `manifest.json is the ${flavour} manifest (background: ${found}), not the Chrome one.`
    : `manifest.json is not the Chrome manifest (background: ${found}).`;
  console.error(
    `FAIL: ${what}\n` +
    `      This suite loads the unpacked extension from ${__dirname}, and Chromium\n` +
    `      cannot load a manifest declaring a background page instead of a service worker.\n` +
    `      Fix: npm run use-chrome`
  );
  process.exit(1);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await assertChromeManifest();

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
      `--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1,MAP sub.a.test 127.0.0.1,MAP sub.b.test 127.0.0.1,MAP c.test 127.0.0.1`,
      // Mark the test origins as secure so crypto.subtle etc. are
      // available (required by test.html's sha256Hex helper).
      `--unsafely-treat-insecure-origin-as-secure=http://a.test:${PORT},http://b.test:${PORT},http://sub.a.test:${PORT},http://sub.b.test:${PORT},http://c.test:${PORT}`,
    ],
  });

  // Safety net: intercept any accidental PHL / PSL network refreshes so
  // _maybeRefreshInBackground() cannot overwrite the seeded mock data.
  const MOCK_PHL_BODY = `// VERSION: test-v1\n// ===BEGIN SHA-256===\n${MOCK_PHL_HASHES.join('\n')}\n// ===END SHA-256===\n`;
  await context.route('https://media.githubusercontent.com/media/WICG/cross-origin-storage/**', route => {
    const url = route.request().url();
    if (url.endsWith('.sha256')) {
      return route.fulfill({
        status:      200,
        contentType: 'text/plain',
        body:        `${sha256Hex(MOCK_PHL_BODY)}  public-hash-list.dat\n`,
      });
    }
    return route.fulfill({ status: 200, contentType: 'text/plain', body: MOCK_PHL_BODY });
  });
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
  // worker variants, stress (3 GiB), origins, MOPHL, CSS, declarative HTML,
  // import attribute, fetch.
  console.log('\nRunning all tests (this may take ~10–15 min for the 3 GiB stress test)…');
  const results = await runAllAndCollect(page, [
    'results',
    'worker-results',
    'variant-results',
    'stress-results',
    'origins-results',
    'mophl-results',
    'css-results',
    'declarative-results',
    'import-attribute-results',
    'fetch-results',
  ]);
  await page.close();

  // ── test-legacy.html: deprecated requestFileHandles() and requestFileHandle() ─

  const legacyPage = await context.newPage();
  console.log(`\nNavigating to http://a.test:${PORT}/test-legacy.html …`);
  await legacyPage.goto(`http://a.test:${PORT}/test-legacy.html`, { waitUntil: 'load' });
  legacyPage.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.error(text);
    } else {
      console.log(text);
    }
  });
  console.log('Running legacy API tests…');
  const legacyResults = (
    await runAllAndCollect(legacyPage, ['results', 'worker-results'])
  ).map(r => ({ ...r, label: `[Legacy] ${r.label}` }));
  await legacyPage.close();

  // ── popup.html: Public Hash List badges ───────────────────────────────────

  // The MOPHL tests above stored both of these; only globalAllowed is on the
  // mock PHL. Search for each in the popup and read its badge.
  console.log('\nChecking Public Hash List badges in the popup…');
  const extensionId = new URL(sw.url()).host;
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
  const popupResults = [];
  for (const [key, expected] of [['globalAllowed', 'On PHL'], ['globalBlocked', 'Not on PHL']]) {
    const hash = sha256Hex(MOPHL_CONTENT[key]);
    const label = `[Popup] ${key} resource shows "${expected}" badge`;
    try {
      await popupPage.fill('#hash-search', hash);
      const badge = popupPage.locator(`#hash-search-result li[title="Hash: ${hash}"] .resource-phl-badge`);
      await badge.waitFor({ timeout: 10_000 });
      const actual = (await badge.textContent()).trim();
      popupResults.push({
        label,
        status: actual === expected ? 'pass' : 'fail',
        detail: `badge text: ${actual}`,
      });
    } catch (err) {
      popupResults.push({ label, status: 'fail', detail: err.message });
    }
  }
  // The "On PHL" / "Not on PHL" filter chips, which need resources listed
  // under an origin (the search panel above doesn't use them).
  await popupPage.fill('#hash-search', '');
  // Each chip is a <label> around a visually hidden radio, so click the label:
  // the radio itself isn't clickable. The label text carries the count too,
  // hence matching on its leading text.
  for (const [chip, expected] of [[/^On PHL/, 'On PHL'], [/^Not on PHL/, 'Not on PHL']]) {
    const label = `[Popup] "${expected}" filter shows only ${expected} resources`;
    try {
      const option = popupPage.locator('#mime-filter label', { hasText: chip });
      await option.waitFor({ timeout: 10_000 });
      await option.click();
      await popupPage.waitForFunction(
        (want) => {
          const items = [...document.querySelectorAll('#hashes-list .resource-item')];
          return items.length > 0 && items.every(
            (li) => li.querySelector('.resource-phl-badge')?.textContent === want
          );
        },
        expected,
        { timeout: 10_000 }
      );
      const shown = await popupPage.locator('#hashes-list .resource-item').count();
      popupResults.push({ label, status: 'pass', detail: `${shown} resource(s) shown` });
      await popupPage.locator('#mime-filter label', { hasText: /^All/ }).click(); // No filter.
    } catch (err) {
      popupResults.push({ label, status: 'fail', detail: err.message.split('\n')[0] });
    }
  }
  await popupPage.close();

  // ── Concurrent record updates ─────────────────────────────────────────────

  // Many requests at once, the way a page loading many COS resources sends
  // them, must each leave their mark in the stored records. Handlers used to
  // reload the records from storage mid-flight, which dropped other
  // handlers' unsaved changes: hit counts, sizes, and visibility.
  console.log('\nChecking records under concurrent requests…');
  const concurrencyResults = [];
  {
    const label = '[Records] 20 concurrent stores and 60 concurrent hits are all recorded';
    const COUNT = 20;
    const READS = 3;
    const bodies = Array.from({ length: COUNT }, (_, i) => `concurrent record ${i} ${Date.now()}`);
    const page = await context.newPage();
    try {
      await page.goto(`http://a.test:${PORT}/test-legacy.html`, { waitUntil: 'load' });
      await page.evaluate(async ({ bodies, reads }) => {
        const hashOf = async (text) =>
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        const hashes = await Promise.all(bodies.map(hashOf));
        await Promise.all(
          hashes.map(async (value, i) => {
            const handle = await navigator.crossOriginStorage.getFileHandle(
              { algorithm: 'SHA-256', value },
              { create: true, origins: '*' }
            );
            const writable = await handle.createWritable();
            await writable.write(new Blob([bodies[i]]));
            await writable.close();
          })
        );
        await Promise.all(
          hashes.flatMap((value) =>
            Array.from({ length: reads }, () =>
              navigator.crossOriginStorage.getFileHandle({ algorithm: 'SHA-256', value })
            )
          )
        );
      }, { bodies, reads: READS });
      // Saves are asynchronous; give the last one a moment to land.
      await new Promise((r) => setTimeout(r, 1000));
      const records = await sw.evaluate(
        async () => (await chrome.storage.local.get('resourceManagerData')).resourceManagerData
      );
      const problems = [];
      bodies.forEach((body, i) => {
        const hash = sha256Hex(body);
        if (records.hashToHitCount?.[hash] !== READS) {
          problems.push(`#${i}: ${records.hashToHitCount?.[hash] ?? 0} hits`);
        }
        if (records.hashToSize?.[hash] !== Buffer.byteLength(body)) {
          problems.push(`#${i}: size ${records.hashToSize?.[hash]}`);
        }
        if (records.hashToGlobal?.[hash] !== true) {
          problems.push(`#${i}: global grant ${JSON.stringify(records.hashToGlobal?.[hash])}`);
        }
      });
      concurrencyResults.push({
        label,
        status: problems.length ? 'fail' : 'pass',
        detail: problems.length
          ? `Lost updates (expected ${READS} hits, the size, and '*' each): ${problems.join(', ')}`
          : `${COUNT} resources, each with ${READS} hits, its size, and '*' visibility`,
      });
    } catch (err) {
      concurrencyResults.push({ label, status: 'fail', detail: err.message.split('\n')[0] });
    }
    await page.close();
  }

  // ── No records without bytes ──────────────────────────────────────────────

  // A create request that's never written, or one written with no bytes,
  // must leave neither a cache entry nor a record. Earlier versions recorded
  // the access at create time, which showed up as empty resources.
  console.log('\nChecking that unwritten and empty files leave nothing behind…');
  const emptyResults = [];
  {
    const unwritten = `never written ${Date.now()}`;
    const EMPTY_HASH = sha256Hex('');
    const page = await context.newPage();
    try {
      await page.goto(`http://a.test:${PORT}/test-legacy.html`, { waitUntil: 'load' });
      const emptyError = await page.evaluate(async ({ unwritten, emptyHash }) => {
        const hashOf = async (text) =>
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        await navigator.crossOriginStorage.getFileHandle(
          { algorithm: 'SHA-256', value: await hashOf(unwritten) },
          { create: true }
        );
        const handle = await navigator.crossOriginStorage.getFileHandle(
          { algorithm: 'SHA-256', value: emptyHash },
          { create: true }
        );
        const writable = await handle.createWritable();
        try {
          await writable.close();
          return null;
        } catch (err) {
          return err.name;
        }
      }, { unwritten, emptyHash: EMPTY_HASH });
      await new Promise((r) => setTimeout(r, 1000));
      const { records, cached } = await sw.evaluate(async (hashes) => {
        const cache = await caches.open('cos-storage');
        const cached = [];
        for (const hash of hashes) {
          if (await cache.match(`https://cos.example.com/SHA-256_${hash}`)) cached.push(hash);
        }
        return {
          records: (await chrome.storage.local.get('resourceManagerData')).resourceManagerData,
          cached,
        };
      }, [sha256Hex(unwritten), EMPTY_HASH]);
      const recorded = (hash) =>
        !!(records.hashToOrigins?.[hash] || hash in (records.hashToSize ?? {}));
      for (const [label, hash, extra] of [
        ['A create request without a write leaves no record', sha256Hex(unwritten), null],
        [
          'An empty file is rejected with a DataError and leaves no record',
          EMPTY_HASH,
          emptyError === 'DataError' ? null : `close() gave ${emptyError ?? 'no error'}`,
        ],
      ]) {
        const problems = [
          extra,
          recorded(hash) && 'a record exists',
          cached.includes(hash) && 'a cache entry exists',
        ].filter(Boolean);
        emptyResults.push({
          label: `[Empty] ${label}`,
          status: problems.length ? 'fail' : 'pass',
          detail: problems.length ? problems.join(', ') : 'nothing stored or recorded',
        });
      }
    } catch (err) {
      emptyResults.push({ label: '[Empty] setup', status: 'fail', detail: err.message.split('\n')[0] });
    }
    await page.close();
  }

  // ── Grants keyed to the top-level site ─────────────────────────────────────

  // A storing grant, and a list grant, only count under the top-level site
  // they were written under, so a frame embedded on two sites can't carry an
  // identifier between them. A create request grants nothing until its bytes
  // arrive. https://wicg.github.io/cross-origin-storage/#cos-entries
  console.log('\nChecking that grants are keyed to the top-level site…');
  const keyingResults = [];
  const at = (host) => `http://${host}:${PORT}`;
  const B = at('b.test');

  // Opens `host` top-level, optionally with a b.test frame, and returns the
  // frame to run in: the b.test frame if there is one, else the page.
  const contexts = [];
  async function open(host, { frameB = false, query = '' } = {}) {
    const p = await context.newPage();
    contexts.push(p);
    await p.goto(`${at(host)}/blank.html${query}`, { waitUntil: 'load' });
    if (!frameB) {
      await p.waitForFunction(() => !!navigator.crossOriginStorage);
      return p.mainFrame();
    }
    await p.evaluate((src) => new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.allow = 'cross-origin-storage';
      f.src = src;
      f.onload = resolve;
      document.body.append(f);
    }), `${B}/blank.html`);
    const frame = p.frames().find((f) => f.url().startsWith(B));
    await frame.waitForFunction(() => !!navigator.crossOriginStorage);
    return frame;
  }
  const write = (frame, text, options = {}) =>
    frame.evaluate(async ({ text, options }) => {
      const bytes = new TextEncoder().encode(text);
      const value = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const handle = await navigator.crossOriginStorage.getFileHandle(
        { algorithm: 'SHA-256', value }, { create: true, ...options });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }, { text, options });
  // Resolves to the stored text, or to the name of the error a read threw.
  const read = (frame, text) =>
    frame.evaluate(async (text) => {
      const bytes = new TextEncoder().encode(text);
      const value = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      try {
        const handle = await navigator.crossOriginStorage.getFileHandle(
          { algorithm: 'SHA-256', value });
        return await (await handle.getFile()).text();
      } catch (err) {
        return err.name;
      }
    }, text);
  async function check(label, text, frame, expectRead) {
    try {
      const got = await read(frame, text);
      const want = expectRead ? text : 'NotFoundError';
      keyingResults.push({
        label: `[Keying] ${label}`,
        status: got === want ? 'pass' : 'fail',
        detail: `expected ${expectRead ? 'the stored bytes' : 'NotFoundError'}, got ${JSON.stringify(got)}`,
      });
    } catch (err) {
      keyingResults.push({ label: `[Keying] ${label}`, status: 'fail', detail: err.message.split('\n')[0] });
    }
  }

  try {
    const stamp = Date.now();
    const marker = `frame marker ${stamp}`;
    const frameOnA = await open('a.test', { frameB: true });
    await write(frameOnA, marker);
    await check('b.test frame on a.test reads back what it wrote there', marker, frameOnA, true);
    const frameOnC = await open('c.test', { frameB: true });
    await check('b.test frame on c.test cannot read what it wrote on a.test', marker, frameOnC, false);
    const topB = await open('b.test');
    await check('b.test top-level cannot read what its frame wrote on a.test', marker, topB, false);

    const firstParty = `first-party ${stamp}`;
    await write(topB, firstParty);
    await check('b.test frame on c.test cannot read what b.test wrote top-level', firstParty, frameOnC, false);
    const topA = await open('a.test');
    await topA.evaluate(async (text) => {
      const bytes = new TextEncoder().encode(text);
      const value = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      await navigator.crossOriginStorage.getFileHandle(
        { algorithm: 'SHA-256', value }, { create: true });
    }, firstParty);
    await check('a.test cannot read an entry after a create request with no bytes', firstParty, topA, false);

    const listed = `listed ${stamp}`;
    await write(topA, listed, { origins: [B] });
    await check('list [b.test] from a.test: b.test top-level reads', listed, topB, true);
    const topSubB = await open('sub.b.test');
    await check('list [b.test] from a.test: sub.b.test (same-site) reads', listed, topSubB, true);
    await check('list [b.test] from a.test: b.test frame on a.test reads', listed, frameOnA, true);
    await check('list [b.test] from a.test: b.test frame on c.test cannot read', listed, frameOnC, false);

    const upgraded = `listed then global ${stamp}`;
    await write(topA, upgraded, { origins: [B] });
    await write(topA, upgraded, { origins: '*' });
    await check('list [b.test] survives a later "*" write for a hash off the PHL', upgraded, topB, true);

    const unauthorized = `listed without a header ${stamp}`;
    const topANoCeiling = await open('a.test', { query: '?noceiling' });
    await write(topANoCeiling, unauthorized, { origins: [B] });
    await check('a list the document\'s Cross-Origin-Storage-Allow-Origin does not authorize is dropped', unauthorized, topB, false);

    const selfListed = `frame lists itself ${stamp}`;
    await write(frameOnA, selfListed, { origins: [B] });
    await check('a list a b.test frame wrote on a.test does not reach b.test top-level', selfListed, topB, false);
  } catch (err) {
    keyingResults.push({ label: '[Keying] setup', status: 'fail', detail: err.message.split('\n')[0] });
  }
  for (const p of contexts) await p.close();

  // ── Collect + report all results ──────────────────────────────────────────

  console.log('\n── Test Results ──────────────────────────────────────');
  let passed = 0, failed = 0;
  for (const r of [...results, ...legacyResults, ...popupResults, ...concurrencyResults, ...emptyResults, ...keyingResults]) {
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
