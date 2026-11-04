// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Runs only on the repro's own page, and writes its results there. Identical
// in both extension folders.

(async () => {
  const output = document.getElementById('sendmessage-repro-log');
  if (!output) return;
  const MiB = 1024 * 1024;
  const KINDS = ['ArrayBuffer', 'Uint8Array', 'Blob'];
  const SIZES = [16, 8 * MiB];
  const results = [];
  const log = (line) => {
    output.textContent += line + '\n';
  };

  // Resolves with the response, or with `{ error }` for a lastError.
  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          resolve(lastError ? { error: lastError.message } : response);
        });
      } catch (err) {
        resolve({ error: `${err.name}: ${err.message}` });
      }
    });

  function make(kind, size) {
    const bytes = new Uint8Array(size).fill(7);
    if (kind === 'ArrayBuffer') return bytes.buffer;
    if (kind === 'Uint8Array') return bytes;
    return new Blob([bytes], { type: 'application/octet-stream' });
  }

  async function describe(value) {
    const tag = Object.prototype.toString.call(value);
    let bytes = null;
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer);
    else if (value instanceof Blob) {
      bytes = new Uint8Array(await value.arrayBuffer());
    }
    if (!bytes) {
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        json = '(not JSON)';
      }
      return `${tag} ${String(json).slice(0, 60)}`;
    }
    const intact = bytes.every((b) => b === 7);
    return `${tag} of ${bytes.length} bytes, ${intact ? 'intact' : 'CORRUPTED'}`;
  }

  function record(test, outcome) {
    results.push({ test, outcome });
    log(`${test.padEnd(48)} ${outcome}`);
  }

  const { context } = (await send({ type: 'context' })) ?? {};
  log(`${navigator.userAgent}\nbackground: ${context ?? 'no answer'}\n`);

  for (const size of SIZES) {
    for (const kind of KINDS) {
      const response = await send({
        type: 'describe',
        value: make(kind, size),
      });
      record(
        `content -> background, ${kind}(${size})`,
        response?.error ?? `arrived as ${response?.description}`,
      );
    }
    for (const kind of KINDS) {
      const response = await send({ type: 'make', kind, size });
      record(
        `background -> content, ${kind}(${size})`,
        response?.error ?? `arrived as ${await describe(response?.value)}`,
      );
    }
  }

  // The escape hatch Chrome's offscreen document gives: a blob: URL made on
  // one side and fetched on the other.
  const made = await send({ type: 'makeBlobURL', size: 16 });
  if (made?.error) {
    record('background blob: URL, fetched by content', made.error);
  } else {
    try {
      const blob = await (await fetch(made.url)).blob();
      record(
        'background blob: URL, fetched by content',
        `${made.url.split(':').slice(0, 2).join(':')}:..., ${await describe(blob)}`,
      );
    } catch (err) {
      record(
        'background blob: URL, fetched by content',
        `${err.name}: ${err.message}`,
      );
    }
  }
  const url = URL.createObjectURL(make('Blob', 16));
  const fetched = await send({ type: 'fetchURL', url });
  record(
    'content blob: URL, fetched by background',
    fetched?.error ?? fetched?.description,
  );

  log('\ndone');
  document.documentElement.dataset.results = JSON.stringify(results);
  document.documentElement.dataset.done = 'true';
})();
