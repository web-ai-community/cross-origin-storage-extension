// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Receives the Cross-Origin Storage extension's anonymous usage reports (see
// `telemetry.js` in the extension) and appends them to the spreadsheet this
// script is bound to: one Installs row and the Population rows per weekly
// snapshot, and the Usage rows from every daily report. `setUpSummaries()`
// adds tabs that rank the data. Setup is in README.md.
//
// The endpoint is public and its URL ships in the extension's source, so
// anyone can post to it. Everything is validated against the report format
// and size-capped, which keeps junk out of the columns, though it can't
// tell a real report from a well-formed fake one.

const SCHEMA_VERSION = 1;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_ROWS_PER_REPORT = 5000;
const MAX_COUNT = 10000000;

const HASH_RE = /^(?:[0-9a-f]{64}|other)$/;
const ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A snapshot's period: an ISO week (`2026-W41`), or a month (`2026-10`) from
// extension versions before 0.1.32, which sent monthly snapshots.
const PERIOD_RE = /^\d{4}-(?:W(?:0[1-9]|[1-4]\d|5[0-3])|0[1-9]|1[0-2])$/;
const VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const PHL_VERSION_RE = /^[\w.:+-]{1,64}$/;
const MIME_TYPE_RE =
  /^(?:[a-z0-9][\w!#$&^.+-]{0,63}\/(?:[a-z0-9][\w!#$&^.+-]{0,63}|\*))?$/;
const BROWSERS = ['chrome', 'firefox', 'safari'];
const EVENTS = ['hit', 'miss', 'store'];
const RELATIONS = ['same', 'cross', 'unknown', ''];
const APIS = ['getFileHandle', 'declarative', 'fetch', 'css'];
const VISIBILITIES = ['global', 'list', 'same-site', ''];

// Every column is plain text except the numeric ones, so Sheets doesn't
// read a hash like `1234e5…` as a number or a period like `2026-10` as a date.
// The summary formulas in `SUMMARIES` refer to these columns by letter, so
// add new columns at the end.
const SHEETS = {
  Installs: [
    ['Received', '@'], // A
    ['Week', '@'], // B
    ['Install ID', '@'], // C
    ['Version', '@'], // D
    ['Browser', '@'], // E
    ['PHL version', '@'], // F
    ['Resources', '0'], // G
    ['PHL resources', '0'], // H
    ['Bytes', '0'], // I
    ['Origins', '0'], // J
    ['Sites', '0'], // K
    ['Dedup savings', '0'], // L
  ],
  Population: [
    ['Received', '@'], // A
    ['Week', '@'], // B
    ['Install ID', '@'], // C
    ['Version', '@'], // D
    ['Browser', '@'], // E
    ['PHL version', '@'], // F
    ['Hash', '@'], // G
    ['MIME type', '@'], // H
    ['Size', '0'], // I
    ['Visibility', '@'], // J
    ['Origins', '0'], // K
    ['Sites', '0'], // L
    ['Count', '0'], // M
  ],
  Usage: [
    ['Received', '@'], // A
    ['Week', '@'], // B
    ['Install ID', '@'], // C
    ['Version', '@'], // D
    ['Browser', '@'], // E
    ['PHL version', '@'], // F
    ['Hash', '@'], // G
    ['MIME type', '@'], // H
    ['Event', '@'], // I
    ['Relation', '@'], // J
    ['API', '@'], // K
    ['Count', '0'], // L
    ['Bytes', '0'], // M
  ],
};

function doGet() {
  return textOutput('Cross-Origin Storage telemetry endpoint');
}

function doPost(e) {
  let report;
  try {
    report = parseReport(e);
  } catch (error) {
    return textOutput(`rejected: ${error.message}`);
  }
  // The day only, in UTC, so rows can't be lined up with each other by time.
  const now = new Date();
  const received = Utilities.formatDate(now, 'UTC', 'yyyy-MM-dd');
  const week = isoWeek(now);
  const common = [
    report.id,
    report.version,
    report.browser,
    report.phlVersion ?? '',
  ];

  const usageRows = report.usage.map((u) => [
    received,
    week,
    ...common,
    u.hash,
    u.mimeType,
    u.event,
    u.relation,
    u.api,
    u.count,
    u.bytes,
  ]);

  const installRows = [];
  const populationRows = [];
  const { snapshot } = report;
  const snapshotWeek = snapshot?.week ?? snapshot?.month;
  if (snapshot) {
    const i = snapshot.install;
    installRows.push([
      received,
      snapshotWeek,
      ...common,
      i.resources,
      i.listedResources,
      i.bytes,
      i.origins,
      i.sites,
      i.dedupBytes,
    ]);
    for (const r of snapshot.resources) {
      populationRows.push([
        received,
        snapshotWeek,
        ...common,
        r.hash,
        r.mimeType,
        r.size ?? '',
        r.visibility,
        r.origins ?? '',
        r.sites ?? '',
        r.count,
      ]);
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    appendRows('Installs', installRows);
    appendRows('Population', populationRows);
    appendRows('Usage', usageRows);
  } finally {
    lock.releaseLock();
  }
  return textOutput('ok');
}

function parseReport(e) {
  const body = e?.postData?.contents;
  check(typeof body === 'string' && body.length <= MAX_BODY_LENGTH, 'body');
  const report = JSON.parse(body);

  check(report.schema === SCHEMA_VERSION, 'schema');
  check(ID_RE.test(report.id), 'id');
  check(VERSION_RE.test(report.version), 'version');
  check(BROWSERS.includes(report.browser), 'browser');
  check(
    report.phlVersion == null || PHL_VERSION_RE.test(report.phlVersion),
    'phlVersion',
  );

  check(Array.isArray(report.usage), 'usage');
  check(report.usage.length <= MAX_ROWS_PER_REPORT, 'usage length');
  for (const u of report.usage) {
    check(HASH_RE.test(u.hash), 'usage hash');
    check(isMimeType(u.mimeType), 'usage mimeType');
    check(EVENTS.includes(u.event), 'usage event');
    check(RELATIONS.includes(u.relation), 'usage relation');
    check(APIS.includes(u.api), 'usage api');
    check(isCount(u.count), 'usage count');
    check(isAmount(u.bytes), 'usage bytes');
  }

  if (report.snapshot != null) {
    const { install, resources } = report.snapshot;
    check(
      PERIOD_RE.test(report.snapshot.week ?? report.snapshot.month),
      'snapshot week',
    );
    check(install != null, 'snapshot install');
    for (const field of [
      'resources',
      'listedResources',
      'bytes',
      'origins',
      'sites',
      'dedupBytes',
    ]) {
      check(isAmount(install[field]), `snapshot install ${field}`);
    }
    check(Array.isArray(resources), 'snapshot resources');
    check(resources.length <= MAX_ROWS_PER_REPORT, 'snapshot length');
    for (const r of resources) {
      check(HASH_RE.test(r.hash), 'snapshot hash');
      check(isMimeType(r.mimeType), 'snapshot mimeType');
      check(r.size == null || isAmount(r.size), 'snapshot size');
      check(VISIBILITIES.includes(r.visibility), 'snapshot visibility');
      check(r.origins == null || isAmount(r.origins), 'snapshot origins');
      check(r.sites == null || isAmount(r.sites), 'snapshot sites');
      check(isCount(r.count), 'snapshot count');
    }
  }
  return report;
}

function isMimeType(value) {
  return typeof value === 'string' && MIME_TYPE_RE.test(value);
}

function isCount(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_COUNT;
}

function isAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function check(condition, field) {
  if (!condition) throw new Error(`invalid ${field}`);
}

function sheetFor(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    const headers = SHEETS[sheetName].map(([header]) => header);
    sheet = spreadsheet.insertSheet(sheetName);
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendRows(sheetName, rows) {
  if (!rows.length) return;
  const formats = SHEETS[sheetName].map(([, format]) => format);
  const sheet = sheetFor(sheetName);
  const range = sheet.getRange(
    sheet.getLastRow() + 1,
    1,
    rows.length,
    formats.length,
  );
  range.setNumberFormats(rows.map(() => formats));
  range.setValues(rows);
}

// The ISO 8601 week of `date` in UTC, as `YYYY-Www`. Must match
// currentWeek() in the extension's telemetry.js.
function isoWeek(date) {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function textOutput(text) {
  return ContentService.createTextOutput(text).setMimeType(
    ContentService.MimeType.TEXT,
  );
}

// Deletes every report, keeping the header rows, for example after testing.
// Run it from the Apps Script editor. It can't be undone there, though the
// spreadsheet's version history still has the old data. The summary tabs
// are formulas and empty themselves.
function resetData() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    for (const name of Object.keys(SHEETS)) {
      const sheet = sheetFor(name);
      const rows = sheet.getLastRow() - 1;
      if (rows > 0) {
        // Clearing leaves the rows in place, since a sheet can't lose all
        // its non-frozen rows, and `appendRows()` writes below the last
        // row with content anyway.
        sheet.getRange(2, 1, rows, SHEETS[name].length).clearContent();
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// Summary tabs, each a live QUERY over the data tabs. Those without
// `allWeeks` show one week, picked in B1: the latest by default, or any
// `YYYY-Www` typed over it. `week` is the cell reference to splice into the
// query.
const SUMMARIES = {
  Overview: {
    note: 'Per week: installs that sent a snapshot, and what their caches hold.',
    allWeeks: true,
    query: () =>
      `=QUERY(Installs!A:L, "select B, count(C), sum(G), sum(H), sum(I), avg(J), avg(K), sum(L) where B is not null group by B order by B desc label B 'Week', count(C) 'Installs', sum(G) 'Resources', sum(H) 'PHL resources', sum(I) 'Bytes', avg(J) 'Origins per install', avg(K) 'Sites per install', sum(L) 'Dedup savings'", 1)`,
  },
  'Installs by browser': {
    note: 'Per week: participating installs per browser.',
    allWeeks: true,
    query: () =>
      `=QUERY(Installs!A:L, "select B, count(C) where B is not null group by B pivot E label B 'Week'", 1)`,
  },
  'Installs by version': {
    note: 'Participating installs per extension version and browser.',
    query: (week) =>
      `=QUERY(Installs!A:L, "select D, count(C) where B = '"&${week}&"' group by D pivot E label D 'Version'", 1)`,
  },
  'Most stored': {
    note: 'Public Hash List resources by the number of installs storing them.',
    query: (week) =>
      `=QUERY(Population!A:M, "select G, H, max(I), count(C), sum(L), max(L) where B = '"&${week}&"' and G <> 'other' group by G, H order by count(C) desc label G 'Hash', H 'MIME type', max(I) 'Size', count(C) 'Installs', sum(L) 'Sites (sum over installs)', max(L) 'Most sites on one install'", 1)`,
  },
  'Most shared': {
    note: 'Public Hash List resources by the number of distinct sites using them, summed over installs.',
    query: (week) =>
      `=QUERY(Population!A:M, "select G, H, max(I), sum(L), sum(K), count(C) where B = '"&${week}&"' and G <> 'other' group by G, H order by sum(L) desc label G 'Hash', H 'MIME type', max(I) 'Size', sum(L) 'Sites (sum over installs)', sum(K) 'Origins (sum over installs)', count(C) 'Installs'", 1)`,
  },
  'Most hit': {
    note: 'Public Hash List resources by hits, with the bytes those hits served.',
    query: (week) =>
      `=QUERY(Usage!A:M, "select G, H, sum(L), sum(M) where B = '"&${week}&"' and I = 'hit' and G <> 'other' group by G, H order by sum(L) desc label G 'Hash', H 'MIME type', sum(L) 'Hits', sum(M) 'Bytes served'", 1)`,
  },
  'Hits by relation': {
    note: 'Hits per resource, by whether the requesting site is the one that stored it.',
    query: (week) =>
      `=QUERY(Usage!A:M, "select G, sum(L) where B = '"&${week}&"' and I = 'hit' group by G pivot J label G 'Hash'", 1)`,
  },
  Events: {
    note: 'Hits, misses, and stores per API. Hit ratio is hit / (hit + miss).',
    query: (week) =>
      `=QUERY(Usage!A:M, "select K, sum(L) where B = '"&${week}&"' group by K pivot I label K 'API'", 1)`,
  },
  'MIME types': {
    note: 'Stored resources by MIME type. Resources not on the Public Hash List appear by top-level type only.',
    query: (week) =>
      `=QUERY(Population!A:M, "select H, sum(M), sum(I) where B = '"&${week}&"' group by H order by sum(M) desc label H 'MIME type', sum(M) 'Resources', sum(I) 'Bytes'", 1)`,
  },
};

// Run once from the Apps Script editor. Running it again rebuilds the tabs.
function setUpSummaries() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  // The QUERY formulas need the data tabs to exist, and their header rows to
  // match SHEETS (the period column was once called Month).
  for (const [name, columns] of Object.entries(SHEETS)) {
    sheetFor(name)
      .getRange(1, 1, 1, columns.length)
      .setValues([columns.map(([header]) => header)]);
  }
  for (const [name, { note, allWeeks, query }] of Object.entries(SUMMARIES)) {
    const existing = spreadsheet.getSheetByName(name);
    if (existing) spreadsheet.deleteSheet(existing);
    const sheet = spreadsheet.insertSheet(name);
    if (allWeeks) {
      sheet.getRange('A1').setValue(note);
      sheet.getRange('A2').setFormula(query());
    } else {
      sheet.getRange('A1').setValue('Week');
      sheet
        .getRange('B1')
        .setNumberFormat('@')
        .setFormula(
          '=IFERROR(INDEX(SORT(UNIQUE(FILTER(Installs!B2:B, Installs!B2:B <> "")), 1, FALSE), 1), "")',
        );
      sheet.getRange('C1').setValue(note);
      sheet.getRange('A2').setFormula(query('$B$1'));
    }
    sheet.getRange('A1:C1').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}
