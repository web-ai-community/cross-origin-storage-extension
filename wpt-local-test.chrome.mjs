// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Runs the Cross-Origin Storage web platform tests against the extension from
// a local web-platform-tests checkout served by `wpt serve`, for when the
// cos-wpt runner (see wpt-test.chrome.mjs) can't be reached, or to run a
// branch of the tests that isn't pushed yet.
//
// Setup, once:
//   git clone https://github.com/web-platform-tests/wpt && cd wpt
//   git fetch origin pull/61811/head && git checkout FETCH_HEAD
//   ./wpt make-hosts-file | sudo tee -a /etc/hosts
// Then, in the checkout:
//   ./wpt serve
//
// Usage:
//   node wpt-local-test.chrome.mjs --wpt <checkout>                  # every test
//   node wpt-local-test.chrome.mjs --wpt <checkout> --filter budget  # by name
//   node wpt-local-test.chrome.mjs --wpt <checkout> --limits default # real budgets
//
// Each test file is loaded as its own top-level page, so each runs under its
// own top-level site the way wptrunner runs it. The page is clicked as soon as
// it loads, the way a user would interact with it, so that "*" writes become
// visible to other sites (see the user-interaction mitigation in
// privacy-mitigations.js). The suite makes far more cross-site lookups and
// writes from one site than the default budgets allow, as Chrome's own WPT
// runs would, so it raises them unless `--limits default` is passed. GREASE'ing
// stays on: the tests allow for it. The Public Hash List is a mock that lists
// the one resource the tests rely on, resources/phl-listed-resource.js.
//
// Results are compared with wpt-expectations.json like wpt-test.chrome.mjs
// does, except that results the expectations list as a cos-wpt limitation
// aren't reported when they pass here. The full results go to
// $TMPDIR/cos-wpt-local-results.json.

import { chromium } from 'playwright';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXT_PATH = __dirname;
const EXPECTATIONS_PATH = join(__dirname, 'wpt-expectations.json');

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const wptDir = arg('--wpt');
const filter = arg('--filter') ?? '';
const defaultLimits = arg('--limits') === 'default';
const origin = arg('--origin') ?? 'https://web-platform.test:8443';
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
// A file that never reports finishes as a timeout after this long.
const TEST_TIMEOUT_MS = 180_000;

// The digest of resources/phl-listed-resource.js (jQuery 3.7.1, minified).
const PHL_LISTED = 'fc9a93dd241f6b045cbff0481cf4e1901becd0e12fb45166a8f17f95823f0b1a';

const SUITE_LIMITS = {
  lookupBudget: 1e9,
  writeFiles: 1e9,
  writeBytes: 1e15,
  siteBytes: 1e15,
};

// Collected by the report script appended to testharnessreport.js.
const REPORTER = `
add_completion_callback((tests, status) => {
  window.__cosWptResults = {
    status: status.status,
    message: status.message,
    tests: tests.map((t) => ({ name: t.name, status: t.status, message: t.message })),
  };
});
`;
const TEST_STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
const HARNESS_STATUS = ['pass', 'error', 'timeout', 'precondition_failed'];

// The test URLs of the suite: every .html test, and the wrapper documents
// wptserve generates for every .any.js and .window.js file, one per global.
async function listTests() {
  const root = join(wptDir, 'cross-origin-storage');
  const urls = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'resources') await walk(path);
        continue;
      }
      const rel = relative(wptDir, path);
      if (entry.name.endsWith('.html')) {
        urls.push(rel);
      } else if (entry.name.endsWith('.window.js')) {
        urls.push(rel.replace(/\.js$/, '.html'));
      } else if (entry.name.endsWith('.any.js')) {
        const source = await readFile(path, 'utf8');
        const meta = /\/\/ META: global=(.*)/.exec(source)?.[1] ?? 'window,dedicatedworker';
        const globals = new Set();
        for (const g of meta.split(',').map((s) => s.trim())) {
          if (g === 'worker')
            ['dedicatedworker', 'sharedworker', 'serviceworker'].forEach((w) => globals.add(w));
          else globals.add(g);
        }
        const base = rel.replace(/\.js$/, '');
        const suffix = {
          window: '.html',
          dedicatedworker: '.worker.html',
          sharedworker: '.sharedworker.html',
          serviceworker: '.serviceworker.html',
        };
        for (const g of globals) if (suffix[g]) urls.push(base + suffix[g]);
      }
    }
  };
  await walk(root);
  return urls.sort().filter((url) => url.includes(filter));
}

async function runTest(context, path) {
  const page = await context.newPage();
  try {
    const url = new URL(`/${path}`, origin).href;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.mouse.click(1, 1).catch(() => {});
    const handle = await page.waitForFunction(() => window.__cosWptResults, null, {
      timeout: TEST_TIMEOUT_MS,
      polling: 500,
    });
    const raw = await handle.jsonValue();
    return {
      test: path,
      status:
        HARNESS_STATUS[raw.status] === 'pass'
          ? raw.tests.every((t) => t.status === 0)
            ? 'pass'
            : 'fail'
          : HARNESS_STATUS[raw.status],
      message: raw.message,
      subtests: raw.tests.map((t) => ({
        name: t.name,
        status: TEST_STATUS[t.status],
        message: t.message,
      })),
    };
  } catch (err) {
    return { test: path, status: 'timeout', message: err.message.split('\n')[0], subtests: [] };
  } finally {
    // Popups the test opened go with it.
    for (const p of context.pages()) await p.close().catch(() => {});
  }
}

async function main() {
  if (!wptDir) throw new Error('Pass --wpt <path to a web-platform-tests checkout>.');
  const manifest = JSON.parse(await readFile(join(__dirname, 'manifest.json'), 'utf8'));
  if (manifest.background?.service_worker === undefined) {
    throw new Error('manifest.json is not the Chrome manifest; run `npm run use-chrome` first.');
  }
  const tests = await listTests();
  console.log(`${tests.length} test files.`);

  const userDataDir = await mkdtemp(join(tmpdir(), 'cos-wpt-local-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    ignoreHTTPSErrors: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
    ],
    // wptserve's hosts resolve through /etc/hosts, never through a proxy.
    ...(proxy && { proxy: { server: proxy, bypass: '*.test' } }),
  });

  // A mock Public Hash List, so the run doesn't download the real one.
  const phlBody = `// VERSION: wpt-local\n// ===BEGIN SHA-256===\n${PHL_LISTED}\n// ===END SHA-256===\n`;
  await context.route(
    'https://media.githubusercontent.com/media/WICG/cross-origin-storage/**',
    (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: phlBody }),
  );
  // Read from the checkout, since wptserve serves it unchanged.
  const harnessReport = await readFile(join(wptDir, 'resources', 'testharnessreport.js'), 'utf8');
  await context.route('**/resources/testharnessreport.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: `${harnessReport}\n${REPORTER}` }),
  );

  try {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
    await sw.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const { workerPatchEnabled } = await chrome.storage.local.get('workerPatchEnabled');
        if (workerPatchEnabled !== undefined) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    await sw.evaluate(
      async ([hash, limits]) => {
        await chrome.storage.local.set({
          phlHashSet: [hash],
          phlFetchedAt: Date.now(),
          phlVersion: 'wpt-local',
          publicHashListEnabled: true,
          workerPatchEnabled: true,
          fetchPatchEnabled: true,
          mitigationLimits: limits,
        });
      },
      [PHL_LISTED, defaultLimits ? {} : SUITE_LIMITS],
    );

    const results = [];
    for (const [i, test] of tests.entries()) {
      const started = Date.now();
      const result = await runTest(context, test);
      results.push(result);
      const failed = result.subtests.filter((s) => s.status !== 'PASS').length;
      console.log(
        `[${i + 1}/${tests.length}] ${result.status.padEnd(7)} ${test} ` +
          `(${result.subtests.length - failed}/${result.subtests.length}, ${Math.round((Date.now() - started) / 1000)} s)`,
      );
    }
    const out = join(tmpdir(), 'cos-wpt-local-results.json');
    await writeFile(out, JSON.stringify({ results }, null, 2));
    console.log(`\nWrote ${out}.`);
    report(results, JSON.parse(await readFile(EXPECTATIONS_PATH, 'utf8')));
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function report(results, expectations) {
  let passed = 0;
  let failed = 0;
  const unexpected = [];
  for (const test of results) {
    const key = `cross-origin-storage/${test.test.replace(/^cross-origin-storage\//, '')}`;
    const known = expectations.failures[key] || {};
    const flaky = expectations.flaky?.[key] || {};
    const subtests = [...test.subtests];
    if (test.status !== 'pass' && test.status !== 'fail') {
      subtests.push({
        name: '(harness)',
        status: test.status.toUpperCase(),
        message: test.message,
      });
    }
    for (const sub of subtests) {
      const ok = sub.status === 'PASS';
      ok ? passed++ : failed++;
      if (sub.name in flaky || ok) continue;
      if (!(sub.name in known)) {
        unexpected.push(`${sub.status} ${key} › ${sub.name}: ${sub.message}`);
      }
    }
  }
  console.log(`\nPassed: ${passed}  Failed: ${failed}`);
  if (unexpected.length) {
    console.log(`\n${unexpected.length} failure(s) wpt-expectations.json doesn't list:`);
    for (const line of unexpected) console.log(`  ${line}`);
    process.exitCode = 1;
  } else {
    console.log('Every failure is one wpt-expectations.json lists.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
