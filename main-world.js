// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

(() => {
  if (navigator.crossOriginStorage) {
    return;
  }

  const pendingRequests = new Map();

  // Listen for responses from the bridge content script.
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.data.source !== 'cos-polyfill-isolated' ||
      !event.data.id
    ) {
      return;
    }
    const { id, data } = event.data;
    if (pendingRequests.has(id)) {
      const { resolve } = pendingRequests.get(id);
      pendingRequests.delete(id);
      resolve(data);
    }
  });

  function talkToBridge(action, payload, transfer) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingRequests.set(id, { resolve, reject });
      window.postMessage(
        {
          source: 'cos-polyfill-main',
          id,
          action,
          data: payload,
        },
        window.location.origin,
        transfer || []
      );
    });
  }

  // Inline copy of sha256.js — main-world.js is a classic MAIN-world content
  // script that must execute synchronously at document_start and therefore
  // cannot use ES module imports.  Keep in sync with sha256.js manually.
  async function streamingHexDigest(algorithm, blob) {
    if (algorithm !== 'SHA-256') {
      const buf = await blob.arrayBuffer();
      return Array.from(
        new Uint8Array(await crypto.subtle.digest(algorithm, buf))
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    const CHUNK = 4 * 1024 * 1024; // 4 MiB
    // SHA-256 round constants.
    const K = new Int32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    let H = new Int32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    let byteCount = 0;
    let pending = new Uint8Array(0);
    const W = new Int32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    function processBlock(blk) {
      for (let i = 0; i < 16; i++) {
        W[i] =
          (blk[i * 4] << 24) |
          (blk[i * 4 + 1] << 16) |
          (blk[i * 4 + 2] << 8) |
          blk[i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let a = H[0],
        b = H[1],
        c = H[2],
        d = H[3],
        e = H[4],
        f = H[5],
        g = H[6],
        h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 =
          (h +
            (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
            ((e & f) ^ (~e & g)) +
            K[i] +
            W[i]) |
          0;
        const t2 =
          ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) |
          0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0;
      H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0;
      H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0;
      H[7] = (H[7] + h) | 0;
    }
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const chunk = new Uint8Array(
        await blob.slice(offset, offset + CHUNK).arrayBuffer()
      );
      const buf = new Uint8Array(pending.length + chunk.length);
      buf.set(pending);
      buf.set(chunk, pending.length);
      byteCount += chunk.length;
      let i = 0;
      for (; i + 64 <= buf.length; i += 64)
        processBlock(buf.subarray(i, i + 64));
      pending = buf.subarray(i);
    }
    // Padding: append 0x80, zeros, then 64-bit big-endian bit count.
    const k = Math.ceil((pending.length + 9) / 64);
    const pad = new Uint8Array(k * 64);
    pad.set(pending);
    pad[pending.length] = 0x80;
    const dv = new DataView(pad.buffer);
    // Split bit count into hi/lo 32-bit halves to avoid float64 precision
    // loss for files larger than 512 MiB (> 2^32 bits).
    dv.setUint32(k * 64 - 8, Math.floor(byteCount / 0x20000000), false);
    dv.setUint32(k * 64 - 4, (byteCount % 0x20000000) * 8, false);
    for (let i = 0; i < pad.length; i += 64)
      processBlock(pad.subarray(i, i + 64));
    return Array.from(H)
      .map((w) => (w >>> 0).toString(16).padStart(8, '0'))
      .join('');
  }

  async function handleRequestFileHandlesResponse(data) {
    if (data.success.length !== data.hashes.length) {
      throw new DOMException(
        `File${data.hashes.length > 1 ? 's' : ''} "${data.hashes.map((hash) => hash.value).join(', ')}" not found in cross-origin storage.`,
        'NotFoundError'
      );
    }

    const { hashes } = data;
    const handles = [];
    for (const hash of hashes) {
      handles.push({
        getFile: async () => {
          const { data, mimeType } = await talkToBridge('getFileData', {
            hash,
          });
          return new File([data], 'file', {
            type: mimeType,
            lastModified: Date.now(),
          });
        },
        createWritable: async () => {
          return {
            write: async (data) => {
              const mimeType =
                (data instanceof Blob ? data.type : '') ||
                'application/octet-stream';
              if (data instanceof ArrayBuffer) {
                // ArrayBuffer is already in the V8 heap; hash it in one shot
                // and transfer it zero-copy to content.js.
                const hashBuffer = await crypto.subtle.digest(
                  hash.algorithm,
                  data
                );
                const actualHashHex = Array.from(new Uint8Array(hashBuffer))
                  .map((byte) => byte.toString(16).padStart(2, '0'))
                  .join('');
                if (actualHashHex !== hash.value) {
                  throw new DOMException(
                    `The hash of the provided data does not match the declared hash.`,
                    'NotAllowedError'
                  );
                }
                return await talkToBridge(
                  'storeFileData',
                  { hash, data, mimeType: { 'content-type': mimeType } },
                  [data]
                );
              }
              // For Blob (or anything else), compute the hash in 4 MiB slices
              // so peak memory stays O(chunk) rather than O(file).  Sending the
              // Blob via postMessage uses structured-clone, which in Chrome is
              // ref-counted for Blob storage rather than a byte copy.
              const blob = data instanceof Blob ? data : new Blob([data]);
              const actualHashHex = await streamingHexDigest(
                hash.algorithm,
                blob
              );
              if (actualHashHex !== hash.value) {
                throw new DOMException(
                  `The hash of the provided data does not match the declared hash.`,
                  'NotAllowedError'
                );
              }
              return await talkToBridge('storeFileData', {
                hash,
                data: blob,
                mimeType: { 'content-type': mimeType },
              });
            },
            close: async () => {
              // no-op
            },
          };
        },
      });
    }
    return handles;
  }

  async function requestFileHandlesWithOptionalPrompt(hashes, create = false) {
    // Internal message-passing action name. Always singular regardless of
    // how many hashes are requested — see WICG/cross-origin-storage#61.
    // This is distinct from the public, still-deprecated-but-supported
    // requestFileHandles() page API below, which is unaffected by this
    // rename.
    const responseData = await talkToBridge('requestFileHandle', {
      hashes,
      create,
      origin: location.origin,
    });
    return handleRequestFileHandlesResponse(responseData);
  }

  // Deprecation warning for the plural requestFileHandles() method, logged
  // on every call. See: https://github.com/WICG/cross-origin-storage/issues/61
  const _requestFileHandlesDeprecationWarning =
    `[Cross-Origin Storage] navigator.crossOriginStorage.requestFileHandles() ` +
    `is deprecated and will be removed in a future version. ` +
    `Use requestFileHandle() (singular) instead. ` +
    `See https://github.com/WICG/cross-origin-storage/issues/61`;

  function _validateHash(hash, methodName) {
    if (!hash.value) {
      throw new TypeError(
        `Failed to execute '${methodName}': missing required 'hash.value'.`
      );
    }
    if (!/^[0-9a-f]{64}$/.test(hash.value)) {
      throw new TypeError(
        `Failed to execute '${methodName}': 'hash.value' must be a valid lowercase hexadecimal string of length 64.`
      );
    }
    if (!hash.algorithm) {
      throw new TypeError(
        `Failed to execute '${methodName}': missing required 'hash.algorithm'.`
      );
    }
    if (!['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(hash.algorithm)) {
      throw new TypeError(
        `Failed to execute '${methodName}': 'hash.algorithm' must be a valid HashAlgorithmIdentifier (e.g. "SHA-256").`
      );
    }
  }

  const crossOriginStorage = {
    requestFileHandle: async (hash, options = {}) => {
      if (!hash) {
        throw new TypeError(
          `Failed to execute 'requestFileHandle': first argument 'hash' is required.`
        );
      }
      _validateHash(hash, 'requestFileHandle');
      const { create = false } = options;
      const [handle] = await requestFileHandlesWithOptionalPrompt(
        [hash],
        create
      );
      return handle;
    },

    requestFileHandles: async (hashes, options = {}) => {
      console.warn(_requestFileHandlesDeprecationWarning);
      if (!hashes) {
        throw new TypeError(
          `Failed to execute 'requestFileHandles': first argument 'hashes' is required.`
        );
      }
      if (!Array.isArray(hashes)) {
        throw new TypeError(
          `Failed to execute 'requestFileHandles': first argument 'hashes' must be an array.`
        );
      }
      for (const hash of hashes) {
        _validateHash(hash, 'requestFileHandles');
      }
      const { create = false } = options;
      return requestFileHandlesWithOptionalPrompt(hashes, create);
    },

    deleteResource: async (hash) => {
      if (!hash || !hash.algorithm || !hash.value) {
        throw new TypeError(
          `Failed to execute 'deleteResource': argument must be a hash object with 'algorithm' and 'value'.`
        );
      }
      const result = await talkToBridge('deleteResource', { hash });
      if (!result?.success) {
        throw new DOMException(
          `Failed to delete resource with hash "${hash.value}".`,
          'NotFoundError'
        );
      }
    },
  };

  Object.defineProperty(navigator, 'crossOriginStorage', {
    value: crossOriginStorage,
    writable: false,
    configurable: true,
  });

  // Single polyfill for both DedicatedWorker and SharedWorker contexts.
  // Injected verbatim into wrapper blobs via .toString() — must be completely
  // self-contained (no outer-closure references, no imports).
  function universalWorkerPolyfill() {
    if (typeof navigator === 'undefined' || navigator.crossOriginStorage)
      return;

    const isSharedWorker =
      typeof SharedWorkerGlobalScope !== 'undefined' &&
      self instanceof SharedWorkerGlobalScope;

    const pendingRequests = new Map();
    let cosPort = null;
    let portReadyResolve;
    const portReady = new Promise((resolve) => {
      portReadyResolve = resolve;
    });

    function handleCOSReply(event) {
      const { id, data, error } = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      if (error) {
        pending.reject(new DOMException(error.message, error.name));
      } else {
        pending.resolve(data);
      }
    }

    if (isSharedWorker) {
      // SharedWorker: relay port arrives on the first connect event.
      // cos-worker-ready is sent inside the handler — there is no direct
      // channel to the creating page until a client connects.
      self.addEventListener(
        'connect',
        function cosSetupConnect(connectEvent) {
          const port = connectEvent.ports[0];
          port.start();
          port.addEventListener('message', function setupCOS(event) {
            if (
              !event.data ||
              event.data.source !== 'cos-setup' ||
              !event.ports ||
              !event.ports.length
            )
              return;
            event.stopImmediatePropagation();
            cosPort = event.ports[0];
            cosPort.onmessage = handleCOSReply;
            port.removeEventListener('message', setupCOS);
            portReadyResolve();
          });
          port.postMessage({ source: 'cos-worker-ready' });
        },
        { once: true }
      );
    } else {
      // DedicatedWorker: cos-setup arrives as a regular message on self.
      self.addEventListener('message', function setupCOS(event) {
        if (
          !event.data ||
          event.data.source !== 'cos-setup' ||
          !event.ports ||
          !event.ports.length
        ) {
          return;
        }
        event.stopImmediatePropagation();
        cosPort = event.ports[0];
        cosPort.onmessage = handleCOSReply; // setting onmessage implicitly calls start()
        self.removeEventListener('message', setupCOS);
        portReadyResolve();
      });
    }

    async function cosRelay(action, payload, transferables) {
      await portReady;
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingRequests.set(id, { resolve, reject });
        cosPort.postMessage({ id, action, data: payload }, transferables || []);
      });
    }

    // Deprecation warning for the plural requestFileHandles() method, logged
    // on every call. See: https://github.com/WICG/cross-origin-storage/issues/61
    const _requestFileHandlesDeprecationWarning =
      `[Cross-Origin Storage] navigator.crossOriginStorage.requestFileHandles() ` +
      `is deprecated and will be removed in a future version. ` +
      `Use requestFileHandle() (singular) instead. ` +
      `See https://github.com/WICG/cross-origin-storage/issues/61`;

    function _validateHash(hash, methodName) {
      if (!hash.value) {
        throw new TypeError(
          `Failed to execute '${methodName}': missing required 'hash.value'.`
        );
      }
      if (!/^[0-9a-f]{64}$/.test(hash.value)) {
        throw new TypeError(
          `Failed to execute '${methodName}': 'hash.value' must be a valid lowercase hexadecimal string of length 64.`
        );
      }
      if (!hash.algorithm) {
        throw new TypeError(
          `Failed to execute '${methodName}': missing required 'hash.algorithm'.`
        );
      }
      if (
        !['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(hash.algorithm)
      ) {
        throw new TypeError(
          `Failed to execute '${methodName}': 'hash.algorithm' must be a valid HashAlgorithmIdentifier (e.g. "SHA-256").`
        );
      }
    }

    async function _cosRequestFileHandles(hashes, create) {
      // Internal message-passing action name (singular wire format, same
      // rationale as talkToBridge's 'requestFileHandle' above — distinct
      // from the public requestFileHandles() page API).
      const { handleIds } = await cosRelay('requestFileHandle', {
        hashes,
        create,
        origin: self.location.origin,
      });
      return handleIds.map((handleId, i) => ({
        getFile: async () => {
          const result = await cosRelay('getFileData', { handleId });
          return new File([result.data], 'file', {
            type: result.mimeType,
            lastModified: result.lastModified,
          });
        },
        createWritable: async () => ({
          write: async (data) => {
            const hash = hashes[i];
            const arrayBuffer = await new Blob([data]).arrayBuffer();
            const hashBuffer = await crypto.subtle.digest(
              hash.algorithm,
              arrayBuffer
            );
            const actualHashHex = Array.from(new Uint8Array(hashBuffer))
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('');
            if (actualHashHex !== hash.value) {
              throw new DOMException(
                `The hash of the provided data does not match the declared hash.`,
                'NotAllowedError'
              );
            }
            return cosRelay(
              'storeFileData',
              {
                handleId,
                arrayBuffer,
                mimeType: {
                  'content-type': data.type || 'application/octet-stream',
                },
              },
              [arrayBuffer]
            );
          },
          close: async () => {},
        }),
      }));
    }

    const workerCrossOriginStorage = {
      requestFileHandle: async (hash, options = {}) => {
        if (!hash) {
          throw new TypeError(
            `Failed to execute 'requestFileHandle': first argument 'hash' is required.`
          );
        }
        _validateHash(hash, 'requestFileHandle');
        const { create = false } = options;
        const [handle] = await _cosRequestFileHandles([hash], create);
        return handle;
      },

      requestFileHandles: async (hashes, options = {}) => {
        console.warn(_requestFileHandlesDeprecationWarning);
        if (!hashes) {
          throw new TypeError(
            `Failed to execute 'requestFileHandles': first argument 'hashes' is required.`
          );
        }
        if (!Array.isArray(hashes)) {
          throw new TypeError(
            `Failed to execute 'requestFileHandles': first argument 'hashes' must be an array.`
          );
        }
        for (const hash of hashes) {
          _validateHash(hash, 'requestFileHandles');
        }
        const { create = false } = options;
        return _cosRequestFileHandles(hashes, create);
      },
    };

    Object.defineProperty(navigator, 'crossOriginStorage', {
      value: workerCrossOriginStorage,
      writable: false,
      configurable: true,
    });

    // Blob: workers have self.location pointing to the blob: URL, so relative
    // fetch/XHR/importScripts calls fail to parse (new URL('/path', 'blob:…')
    // is invalid per the WHATWG URL spec).  Patch these APIs to resolve
    // relative URLs against __cosWorkerBaseURL — the original HTTP(S) script
    // URL injected by the wrapper loader.  The inner try/catch handles the
    // temporal dead zone when this polyfill executes before the loader's const
    // is initialized, and the undeclared-variable case when running outside a
    // COS blob wrapper.
    if (typeof fetch !== 'undefined') {
      const _nativeFetch = fetch;
      self.fetch = function (input, init) {
        if (typeof input === 'string') {
          let base;
          try {
            base = __cosWorkerBaseURL;
          } catch (_) {}
          if (base) {
            try {
              input = new URL(input, base).href;
            } catch (_) {}
          }
        }
        return _nativeFetch.call(self, input, init);
      };
    }
    if (typeof XMLHttpRequest !== 'undefined') {
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === 'string') {
          let base;
          try {
            base = __cosWorkerBaseURL;
          } catch (_) {}
          if (base) {
            try {
              url = new URL(url, base).href;
            } catch (_) {}
          }
        }
        return _open.call(this, method, url, ...rest);
      };
    }
    if (typeof importScripts !== 'undefined') {
      const _importScripts = importScripts;
      self.importScripts = function (...urls) {
        let base;
        try {
          base = __cosWorkerBaseURL;
        } catch (_) {}
        if (base) {
          urls = urls.map((url) => {
            if (typeof url === 'string') {
              try {
                return new URL(url, base).href;
              } catch (_) {
                return url;
              }
            }
            return url;
          });
        }
        return _importScripts.apply(self, urls);
      };
    }

    // Sub-worker patching: dedicated workers only — SharedWorkers don't spawn
    // child workers through this relay in the current implementation.
    if (!isSharedWorker && typeof Worker !== 'undefined') {
      const OriginalSubWorker = Worker;
      // Self-referential: serialise this very function so each sub-worker blob
      // contains a fresh copy of the polyfill.
      const INNER_POLYFILL = '(' + universalWorkerPolyfill.toString() + ')();';

      self.Worker = class SubWorker extends OriginalSubWorker {
        constructor(scriptURL, opts) {
          // Resolve relative URLs against the original HTTP URL, not the blob URL
          // that self.location.href points to inside a COS wrapper blob.
          // __cosWorkerBaseURL is injected by the wrapper at inlining time.
          const baseURL =
            typeof __cosWorkerBaseURL !== 'undefined'
              ? __cosWorkerBaseURL
              : self.location.href;
          const absURL = new URL(scriptURL, baseURL).href;
          const isModule = opts?.type === 'module';

          let loader;
          if (!isModule) {
            try {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', absURL, false);
              xhr.send();
              loader =
                'const __cosWorkerBaseURL = ' +
                JSON.stringify(absURL) +
                ';\n' +
                xhr.responseText;
            } catch (_) {}
          }
          if (!loader) {
            loader = isModule
              ? '(async()=>{ try { await import(' +
                JSON.stringify(absURL) +
                '); } catch(e) { console.error(e); } })();'
              : 'try { importScripts(' +
                JSON.stringify(absURL) +
                '); } catch(e) { console.error(e); }';
          }

          const blob = new Blob([INNER_POLYFILL + '\n' + loader], {
            type: 'text/javascript',
          });
          const blobURL = URL.createObjectURL(blob);
          super(blobURL, opts);
          URL.revokeObjectURL(blobURL);

          // When the sub-worker signals readiness, wire up a relay that forwards
          // its COS actions through this worker's own cosRelay (and therefore
          // through the existing MessageChannel to the main-thread relay).
          OriginalSubWorker.prototype.addEventListener.call(
            this,
            'message',
            (event) => {
              if (event.data?.source !== 'cos-worker-ready') return;
              event.stopImmediatePropagation();

              const ch = new MessageChannel();
              ch.port1.onmessage = async (e) => {
                const { id: innerReqId, action, data: reqData } = e.data;
                try {
                  const transfers =
                    action === 'storeFileData' && reqData.arrayBuffer
                      ? [reqData.arrayBuffer]
                      : [];
                  const respData = await cosRelay(action, reqData, transfers);
                  const respTransfers =
                    respData?.data instanceof ArrayBuffer
                      ? [respData.data]
                      : [];
                  ch.port1.postMessage(
                    { id: innerReqId, data: respData },
                    respTransfers
                  );
                } catch (err) {
                  ch.port1.postMessage({
                    id: innerReqId,
                    error: { message: err.message, name: err.name },
                  });
                }
              };
              OriginalSubWorker.prototype.postMessage.call(
                this,
                { source: 'cos-setup' },
                [ch.port2]
              );
            }
          );
        }
      };
    }

    // Dedicated workers signal readiness after wiring up the setupCOS listener;
    // SharedWorkers signal inside the connect handler instead (see above).
    if (!isSharedWorker) {
      self.postMessage({ source: 'cos-worker-ready' });
    }
  }

  // (sharedWorkerCrossOriginStoragePolyfill merged into universalWorkerPolyfill above)

  // Worker/SharedWorker patching is gated behind a user opt-in setting because
  // replacing these globals can confuse bot-detection systems (e.g. Cloudflare
  // Turnstile).  We fetch the setting asynchronously; by the time real page
  // scripts create workers the setting will already be known.
  talkToBridge('getWorkerPatchSetting')
    .then(({ workerPatchEnabled }) => {
      if (!workerPatchEnabled) return;

      if (typeof SharedWorker !== 'undefined') {
        const OriginalSharedWorker = SharedWorker;
        const SHARED_WORKER_POLYFILL =
          '(' + universalWorkerPolyfill.toString() + ')();';

        const makeCOSSharedWorker = (scriptURL, options) => {
          const absURL = new URL(scriptURL, location.href).href;

          // SharedWorker connect-timing constraint:
          // Chrome dispatches the 'connect' event as soon as the worker global
          // scope is created — BEFORE a top-level 'await import()' resolves in
          // module workers.  That means the user's onconnect handler is not yet
          // registered when the only connect event fires, so it never runs.
          //
          // Fix: always use a classic wrapper blob (type: 'text/javascript').
          // importScripts() executes synchronously, so self.onconnect is set
          // before the connect event can fire.  We strip 'type' from the options
          // passed to super() so the browser treats the wrapper as classic;
          // the user's script still loads and behaves correctly for any script
          // that doesn't rely on static import/export declarations (which covers
          // all SharedWorker scripts in practice, since classic importScripts is
          // the dominant pattern).
          let loader;
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', absURL, /* async= */ false);
            xhr.send();
            loader = `const __cosWorkerBaseURL = ${JSON.stringify(absURL)};
${xhr.responseText}`;
          } catch (_) {
            // Cross-origin or revoked-blob URL — fall back to importScripts().
          }
          if (!loader) {
            loader = `try { importScripts(${JSON.stringify(absURL)}); } catch (e) { console.error(e); }`;
          }

          const blobURL = URL.createObjectURL(
            new Blob([SHARED_WORKER_POLYFILL + '\n' + loader], {
              type: 'text/javascript',
            })
          );
          // Pass options without 'type' — the wrapper blob is always classic.
          const { type: _t, ...superOptions } = options ?? {};
          const blobOptions = Object.keys(superOptions).length
            ? superOptions
            : undefined;

          // Detect worker-src CSP violations that block blob: URLs (e.g. sites with
          // "worker-src 'self'" which does not cover the blob: scheme).  The
          // securitypolicyviolation event fires synchronously during worker creation
          // in Chrome, so we can detect and fall back in the same call stack.
          //
          // NOTE: same as makeCOSWorker — these violations appear as harmless noise
          // in chrome://extensions/?errors= and cannot be suppressed from JS.
          let cspBlocked = false;
          const cspListener = (e) => {
            if (e.blockedURI === 'blob' || e.blockedURI.startsWith('blob:')) {
              cspBlocked = true;
            }
          };
          document.addEventListener(
            'securitypolicyviolation',
            cspListener,
            true
          );
          let worker;
          try {
            worker = new OriginalSharedWorker(blobURL, blobOptions);
          } catch (_) {
            cspBlocked = true;
          }
          document.removeEventListener(
            'securitypolicyviolation',
            cspListener,
            true
          );
          URL.revokeObjectURL(blobURL);

          if (cspBlocked) {
            // Fall back: let the site's original worker run without the COS polyfill.
            return new OriginalSharedWorker(scriptURL, options);
          }

          const workerHandles = new Map();

          // Start the port so the cos-worker-ready message (queued by the worker's
          // onconnect handler) is actually delivered to our listener below.
          worker.port.start();

          worker.port.addEventListener('message', (event) => {
            if (event.data?.source !== 'cos-worker-ready') return;
            event.stopImmediatePropagation();

            const { port1: mainPort, port2: workerPort } = new MessageChannel();
            mainPort.onmessage = async (e) => {
              const { id, action, data } = e.data;
              try {
                let result;
                if (action === 'requestFileHandle') {
                  const handles = await requestFileHandlesWithOptionalPrompt(
                    data.hashes,
                    data.create
                  );
                  const handleIds = handles.map(() => crypto.randomUUID());
                  handleIds.forEach((hid, i) =>
                    workerHandles.set(hid, {
                      handle: handles[i],
                      hash: data.hashes[i],
                    })
                  );
                  result = { handleIds };
                } else if (action === 'getFileData') {
                  const { handle } = workerHandles.get(data.handleId);
                  const file = await handle.getFile();
                  // Send the File (a Blob) directly; structured-clone in Chrome
                  // is ref-counted for Blob storage, avoiding a full byte copy.
                  mainPort.postMessage({
                    id,
                    data: {
                      data: file,
                      mimeType: file.type,
                      lastModified: file.lastModified,
                    },
                  });
                  return;
                } else if (action === 'storeFileData') {
                  const { hash } = workerHandles.get(data.handleId);
                  await talkToBridge('storeFileData', {
                    hash,
                    data: new Blob([data.arrayBuffer]),
                    mimeType: data.mimeType,
                  });
                  result = {};
                }
                mainPort.postMessage({ id, data: result });
              } catch (err) {
                mainPort.postMessage({
                  id,
                  error: { message: err.message, name: err.name },
                });
              }
            };
            worker.port.postMessage({ source: 'cos-setup' }, [workerPort]);
          });

          return worker;
        };

        window.SharedWorker = function SharedWorker(scriptURL, options) {
          return makeCOSSharedWorker(scriptURL, options);
        };
        window.SharedWorker.prototype = OriginalSharedWorker.prototype;
      }

      if (typeof Worker !== 'undefined') {
        const OriginalWorker = Worker;
        const WORKER_POLYFILL =
          '(' + universalWorkerPolyfill.toString() + ')();';

        const makeCOSWorker = (scriptURL, options) => {
          const absURL = new URL(scriptURL, location.href).href;
          const isModule = options?.type === 'module';

          // Strategy for loading the user's worker script without races:
          //
          // For blob: URLs and classic (non-module) workers we synchronously
          // fetch the source and inline it so user code runs before the event
          // loop dispatches any queued messages — fixing both:
          //   1. Revocation race: blob: URLs revoked right after new Worker().
          //   2. Message-before-onmessage race: async import() lets queued
          //      tasks fire before onmessage is set, silently dropping them.
          //
          // For module workers loading from http(s): URLs we must NOT inline:
          // the module's own import specifiers (e.g. '/node_modules/…') would
          // be resolved against the wrapper blob URL instead of the original
          // script URL, breaking absolute-path and relative imports.  Instead
          // we use import() and buffer any messages that arrive before the
          // async import resolves, then replay them once onmessage is set.
          let loader;
          if (absURL.startsWith('blob:') || !isModule) {
            try {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', absURL, /* async= */ false);
              xhr.send();
              loader = `const __cosWorkerBaseURL = ${JSON.stringify(absURL)};
${xhr.responseText}`;
            } catch (_) {
              // fall through to importScripts / import()
            }
          }
          if (!loader) {
            loader = isModule
              ? `const __cosBuffer = [];
let __cosBuffering = true;
self.addEventListener('message', function __cosBufferFn(e) {
  if (!__cosBuffering) { self.removeEventListener('message', __cosBufferFn); return; }
  if (e.data && e.data.source === 'cos-setup') return;
  e.stopImmediatePropagation();
  __cosBuffer.push({ data: e.data, ports: [...(e.ports || [])] });
});
(async () => {
  try {
    await import(${JSON.stringify(absURL)});
    __cosBuffering = false;
    for (const m of __cosBuffer.splice(0)) {
      self.dispatchEvent(new MessageEvent('message', { data: m.data, ports: m.ports }));
    }
  } catch(e) { console.error(e); }
})();`
              : `try { importScripts(${JSON.stringify(absURL)}); } catch(e) { console.error(e); }`;
          }
          const blobURL = URL.createObjectURL(
            new Blob([WORKER_POLYFILL + '\n' + loader], {
              type: 'text/javascript',
            })
          );

          // Detect worker-src CSP violations that block blob: URLs (e.g. sites with
          // "worker-src 'self'" which does not cover the blob: scheme).  The
          // securitypolicyviolation event fires synchronously during worker creation
          // in Chrome, so we can detect and fall back in the same call stack.
          //
          // NOTE: Chrome logs CSP violations at the engine level before dispatching
          // the securitypolicyviolation event, so these violations will appear in
          // chrome://extensions/?errors= as harmless noise even though the fallback
          // below handles them correctly.  There is no way to suppress that log
          // entry from JavaScript: the blob: URL is scoped to the page origin (MAIN
          // world), and HTTP-header-based CSP cannot be read from a content script
          // to pre-check allowance.
          let cspBlocked = false;
          const cspListener = (e) => {
            if (e.blockedURI === 'blob' || e.blockedURI.startsWith('blob:')) {
              cspBlocked = true;
            }
          };
          document.addEventListener(
            'securitypolicyviolation',
            cspListener,
            true
          );
          let worker;
          try {
            worker = new OriginalWorker(blobURL, options);
          } catch (_) {
            cspBlocked = true;
          }
          document.removeEventListener(
            'securitypolicyviolation',
            cspListener,
            true
          );
          URL.revokeObjectURL(blobURL);

          if (cspBlocked) {
            // Fall back: let the site's original worker run without the COS polyfill.
            if (worker)
              try {
                worker.terminate();
              } catch (_) {}
            return new OriginalWorker(scriptURL, options);
          }

          const workerHandles = new Map();

          // Wait for the worker to signal it's ready before sending the port.
          // Registered here so it fires before any user handler, letting
          // stopImmediatePropagation() keep the message invisible.
          OriginalWorker.prototype.addEventListener.call(
            worker,
            'message',
            (event) => {
              if (event.data?.source !== 'cos-worker-ready') return;
              event.stopImmediatePropagation();

              const { port1: mainPort, port2: workerPort } =
                new MessageChannel();
              mainPort.onmessage = async (e) => {
                // setting onmessage implicitly calls start()
                const { id, action, data } = e.data;
                try {
                  let result;
                  if (action === 'requestFileHandle') {
                    // Run the full permission flow (including any dialog) on the
                    // main thread, then give the worker opaque handle IDs to use.
                    const handles = await requestFileHandlesWithOptionalPrompt(
                      data.hashes,
                      data.create
                    );
                    const handleIds = handles.map(() => crypto.randomUUID());
                    handleIds.forEach((hid, i) =>
                      workerHandles.set(hid, {
                        handle: handles[i],
                        hash: data.hashes[i],
                      })
                    );
                    result = { handleIds };
                  } else if (action === 'getFileData') {
                    const { handle } = workerHandles.get(data.handleId);
                    const file = await handle.getFile();
                    // Send the File (a Blob) directly; structured-clone in Chrome
                    // is ref-counted for Blob storage, avoiding a full byte copy.
                    mainPort.postMessage({
                      id,
                      data: {
                        data: file,
                        mimeType: file.type,
                        lastModified: file.lastModified,
                      },
                    });
                    return;
                  } else if (action === 'storeFileData') {
                    // The worker already verified the hash; forward raw bytes to
                    // the bridge, skipping the redundant check in the handle wrapper.
                    const { hash } = workerHandles.get(data.handleId);
                    await talkToBridge('storeFileData', {
                      hash,
                      data: new Blob([data.arrayBuffer]),
                      mimeType: data.mimeType,
                    });
                    result = {};
                  }
                  mainPort.postMessage({ id, data: result });
                } catch (e) {
                  mainPort.postMessage({
                    id,
                    error: { message: e.message, name: e.name },
                  });
                }
              };
              // Send the port only after onmessage is set, so no reply can arrive
              // on a null handler and be silently dropped.
              OriginalWorker.prototype.postMessage.call(
                worker,
                { source: 'cos-setup' },
                [workerPort]
              );
            }
          );
          return worker;
        };

        window.Worker = function Worker(scriptURL, options) {
          return makeCOSWorker(scriptURL, options);
        };
        window.Worker.prototype = OriginalWorker.prototype;
      }
    }) // end talkToBridge('getWorkerPatchSetting').then()
    .catch(() => {});

  // CSS cross-origin-storage() polyfill.
  // Intercepts <style> and <link rel="stylesheet" data-cos> elements that use
  // the proposed url("…" integrity("sha256-…") cross-origin-storage(…)) syntax,
  // rewrites them via the COS cache, and re-injects the resolved CSS.

  // Replaces __COS_FONT_N__ placeholders in rewritten CSS with page-origin
  // blob URLs.  URL.createObjectURL() must run in the MAIN world so the
  // resulting blob: URL carries the page's origin and is accessible to the
  // browser's font-loading pipeline.
  function applyFontBlobs(cssText, fonts) {
    let resolved = cssText;
    for (const { placeholder, blob } of fonts || []) {
      const blobUrl = URL.createObjectURL(blob);
      resolved = resolved.replace(`"${placeholder}"`, `"${blobUrl}"`);
    }
    return resolved;
  }

  function processStyleForCOS(styleEl) {
    if (styleEl._cosProcessed) return;
    const text = styleEl.textContent;
    if (!text.includes('cross-origin-storage')) return;
    styleEl._cosProcessed = true;
    talkToBridge('rewriteStylesheet', {
      cssText: text,
      origin: location.origin,
    }).then(({ cssText, fonts }) => {
      if (cssText) styleEl.textContent = applyFontBlobs(cssText, fonts);
    });
  }

  // Fonts inside a data-cos stylesheet may be fetched twice: once by the browser
  // before the href is removed, and once by the background script to populate the
  // COS cache on first encounter.  Blocking those browser requests via
  // declarativeNetRequest to avoid the double-fetch would also block the background
  // script's own cache-seeding fetches, so no request blocking is applied.
  function processLinkForCOS(linkEl) {
    if (linkEl._cosProcessed) return;
    if (linkEl.rel !== 'stylesheet' || !linkEl.hasAttribute('data-cos')) return;
    linkEl._cosProcessed = true;
    const href = linkEl.href;
    linkEl.removeAttribute('href');
    talkToBridge('rewriteStylesheet', { url: href, origin: location.origin })
      .then(({ cssText, fonts }) => {
        if (!cssText) {
          linkEl.href = href;
          return;
        }
        const style = document.createElement('style');
        style.textContent = applyFontBlobs(cssText, fonts);
        linkEl.parentNode?.insertBefore(style, linkEl.nextSibling);
      })
      .catch(() => {
        linkEl.href = href;
      });
  }

  const cosStyleObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === 'STYLE') processStyleForCOS(node);
        else if (node.tagName === 'LINK') processLinkForCOS(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('style').forEach(processStyleForCOS);
          node
            .querySelectorAll('link[rel="stylesheet"][data-cos]')
            .forEach(processLinkForCOS);
        }
      }
    }
  });
  cosStyleObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
