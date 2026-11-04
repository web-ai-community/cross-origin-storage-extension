<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# `cache.put()` of a 2 GiB response crashes the web content process

**Component:** WebKit, Service Workers / Cache Storage

## Steps

1. Run `node browser-bugs/serve.mjs`.
2. Open
   `http://localhost:8123/safari/cache-storage-2gib/?sizes=2147483647,2147483648`.
3. Click Run.

The page creates a `Response` whose body is a `ReadableStream` producing the
given number of bytes in 4 MiB chunks, calls `cache.put()` with it, reads the
size of the stored entry back, and deletes it. `mode=network` stores the
`Response` of a `fetch()` of `/bytes/<size>` instead. Both fail the same way.

Do not add `autorun` for the crashing size: Safari reloads a tab whose web
process crashed, which runs it again.

## Expected

The entry is stored, as it is in Chrome 159 (2,147,483,648 and 2,148,532,224
bytes both store and read back). If WebKit has a per-entry limit, `put()`
rejects with a `QuotaExceededError`, and the page keeps running.

## Actual

2,147,483,647 bytes (2^31 − 1) store and read back correctly, in about 17
seconds. At 2,147,483,648 bytes (2^31) the web content process is killed
(`EXC_BREAKPOINT`, `SIGKILL`) once the body finishes:

```
WebCore::combineSegmentsData(Vector<FragmentedSharedBuffer::DataSegmentVectorEntry, 1, CrashOnOverflow, 16> const&, unsigned long)
WebCore::FragmentedSharedBuffer::makeContiguous() const
WebCore::DOMCache::put(...)::$_0::call(ExceptionOr<std::span<unsigned char const>*>&&)
WebCore::FetchResponse::consumeBodyReceivedByChunk(...)::$_0::call(...)
WebCore::ReadableStreamToSharedBufferSink::close()
```

With `mode=network`, the frames below `DOMCache::put` are
`FetchResponse::didSucceed` and `FetchResponse::Loader::didSucceed`.

The stack shows that `DOMCache::put` collects the whole body in memory and then
copies it into one contiguous buffer, whose size appears to be limited to 32
bits. If that copy happens for every entry, storing one just under the limit
needs about twice its size in memory.

## Environment

Safari Technology Preview 27.0 (WebKit 21627.1.4.19.1), macOS 26 on a 16 GiB
Mac. Not yet checked in Safari 27.2.

## Notes

An earlier Safari, inside a web extension's background page, rejected the same
write with `TypeError: Failed writing data to the file system`, also at exactly
2^31 bytes. The Cross-Origin Storage extension refuses resources over 2^31 − 1
bytes in Safari before hashing them, detecting Safari by user agent.
