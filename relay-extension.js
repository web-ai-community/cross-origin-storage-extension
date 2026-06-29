// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

window.addEventListener('message', async (event) => {
  if (!event.data || event.data.source !== 'cos-relay-cmd') return;
  const { id, action, hash } = event.data;

  function reply(data) {
    event.source.postMessage(
      { source: 'cos-relay-result', id, ...data },
      event.origin
    );
  }

  if (action === 'ping') {
    reply({ ok: true, cosAvailable: !!navigator.crossOriginStorage, origin: location.origin });
    return;
  }

  if (!navigator.crossOriginStorage) {
    reply({ ok: false, error: 'COS not available in relay' });
    return;
  }

  try {
    const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
    const file = await handle.getFile();
    const text = await file.text();
    reply({ ok: true, text });
  } catch (err) {
    reply({ ok: false, error: `${err.name}: ${err.message}` });
  }
});
