// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Shows where the resources in COS appear on the Public Hash List.
//
// Each hash on the list is preceded by a comment naming where it was seen,
// with an example URL. Storing those for all ~440,000 entries would cost tens
// of megabytes, so the background keeps them only for the resources in COS
// while it parses the list it just downloaded. This page reads those, and
// only offers to read the published file again for resources the stored
// provenance doesn't cover, such as ones added since that download.
//
// Opened from the popup's "On PHL" / "Not on PHL" badges, which pass the
// resource's hash in the query string to highlight it.

import ResourceManager from './resource-manager.js';
import {
  PHL_URL,
  mergeStoredProvenance,
  readRawPublicHashList,
  readStoredPublicHashListMeta,
  storeRawPublicHashList,
} from './public-hash-list.js';

const retryButton = document.getElementById('scan-retry');
const scanStatus = document.getElementById('scan-status');
const scanProgress = document.getElementById('scan-progress');
const scanMeter = document.getElementById('scan-meter');
const scanProgressText = document.getElementById('scan-progress-text');
const entriesNote = document.getElementById('entries-note');
const listMeta = document.getElementById('list-meta');
const entriesTable = document.getElementById('entries');
const entriesBody = document.getElementById('entries-body');
const entriesEmpty = document.getElementById('entries-empty');
const resourcesDesc = document.getElementById('resources-desc');

const SECTION_RE = /^\/\/\s*===(BEGIN|END)\s+(SHA-256(?:\s+[A-Z-]+)?)\s*===/;
const HEX64_RE = /^[a-f0-9]{64}$/;
// "// HTTP Archive — e.g. https://example.com/app.js"
const PROVENANCE_RE = /^\/\/\s*(.+?)\s+(?:—|--)\s*e\.g\.\s*(\S+)/;

// The list's core section holds nearly everything, so only the other two are
// worth marking. See the section comments in the published file.
const SECTION_NOTES = {
  'SHA-256 HUGGING-FACE': {
    label: 'Optional section',
    tooltip:
      'From the Hugging Face section, which browsers may leave out, so another browser may not treat this as eligible.',
  },
  'SHA-256 MANUAL': {
    label: 'Manual entry',
    tooltip: 'Hand-curated addition, reviewed via pull request. Browsers must treat it as eligible.',
  },
};

const highlightHash = new URLSearchParams(location.search).get('hash');

// Hash -> { comment, section }, from storage and from any read of the file.
const provenance = new Map();
// Hash -> byte size, from the resource manager.
const resourceSizes = new Map();
let listedHashes = new Set();
let resourceHashes = [];
let listAvailable = false;
let storedMeta = { header: [], provenance: {}, fetchedAt: 0, version: null };
let hashesToResolve = new Set();

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

/**
 * Streams the published list, filling in provenance for `wanted`.
 * @param {Set<string>} wanted
 * @param {(receivedBytes: number, totalBytes: number|null) => void} onProgress
 */
async function readPublicHashList(wanted, onProgress) {
  // The copy kept when the list was downloaded, if there is one. Reading it
  // costs no network at all.
  let response = await readRawPublicHashList();
  const fromStoredCopy = !!response;
  if (!response) {
    response = await fetch(PHL_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching the Public Hash List`);
    }
  }
  const totalBytes = Number(response.headers.get('content-length')) || null;
  // Keep the bytes of a downloaded list, so this is the last time it has to
  // be fetched. A stored copy is already kept.
  const rawChunks = fromStoredCopy ? null : [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  const header = [];
  let section = null;
  let lastComment = null;
  let hashCount = 0;
  let receivedBytes = 0;
  let pending = '';
  let sawFirstHash = false;

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('//')) {
      const sectionMatch = line.match(SECTION_RE);
      if (sectionMatch) {
        section = sectionMatch[1] === 'BEGIN' ? sectionMatch[2] : null;
        lastComment = null;
        return;
      }
      if (!sawFirstHash) header.push(line.replace(/^\/\/\s?/, ''));
      lastComment = line;
      return;
    }
    if (!HEX64_RE.test(line)) return;
    sawFirstHash = true;
    hashCount++;
    if (wanted.has(line)) {
      provenance.set(line, { comment: lastComment, section });
      listedHashes.add(line);
    }
    lastComment = null;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.length;
    rawChunks?.push(value);
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    // The last piece may be half a line, so hold it back for the next chunk.
    pending = lines.pop();
    for (const line of lines) handleLine(line);
    onProgress(receivedBytes, totalBytes);
  }
  handleLine(pending);

  if (rawChunks) {
    const raw = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of rawChunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }
    await storeRawPublicHashList(raw);
  }
  // Remember what was found, so the next visit needs no read at all.
  const discovered = {};
  for (const hash of wanted) {
    if (provenance.has(hash)) discovered[hash] = provenance.get(hash);
  }
  await mergeStoredProvenance(discovered);

  return { header, hashCount, receivedBytes, fromStoredCopy };
}

function parseProvenance(entry) {
  if (!entry?.comment) return null;
  const match = entry.comment.match(PROVENANCE_RE);
  if (!match) return { source: entry.comment.replace(/^\/\/\s?/, ''), url: null };
  const [, source, url] = match;
  // Only ever link to the web.
  return { source, url: /^https?:\/\//i.test(url) ? url : null };
}

function renderMeta(rows) {
  listMeta.innerHTML = '';
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    listMeta.append(dt, dd);
  }
  listMeta.hidden = rows.length === 0;
}

function metaRows(stored, scan) {
  const labels = { VERSION: 'Version', COMMIT: 'Commit', Algorithm: 'Algorithm', License: 'License' };
  const rows = [];
  for (const line of scan?.header ?? stored.header) {
    const match = line.match(/^([A-Za-z][A-Za-z -]*):\s*(.+)$/);
    if (match && labels[match[1]]) rows.push([labels[match[1]], match[2]]);
  }
  if (stored.fetchedAt && !scan) {
    rows.push(['Downloaded', new Date(stored.fetchedAt).toLocaleString()]);
  }
  if (scan) {
    rows.push(['Hashes on the list', scan.hashCount.toLocaleString()]);
    rows.push(['Read just now', formatBytes(scan.receivedBytes)]);
  }
  return rows;
}

let sortKey = 'size';
let sortAscending = false;

function formatSize(bytes) {
  return bytes === undefined || bytes === null ? '' : formatBytes(bytes);
}

// Only resources that are on the list: the others have no entry to show.
function listedRows() {
  return resourceHashes
    .filter((hash) => listedHashes.has(hash))
    .map((hash) => {
      const entry = provenance.get(hash);
      const parsed = parseProvenance(entry);
      return {
        hash,
        size: resourceSizes.get(hash) ?? null,
        section: entry?.section ?? '',
        source: parsed?.source ?? '',
        url: parsed?.url ?? '',
      };
    });
}

function sortRows(rows) {
  const direction = sortAscending ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortKey === 'size') return ((a.size ?? -1) - (b.size ?? -1)) * direction;
    return String(a[sortKey]).localeCompare(String(b[sortKey])) * direction;
  });
}

function renderEntries() {
  const rows = listedRows();
  entriesBody.innerHTML = '';
  for (const row of sortRows(rows)) {
    const { hash } = row;
    const tr = document.createElement('tr');
    tr.id = `hash-${hash}`;
    if (hash === highlightHash) tr.className = 'phl-row--highlight';

    const hashCell = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = hash;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-btn';
    copy.textContent = 'Copy hash';
    copy.addEventListener('click', () => navigator.clipboard.writeText(hash));
    hashCell.append(code, ' ', copy);

    const sizeCell = document.createElement('td');
    sizeCell.className = 'phl-size';
    sizeCell.textContent = formatSize(row.size);

    const sourceCell = document.createElement('td');
    sourceCell.textContent = row.source;
    const sectionNote = SECTION_NOTES[row.section];
    if (sectionNote) {
      const badge = document.createElement('span');
      badge.className = 'resource-page-badge phl-section-badge tip-host';
      badge.textContent = sectionNote.label;
      badge.dataset.tooltip = sectionNote.tooltip;
      sourceCell.append(' ', badge);
    }

    const urlCell = document.createElement('td');
    if (row.url) {
      const link = document.createElement('a');
      link.href = row.url;
      link.textContent = row.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'phl-url';
      urlCell.append(link);
    } else if (row.source) {
      urlCell.append('no example URL');
    } else {
      urlCell.className = 'empty-state';
      urlCell.textContent = 'Read the list to see where this was seen.';
    }

    tr.append(hashCell, sizeCell, sourceCell, urlCell);
    entriesBody.append(tr);
  }

  entriesTable.hidden = rows.length === 0;
  entriesEmpty.hidden = rows.length > 0;
  if (rows.length === 0) {
    entriesEmpty.textContent = listAvailable
      ? 'No resource in Cross-Origin Storage is on the Public Hash List.'
      : "The Public Hash List hasn't been downloaded, so there is nothing to compare against yet.";
  }

  // Say what the table leaves out, including the resource that was linked to.
  const hidden = resourceHashes.length - rows.length;
  const notes = [];
  if (hidden > 0) {
    notes.push(`${hidden} of ${resourceHashes.length} ${hidden === 1 ? 'is' : 'are'} not on the list and ${hidden === 1 ? 'is' : 'are'} not shown.`);
  }
  if (highlightHash && !listedHashes.has(highlightHash)) {
    notes.push('The resource this page was opened for is not on the list.');
  }
  entriesNote.textContent = notes.join(' ');
  entriesNote.hidden = notes.length === 0;

  if (highlightHash) {
    document.getElementById(`hash-${highlightHash}`)?.scrollIntoView({ block: 'center' });
  }
  return rows.filter((row) => !row.source).length;
}

function renderSortHeaders() {
  for (const th of entriesTable.querySelectorAll('th[data-sort]')) {
    const key = th.dataset.sort;
    th.ariaSort = sortKey === key ? (sortAscending ? 'ascending' : 'descending') : 'none';
    th.classList.toggle('phl-sorted', sortKey === key);
    if (th.dataset.wired) continue;
    th.dataset.wired = 'true';
    th.tabIndex = 0;
    th.addEventListener('click', () => {
      // Clicking the sorted column reverses it; a new column starts
      // descending for size and ascending for text.
      if (sortKey === key) {
        sortAscending = !sortAscending;
      } else {
        sortKey = key;
        sortAscending = key !== 'size';
      }
      renderSortHeaders();
      renderEntries();
    });
    th.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        th.click();
      }
    });
  }
}

async function run() {
  const resourceManager = new ResourceManager();
  await resourceManager.loadManagerFromStorage();
  const hashes = new Set(resourceManager.getAllHashes());
  if (highlightHash) hashes.add(highlightHash);
  resourceHashes = [...hashes];
  hashesToResolve = hashes;
  for (const hash of resourceHashes) {
    const size = resourceManager.getSizeByHash(hash);
    if (size !== undefined) resourceSizes.set(hash, size);
  }

  if (resourceHashes.length === 0) {
    entriesEmpty.hidden = false;
    entriesEmpty.textContent = 'There are no resources in Cross-Origin Storage yet.';
    scanStatus.textContent = '';
    return;
  }
  resourcesDesc.textContent =
    `Cross-Origin Storage holds ${resourceHashes.length} resource` +
    `${resourceHashes.length === 1 ? '' : 's'}.`;

  storedMeta = await readStoredPublicHashListMeta();
  for (const [hash, entry] of Object.entries(storedMeta.provenance)) {
    if (hashes.has(hash)) provenance.set(hash, entry);
  }

  // Membership comes from the background, which holds the hash set in memory;
  // reading the whole set into this page would cost tens of megabytes.
  const response = await chrome.runtime.sendMessage({
    action: 'getPublicHashListStatus',
    data: { hashes: resourceHashes, download: false },
  });
  listAvailable = !!response?.data?.available;
  listedHashes = new Set(response?.data?.listed ?? []);

  renderMeta(metaRows(storedMeta, null));
  renderSortHeaders();
  let missing = renderEntries();
  if (missing === 0) return;

  // Anything the stored provenance doesn't cover is read from the kept copy
  // of the list, or failing that from GitHub. No reason to ask first: showing
  // this is what the page is for.
  await readAndRender();

  retryButton.addEventListener('click', readAndRender);
}

async function readAndRender() {
  retryButton.hidden = true;
  scanMeter.hidden = false;
  scanProgress.removeAttribute('value');
  scanProgressText.textContent = '';
  scanStatus.textContent = 'Reading the list…';
  try {
    const scan = await readPublicHashList(hashesToResolve, (receivedBytes, totalBytes) => {
      if (!totalBytes) {
        scanProgressText.textContent = formatBytes(receivedBytes);
        return;
      }
      scanProgress.max = totalBytes;
      scanProgress.value = receivedBytes;
      const percent = String(Math.round((receivedBytes / totalBytes) * 100)).padStart(3, '\u2007');
      const total = formatBytes(totalBytes);
      const received = formatBytes(receivedBytes).padStart(total.length, '\u2007');
      scanProgressText.textContent = `${percent}% (${received} of ${total})`;
    });
    listAvailable = true;
    renderMeta(metaRows(storedMeta, scan));
    renderEntries();
    scanStatus.textContent = '';
  } catch (error) {
    scanStatus.textContent = `Couldn't read the list: ${error.message}`;
    retryButton.hidden = false;
  } finally {
    scanMeter.hidden = true;
  }
}

run();
