// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Builds the extension and publishes it to the Chrome Web Store (API v2),
// addons.mozilla.org (API v5), or the App Store (App Store Connect API). No
// dependencies: the APIs are plain HTTPS + JSON, and the JWTs they need are
// signed with node:crypto.
//
// Usage:
//   node publish-extension.mjs <chrome|firefox|safari> [options]
//
// Options:
//   --status                Print what the store currently has (version,
//                           review state) and exit. Needs credentials, so
//                           it doubles as a check that they work.
//   --dry-run               Authenticate and work out what would be
//                           published (for Chrome and Firefox, also build
//                           the archive), but upload and submit nothing.
//   --staged                Chrome only: once approved, hold the release
//                           instead of publishing it right away (publish it
//                           later from the Developer Dashboard).
//   --release-notes TEXT    Firefox: release notes shown on AMO. Safari
//                           (required): the "What's New" text.
//   --approval-notes TEXT   Firefox only: notes for Mozilla's reviewers.
//   --allow-dirty           Publish even if the git working tree has
//                           uncommitted changes. The archive is built from
//                           the working tree, so by default that is refused.
//   -h, --help              Show this help and exit.
//
// Safari only:
//   --platform macos|ios|both
//                           Which platform(s) to release. Default: both.
//   --marketing-version X.Y The App Store version. By default, a draft or
//                           rejected version still open in App Store Connect
//                           is reused, and otherwise the minor version of the
//                           newest released one is bumped (2.0 -> 2.1).
//   --build-number N        The build number. By default, one more than the
//                           highest build ever uploaded on either platform,
//                           since macOS rejects any build number that isn't
//                           higher than the last.
//   --cancel-review         Take the version now in review out of review
//                           first, so this release replaces it. It loses its
//                           place in the queue.
//   --regenerate            Rebuild the Xcode wrapper project before
//                           building, needed when the extension's file list
//                           changes. Discards manual Xcode customizations.
//   --skip-build            Don't build and upload; submit the newest build
//                           already uploaded for the marketing version (or
//                           the one --build-number names).
//
// A Safari release uploads the builds with upload-safari-build.sh, waits for
// App Store Connect to process them, attaches each to its App Store version
// with the release notes, and submits it for review.
//
// Credentials are read from the environment or the gitignored .env file.
// See .env.example for the variables, and the "Publishing" section of
// README.md for the one-time setup in each store.

import { execFileSync } from 'node:child_process';
import {
  createHmac,
  createPrivateKey,
  createSign,
  randomUUID,
  sign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

// Not secret (both are visible in the Developer Dashboard), so they default
// to this project's values. Override with CWS_PUBLISHER_ID / CWS_ITEM_ID.
const CHROME_PUBLISHER_ID = '6452897e-23a2-4474-82bf-cbe87fcfc7f7';
const CHROME_ITEM_ID = 'denpnpcgjgikjpoglpjefakmdcbmlgih';
const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const CWS_API = 'https://chromewebstore.googleapis.com';
const AMO_API = 'https://addons.mozilla.org/api/v5';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

class UsageError extends Error {}

function printHelp() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const header = [];
  // The comment block after the license header, up to the first import.
  for (const line of source.split('\n').slice(3)) {
    if (!line.startsWith('//')) break;
    header.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(header.join('\n'));
}

function parseArgs(argv) {
  const options = {
    browser: null,
    status: false,
    dryRun: false,
    staged: false,
    releaseNotes: null,
    approvalNotes: null,
    allowDirty: false,
    help: false,
    platform: null,
    marketingVersion: null,
    buildNumber: null,
    skipBuild: false,
    cancelReview: false,
    regenerate: false,
  };
  const takeValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a value.`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case 'chrome':
      case 'firefox':
      case 'safari':
        options.browser = arg;
        break;
      case '--platform':
        options.platform = takeValue(arg, i++);
        break;
      case '--marketing-version':
        options.marketingVersion = takeValue(arg, i++);
        break;
      case '--build-number':
        options.buildNumber = takeValue(arg, i++);
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--cancel-review':
        options.cancelReview = true;
        break;
      case '--regenerate':
        options.regenerate = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--staged':
        options.staged = true;
        break;
      case '--release-notes':
        options.releaseNotes = takeValue(arg, i++);
        break;
      case '--approval-notes':
        options.approvalNotes = takeValue(arg, i++);
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.browser) {
    throw new UsageError('Say which store to publish to: chrome, firefox, or safari.');
  }
  if (options.browser === 'chrome' && (options.releaseNotes || options.approvalNotes)) {
    throw new UsageError(
      '--release-notes and --approval-notes are not supported for Chrome; the Chrome Web Store API has no equivalent.'
    );
  }
  if (options.browser !== 'chrome' && options.staged) {
    throw new UsageError('--staged is Chrome only.');
  }
  if (options.browser !== 'firefox' && options.approvalNotes) {
    throw new UsageError('--approval-notes is Firefox only.');
  }
  const safariOnly = [
    ['--platform', options.platform],
    ['--marketing-version', options.marketingVersion],
    ['--build-number', options.buildNumber],
    ['--skip-build', options.skipBuild],
    ['--cancel-review', options.cancelReview],
    ['--regenerate', options.regenerate],
  ].filter(([, value]) => value);
  if (options.browser !== 'safari' && safariOnly.length) {
    throw new UsageError(`${safariOnly.map(([flag]) => flag).join(', ')}: Safari only.`);
  }
  if (options.browser === 'safari') {
    options.platform ??= 'both';
    if (!['macos', 'ios', 'both'].includes(options.platform)) {
      throw new UsageError('--platform must be macos, ios, or both.');
    }
    if (options.marketingVersion && !/^\d+(\.\d+){1,2}$/.test(options.marketingVersion)) {
      throw new UsageError('--marketing-version must look like 2.1 or 2.1.1.');
    }
    if (options.buildNumber !== null) {
      if (!/^[1-9]\d*$/.test(options.buildNumber)) {
        throw new UsageError('--build-number must be a positive integer.');
      }
      options.buildNumber = Number(options.buildNumber);
    }
  }
  return options;
}

function loadEnv() {
  try {
    process.loadEnvFile(join(REPO_ROOT, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    throw new UsageError(`${name} is not set. ${hint}`);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Compares dotted numeric versions ("0.1.24" vs "0.1.9"), the only format
// either store accepts for this extension.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

async function readJsonResponse(response, what) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const detail = body.error?.message || body.detail || body.raw || JSON.stringify(body);
    const error = new Error(`${what} failed with HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

// ── Build ───────────────────────────────────────────────────────────────────

function assertCleanTree() {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Only trim the end: porcelain lines start with a meaningful space.
  }).trimEnd();
  if (!status) return;
  throw new UsageError(
    `The git working tree has uncommitted changes, and the archive would be built from them:\n` +
      status
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n') +
      `\nCommit them first, or pass --allow-dirty to publish anyway.`
  );
}

function build(browser) {
  console.log(`==> Building the ${browser} archive`);
  execFileSync('bash', [join(REPO_ROOT, 'zip-extension.sh'), browser], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const zipPath = join(REPO_ROOT, `cross-origin-storage-extension-${browser}.zip`);
  // Read the version from the manifest the archive was built from, not
  // manifest.json, which is whichever browser's copy was swapped in last.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, `manifest.${browser}.json`), 'utf8'));
  return { zipPath, version: manifest.version, bytes: readFileSync(zipPath) };
}

// ── Chrome Web Store ────────────────────────────────────────────────────────

async function chromeAccessToken() {
  const impersonate = process.env.CWS_SERVICE_ACCOUNT;
  const keyPath = process.env.CWS_SERVICE_ACCOUNT_KEY_PATH;
  const keyJson = process.env.CWS_SERVICE_ACCOUNT_KEY;

  if (impersonate) {
    // Google's recommended route: short-lived tokens minted through gcloud,
    // with no key file on disk. Needs `gcloud auth login` and the
    // Service Account Token Creator role on the service account.
    try {
      return execFileSync(
        'gcloud',
        [
          'auth',
          'print-access-token',
          `--impersonate-service-account=${impersonate}`,
          `--scopes=${CWS_SCOPE}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
    } catch (error) {
      const stderr = error.stderr?.toString().trim() || error.message;
      throw new Error(
        `gcloud could not mint a token impersonating ${impersonate}:\n${stderr}\n` +
          'Run `gcloud auth login` with an account that has the Service Account Token Creator role on it.'
      );
    }
  }

  if (!keyPath && !keyJson) {
    throw new UsageError(
      'No Chrome Web Store credentials. Set CWS_SERVICE_ACCOUNT (to impersonate the service account through gcloud), ' +
        'or CWS_SERVICE_ACCOUNT_KEY_PATH / CWS_SERVICE_ACCOUNT_KEY (a JSON key). See .env.example.'
    );
  }
  const key = JSON.parse(keyPath ? readFileSync(keyPath, 'utf8') : keyJson);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: CWS_SCOPE,
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(key.private_key, 'base64url');
  const response = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Exchanging the service account key for a token failed: ${body.error_description || body.error}`
    );
  }
  return body.access_token;
}

function chromeItemName() {
  const publisherId = process.env.CWS_PUBLISHER_ID || CHROME_PUBLISHER_ID;
  const itemId = process.env.CWS_ITEM_ID || CHROME_ITEM_ID;
  return `publishers/${publisherId}/items/${itemId}`;
}

async function chromeRequest(token, method, url, what, init = {}) {
  const response = await fetch(url, {
    ...init,
    method,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  try {
    return await readJsonResponse(response, what);
  } catch (error) {
    if (error.status === 403 || error.status === 401) {
      error.message +=
        '\nCheck that the service account email is added in the Developer Dashboard (Account section), ' +
        'that the publisher ID is right, and that the Chrome Web Store API is enabled in its Cloud project.';
    }
    throw error;
  }
}

function describeChromeStatus(status) {
  const lines = [];
  for (const [label, revision] of [
    ['Published', status.publishedItemRevisionStatus],
    ['Submitted', status.submittedItemRevisionStatus],
  ]) {
    if (!revision) continue;
    const channels = (revision.distributionChannels || [])
      .map((c) => `${c.crxVersion} at ${c.deployPercentage ?? 100}%`)
      .join(', ');
    lines.push(`  ${label}: ${revision.state}${channels ? ` (${channels})` : ''}`);
  }
  if (status.lastAsyncUploadState) {
    lines.push(`  Last upload: ${status.lastAsyncUploadState}`);
  }
  if (status.takenDown) lines.push('  Taken down: yes');
  if (status.warned) lines.push('  Warned: yes');
  return lines.join('\n') || '  (nothing published or submitted yet)';
}

function newestChromeVersion(status) {
  const versions = [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .flatMap((revision) => revision?.distributionChannels || [])
    .map((channel) => channel.crxVersion)
    .filter(Boolean);
  return versions.sort(compareVersions).at(-1) ?? null;
}

async function publishChrome(options) {
  const name = chromeItemName();
  console.log('==> Authenticating with the Chrome Web Store');
  const token = await chromeAccessToken();
  const fetchStatus = () =>
    chromeRequest(token, 'GET', `${CWS_API}/v2/${name}:fetchStatus`, 'Fetching the item status');

  const status = await fetchStatus();
  console.log(`Chrome Web Store item ${status.itemId}:\n${describeChromeStatus(status)}`);
  if (options.status) return;

  const { bytes, version } = build('chrome');
  const storeVersion = newestChromeVersion(status);
  if (storeVersion && compareVersions(version, storeVersion) <= 0) {
    throw new UsageError(
      `The archive is version ${version}, but the store already has ${storeVersion}. Bump the version in all manifests first.`
    );
  }
  if (status.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    throw new UsageError(
      'A submission is already pending review. Cancel it in the Developer Dashboard (or wait for the review) before uploading a new version.'
    );
  }
  if (options.dryRun) {
    console.log(`Dry run: would upload version ${version} (${bytes.length} bytes) and publish it.`);
    return;
  }

  console.log(`==> Uploading version ${version}`);
  const upload = await chromeRequest(token, 'POST', `${CWS_API}/upload/v2/${name}:upload`, 'Uploading', {
    headers: { 'Content-Type': 'application/zip' },
    body: bytes,
  });
  let uploadState = upload.uploadState;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (uploadState === 'IN_PROGRESS') {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the Chrome Web Store to process the upload.');
    }
    await sleep(POLL_INTERVAL_MS);
    uploadState = (await fetchStatus()).lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') {
    throw new Error(`The upload did not succeed (state: ${uploadState}). Response: ${JSON.stringify(upload)}`);
  }

  console.log(`==> Submitting for review (${options.staged ? 'staged' : 'publish on approval'})`);
  const result = await chromeRequest(token, 'POST', `${CWS_API}/v2/${name}:publish`, 'Publishing', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishType: options.staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH',
    }),
  });
  for (const warning of result.warningInfo?.warnings || [result.warningInfo].filter(Boolean)) {
    console.warn(`Warning: ${warning.reason || ''} ${warning.description || JSON.stringify(warning)}`);
  }
  console.log(`✅ Chrome Web Store: version ${version} submitted, state ${result.state}.`);
}

// ── addons.mozilla.org ──────────────────────────────────────────────────────

function amoAuthHeader() {
  const hint =
    'Generate a key and secret at https://addons.mozilla.org/developers/addon/api/key/ and put them in .env.';
  const key = requireEnv('AMO_API_KEY', hint);
  const secret = requireEnv('AMO_API_SECRET', hint);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // AMO rejects tokens that live longer than five minutes and wants a unique
  // jti per request, so every request gets a fresh token.
  const claims = base64url(JSON.stringify({ iss: key, jti: randomUUID(), iat: now, exp: now + 60 }));
  const signature = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
  return `JWT ${header}.${claims}.${signature}`;
}

async function amoRequest(method, path, what, init = {}) {
  const response = await fetch(`${AMO_API}${path}`, {
    ...init,
    method,
    headers: { Authorization: amoAuthHeader(), ...init.headers },
  });
  try {
    return await readJsonResponse(response, what);
  } catch (error) {
    if (error.status === 401) {
      error.message += '\nCheck AMO_API_KEY and AMO_API_SECRET, and that this machine\'s clock is accurate.';
    }
    throw error;
  }
}

function firefoxGuid() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.firefox.json'), 'utf8'));
  const guid = manifest.browser_specific_settings?.gecko?.id;
  if (!guid) throw new Error('manifest.firefox.json has no browser_specific_settings.gecko.id.');
  return guid;
}

function describeValidation(validation) {
  return (validation?.messages || [])
    .filter((message) => message.type === 'error' || message.type === 'warning')
    .map((message) => {
      const where = message.file ? ` (${message.file}${message.line ? `:${message.line}` : ''})` : '';
      return `  ${message.type}: ${message.message}${where}`;
    })
    .join('\n');
}

async function publishFirefox(options) {
  const guid = firefoxGuid();
  const addonPath = `/addons/addon/${encodeURIComponent(guid)}`;

  console.log('==> Authenticating with addons.mozilla.org');
  const addon = await amoRequest('GET', `${addonPath}/`, 'Fetching the add-on');
  // The newest listed version, whatever its review state, is what a new
  // upload has to beat.
  const versions = await amoRequest(
    'GET',
    `${addonPath}/versions/?filter=all_with_unlisted&page_size=5`,
    'Fetching versions'
  );
  const listed = (versions.results || []).filter((v) => v.channel === 'listed');
  console.log(`addons.mozilla.org add-on ${addon.slug} (${addon.status}):`);
  console.log(`  Public: ${addon.current_version?.version ?? 'none'}`);
  for (const v of listed.slice(0, 3)) {
    console.log(`  ${v.version}: ${v.file?.status ?? 'unknown'}`);
  }
  if (options.status) return;

  const { bytes, version, zipPath } = build('firefox');
  const newest = listed.map((v) => v.version).sort(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) <= 0) {
    throw new UsageError(
      `The archive is version ${version}, but AMO already has ${newest}. Bump the version in all manifests first.`
    );
  }
  if (options.dryRun) {
    console.log(`Dry run: would upload version ${version} (${bytes.length} bytes) to the listed channel.`);
    return;
  }

  console.log(`==> Uploading version ${version}`);
  const form = new FormData();
  form.append('upload', new Blob([bytes], { type: 'application/zip' }), zipPath.split('/').at(-1));
  form.append('channel', 'listed');
  let upload = await amoRequest('POST', '/addons/upload/', 'Uploading', { body: form });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!upload.processed) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for AMO to validate the upload.');
    }
    await sleep(POLL_INTERVAL_MS);
    upload = await amoRequest('GET', `/addons/upload/${upload.uuid}/`, 'Checking the upload');
  }
  const findings = describeValidation(upload.validation);
  if (!upload.valid) {
    throw new Error(`AMO validation failed:\n${findings || JSON.stringify(upload.validation)}`);
  }
  if (findings) console.warn(`AMO validation passed with warnings:\n${findings}`);

  console.log('==> Submitting for review');
  const body = { upload: upload.uuid };
  if (options.releaseNotes) body.release_notes = { 'en-US': options.releaseNotes };
  if (options.approvalNotes) body.approval_notes = options.approvalNotes;
  const created = await amoRequest('POST', `${addonPath}/versions/`, 'Creating the version', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(
    `✅ addons.mozilla.org: version ${created.version} submitted, status ${created.file?.status ?? 'unknown'}.`
  );
}

// ── App Store (Safari) ──────────────────────────────────────────────────────

// Not secret (visible in App Store Connect), and the same defaults
// upload-safari-build.sh uses. Override with ASC_KEY_ID / ASC_ISSUER_ID.
const DEFAULT_ASC_KEY_ID = 'B78MTCSY2V';
const DEFAULT_ASC_ISSUER_ID = '69a6de6f-b54e-47e3-e053-5b8c7c11a4d1';
const SAFARI_BUNDLE_ID = 'com.tomayac.crossoriginstorage';
const ASC_API = 'https://api.appstoreconnect.apple.com';

const SAFARI_PLATFORMS = {
  macos: { asc: 'MAC_OS', label: 'macOS' },
  ios: { asc: 'IOS', label: 'iOS' },
};

// Versions in these states can still be edited and submitted, so a release
// reuses one rather than creating another.
const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);
// Versions that are finished, which a new version can follow. A version in
// any other state (waiting for or in review, approved but not yet released)
// keeps App Store Connect from taking a new one on that platform.
const RELEASED_VERSION_STATES = new Set([
  'READY_FOR_DISTRIBUTION',
  'REPLACED_WITH_NEW_VERSION',
]);

// Apple usually processes an upload within minutes, but not always.
const BUILD_PROCESSING_POLL_MS = 30_000;
const BUILD_PROCESSING_TIMEOUT_MS = 90 * 60_000;

let ascPrivateKey = null;

function ascKeyId() {
  return process.env.ASC_KEY_ID || DEFAULT_ASC_KEY_ID;
}

// Same sources, in the same order, as upload-safari-build.sh.
function loadAscPrivateKey() {
  if (ascPrivateKey) return ascPrivateKey;
  let pem = null;
  if (process.env.ASC_API_KEY_PATH) {
    pem = readFileSync(process.env.ASC_API_KEY_PATH, 'utf8');
  } else if (process.env.ASC_API_KEY) {
    pem = process.env.ASC_API_KEY;
  } else {
    try {
      pem = execFileSync(
        'security',
        ['find-generic-password', '-a', ascKeyId(), '-s', `AppStoreConnect API Key (${ascKeyId()})`, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      // `security` prints a secret that contains newlines, as a PEM key does, in hex.
      if (/^[0-9a-f]+$/i.test(pem)) pem = Buffer.from(pem, 'hex').toString('utf8');
    } catch {
      pem = null;
    }
  }
  if (!pem) {
    throw new UsageError(
      'No App Store Connect API key. Set ASC_API_KEY or ASC_API_KEY_PATH in .env, or store the key in the ' +
        'Keychain with ./upload-safari-build.sh --store-key-in-keychain. See .env.example.'
    );
  }
  ascPrivateKey = createPrivateKey(pem);
  return ascPrivateKey;
}

// App Store Connect rejects tokens that live longer than 20 minutes, and a
// release can spend longer than that waiting for processing, so every request
// signs a fresh one.
function ascAuthHeader() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: ascKeyId(), typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: process.env.ASC_ISSUER_ID || DEFAULT_ASC_ISSUER_ID,
      iat: now,
      exp: now + 600,
      aud: 'appstoreconnect-v1',
    })
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: loadAscPrivateKey(),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `Bearer ${header}.${claims}.${signature}`;
}

async function ascRequest(method, pathOrUrl, what, body) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${ASC_API}${pathOrUrl}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: ascAuthHeader(),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  try {
    return await readJsonResponse(response, what);
  } catch (error) {
    const errors = error.body?.errors;
    if (errors?.length) {
      const lines = errors.flatMap((e) => [
        `${e.title || e.code}${e.detail ? `: ${e.detail}` : ''}`,
        // Submitting for review lists what is missing (screenshots, export
        // compliance, and so on) under meta.associatedErrors.
        ...Object.values(e.meta?.associatedErrors || {})
          .flat()
          .map((a) => `  ${a.title || a.code}${a.detail ? `: ${a.detail}` : ''}`),
      ]);
      error.message = `${what} failed with HTTP ${error.status}:\n  ${lines.join('\n  ')}`;
    }
    if (error.status === 401) {
      error.message += '\nCheck the App Store Connect API key and ASC_KEY_ID / ASC_ISSUER_ID.';
    }
    throw error;
  }
}

async function ascGetAll(path, what) {
  const data = [];
  const included = [];
  let next = path;
  while (next) {
    const page = await ascRequest('GET', next, what);
    data.push(...(page.data || []));
    included.push(...(page.included || []));
    next = page.links?.next;
  }
  return { data, included };
}

async function fetchSafariCatalog() {
  const apps = await ascRequest(
    'GET',
    `/v1/apps?filter[bundleId]=${SAFARI_BUNDLE_ID}&fields[apps]=bundleId,name`,
    'Looking up the app'
  );
  const app = (apps.data || []).find((a) => a.attributes.bundleId === SAFARI_BUNDLE_ID);
  if (!app) throw new Error(`App Store Connect has no app with bundle ID ${SAFARI_BUNDLE_ID}.`);

  const versionPages = await ascGetAll(
    `/v1/apps/${app.id}/appStoreVersions?limit=200&include=build` +
      '&fields[appStoreVersions]=versionString,platform,appVersionState,build&fields[builds]=version',
    'Fetching App Store versions'
  );
  const attachedBuilds = new Map(
    versionPages.included.filter((i) => i.type === 'builds').map((b) => [b.id, b.attributes.version])
  );
  const versions = versionPages.data.map((v) => ({
    id: v.id,
    platform: v.attributes.platform,
    versionString: v.attributes.versionString,
    state: v.attributes.appVersionState,
    buildNumber: attachedBuilds.get(v.relationships?.build?.data?.id) ?? null,
  }));

  const buildPages = await ascGetAll(
    `/v1/builds?filter[app]=${app.id}&limit=200&include=preReleaseVersion` +
      '&fields[builds]=version,processingState,preReleaseVersion&fields[preReleaseVersions]=version,platform',
    'Fetching builds'
  );
  const preReleases = new Map(
    buildPages.included.filter((i) => i.type === 'preReleaseVersions').map((p) => [p.id, p.attributes])
  );
  const builds = buildPages.data.map((b) => {
    const preRelease = preReleases.get(b.relationships?.preReleaseVersion?.data?.id) || {};
    return {
      id: b.id,
      platform: preRelease.platform,
      marketingVersion: preRelease.version,
      buildNumber: Number(b.attributes.version),
      processingState: b.attributes.processingState,
    };
  });
  return { app, versions, builds };
}

function newestFirst(versions) {
  return [...versions].sort((a, b) => compareVersions(b.versionString, a.versionString));
}

function describeSafariStatus(catalog) {
  const lines = [];
  for (const { asc, label } of Object.values(SAFARI_PLATFORMS)) {
    lines.push(`  ${label}:`);
    for (const v of newestFirst(catalog.versions.filter((v) => v.platform === asc)).slice(0, 2)) {
      lines.push(`    App Store ${v.versionString}${v.buildNumber ? ` (${v.buildNumber})` : ''}: ${v.state}`);
    }
    const builds = catalog.builds
      .filter((b) => b.platform === asc)
      .sort((a, b) => b.buildNumber - a.buildNumber)
      .slice(0, 2);
    for (const b of builds) {
      lines.push(`    Build ${b.marketingVersion} (${b.buildNumber}): ${b.processingState}`);
    }
  }
  return lines.join('\n');
}

function bumpMinorVersion(version) {
  const [major, minor = '0'] = version.split('.');
  return `${major}.${Number(minor) + 1}`;
}

function planSafariRelease(catalog, options) {
  const keys = options.platform === 'both' ? ['macos', 'ios'] : [options.platform];
  const platforms = keys.map((key) => {
    const { asc, label } = SAFARI_PLATFORMS[key];
    const versions = newestFirst(catalog.versions.filter((v) => v.platform === asc));
    const blocking = versions.find(
      (v) => !EDITABLE_VERSION_STATES.has(v.state) && !RELEASED_VERSION_STATES.has(v.state)
    );
    if (blocking) {
      throw new UsageError(
        `${label} ${blocking.versionString} is ${blocking.state}, so App Store Connect won't take another version yet. ` +
          'Wait for it to be released, or cancel its submission in App Store Connect.'
      );
    }
    return {
      key,
      asc,
      label,
      editable: versions.find((v) => EDITABLE_VERSION_STATES.has(v.state)) ?? null,
      released: versions.find((v) => RELEASED_VERSION_STATES.has(v.state)) ?? null,
      buildNumber: null,
    };
  });

  const marketingVersion =
    options.marketingVersion ??
    platforms
      .map((p) => p.editable?.versionString ?? (p.released ? bumpMinorVersion(p.released.versionString) : '1.0'))
      .sort(compareVersions)
      .at(-1);
  for (const p of platforms) {
    if (p.released && compareVersions(marketingVersion, p.released.versionString) <= 0) {
      throw new UsageError(
        `${p.label} has already released ${p.released.versionString}, so the marketing version must be higher than that.`
      );
    }
  }

  if (options.skipBuild) {
    for (const p of platforms) {
      const newest = catalog.builds
        .filter((b) => b.platform === p.asc && b.marketingVersion === marketingVersion)
        .filter((b) => options.buildNumber === null || b.buildNumber === options.buildNumber)
        .filter((b) => b.processingState !== 'FAILED' && b.processingState !== 'INVALID')
        .sort((a, b) => b.buildNumber - a.buildNumber)[0];
      if (!newest) {
        const which = options.buildNumber === null ? '' : ` (${options.buildNumber})`;
        throw new UsageError(
          `No usable ${p.label} build of ${marketingVersion}${which} has been uploaded. Drop --skip-build to build one.`
        );
      }
      p.buildNumber = newest.buildNumber;
    }
  } else {
    // One build number for both platforms, above every build uploaded so far.
    const buildNumber =
      options.buildNumber ??
      Math.max(0, ...catalog.builds.map((b) => b.buildNumber).filter(Number.isInteger)) + 1;
    for (const p of platforms) p.buildNumber = buildNumber;
  }

  return { marketingVersion, platforms, upload: !options.skipBuild };
}

function describeSafariPlan(plan) {
  const lines = [`Plan for ${plan.marketingVersion}:`];
  for (const p of plan.platforms) {
    let version = `create App Store version ${plan.marketingVersion}`;
    if (p.editable?.versionString === plan.marketingVersion) {
      version = `reuse App Store version ${plan.marketingVersion} (${p.editable.state})`;
    } else if (p.editable) {
      version = `rename App Store version ${p.editable.versionString} (${p.editable.state}) to ${plan.marketingVersion}`;
    }
    const build = plan.upload ? `build and upload build ${p.buildNumber}` : `use uploaded build ${p.buildNumber}`;
    lines.push(`  ${p.label}: ${build}, ${version}, submit for review`);
  }
  return lines.join('\n');
}

async function waitForProcessedBuild(app, platform, marketingVersion) {
  const tag = `${platform.label} ${marketingVersion} (${platform.buildNumber})`;
  const query =
    `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.platform]=${platform.asc}` +
    `&filter[preReleaseVersion.version]=${marketingVersion}&filter[version]=${platform.buildNumber}` +
    '&fields[builds]=version,processingState,usesNonExemptEncryption';
  const started = Date.now();
  let lastState = null;
  for (;;) {
    const { data = [] } = await ascRequest('GET', query, `Checking ${tag}`);
    const build = data[0];
    // A fresh upload can take a few minutes to show up at all.
    const state = build?.attributes.processingState ?? 'NOT_VISIBLE_YET';
    if (state === 'VALID') return build;
    if (state === 'FAILED' || state === 'INVALID') {
      throw new Error(`App Store Connect marked ${tag} ${state}. Apple emails the reason.`);
    }
    if (Date.now() - started > BUILD_PROCESSING_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for App Store Connect to process ${tag}. Once it has, finish the release with ` +
          `--skip-build --platform ${platform.key} --marketing-version ${marketingVersion}.`
      );
    }
    if (state !== lastState) {
      console.log(`    ${tag}: ${state}, checking every ${BUILD_PROCESSING_POLL_MS / 1000}s`);
      lastState = state;
    }
    await sleep(BUILD_PROCESSING_POLL_MS);
  }
}

async function submitSafariPlatform(app, plan, platform, releaseNotes) {
  const { label, asc } = platform;
  const tag = `${label} ${plan.marketingVersion} (${platform.buildNumber})`;
  const build = await waitForProcessedBuild(app, platform, plan.marketingVersion);

  if (build.attributes.usesNonExemptEncryption == null) {
    // The export compliance question, which blocks submission until answered.
    // The extension only uses encryption built into the OS (HTTPS and SHA-256
    // hashing), which is exempt, and every earlier build was answered this way.
    await ascRequest('PATCH', `/v1/builds/${build.id}`, `Answering export compliance for ${tag}`, {
      data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } },
    });
  }

  let versionId = platform.editable?.id;
  if (!versionId) {
    const created = await ascRequest(
      'POST',
      '/v1/appStoreVersions',
      `Creating ${label} App Store version ${plan.marketingVersion}`,
      {
        data: {
          type: 'appStoreVersions',
          attributes: { platform: asc, versionString: plan.marketingVersion, releaseType: 'AFTER_APPROVAL' },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      }
    );
    versionId = created.data.id;
  } else if (platform.editable.versionString !== plan.marketingVersion) {
    await ascRequest('PATCH', `/v1/appStoreVersions/${versionId}`, `Renaming the ${label} App Store version`, {
      data: { type: 'appStoreVersions', id: versionId, attributes: { versionString: plan.marketingVersion } },
    });
  }

  await ascRequest('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, `Attaching ${tag}`, {
    data: { type: 'builds', id: build.id },
  });

  const localizations = await ascGetAll(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale`,
    `Fetching the ${label} localizations`
  );
  for (const localization of localizations.data) {
    await ascRequest(
      'PATCH',
      `/v1/appStoreVersionLocalizations/${localization.id}`,
      `Setting What's New (${localization.attributes.locale}) for ${label}`,
      { data: { type: 'appStoreVersionLocalizations', id: localization.id, attributes: { whatsNew: releaseNotes } } }
    );
  }

  // App Store Connect allows one draft submission per platform, so reuse it
  // if an earlier run left one behind.
  const drafts = await ascRequest(
    'GET',
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=${asc}&filter[state]=READY_FOR_REVIEW`,
    `Looking for a ${label} draft submission`
  );
  let submissionId = drafts.data?.[0]?.id;
  if (!submissionId) {
    const created = await ascRequest('POST', '/v1/reviewSubmissions', `Creating the ${label} review submission`, {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: asc },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    });
    submissionId = created.data.id;
  }
  const items = await ascGetAll(
    `/v1/reviewSubmissions/${submissionId}/items?include=appStoreVersion&fields[reviewSubmissionItems]=appStoreVersion`,
    `Fetching the ${label} submission's items`
  );
  if (!items.data.some((item) => item.relationships?.appStoreVersion?.data?.id === versionId)) {
    await ascRequest('POST', '/v1/reviewSubmissionItems', `Adding ${tag} to the submission`, {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
  }
  const submitted = await ascRequest('PATCH', `/v1/reviewSubmissions/${submissionId}`, `Submitting ${tag}`, {
    data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
  });
  const state = submitted.data?.attributes?.state ?? 'unknown';
  console.log(`✅ App Store (${label}): ${plan.marketingVersion} (${platform.buildNumber}) submitted, state ${state}.`);
}

// States a submission can be taken out of. Cancelling returns its version to
// an editable state, so this release can replace it.
const CANCELLABLE_SUBMISSION_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'];

async function cancelSafariReviews(app, keys) {
  let cancelled = 0;
  for (const key of keys) {
    const { asc, label } = SAFARI_PLATFORMS[key];
    const submissions = await ascRequest(
      'GET',
      `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=${asc}` +
        `&filter[state]=${CANCELLABLE_SUBMISSION_STATES.join(',')}`,
      `Looking for a ${label} submission in review`
    );
    for (const submission of submissions.data || []) {
      await ascRequest('PATCH', `/v1/reviewSubmissions/${submission.id}`, `Taking ${label} out of review`, {
        data: { type: 'reviewSubmissions', id: submission.id, attributes: { canceled: true } },
      });
      console.log(`    ${label}: took submission out of review (was ${submission.attributes?.state}).`);
      cancelled++;
    }
  }
  if (cancelled === 0) {
    console.log('    Nothing was in review.');
    return;
  }
  // App Store Connect takes a moment to hand the versions back.
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    let catalog = await fetchSafariCatalog();
    const stuck = catalog.versions.filter(
      (v) =>
        keys.some((key) => SAFARI_PLATFORMS[key].asc === v.platform) &&
        !EDITABLE_VERSION_STATES.has(v.state) &&
        !RELEASED_VERSION_STATES.has(v.state)
    );
    if (stuck.length === 0) return catalog;
    if (Date.now() > deadline) {
      throw new Error(
        `Still waiting for ${stuck.map((v) => `${v.platform} ${v.versionString} (${v.state})`).join(', ')}. ` +
          'Check App Store Connect.'
      );
    }
    await sleep(15_000);
  }
}

async function publishSafari(options) {
  console.log('==> Authenticating with App Store Connect');
  let catalog = await fetchSafariCatalog();
  console.log(`App Store app ${catalog.app.attributes.name} (${catalog.app.id}):\n${describeSafariStatus(catalog)}`);
  if (options.status) return;

  if (options.cancelReview) {
    console.log('==> Taking the version(s) in review out of review');
    const keys = options.platform === 'both' ? ['macos', 'ios'] : [options.platform];
    catalog = (await cancelSafariReviews(catalog.app, keys)) ?? catalog;
  }

  const plan = planSafariRelease(catalog, options);
  console.log(describeSafariPlan(plan));
  if (!options.releaseNotes) {
    const message = "--release-notes is required for Safari; it becomes the version's What's New text.";
    if (!options.dryRun) throw new UsageError(message);
    console.warn(`Warning: ${message}`);
  }
  if (options.dryRun) {
    console.log('Dry run: nothing uploaded or submitted.');
    return;
  }

  if (plan.upload) {
    const buildNumber = String(plan.platforms[0].buildNumber);
    console.log(`==> Building and uploading ${plan.marketingVersion} (${buildNumber})`);
    try {
      execFileSync(
        'bash',
        [
          join(REPO_ROOT, 'upload-safari-build.sh'),
          '--marketing-version',
          plan.marketingVersion,
          '--build-number',
          buildNumber,
          '--platform',
          options.platform,
          ...(options.regenerate ? ['--regenerate'] : []),
        ],
        { cwd: REPO_ROOT, stdio: 'inherit' }
      );
    } catch {
      throw new Error(
        'upload-safari-build.sh failed; see its output above. If one platform did upload, submit it with ' +
          `--skip-build --platform <macos|ios> --marketing-version ${plan.marketingVersion}.`
      );
    }
  }

  console.log('==> Waiting for App Store Connect to process the builds, then submitting');
  for (const platform of plan.platforms) {
    await submitSafariPlatform(catalog.app, plan, platform, options.releaseNotes);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  loadEnv();
  // --skip-build publishes builds that are already uploaded, so the working
  // tree doesn't matter.
  const building = !options.status && !options.dryRun && !options.skipBuild;
  if (building && !options.allowDirty) assertCleanTree();

  if (options.browser === 'chrome') {
    await publishChrome(options);
  } else if (options.browser === 'firefox') {
    await publishFirefox(options);
  } else {
    await publishSafari(options);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  if (error instanceof UsageError) {
    console.error('Run with --help for usage.');
  }
  process.exit(1);
});
