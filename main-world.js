// Copyright 2025 Google LLC.
// SPDX-License-Identifier: Apache-2.0

(() => {
  if (navigator.crossOriginStorage) {
    return;
  }

  const pendingRequests = new Map();

  // QuotaExceededError is a newer, dedicated interface (not a DOMException)
  // but is Chrome-only so far (unsupported in Firefox and Safari as of this
  // writing); fall back to the long-established DOMException-with-that-name
  // convention elsewhere, which every caller checking err.name will see
  // identically either way.
  function makeQuotaExceededError(message) {
    if (typeof QuotaExceededError !== 'undefined') {
      return new QuotaExceededError(message);
    }
    return new DOMException(message, 'QuotaExceededError');
  }

  // background.js's catch-all handler reports unexpected exceptions as
  // { error: message, errorName } rather than throwing a real exception
  // object across the message boundary (which isn't guaranteed to survive
  // that crossing intact in every engine).
  function errorFromResponse(data) {
    if (data.errorName === 'QuotaExceededError') {
      return makeQuotaExceededError(data.error);
    }
    return new DOMException(data.error, data.errorName || 'UnknownError');
  }

  // This MAIN-world script has no chrome.runtime access (that's the whole
  // reason the ISOLATED-world bridge in content.js exists), so it can't use
  // content.js's reliable safari-web-extension:// scheme check. This is a
  // best-effort heuristic used only to skip pointless work early (see
  // SAFARI_MAX_RESOURCE_SIZE below) -- the write path's own quota check
  // (background.js) is the authoritative correctness backstop regardless of
  // whether this misdetects a browser.
  const IS_LIKELY_SAFARI =
    /^((?!chrome|crios|fxios|android).)*safari/i.test(navigator.userAgent);

  // Safari's Cache Storage implementation has an undocumented per-entry
  // size ceiling: writes fail exactly at the 2^31-byte boundary (confirmed:
  // 1 GiB succeeds, 2 GiB fails with a generic "Failed writing data to the
  // file system" error), strongly suggesting an internal 32-bit signed
  // integer overflow in WebKit. Checking this before hashing lets a
  // known-too-large write fail fast instead of spending potentially minutes
  // computing a hash for a file that can't be stored regardless.
  const SAFARI_MAX_RESOURCE_SIZE = 2 ** 31 - 1;

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
      const { resolve, reject } = pendingRequests.get(id);
      pendingRequests.delete(id);
      if (data?.error) {
        reject(errorFromResponse(data));
      } else {
        resolve(data);
      }
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

  // Blob structured-clone across the MAIN-world/isolated-world content
  // script boundary isn't part of the DOM spec (isolated worlds are a
  // WebExtensions-only construct) and isn't reliably supported by every
  // engine, so file bytes cross that boundary as transferred ArrayBuffers
  // instead. Slicing into fixed-size chunks (rather than one arrayBuffer()
  // call on the whole Blob) keeps peak memory bounded and avoids the
  // whole-file materialization that can fail for very large (multi-GiB)
  // files.
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
  async function blobToTransferChunks(blob) {
    const chunks = [];
    for (let offset = 0; offset < blob.size; offset += TRANSFER_CHUNK_SIZE) {
      chunks.push(
        await blob.slice(offset, offset + TRANSFER_CHUNK_SIZE).arrayBuffer()
      );
    }
    return chunks;
  }

  // Inline copy of sha256.js — main-world.js is a classic MAIN-world content
  // script that must execute synchronously at document_start and therefore
  // cannot use ES module imports.  Keep in sync with sha256.js manually.
  //
  // Below NATIVE_DIGEST_MAX_SIZE, native crypto.subtle.digest on the whole
  // buffer at once is used instead of the hand-rolled streaming loop below --
  // it's hardware-accelerated and consistently much faster (the hand-rolled
  // loop is a poor fit for at least one JS engine's GC behavior at scale:
  // observed 500 MiB taking over a minute in Safari).
  const NATIVE_DIGEST_MAX_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB
  async function streamingHexDigest(algorithm, blob) {
    if (algorithm !== 'SHA-256' || blob.size <= NATIVE_DIGEST_MAX_SIZE) {
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
      byteCount += chunk.length;
      // pending is empty whenever CHUNK is a multiple of 64 (always true
      // here) and every prior chunk was full-sized (true for all but the
      // last) -- i.e. in practice on every iteration except possibly the
      // final one. Concatenating into a fresh buffer in that (common) case
      // was a wholly unnecessary multi-MiB allocation + copy on every
      // single chunk.
      let buf;
      if (pending.length === 0) {
        buf = chunk;
      } else {
        buf = new Uint8Array(pending.length + chunk.length);
        buf.set(pending);
        buf.set(chunk, pending.length);
      }
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
          const { dataChunks, mimeType } = await talkToBridge('getFileData', {
            hash,
          });
          if (!dataChunks) {
            throw new DOMException(
              `File contents must be written before getFile() can be called.`,
              'NotAllowedError'
            );
          }
          return new File(dataChunks, 'file', {
            type: mimeType,
            lastModified: Date.now(),
          });
        },
        createWritable: async () => {
          const chunks = [];
          let detectedMimeType = 'application/octet-stream';

          const ws = new WritableStream({
            write(chunk) {
              if (chunk instanceof Blob && chunk.type) {
                detectedMimeType = chunk.type;
              }
              chunks.push(chunk);
            },
            async close() {
              // For Blob (or anything else), compute the hash in 4 MiB slices
              // so peak memory stays O(chunk) rather than O(file).
              const blob = new Blob(chunks);
              if (IS_LIKELY_SAFARI && blob.size > SAFARI_MAX_RESOURCE_SIZE) {
                throw makeQuotaExceededError(
                  `This resource (${blob.size} bytes) exceeds the maximum size Safari's storage backend supports for a single resource (~2 GiB).`
                );
              }
              const actualHashHex = await streamingHexDigest(
                hash.algorithm,
                blob
              );
              if (actualHashHex !== hash.value) {
                throw new DOMException(
                  `The hash of the provided data does not match the declared hash.`,
                  'DataError'
                );
              }
              const dataChunks = await blobToTransferChunks(blob);
              await talkToBridge(
                'storeFileData',
                {
                  hash,
                  dataChunks,
                  mimeType: { 'content-type': detectedMimeType },
                },
                dataChunks
              );
            },
          });

          // Convenience method for the write(data); close() pattern — WritableStream
          // has no write() directly; callers use this instead of getWriter().
          ws.write = async (data) => {
            const writer = ws.getWriter();
            await writer.write(data);
            writer.releaseLock();
          };

          return ws;
        },
      });
    }
    return handles;
  }

  /**
   * Validates an `options.origins` value per the COS explainer's
   * CrossOriginStorageRequestFileHandleOptions dictionary: optional
   * (USVString or sequence<USVString>). '*' means global, an array
   * means a restricted list, and omitting it entirely means
   * same-site-only.
   */
  function _validateOrigins(origins, methodName) {
    if (origins === undefined) return;
    if (origins === '*') return;
    if (Array.isArray(origins)) {
      for (const o of origins) {
        if (typeof o !== 'string') {
          throw new TypeError(
            `Failed to execute '${methodName}': 'origins' array must contain only strings.`
          );
        }
      }
      return;
    }
    throw new TypeError(
      `Failed to execute '${methodName}': 'origins' must be '*', an array of origin strings, or omitted.`
    );
  }

  async function requestFileHandlesWithOptionalPrompt(
    hashes,
    create = false,
    origins = undefined
  ) {
    const responseData = await talkToBridge('requestFileHandle', {
      hashes,
      create,
      origins,
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
      const { create = false, origins } = options;
      _validateOrigins(origins, 'requestFileHandle');
      const [handle] = await requestFileHandlesWithOptionalPrompt(
        [hash],
        create,
        origins
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

    // Not part of the COS explainer's public surface — a private, debug-only
    // escape hatch used by this extension's own tests to clean up resources.
    // Not spec'd, not stable, and not for production use by page scripts.
    __non_standard__deleteResource: async (hash) => {
      if (!hash || !hash.algorithm || !hash.value) {
        throw new TypeError(
          `Failed to execute '__non_standard__deleteResource': argument must be a hash object with 'algorithm' and 'value'.`
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

    function _validateOrigins(origins, methodName) {
      if (origins === undefined) return;
      if (origins === '*') return;
      if (Array.isArray(origins)) {
        for (const o of origins) {
          if (typeof o !== 'string') {
            throw new TypeError(
              `Failed to execute '${methodName}': 'origins' array must contain only strings.`
            );
          }
        }
        return;
      }
      throw new TypeError(
        `Failed to execute '${methodName}': 'origins' must be '*', an array of origin strings, or omitted.`
      );
    }

    async function _cosRequestFileHandles(hashes, create, origins) {
      // Internal wire action — matches the 'requestFileHandle' case in background.js.
      const { handleIds } = await cosRelay('requestFileHandle', {
        hashes,
        create,
        origins,
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
        createWritable: async () => {
          const _hash = hashes[i];
          const chunks = [];
          let detectedMimeType = 'application/octet-stream';

          const ws = new WritableStream({
            write(chunk) {
              if (chunk instanceof Blob && chunk.type) {
                detectedMimeType = chunk.type;
              }
              chunks.push(chunk);
            },
            async close() {
              const arrayBuffer = await new Blob(chunks).arrayBuffer();
              const hashBuffer = await crypto.subtle.digest(
                _hash.algorithm,
                arrayBuffer
              );
              const actualHashHex = Array.from(new Uint8Array(hashBuffer))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
              if (actualHashHex !== _hash.value) {
                throw new DOMException(
                  `The hash of the provided data does not match the declared hash.`,
                  'DataError'
                );
              }
              await cosRelay(
                'storeFileData',
                {
                  handleId,
                  arrayBuffer,
                  mimeType: { 'content-type': detectedMimeType },
                },
                [arrayBuffer]
              );
            },
          });

          ws.write = async (data) => {
            const writer = ws.getWriter();
            await writer.write(data);
            writer.releaseLock();
          };

          return ws;
        },
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
        const { create = false, origins } = options;
        _validateOrigins(origins, 'requestFileHandle');
        const [handle] = await _cosRequestFileHandles(
          [hash],
          create,
          origins
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
        const { create = false, origins } = options;
        _validateOrigins(origins, 'requestFileHandles');
        return _cosRequestFileHandles(hashes, create, origins);
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
    // Wrapped in try/catch so a browser-specific failure (e.g. inability to
    // subclass a native Worker constructor) doesn't prevent cos-worker-ready
    // from being sent and the polyfill from being usable for the primary worker.
    try { if (!isSharedWorker && typeof Worker !== 'undefined') {
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
    } } catch {} // end sub-worker patching try-catch

    // Dedicated workers signal readiness after wiring up the setupCOS listener;
    // SharedWorkers signal inside the connect handler instead (see above).
    if (!isSharedWorker) {
      self.postMessage({ source: 'cos-worker-ready' });
    }
  }

  // Worker/SharedWorker patching is gated behind a user opt-in setting because
  // replacing these globals can confuse bot-detection systems (e.g. Cloudflare
  // Turnstile).  We fetch the setting asynchronously; by the time real page
  // scripts create workers the setting will already be known.
  talkToBridge('getWorkerPatchSetting')
    .then((result) => {
      if (!result?.workerPatchEnabled) return;

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
                    data.create,
                    data.origins
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
                  const dataChunks = await blobToTransferChunks(
                    new Blob([data.arrayBuffer])
                  );
                  await talkToBridge(
                    'storeFileData',
                    { hash, dataChunks, mimeType: data.mimeType },
                    dataChunks
                  );
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
                      data.create,
                      data.origins
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
                    const dataChunks = await blobToTransferChunks(
                      new Blob([data.arrayBuffer])
                    );
                    await talkToBridge(
                      'storeFileData',
                      { hash, dataChunks, mimeType: data.mimeType },
                      dataChunks
                    );
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
    for (const { placeholder, dataChunks, mimeType } of fonts || []) {
      // Rebuild the Blob here in the MAIN world from the transferred bytes
      // rather than using a cross-world-cloned Blob directly — see the note
      // in storeFileData's close() handler for why.
      const blob = new Blob(dataChunks, { type: mimeType });
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

  // Declarative HTML integration: <link integrity crossoriginstorage> and
  // <script integrity crossoriginstorage>. Intercepts elements carrying both
  // an `integrity` and a `crossoriginstorage` attribute, resolves them via
  // the COS cache, and re-injects the resolved bytes as a blob: URL.
  // See https://github.com/WICG/cross-origin-storage/blob/main/README.md#declarative-html-integration
  //
  // As with the CSS integration above, this MutationObserver callback runs
  // as a microtask after the element is inserted, so the browser's native
  // loader has always already begun fetching the original href/src before
  // this callback can remove it -- a benign double-fetch for <link>, but a
  // hard limitation for <script>: per the HTML spec, a classic script's
  // "already started" flag is set synchronously the moment it's inserted
  // with a src, and once set, no later reassignment of .src can make the
  // element fetch/execute again (verified empirically -- reassigning
  // script.src, even synchronously in the same tick, never changes what
  // executes; reassigning link.href, by contrast, reliably does). So for
  // <script>, the blob: URL swap below still runs and still seeds COS for
  // other readers, but the *original* network response -- not the COS
  // replacement -- is always what actually executes on this element. Only
  // a network-layer interception (e.g. declarativeNetRequest redirects)
  // could change that, which this content-script-based polyfill does not
  // attempt. This has no effect on <link rel="stylesheet">, which has no
  // execute-once semantics.

  // Picks the first `integrity` token using an algorithm COS/SRI both
  // support. `integrity` may list several space-separated hashes; the
  // conversion to a COS hex-hash object happens bridge-side (see
  // background.js's sriToHashObj) so only one realm needs that logic.
  function firstSupportedIntegrityToken(integrity) {
    for (const token of integrity.trim().split(/\s+/)) {
      if (/^sha(256|384|512)-/.test(token)) return token;
    }
    return null;
  }

  // Mirrors the JS API's origins shape: '*' stays '*', a space-separated
  // list becomes an array, and a valueless/empty attribute (same-site-only)
  // becomes undefined -- matching omitting `origins` in requestFileHandle().
  function parseCrossOriginStorageAttr(value) {
    const trimmed = (value || '').trim();
    if (trimmed === '') return undefined;
    if (trimmed === '*') return '*';
    return trimmed.split(/\s+/);
  }

  function processDeclarativeResource(el, urlAttr) {
    if (el._cosDeclarativeProcessed) return;
    if (!el.hasAttribute('crossoriginstorage') || !el.hasAttribute('integrity'))
      return;
    const sriToken = firstSupportedIntegrityToken(el.getAttribute('integrity'));
    if (!sriToken) return; // No COS-supported hash algorithm -- let the browser handle it natively.
    el._cosDeclarativeProcessed = true;
    const origins = parseCrossOriginStorageAttr(
      el.getAttribute('crossoriginstorage')
    );
    const url = el[urlAttr]; // Resolved absolute URL, read before removing the attribute.
    el.removeAttribute(urlAttr);

    const restoreNative = () => {
      el[urlAttr] = url;
    };

    talkToBridge('resolveDeclarativeResource', {
      url,
      integrity: sriToken,
      origins,
      origin: location.origin,
    })
      .then(({ dataChunks, mimeType }) => {
        if (!dataChunks) {
          restoreNative();
          return;
        }
        const blob = new Blob(dataChunks, { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);

        // Detect worker-src-style CSP violations blocking the blob: URL
        // (e.g. a strict script-src/style-src without the blob: scheme) --
        // same synchronous-detection approach as the Worker/SharedWorker
        // blob CSP guards above.
        let cspBlocked = false;
        const cspListener = (e) => {
          if (e.blockedURI === 'blob' || e.blockedURI.startsWith('blob:'))
            cspBlocked = true;
        };
        document.addEventListener('securitypolicyviolation', cspListener, true);
        el[urlAttr] = blobUrl;
        document.removeEventListener('securitypolicyviolation', cspListener, true);

        if (cspBlocked) {
          URL.revokeObjectURL(blobUrl);
          restoreNative();
          return;
        }
        const cleanup = () => URL.revokeObjectURL(blobUrl);
        el.addEventListener('load', cleanup, { once: true });
        el.addEventListener('error', cleanup, { once: true });
      })
      .catch(restoreNative);
  }

  function scanForDeclarativeResources(root) {
    if (root.tagName === 'LINK' && root.rel === 'stylesheet') {
      processDeclarativeResource(root, 'href');
    } else if (root.tagName === 'SCRIPT') {
      processDeclarativeResource(root, 'src');
    }
    if (root.querySelectorAll) {
      root
        .querySelectorAll('link[rel="stylesheet"][integrity][crossoriginstorage]')
        .forEach((el) => processDeclarativeResource(el, 'href'));
      root
        .querySelectorAll('script[integrity][crossoriginstorage]')
        .forEach((el) => processDeclarativeResource(el, 'src'));
    }
  }

  const cosDeclarativeObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        scanForDeclarativeResources(node);
      }
    }
  });
  cosDeclarativeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Declarative JavaScript integration: import attributes
  // (`import … from "url" with { crossOriginStorage }` and
  // `import(url, { with: { crossOriginStorage } })`).
  // See https://github.com/WICG/cross-origin-storage#declarative-javascript-integration
  //
  // Unlike the CSS/HTML integrations above, this one cannot be implemented
  // as request-time interception at all: there's no DOM node to react to,
  // and `import` isn't a monkey-patchable property the way fetch/Worker/
  // XMLHttpRequest are (`const f = import;` is a SyntaxError -- dynamic
  // import is a syntactic form, not a callable reference). Worse, this is
  // broken two levels deeper than that, both verified empirically against
  // Chrome:
  //   1. Every browser today rejects *any* unrecognized import-attribute
  //      key -- including `integrity`, which isn't COS-specific -- with a
  //      synchronous TypeError ("Invalid attribute key"), thrown before any
  //      fetch is even dispatched (a bad key never reaches the network, so
  //      not even a Service Worker fetch handler gets a chance to
  //      intervene).
  //   2. Even that assumes the syntax parses at all: the current import
  //      attributes grammar only permits *string* attribute values, so
  //      `crossOriginStorage: []`/`crossOriginStorage: [...]` -- an array,
  //      as the proposal itself specifies -- is a flat SyntaxError in a
  //      real `type="module"` script, not merely a rejected TypeError.
  // So a `with { crossOriginStorage }` import written exactly as the spec
  // describes cannot be rescued once the browser starts on it, in any way,
  // by any content script -- and for the same reason, it can never even
  // appear inside a real `type="module"` script without taking down that
  // script's entire parse.
  //
  // This instead follows the approach pioneered by es-module-shims
  // (https://github.com/guybedford/es-module-shims): authors opt in with a
  // non-standard `type="module-cos"` script type, which real browsers never
  // try to parse or execute (so there's no race to lose, unlike the
  // `<script>`/`<link>` case above). This polyfill fetches that script's
  // source as plain text, rewrites every import specifier it can find to an
  // absolute URL, resolves any `crossOriginStorage`-bearing import through
  // the same 'resolveDeclarativeResource' bridge action the HTML integration
  // uses (swapping in a blob: URL and stripping the now-meaningless
  // `integrity`/`crossOriginStorage` keys -- COS has already verified the
  // bytes, and the browser doesn't recognize those keys regardless), and
  // finally executes the fully-rewritten, 100%-standard source as a real
  // `type="module"` script. Dynamic `import(literal, { with: {...} })`
  // calls inside that source are rewritten the same way -- this only works
  // for a literal string specifier, not a computed one, which is a known,
  // documented limitation (import specifiers are scanned as text, not
  // evaluated).
  //
  // For code that can't adopt `type="module-cos"` (or needs a
  // runtime-computed specifier),
  // `navigator.crossOriginStorage.__non_standard__import()` below exposes
  // the same resolution logic as a callable, non-standard
  // stand-in for dynamic `import()`.

  function findMatchingBrace(text, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Import attribute values are always literals (strings, arrays of
  // strings, or '*') per the proposal, so evaluating the extracted object
  // literal text is simpler and more robust than hand-rolling a parser for
  // it -- this only ever runs on text the page's own <script type="module-
  // cos"> already contained.
  function evalLiteral(text) {
    try {
      return Function('"use strict"; return (' + text + ');')();
    } catch (_) {
      return null;
    }
  }

  // Matches static `import <clause>? from "specifier" with {...}?` (and the
  // side-effect-only `import "specifier" with {...}?` form). Import
  // attribute values are always flat (string/array-of-string/'*'), so the
  // with-clause's own object literal never nests braces -- a non-greedy,
  // non-nested match is sufficient there, unlike the specifier scanner
  // above this comment wouldn't need to worry about. Requires the `d` flag
  // (capture-group indices) to locate each piece precisely enough to splice
  // without reconstructing the whole statement.
  const STATIC_IMPORT_RE =
    /import\s+(?:([\s\S]*?)\s+from\s+)?(["'])((?:(?!\2)[^\\\r\n]|\\.)*)\2(\s+with\s*\{[^{}]*\})?/dg;
  // Matches dynamic `import("specifier", { with: {...} })?`.
  const DYNAMIC_IMPORT_RE =
    /import\s*\(\s*(["'])((?:(?!\1)[^\\\r\n]|\\.)*)\1(\s*,\s*\{\s*with\s*:\s*\{[^{}]*\}\s*\})?\s*\)/dg;

  function attrsObjectTextFromWrapper(kind, wrapperText) {
    if (!wrapperText) return null;
    const m =
      kind === 'static'
        ? /\{[^{}]*\}/.exec(wrapperText)
        : /with\s*:\s*(\{[^{}]*\})/.exec(wrapperText);
    return m ? m[kind === 'static' ? 0 : 1] : null;
  }

  // Scans `source` for every import reference (static declarations and
  // dynamic calls), returning enough position info to splice each one
  // in-place without disturbing the rest of the source. Doesn't handle
  // `export … from "specifier"` re-exports -- a documented scope limit,
  // same as the CSS integration above only handling one specific pattern
  // rather than parsing full CSS.
  function scanModuleReferences(source) {
    const refs = [];
    let m;
    STATIC_IMPORT_RE.lastIndex = 0;
    while ((m = STATIC_IMPORT_RE.exec(source))) {
      const wrapperRange = m.indices[4];
      refs.push({
        kind: 'static',
        specifier: m[3],
        specStart: m.indices[3][0],
        specEnd: m.indices[3][1],
        wrapperStart: wrapperRange ? wrapperRange[0] : -1,
        wrapperEnd: wrapperRange ? wrapperRange[1] : -1,
        attrsText: attrsObjectTextFromWrapper('static', m[4]),
      });
    }
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    while ((m = DYNAMIC_IMPORT_RE.exec(source))) {
      const wrapperRange = m.indices[3];
      refs.push({
        kind: 'dynamic',
        specifier: m[2],
        specStart: m.indices[2][0],
        specEnd: m.indices[2][1],
        wrapperStart: wrapperRange ? wrapperRange[0] : -1,
        wrapperEnd: wrapperRange ? wrapperRange[1] : -1,
        attrsText: attrsObjectTextFromWrapper('dynamic', m[3]),
      });
    }
    refs.sort((a, b) => a.specStart - b.specStart);
    return refs;
  }

  // Sentinel distinguishing "not a valid origins value" from every legal
  // parsed result (including `undefined`, which is itself a legal result).
  const INVALID_JS_ORIGINS = Symbol('invalid-js-origins');

  // Mirrors the JS API's origins shape, but starting from an *array*
  // (per the proposal, an empty array -- not an omitted key -- means
  // same-site-only for the JS integration, unlike the HTML attribute form).
  function parseJSImportOrigins(value) {
    if (value === '*') return '*';
    if (Array.isArray(value)) {
      if (value.length === 0) return undefined; // same-site
      if (value.every((v) => typeof v === 'string')) return value;
    }
    return INVALID_JS_ORIGINS;
  }

  // Resolves one scanned reference against `baseURL`, returning either
  // `null` (nothing to rewrite -- leave the original text as-is, which for
  // a crossOriginStorage-bearing import means the browser's own native
  // "Invalid attribute key" rejection still applies, same as if this
  // polyfill didn't exist) or a splice instruction for rewriteModuleSource.
  async function resolveModuleRef(ref, baseURL) {
    const attrs = ref.attrsText ? evalLiteral(ref.attrsText) : null;
    const hasCOS = !!(
      attrs &&
      Object.prototype.hasOwnProperty.call(attrs, 'crossOriginStorage') &&
      attrs.integrity
    );

    let absoluteSpecifier;
    const isRelative =
      /^\.{1,2}\//.test(ref.specifier) || ref.specifier.startsWith('/');
    const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(ref.specifier);
    if (isAbsolute) {
      absoluteSpecifier = ref.specifier;
    } else if (isRelative || hasCOS) {
      try {
        absoluteSpecifier = new URL(ref.specifier, baseURL).href;
      } catch (_) {
        return null;
      }
    } else {
      // Bare specifier (e.g. "lodash") with no crossOriginStorage attribute:
      // needs an import map to resolve, which is outside this polyfill's
      // scope -- leave it untouched for the browser to handle as it
      // normally would.
      return null;
    }

    if (!hasCOS) {
      if (absoluteSpecifier === ref.specifier) return null; // nothing changed
      return {
        ref,
        // ref.specStart/specEnd span only the text BETWEEN the original
        // quote characters (which are left untouched in the source), so
        // this must be the raw URL text, not a re-quoted JSON string --
        // otherwise splicing it in doubles the quotes.
        newSpecifierText: absoluteSpecifier,
        wrapperReplacement: null, // leave any existing with-clause untouched
      };
    }

    const sriToken = firstSupportedIntegrityToken(attrs.integrity);
    if (!sriToken) return null;
    const origins = parseJSImportOrigins(attrs.crossOriginStorage);
    if (origins === INVALID_JS_ORIGINS) return null;

    let result;
    try {
      result = await talkToBridge('resolveDeclarativeResource', {
        url: absoluteSpecifier,
        integrity: sriToken,
        origins,
        origin: location.origin,
      });
    } catch (_) {
      return null;
    }
    if (!result || !result.dataChunks) return null;

    const blobMimeType =
      attrs.type === 'json'
        ? 'application/json'
        : attrs.type === 'css'
          ? 'text/css'
          : result.mimeType || 'text/javascript';
    const blob = new Blob(result.dataChunks, { type: blobMimeType });
    const blobUrl = URL.createObjectURL(blob);

    const wrapperReplacement = attrs.type
      ? ref.kind === 'static'
        ? ` with { type: ${JSON.stringify(attrs.type)} }`
        : `, { with: { type: ${JSON.stringify(attrs.type)} } }`
      : '';

    return { ref, newSpecifierText: blobUrl, wrapperReplacement };
  }

  // Resolves and splices every import reference in `source`, in
  // right-to-left order so earlier splices don't invalidate the recorded
  // offsets of ones still to be applied.
  async function rewriteModuleSource(source, baseURL) {
    const refs = scanModuleReferences(source);
    const settled = await Promise.all(
      refs.map((ref) => resolveModuleRef(ref, baseURL))
    );
    const rewrites = settled
      .filter(Boolean)
      .sort((a, b) => b.ref.specStart - a.ref.specStart);
    let out = source;
    for (const { ref, newSpecifierText, wrapperReplacement } of rewrites) {
      if (ref.wrapperStart !== -1 && wrapperReplacement !== null) {
        out =
          out.slice(0, ref.wrapperStart) +
          wrapperReplacement +
          out.slice(ref.wrapperEnd);
      }
      out = out.slice(0, ref.specStart) + newSpecifierText + out.slice(ref.specEnd);
    }
    return out;
  }

  async function processModuleCosScript(el) {
    if (el._cosModuleProcessed) return;
    el._cosModuleProcessed = true;
    const src = el.getAttribute('src');
    const baseURL = src ? new URL(src, location.href).href : location.href;
    let source;
    if (src) {
      try {
        source = await fetch(src).then((r) => r.text());
      } catch (_) {
        return; // Leave inert -- same no-op outcome an unrecognized type would already have.
      }
    } else {
      source = el.textContent;
    }
    let rewritten;
    try {
      rewritten = await rewriteModuleSource(source, baseURL);
    } catch (_) {
      return;
    }
    const blobUrl = URL.createObjectURL(
      new Blob([rewritten], { type: 'text/javascript' })
    );
    const script = document.createElement('script');
    script.type = 'module';
    if (el.id) script.id = el.id;
    script.addEventListener('load', () => URL.revokeObjectURL(blobUrl), {
      once: true,
    });
    script.addEventListener('error', () => URL.revokeObjectURL(blobUrl), {
      once: true,
    });
    script.src = blobUrl;
    el.replaceWith(script);
  }

  function scanForModuleCosScripts(root) {
    if (root.tagName === 'SCRIPT' && root.getAttribute('type') === 'module-cos') {
      processModuleCosScript(root);
    }
    if (root.querySelectorAll) {
      root
        .querySelectorAll('script[type="module-cos"]')
        .forEach(processModuleCosScript);
    }
  }

  const cosModuleObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        scanForModuleCosScripts(node);
      }
    }
  });
  cosModuleObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Not part of the COS explainer's public surface — a non-standard,
  // callable stand-in for dynamic `import(specifier, { with: {
  // crossOriginStorage } })`, since native import() can't be intercepted or
  // monkey-patched (see the comment on processModuleCosScript above). For
  // callers that can't use a <script type="module-cos"> (e.g. a
  // runtime-computed specifier, or code that isn't itself inside one).
  // Mirrors native dynamic import()'s shape as closely as possible: same
  // two positional arguments, same resolved module namespace object. Not
  // spec'd, not stable, and not for production use by page scripts.
  crossOriginStorage.__non_standard__import = async (specifier, options = {}) => {
    let absoluteSpecifier;
    try {
      absoluteSpecifier = new URL(specifier, location.href).href;
    } catch (_) {
      throw new TypeError(
        `Failed to execute '__non_standard__import': '${specifier}' is not a valid URL.`
      );
    }
    const attrs = (options && options.with) || {};
    if (!attrs.crossOriginStorage || !attrs.integrity) {
      return import(absoluteSpecifier); // No COS attributes -- behave like a plain dynamic import.
    }
    const sriToken = firstSupportedIntegrityToken(attrs.integrity);
    if (!sriToken) {
      throw new TypeError(
        `Failed to execute '__non_standard__import': 'integrity' must be a supported SRI hash string.`
      );
    }
    const origins = parseJSImportOrigins(attrs.crossOriginStorage);
    if (origins === INVALID_JS_ORIGINS) {
      throw new TypeError(
        `Failed to execute '__non_standard__import': 'crossOriginStorage' must be '*' or an array of origin strings.`
      );
    }
    const result = await talkToBridge('resolveDeclarativeResource', {
      url: absoluteSpecifier,
      integrity: sriToken,
      origins,
      origin: location.origin,
    });
    if (!result || !result.dataChunks) {
      // Fall back to a real network import -- lets native fetch/integrity
      // semantics apply if it also fails, same as the HTML integration's
      // restoreNative() fallback.
      return import(absoluteSpecifier);
    }
    const blobMimeType =
      attrs.type === 'json'
        ? 'application/json'
        : attrs.type === 'css'
          ? 'text/css'
          : result.mimeType || 'text/javascript';
    const blob = new Blob(result.dataChunks, { type: blobMimeType });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  };
})();
