// Worker half of the fetch integration test in test.html.
//
// Exercises the `crossOriginStorage` RequestInit option inside a worker
// scope, which is where the integration's motivating case -- streaming a
// Wasm module -- most often runs. The page verifies afterwards that the
// resource actually landed in COS, which is the part only the polyfill's
// store-on-miss path can produce.
self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  if (!self.navigator?.crossOriginStorage) {
    self.postMessage({
      type: 'result',
      pass: null,
      detail: 'navigator.crossOriginStorage not available',
    });
    return;
  }
  try {
    const res = await fetch(data.url, {
      integrity: data.integrity,
      crossOriginStorage: '',
    });
    self.postMessage({
      type: 'result',
      ok: res.ok,
      text: await res.text(),
      contentType: res.headers.get('content-type'),
    });
  } catch (err) {
    self.postMessage({
      type: 'result',
      ok: false,
      error: `${err.name}: ${err.message}`,
    });
  }
};
