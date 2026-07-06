#!/usr/bin/env node
// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Serves docs/ (where test.html and the demo pages live) over plain HTTP,
// so a manually loaded unpacked extension has something to point at.
//
// Usage: node serve-docs.mjs [port]  (defaults to 7474, same as e2e-test.chrome.mjs)

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = join(ROOT, 'docs');
const PORT = Number(process.argv[2]) || 7474;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.bin':  'application/octet-stream',
  '.woff2':'font/woff2',
};

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

server.listen(PORT, () => {
  console.log(`[serve-docs] http://localhost:${PORT}/test.html`);
});
