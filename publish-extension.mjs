// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Builds the extension with zip-extension.sh and publishes it to the Chrome
// Web Store (API v2) or addons.mozilla.org (API v5). No dependencies: both
// APIs are plain HTTPS + JSON, and the JWTs they need are signed with
// node:crypto.
//
// Usage:
//   node publish-extension.mjs <chrome|firefox> [options]
//
// Options:
//   --status                Print what the store currently has (version,
//                           review state) and exit. Needs credentials, so
//                           it doubles as a check that they work.
//   --dry-run               Build, authenticate, and check the version, but
//                           stop before uploading anything.
//   --staged                Chrome only: once approved, hold the release
//                           instead of publishing it right away (publish it
//                           later from the Developer Dashboard).
//   --release-notes TEXT    Firefox only: release notes shown on AMO.
//   --approval-notes TEXT   Firefox only: notes for Mozilla's reviewers.
//   --allow-dirty           Publish even if the git working tree has
//                           uncommitted changes. The archive is built from
//                           the working tree, so by default that is refused.
//   -h, --help              Show this help and exit.
//
// Credentials are read from the environment or the gitignored .env file.
// See .env.example for the variables, and the "Publishing" section of
// README.md for the one-time setup in each store.

import { execFileSync } from 'node:child_process';
import { createHmac, createSign, randomUUID } from 'node:crypto';
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
        options.browser = arg;
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
    throw new UsageError('Say which store to publish to: chrome or firefox.');
  }
  if (options.browser === 'chrome' && (options.releaseNotes || options.approvalNotes)) {
    throw new UsageError(
      '--release-notes and --approval-notes are Firefox only; the Chrome Web Store API has no equivalent.'
    );
  }
  if (options.browser === 'firefox' && options.staged) {
    throw new UsageError('--staged is Chrome only.');
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  loadEnv();
  const publishing = !options.status && !options.dryRun;
  if (publishing && !options.allowDirty) assertCleanTree();

  if (options.browser === 'chrome') {
    await publishChrome(options);
  } else {
    await publishFirefox(options);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  if (error instanceof UsageError) {
    console.error('Run with --help for usage.');
  }
  process.exit(1);
});
