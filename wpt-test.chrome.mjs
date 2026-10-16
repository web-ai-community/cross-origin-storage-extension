// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Runs the official Cross-Origin Storage web platform tests
// (web-platform-tests/wpt#61811) against the extension, through the cos-wpt
// runner (https://tomayac.github.io/cos-wpt/), which serves the tests straight
// from the pull request.
//
// Launches Chrome with the unpacked extension, turns on the Public Hash List
// gate and the Worker and fetch() patches, opens the runner with ?autorun, and
// waits for its cos-wpt:done event. Every subtest result is then compared with
// wpt-expectations.json, which lists the subtests the extension is known to
// fail (`failures`) and those whose result depends on timing (`flaky`), each
// with the reason. A new failure, or a listed failure that now passes, fails
// the run. A flaky subtest may go either way.
//
// Usage:
//   node wpt-test.chrome.mjs                  # the whole suite
//   node wpt-test.chrome.mjs --filter origins # tests whose name contains "origins"
//   node wpt-test.chrome.mjs --update         # rewrite wpt-expectations.json

import { chromium } from 'playwright';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXT_PATH = __dirname;
const EXPECTATIONS_PATH = join(__dirname, 'wpt-expectations.json');
const RUNNER = 'https://tomayac.github.io/cos-wpt/';
// The suite runs serially and its long tests take minutes each.
const RUN_TIMEOUT_MS = 90 * 60 * 1000;

const args = process.argv.slice(2);
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : '';
const update = args.includes('--update');

async function loadExpectations() {
  try {
    return JSON.parse(await readFile(EXPECTATIONS_PATH, 'utf8'));
  } catch {
    return { failures: {}, flaky: {} };
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(join(__dirname, 'manifest.json'), 'utf8'));
  if (manifest.background?.service_worker === undefined) {
    throw new Error('manifest.json is not the Chrome manifest; run `npm run use-chrome` first.');
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'cos-wpt-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
    await sw.evaluate(() =>
      chrome.storage.local.set({
        publicHashListEnabled: true,
        workerPatchEnabled: true,
        fetchPatchEnabled: true,
      })
    );

    const page = await context.newPage();
    // WPT_DEBUG=1 prints every console message, from frames and workers too.
    const debug = !!process.env.WPT_DEBUG;
    page.on('console', (msg) => {
      if (debug) console.log(`[${msg.type()}] ${msg.location().url?.split('/').pop() || ''} ${msg.text()}`);
      else if (msg.type() === 'error') console.error(`[runner] ${msg.text()}`);
    });
    if (debug) page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
    const url = new URL(RUNNER);
    url.searchParams.set('autorun', '');
    if (filter) url.searchParams.set('filter', filter);
    console.log(`Opening ${url.href} …`);
    await page.goto(url.href, { waitUntil: 'load' });

    // Progress, since a full run takes the better part of an hour.
    const progress = setInterval(async () => {
      try {
        const running = await page.evaluate(() =>
          window.cosWpt?.state.tests.find((t) => t.result?.status === 'running')?.name
        );
        if (running) console.log(`… ${running}`);
      } catch {}
    }, 30_000);
    const results = await page.evaluate(
      (timeout) =>
        new Promise((resolve, reject) => {
          window.addEventListener('cos-wpt:done', (event) => resolve(event.detail), { once: true });
          setTimeout(() => reject(new Error('the run did not finish in time')), timeout);
        }),
      RUN_TIMEOUT_MS
    );
    clearInterval(progress);
    // WPT_DUMP=1 keeps the extension's records, for debugging grants.
    if (process.env.WPT_DUMP) {
      const records = await sw.evaluate(async () =>
        (await chrome.storage.local.get('resourceManagerData')).resourceManagerData
      );
      await writeFile(join(tmpdir(), 'cos-wpt-records.json'), JSON.stringify(records, null, 2));
    }
    await writeFile(join(tmpdir(), 'cos-wpt-results.json'), JSON.stringify(results, null, 2));
    await report(results, await loadExpectations());
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function report(results, expectations) {
  const seen = {};
  let passed = 0;
  let skipped = 0;
  const unexpected = [];
  for (const test of results.results) {
    if (test.status === 'notrun') continue; // Filtered out.
    if (test.status === 'skipped') {
      skipped++;
      console.log(`⏭️  ${test.test}: ${test.reason}`);
      continue;
    }
    const known = expectations.failures[test.test] || {};
    const flaky = expectations.flaky?.[test.test] || {};
    // A file that didn't complete keeps the subtests it reported, plus one
    // entry for the harness itself.
    const subtests = [...test.subtests];
    if (test.status !== 'pass' && test.status !== 'fail') {
      subtests.push({ name: '(harness)', status: test.status.toUpperCase(), message: test.status });
    }
    for (const sub of subtests) {
      const ok = sub.status === 'PASS';
      if (ok) passed++;
      if (!ok) (seen[test.test] ??= {})[sub.name] = sub.message || sub.status;
      const expectedFail = sub.name in known;
      if (sub.name in flaky) continue;
      if (ok === expectedFail) {
        unexpected.push(
          ok
            ? `PASS (expected FAIL) ${test.test} › ${sub.name}`
            : `${sub.status} ${test.test} › ${sub.name}: ${sub.message}`
        );
      }
    }
  }

  if (update) {
    const failures = {};
    for (const [test, subs] of Object.entries(seen)) {
      for (const name of Object.keys(subs)) {
        if (expectations.flaky?.[test]?.[name]) continue;
        (failures[test] ??= {})[name] = expectations.failures[test]?.[name] || 'TODO: reason';
      }
    }
    const flaky = expectations.flaky || {};
    return writeFile(EXPECTATIONS_PATH, JSON.stringify({ failures, flaky }, null, 2) + '\n').then(() =>
      console.log(`\nWrote ${EXPECTATIONS_PATH}.`)
    );
  }

  const failed = Object.values(seen).reduce((n, subs) => n + Object.keys(subs).length, 0);
  console.log(`\nPassed: ${passed}  Failed: ${failed}  Unrunnable files: ${skipped}`);
  if (unexpected.length) {
    console.log(`\n${unexpected.length} unexpected result(s):`);
    for (const line of unexpected) console.log(`  ${line}`);
    process.exitCode = 1;
  } else {
    console.log('Every result matches wpt-expectations.json.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
