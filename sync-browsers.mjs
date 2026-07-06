#!/usr/bin/env node
// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Regenerates the per-browser manifest.json (base + browser diff, shallow
// merged) and re-copies main-world.js into chrome/, firefox/, safari/.
//
// Every other file those folders need is a symlink into the repo root, so
// it never goes stale. These two are the exceptions:
//   - manifest.json genuinely differs per browser (permissions, background,
//     content_scripts match patterns, browser_specific_settings), so it's
//     built from manifest.base.json + manifest.<browser>.diff.json.
//   - main-world.js is identical for every browser, but Chrome silently
//     refuses to inject a "world": "MAIN" content script when its file is a
//     symlink resolving outside the extension directory, so it must be a
//     real, separately-copied file in each folder.
//
// Usage:
//   node sync-browsers.mjs           # run once
//   node sync-browsers.mjs --watch   # regenerate on every source change

import { readFileSync, writeFileSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BROWSERS = ['chrome', 'firefox', 'safari'];

function sync() {
  const base = JSON.parse(readFileSync(join(ROOT, 'manifest.base.json'), 'utf8'));
  const mainWorld = readFileSync(join(ROOT, 'main-world.js'));

  for (const browser of BROWSERS) {
    const diff = JSON.parse(readFileSync(join(ROOT, `manifest.${browser}.diff.json`), 'utf8'));
    const merged = { ...base, ...diff };
    writeFileSync(join(ROOT, browser, 'manifest.json'), JSON.stringify(merged, null, 2) + '\n');
    writeFileSync(join(ROOT, browser, 'main-world.js'), mainWorld);
  }
  console.log(`[sync-browsers] regenerated manifest.json + main-world.js for ${BROWSERS.join(', ')}`);
}

sync();

if (process.argv.includes('--watch')) {
  const watched = [
    'manifest.base.json',
    'manifest.chrome.diff.json',
    'manifest.firefox.diff.json',
    'manifest.safari.diff.json',
    'main-world.js',
  ];
  console.log(`[sync-browsers] watching ${watched.join(', ')} for changes…`);
  let pending = false;
  const debouncedSync = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try {
        sync();
      } catch (e) {
        console.error('[sync-browsers] error:', e.message);
      }
    }, 50);
  };
  for (const file of watched) {
    watch(join(ROOT, file), debouncedSync);
  }
}
