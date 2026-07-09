# Cross-Origin Storage extension

<img src="https://raw.githubusercontent.com/web-ai-community/cross-origin-storage-extension/refs/heads/main/logo-cos.svg" alt="Cross-Origin Storage API logo" width="60" height="60">

## Usage

1. Choose between the developer or the end user flow:
   - Developer:
     - Clone the repo or download the files manually.
     - Install the extension as per the
       [Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
       instructions.
   - End user:
     - Install the extension from the
       [Chrome Web Store](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih).
1. Navigate to the demo app on
   [https://web-ai-community.github.io](https://web-ai-community.github.io/cross-origin-storage-extension/)
   (or try the more realistic
   [Hugging Face Whisper example](https://web-ai-community.github.io/cross-origin-storage-extension/huggingface.html)
   on that origin).
1. Press the **Analyze sentiment** button.
1. Navigate to the same demo app but hosted on the different origin
   [https://googlechrome.github.io](https://googlechrome.github.io/samples/cos-demo/)
   (or try the more realistic
   [Hugging Face Whisper example](https://googlechrome.github.io/samples/cos-demo/huggingface.html)
   on that different origin).
1. Press the **Analyze sentiment** button. Now the resource with the SHA-256
   hash `0fb85c8c503d43711cf821d5629ac17fecaf1a3e98517c73038e72105aaf56d9` is
   already in Cross-Origin Storage 🎉.
1. Click the extension icon to see stats about the different resources and
   origins.

   <img width="631" height="757" alt="Image" src="https://github.com/user-attachments/assets/5554f89e-dd7d-478e-8cf9-edccc5a5a0c4" />

## Supported integrations

Cross-Origin Storage has one imperative API and three declarative forms (see
the [explainer](https://github.com/WICG/cross-origin-storage)). A content
script can't intercept everything a real browser implementation could, so a
couple of the declarative forms need a small, documented deviation from the
literal spec syntax to work at all. The table below summarizes it; details
and the reasoning are in code comments in `main-world.js`.

| Integration | Matches the spec syntax exactly? | Caveat |
| --- | --- | --- |
| [Imperative JS API](#imperative-js-api) (`navigator.crossOriginStorage`) | ✅ Yes | None — this is the extension's core, fully-supported surface. |
| [CSS `cross-origin-storage()`](#css-integration) | ✅ Yes | An external `<link rel="stylesheet">` needs an extra `data-cos` marker attribute — recommended for performance, not required by the syntax itself; see below. |
| [Declarative HTML](#declarative-html-integration) (`crossoriginstorage` attribute) | ✅ Yes | For `<script>` (not `<link>`) elements, the browser's native fetch always wins execution — see caveat below. |
| [Declarative JavaScript](#declarative-javascript-integration) (import attributes) | ❌ No | Requires a `<script type="module-cos">` opt-in, or the `navigator.crossOriginStorage.__non_standard__import()` helper, instead of literal `with { crossOriginStorage }` syntax. |

### Imperative JS API

Works exactly as specified:

```js
const handle = await navigator.crossOriginStorage.requestFileHandle(
  { algorithm: 'SHA-256', value: '8f434346...' },
  { create: true, origins: '*' }
);
```

### CSS integration

Spec syntax, inside a `<style>` block:

```html
<style>
  @font-face {
    font-family: "Example";
    src: url("font.woff2" integrity("sha256-...") cross-origin-storage(*));
  }
</style>
```

The same syntax also works when the CSS lives in an external file loaded
via `<link rel="stylesheet">` — but there, the polyfill needs an extra
`data-cos` marker attribute on the `<link>` before it will look at it:

```html
<link rel="stylesheet" href="fonts.css" data-cos />
```

That marker is purely a performance shortcut, not a technical requirement.
A `<style>` block's text is already sitting in the DOM, so checking it for
`cross-origin-storage(...)` costs nothing. An external stylesheet's content
isn't available until it's fetched, though, and the polyfill *could* just
fetch and scan every `<link rel="stylesheet">` on every page to find out —
but that would mean an extra fetch of every stylesheet on every page (and,
for a non-idempotent URL, potentially double-triggering whatever side
effects that fetch has), for the overwhelming majority of stylesheets that
never use this feature at all. The `data-cos` marker lets a page opt in
explicitly, so that extra fetch only happens where it's actually needed. A
real, native browser implementation wouldn't need a marker like this at
all, since it already fetches and parses every stylesheet regardless.

**How the polyfill works:** a `MutationObserver`, installed at
`document_start` (the extension's script runs the moment the page starts
loading, before the page's own scripts run), watches for new `<style>`
elements and `data-cos` `<link>` elements. For a `<style>`, it just checks
whether its text contains the string `cross-origin-storage`; for a
`data-cos` `<link>`, it removes the `href` attribute and fetches the
file's text itself. Either way, it then scans that text with a regex for
`url("…" integrity("…") cross-origin-storage(…))` occurrences. For each
match, it converts the SRI hash to COS's hex format and hands it, along
with the parsed origins, to the background service worker, which looks it
up in the extension's `CacheStorage`-backed COS store — or, on a miss,
fetches it over the network, verifies the fetched bytes against the hash,
and stores it (subject to the declared origins). The resolved bytes come
back as a page-origin `blob:` URL, which gets substituted into the CSS text
in place of the original `url(...)`; the rewritten CSS is then applied
(`textContent` for `<style>`, or a new `<style>` inserted right after the
original `<link>`). Conceptually, the `<style>` example above ends up
looking like this:

```html
<!-- After the polyfill resolves it: -->
<style>
  @font-face {
    font-family: "Example";
    src: url("blob:https://example.com/1a2b3c4d-...");
  }
</style>
```

The `integrity(...)`/`cross-origin-storage(...)` modifiers are gone — COS
has already verified the bytes, and the browser wouldn't understand those
modifiers regardless — leaving a `url(...)` the browser can load exactly
like any other same-origin resource.

### Declarative HTML integration

Works with the literal spec syntax:

```html
<link
  rel="stylesheet"
  href="https://cdn.example.com/lib.css"
  integrity="sha256-..."
  crossorigin="anonymous"
  crossoriginstorage="*"
/>
<script
  src="https://cdn.example.com/lib.js"
  integrity="sha256-..."
  crossorigin="anonymous"
  crossoriginstorage="*"
></script>
```

The `crossorigin` attribute here is unrelated to `crossoriginstorage`
despite the similar name — [the spec itself notes this](https://github.com/WICG/cross-origin-storage/blob/main/README.md#declarative-html-integration).
It's required whenever the resource is genuinely cross-origin, same as with
plain SRI today: without it, the fetch defaults to `no-cors` mode, which
produces an opaque response that `integrity` can never validate, so the
browser refuses to load the resource at all — independent of COS.

**How the polyfill works:** the same `MutationObserver` approach as the CSS
integration, but simpler, since the `integrity`/`crossoriginstorage`
attributes are already sitting right there on the element — no fetch is
needed just to check whether they're present. On a match, the polyfill
removes the `href`/`src` attribute (best-effort — see the caveat below on
why this doesn't always win the race) and hands the resolved URL, SRI hash,
and parsed `origins` to the exact same background resolution logic the CSS
integration uses (cache lookup, or fetch-verify-store on a miss). On
success it swaps in a `blob:` URL, after checking for a CSP violation on
that `blob:` scheme and falling back to the original URL if the page's CSP
disallows it; on any other failure (an unreachable or hash-mismatched
resource) it also restores the original attribute, so the browser's normal
fetch-and-verify path takes over exactly as if this attribute weren't
present at all. Conceptually, the example above ends up looking like this
(note that only `href`/`src` change — `integrity`/`crossoriginstorage`
themselves are left in place on the element):

```html
<!-- After the polyfill resolves it: -->
<link
  rel="stylesheet"
  href="blob:https://example.com/1a2b3c4d-..."
  integrity="sha256-..."
  crossorigin="anonymous"
  crossoriginstorage="*"
/>
<!-- The polyfill swaps src the same way here, but -- per the caveat below --
     the browser still executes the ORIGINAL network response, not this blob. -->
<script
  src="blob:https://example.com/5e6f7a8b-..."
  integrity="sha256-..."
  crossorigin="anonymous"
  crossoriginstorage="*"
></script>
```

**Caveat:** a classic `<script>` element's fetch can't be intercepted before
the browser commits to it (the HTML spec sets its "already started" flag
synchronously on insertion, and no later `src` reassignment can undo that —
verified empirically, not just from reading the spec). So for `<script>`
specifically, whatever the *network* returns is what actually executes;
COS still gets seeded from it for other same-hash readers, but this
particular element doesn't benefit from a cache hit. The `<link>` form has
no such limitation and works as a genuine cache hit end to end.

### Declarative JavaScript integration

The literal spec syntax can't be supported at all: real browsers reject any
unrecognized import-attribute key (`integrity`, `crossOriginStorage`) with a
synchronous `TypeError` before any fetch is dispatched, and — one level
deeper — the current import-attributes grammar only permits *string*
attribute values, so `crossOriginStorage: []`/`[...]` (an array, as the
proposal itself specifies) is an outright `SyntaxError`, not just a rejected
attribute. Dynamic `import()` also isn't something a content script can
monkey-patch (`const f = import;` is itself a `SyntaxError`).

```js
// Spec syntax -- throws in every current browser, can't be polyfilled:
import data from "resource.json" with {
  type: "json",
  integrity: "sha256-...",
  crossOriginStorage: "*",
};
```

Instead, following the approach [es-module-shims](https://github.com/guybedford/es-module-shims)
pioneered for other not-yet-shipped module features, opt in with a
non-standard `type="module-cos"` script type (which real browsers never try
to parse, so there's nothing to race):

```html
<script type="module-cos">
  import data from "resource.json" with {
    type: "json",
    integrity: "sha256-...",
    crossOriginStorage: "*",
  };
</script>
```

**How the polyfill works:** the same `MutationObserver` watches for
`<script type="module-cos">` elements. When it finds one, it fetches the
script's source (or reads it inline) as plain *text* — never as a module,
so none of the syntax/attribute problems above ever apply — and scans that
text with a lightweight, regex-based scanner for both static
`import … from "…" with {…}` declarations and dynamic
`import("…", { with: {…} })` calls. Every specifier found (the
`"resource.json"` part of the examples above) is resolved to an absolute
URL; any that carry a `crossOriginStorage` attribute go through
the exact same background resolution logic (cache lookup, or
fetch-verify-store on a miss) as the CSS and HTML integrations, and have
their specifier spliced in-place with a `blob:` URL, with `integrity`/
`crossOriginStorage` trimmed out of the attribute clause (COS has already
verified the bytes, and the browser wouldn't recognize those keys anyway —
only `type`, if present, is kept). The fully-rewritten source — now
entirely standard syntax, nothing left for the browser to reject — is then
injected as a real `<script type="module">` and executes normally.

This only recognizes a specifier written as a literal string right there in
the source, like `"resource.json"` above — the rewriter finds import calls
by scanning the source *text* for a quoted string, not by evaluating the
code. A computed specifier, like a variable or a template literal
(`import(url, {...})`, `` import(`${base}/file.js`, {...}) ``), isn't
recognized at all: nothing gets rewritten, so the native `import()` call
underneath still hits the same `TypeError` as if this polyfill didn't
exist — see the helper below for that case.

Conceptually, the `module-cos` example above ends up looking like this,
injected in its place:

```html
<!-- After the polyfill resolves it: -->
<script type="module">
  import data from "blob:https://example.com/9c8d7e6f-..." with {
    type: "json",
  };
</script>
```

For a dynamic, runtime-computed specifier (or code that can't use
`type="module-cos"`), call the non-standard
`navigator.crossOriginStorage.__non_standard__import()` helper instead of
native `import()`. It runs the identical resolve-then-`blob:`-URL logic for
that one specifier, then calls real dynamic `import()` on the result — this
works identically whether the specifier is a literal string:

```js
const mod = await navigator.crossOriginStorage.__non_standard__import(
  "resource.json",
  { with: { type: "json", integrity: "sha256-...", crossOriginStorage: "*" } }
);
// Internally, this ends up calling something like the module-cos rewrite
// produces above, just without an actual <script> to inject into:
//   import("blob:https://example.com/9c8d7e6f-...", { with: { type: "json" } })
```

...or a runtime-computed one, which is the case `type="module-cos"` can't
handle at all, since the helper takes the specifier as a real function
argument rather than text it scans for a literal string:

```js
const filename = await pickResourceForUser(); // e.g. resolves to "resource.json"
const mod = await navigator.crossOriginStorage.__non_standard__import(
  filename,
  { with: { type: "json", integrity: "sha256-...", crossOriginStorage: "*" } }
);
// Resolves exactly the same way, regardless of where `filename` came from:
//   import("blob:https://example.com/9c8d7e6f-...", { with: { type: "json" } })
```

## License

Apache 2.0.
