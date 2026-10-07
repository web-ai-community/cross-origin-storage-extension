// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Anonymous usage statistics: which widely deployed resources sit in COS
// caches (population) and how often they are requested, found, and stored
// (usage). Enabled by default, with an opt-out on telemetry-notice.html and
// options.html. Firefox's built-in data consent governs there instead.
//
// What a report contains, and what it never contains:
//   - Only hashes on the Public Hash List are reported by value. Any other
//     hash could fingerprint a private or site-specific file, so those are
//     folded into `other` counts before anything leaves the machine, keeping
//     only their top-level MIME type (`font/*`) and their total size rounded
//     to two significant digits.
//   - No URLs, origins, or sites. Origins and sites are only counted, and a
//     hit carries only whether the requesting origin is same-site with the
//     resource's storer. Local development origins aren't counted.
//   - Events are counted locally and sent once a day, so a report can't be
//     lined up with a page visit by its timing.
//   - The install ID is random and replaced every calendar month (UTC).
//   - Exact sizes and MIME types are reported only for Public Hash List
//     resources, where the hash already determines them.
// The receiving end lives in telemetry-backend/.

// The Apps Script web app that receives reports (its `/exec` URL, see
// telemetry-backend/README.md). While empty, reports are logged to the
// background console and dropped.
const TELEMETRY_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwmo1mxvZVohWdI1PWrxyb1eqWtdaiksHCnuF4HQDly_4X9cJCgYJt5mlJhPw0CLbXW/exec';

const SCHEMA_VERSION = 1;

const FLUSH_ALARM = 'cos-telemetry-flush';
const FLUSH_PERIOD_MINUTES = 24 * 60;

// Nothing is sent until a day after the notice was shown, so opting out
// there takes effect before the first report.
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

// The Public Hash List is about 88 MB, so telemetry accepts a cached copy up
// to a month old. It is only downloaded when there is a hash to look up.
const PHL_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;

// Caps the number of distinct queued (hash, event, relation, api) keys, so a
// page requesting many distinct hashes can't grow the queue without bound.
// Past the cap, new keys are counted under `other` right away.
const MAX_QUEUE_KEYS = 5000;

const OTHER = 'other';

// Firefox's data consent category for this kind of data. It can only be
// declared optional, and users choose it in the install dialog.
const DATA_COLLECTION = ['technicalAndInteraction'];

const KEY_ENABLED = 'telemetryEnabled';
const KEY_NOTICE_SHOWN = 'telemetryNoticeShown';
const KEY_NOT_BEFORE = 'telemetryNotBefore';
const KEY_INSTALL_ID = 'telemetryInstallId';
const KEY_SNAPSHOT_MONTH = 'telemetrySnapshotMonth';
const KEY_QUEUE = 'telemetryQueue';
// Development installs never send to `TELEMETRY_ENDPOINT`. Setting this key
// (from the background console) sends their reports here instead, for
// testing against a local or staging endpoint.
const KEY_DEBUG_ENDPOINT = 'telemetryDebugEndpoint';

function isFirefox() {
  return typeof globalThis.browser?.runtime?.getBrowserInfo === 'function';
}

function browserName() {
  if (isFirefox()) return 'firefox';
  if (chrome.runtime.getURL('').startsWith('safari-web-extension://')) {
    return 'safari';
  }
  return 'chrome';
}

/**
 * Returns whether Firefox's built-in data consent is granted, or null in
 * browsers without one (Chrome, Safari, and Firefox before 140).
 */
async function browserDataConsent() {
  try {
    const { data_collection } = await chrome.permissions.getAll();
    if (!Array.isArray(data_collection)) return null;
    return DATA_COLLECTION.every((type) => data_collection.includes(type));
  } catch {
    return null;
  }
}

async function isTelemetryEnabled() {
  const consent = await browserDataConsent();
  if (consent !== null) return consent;
  const { [KEY_ENABLED]: enabled } =
    await chrome.storage.local.get(KEY_ENABLED);
  return enabled !== false;
}

/**
 * Turns telemetry on or off and resolves to the resulting state, which on
 * Firefox is whatever the user answered in its consent prompt. Call it
 * straight from an input handler: Firefox only shows that prompt in
 * response to a user gesture, so it is requested before anything is awaited.
 */
async function setTelemetryEnabled(enabled) {
  let consentChange = null;
  if (isFirefox()) {
    const request = { data_collection: DATA_COLLECTION };
    consentChange = (
      enabled
        ? browser.permissions.request(request)
        : browser.permissions.remove(request)
    ).catch(() => null);
  }
  await chrome.storage.local.set({ [KEY_ENABLED]: enabled });
  await consentChange;
  return isTelemetryEnabled();
}

async function isDevelopmentInstall() {
  try {
    return (await chrome.management.getSelf()).installType === 'development';
  } catch {
    return false;
  }
}

// Local test servers (and this repository's own test pages) would otherwise
// dominate the numbers.
function isDevelopmentOrigin(origin) {
  let hostname;
  try {
    ({ hostname } = new URL(origin));
  } catch {
    return true;
  }
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.test') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function installIdFor(month) {
  const { [KEY_INSTALL_ID]: stored } =
    await chrome.storage.local.get(KEY_INSTALL_ID);
  if (stored?.month === month) return stored.id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY_INSTALL_ID]: { id, month } });
  return id;
}

// Serializes read-modify-write cycles on the queue, since events arrive
// from concurrent message handlers.
let queueTail = Promise.resolve();
function withQueue(task) {
  const run = queueTail.then(task);
  queueTail = run.catch(() => {});
  return run;
}

function queueKey(hash, event, relation, api) {
  return [hash, event, relation, api].join('|');
}

function addToQueue(queue, counts) {
  for (const [key, count] of Object.entries(counts)) {
    let target = key;
    if (!(key in queue) && Object.keys(queue).length >= MAX_QUEUE_KEYS) {
      const [, ...rest] = key.split('|');
      target = [OTHER, ...rest].join('|');
    }
    queue[target] = (queue[target] || 0) + count;
  }
  return queue;
}

/**
 * Counts one event for the next daily report. Callers don't need to await
 * it, and it never throws.
 *
 * @param {object} event
 * @param {string} event.hash Hex digest of the resource.
 * @param {'hit'|'miss'|'store'} event.event
 * @param {'getFileHandle'|'declarative'|'fetch'|'css'} event.api
 * @param {string} event.origin The requesting origin. Used only to skip
 *   local development origins, and never stored or sent.
 * @param {() => Promise<'same'|'cross'|'unknown'>} [event.relation] For hits:
 *   resolves how the requesting origin relates to the resource's storer.
 *   Only called when telemetry is enabled.
 */
function recordTelemetryEvent({ hash, event, api, origin, relation }) {
  if (isDevelopmentOrigin(origin)) return Promise.resolve();
  return (async () => {
    if (!(await isTelemetryEnabled())) return;
    const resolved = relation ? await relation() : '';
    await withQueue(async () => {
      const { [KEY_QUEUE]: queue = {} } =
        await chrome.storage.local.get(KEY_QUEUE);
      addToQueue(queue, { [queueKey(hash, event, resolved, api)]: 1 });
      await chrome.storage.local.set({ [KEY_QUEUE]: queue });
    });
  })().catch((error) => {
    console.warn('[COS] Telemetry event not recorded:', error);
  });
}

function takeQueue() {
  return withQueue(async () => {
    const { [KEY_QUEUE]: queue = {} } =
      await chrome.storage.local.get(KEY_QUEUE);
    await chrome.storage.local.remove(KEY_QUEUE);
    return queue;
  });
}

function requeue(counts) {
  return withQueue(async () => {
    const { [KEY_QUEUE]: queue = {} } =
      await chrome.storage.local.get(KEY_QUEUE);
    await chrome.storage.local.set({ [KEY_QUEUE]: addToQueue(queue, counts) });
  });
}

// Two significant digits: precise enough for totals, too coarse to pin down
// the size of an individual file that isn't on the Public Hash List.
function roundBytes(bytes) {
  if (!bytes) return 0;
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(bytes)) - 1);
  return Math.round(bytes / unit) * unit;
}

const MIME_TYPE_RE = /^[a-z0-9][\w!#$&^.+-]{0,63}\/[a-z0-9][\w!#$&^.+-]{0,63}$/;
const TOP_LEVEL_TYPES = [
  'application',
  'audio',
  'font',
  'image',
  'model',
  'text',
  'video',
];

// The full MIME type for a listed resource, and only its top-level type
// (`font/*`) for any other, since an unusual subtype could single out a file.
function reportedMimeType(mimeType, listed) {
  const essence = String(mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!MIME_TYPE_RE.test(essence)) return '';
  const [type] = essence.split('/');
  if (!TOP_LEVEL_TYPES.includes(type)) return '';
  return listed ? essence : `${type}/*`;
}

/**
 * Builds the report: usage counts from `queue`, plus the monthly snapshot
 * when `snapshot` is given. `describe()` returns what is known locally about
 * a hash, and `isListed()` decides which hashes are reported by value.
 *
 * @param {object} options
 * @param {{hashes: string[], sitesOf: Map<string, number>, origins: number,
 *   sites: number}|null} options.snapshot The stored hashes, the number of
 *   distinct sites per listed hash, and the install's distinct origins and
 *   sites.
 */
function buildReport({
  id,
  month,
  phlVersion,
  queue,
  snapshot,
  describe,
  isListed,
}) {
  const usageRows = new Map();
  for (const [key, count] of Object.entries(queue)) {
    const [hash, event, relation, api] = key.split('|');
    const listed = isListed(hash);
    const { size, mimeType } = describe(hash);
    const row = {
      hash: listed ? hash : OTHER,
      mimeType: reportedMimeType(mimeType, listed),
      event,
      relation,
      api,
    };
    const rowKey = Object.values(row).join('|');
    const existing = usageRows.get(rowKey) ?? { ...row, count: 0, bytes: 0 };
    existing.count += count;
    // Bytes served (hits) or written (stores), as in the popup's stats.
    if (event !== 'miss') existing.bytes += count * (size ?? 0);
    usageRows.set(rowKey, existing);
  }
  const usage = [...usageRows.values()].map((row) =>
    row.hash === OTHER ? { ...row, bytes: roundBytes(row.bytes) } : row,
  );

  const report = {
    schema: SCHEMA_VERSION,
    id,
    version: chrome.runtime.getManifest().version,
    browser: browserName(),
    phlVersion,
    usage,
  };

  if (snapshot) {
    const resources = [];
    const others = new Map();
    let listedResources = 0;
    let bytes = 0;
    let dedupBytes = 0;
    for (const hash of snapshot.hashes) {
      const { size, mimeType, visibility, origins } = describe(hash);
      bytes += size ?? 0;
      // What the popup calls deduplication savings: every origin past the
      // first that uses the resource would otherwise have stored its own copy.
      if (origins > 1) dedupBytes += (origins - 1) * (size ?? 0);
      if (isListed(hash)) {
        listedResources++;
        resources.push({
          hash,
          mimeType: reportedMimeType(mimeType, true),
          size: size ?? null,
          visibility,
          origins,
          sites: snapshot.sitesOf.get(hash) ?? 0,
          count: 1,
        });
      } else {
        const type = reportedMimeType(mimeType, false);
        const other = others.get(type) ?? { size: 0, count: 0 };
        other.size += size ?? 0;
        other.count++;
        others.set(type, other);
      }
    }
    for (const [mimeType, { size, count }] of others) {
      resources.push({
        hash: OTHER,
        mimeType,
        size: roundBytes(size),
        visibility: '',
        origins: null,
        sites: null,
        count,
      });
    }
    report.snapshot = {
      month,
      install: {
        resources: snapshot.hashes.length,
        listedResources,
        bytes: roundBytes(bytes),
        origins: snapshot.origins,
        sites: snapshot.sites,
        dedupBytes: roundBytes(dedupBytes),
      },
      resources,
    };
  }
  return report;
}

async function send(endpoint, report) {
  // A `no-cors` POST with a text/plain body is a simple request: there's no
  // preflight, and no host permission is needed for Apps Script, whose
  // redirect to script.googleusercontent.com would otherwise also have to
  // pass a CORS check. The response is opaque, so only a network failure
  // shows up here. `credentials: 'omit'` keeps any Google sign-in cookies
  // off the request.
  await fetch(endpoint, {
    method: 'POST',
    mode: 'no-cors',
    credentials: 'omit',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(report),
  });
}

/**
 * Sends the daily report: queued usage counts, plus the population snapshot
 * if none has been sent this month (so the first report after install
 * always carries one). Failed reports are requeued for the next day.
 */
async function flushTelemetry({ publicHashList, resourceManager, getSite }) {
  if (!(await isTelemetryEnabled())) {
    await withQueue(() => chrome.storage.local.remove(KEY_QUEUE));
    return;
  }
  const stored = await chrome.storage.local.get([
    KEY_NOT_BEFORE,
    KEY_SNAPSHOT_MONTH,
    KEY_DEBUG_ENDPOINT,
  ]);
  if (Date.now() < (stored[KEY_NOT_BEFORE] ?? 0)) return;

  const endpoint = (await isDevelopmentInstall())
    ? stored[KEY_DEBUG_ENDPOINT]
    : TELEMETRY_ENDPOINT;
  const month = currentMonth();
  const snapshotDue = stored[KEY_SNAPSHOT_MONTH] !== month;

  const queue = await takeQueue();
  try {
    await resourceManager.ready();
    const snapshotHashes = snapshotDue ? resourceManager.getAllHashes() : null;
    if (!snapshotHashes && !Object.keys(queue).length) return;

    // An empty snapshot still counts the install, and needs no list.
    const needsList =
      snapshotHashes?.length ||
      Object.keys(queue).some((k) => !k.startsWith(`${OTHER}|`));
    if (needsList) await publicHashList.ensureLoaded(PHL_MAX_AGE_MS);
    const isListed = (hash) => publicHashList.includes(hash);

    // Origins are only ever counted here, never sent, and local development
    // origins aren't counted at all.
    const originsOf = (hash) =>
      resourceManager
        .getOriginsByHash(hash)
        .filter((origin) => !isDevelopmentOrigin(origin));
    const countSites = async (origins) =>
      new Set(
        (await Promise.all(origins.map((origin) => getSite(origin)))).filter(
          Boolean,
        ),
      ).size;

    let snapshot = null;
    if (snapshotHashes) {
      const sitesOf = new Map();
      for (const hash of snapshotHashes.filter(isListed)) {
        sitesOf.set(hash, await countSites(originsOf(hash)));
      }
      const installOrigins = resourceManager
        .getAllOrigins()
        .filter((origin) => !isDevelopmentOrigin(origin));
      snapshot = {
        hashes: snapshotHashes,
        sitesOf,
        origins: installOrigins.length,
        sites: await countSites(installOrigins),
      };
    }

    const report = buildReport({
      id: await installIdFor(month),
      month,
      phlVersion: needsList ? publicHashList.version : null,
      queue,
      snapshot,
      describe: (hash) => ({
        size: resourceManager.getSizeByHash(hash),
        mimeType: resourceManager.getMimeTypeByHash(hash),
        visibility: resourceManager.constructor.classifyVisibility(
          resourceManager.getVisibility(hash),
        ),
        origins: originsOf(hash).length,
      }),
      isListed,
    });
    if (endpoint) {
      await send(endpoint, report);
    } else {
      console.info(
        '[COS] Telemetry report (no endpoint configured, not sent):',
        report,
      );
    }
    if (snapshotDue) {
      await chrome.storage.local.set({ [KEY_SNAPSHOT_MONTH]: month });
    }
  } catch (error) {
    await requeue(queue);
    console.warn('[COS] Telemetry report not sent, retrying tomorrow:', error);
  }
}

async function ensureFlushAlarm() {
  if (await chrome.alarms.get(FLUSH_ALARM)) return;
  await chrome.alarms.create(FLUSH_ALARM, {
    delayInMinutes: FLUSH_PERIOD_MINUTES,
    periodInMinutes: FLUSH_PERIOD_MINUTES,
  });
}

/**
 * Registers the telemetry listeners. Call synchronously at the top level of
 * the background script, so the alarm wakes a stopped service worker.
 * `getSite()` maps an origin to its site, for counting distinct sites.
 */
function initTelemetry({ publicHashList, resourceManager, getSite }) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== FLUSH_ALARM) return;
    flushTelemetry({ publicHashList, resourceManager, getSite });
  });

  chrome.runtime.onStartup.addListener(() => {
    ensureFlushAlarm();
  });

  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    await ensureFlushAlarm();
    if (reason !== 'install' && reason !== 'update') return;
    // Shown once: on install, or on the first update that includes
    // telemetry.
    const { [KEY_NOTICE_SHOWN]: shown } =
      await chrome.storage.local.get(KEY_NOTICE_SHOWN);
    if (shown) return;
    await chrome.storage.local.set({
      [KEY_NOTICE_SHOWN]: true,
      [KEY_NOT_BEFORE]: Date.now() + GRACE_PERIOD_MS,
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL('telemetry-notice.html'),
    });
  });
}

export {
  initTelemetry,
  recordTelemetryEvent,
  flushTelemetry,
  isTelemetryEnabled,
  setTelemetryEnabled,
};
