// Quick end-to-end test for the Cross-Origin Storage extension.
// Launches Chrome with the unpacked extension loaded, starts a local HTTP
// server for the docs/ directory, runs the main COS tests on the test page,
// and reports pass/fail.
//
// Usage: node e2e-test.mjs

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { extname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXT_PATH = __dirname;
const DOCS_PATH = join(__dirname, 'docs');
const PORT = 7474;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.bin':  'application/octet-stream',
  '.woff2':'font/woff2',
};

// Minimal static file server for docs/
function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filePath = join(DOCS_PATH, url.pathname === '/' ? 'test.html' : url.pathname);
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  console.log('Starting local server…');
  const server = await startServer();

  const userDataDir = await mkdtemp(join(tmpdir(), 'cos-e2e-'));
  console.log(`Loading extension from: ${EXT_PATH}`);
  // Use Playwright's bundled "Chrome for Testing" (not the system Chrome).
  // The system Google Chrome binary on managed machines blocks --load-extension.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // Playwright adds --disable-extensions by default; exclude it so our
    // extension can load.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Wait for the extension's service worker to spin up.
  await new Promise(r => setTimeout(r, 2000));

  const page = await context.newPage();
  console.log(`Navigating to http://localhost:${PORT}/test.html …`);
  await page.goto(`http://localhost:${PORT}/test.html`, { waitUntil: 'load' });

  // Wait a moment for the MAIN-world content script to inject.
  await new Promise(r => setTimeout(r, 1000));

  // Verify extension injected the API.
  const hasCOS = await page.evaluate(() => !!navigator.crossOriginStorage);
  if (!hasCOS) {
    console.error('FAIL: navigator.crossOriginStorage not found — extension not loaded.');
    await context.close();
    server.close();
    process.exit(1);
  }
  console.log('navigator.crossOriginStorage detected ✓');

  // Click "Run main tests" which runs main + singular tests.
  console.log('Running main tests…');
  await page.click('#run-main-tests');

  // Wait until all badges in both tables are no longer "pending" or "running".
  console.log('Waiting for results…');
  await page.waitForFunction(() => {
    const badges = [...document.querySelectorAll('#results .badge, #singular-results .badge')];
    return badges.length > 0 && badges.every(b => !b.textContent.match(/pending|running/));
  }, { timeout: 60_000 });

  // Collect results.
  const results = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#results tr[id], #singular-results tr[id]')];
    return rows.map(tr => ({
      label: tr.querySelector('td:nth-child(2)')?.textContent?.trim(),
      status: tr.querySelector('.badge')?.textContent?.trim(),
      detail: tr.querySelector('.detail')?.textContent?.trim(),
    }));
  });

  // Print summary.
  console.log('\n── Test Results ──────────────────────────────────────');
  let passed = 0, failed = 0;
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : '❌';
    console.log(`${icon} [${r.status}] ${r.label}`);
    if (r.status !== 'pass' && r.detail) console.log(`      ${r.detail.split('\n')[0]}`);
    r.status === 'pass' ? passed++ : failed++;
  }
  console.log(`─────────────────────────────────────────────────────`);
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
