#!/usr/bin/env node
// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Runs sync-browsers.mjs --watch and serve-docs.mjs side by side for local
// dev: load the extension unpacked from chrome/, firefox/, or safari/, then
// point your browser at the printed docs/ URL. Ctrl+C stops both.

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const children = [
  spawn('node', ['sync-browsers.mjs', '--watch'], { cwd: ROOT, stdio: 'inherit' }),
  spawn('node', ['serve-docs.mjs'], { cwd: ROOT, stdio: 'inherit' }),
];

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
}

for (const child of children) {
  child.on('exit', shutdown);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
