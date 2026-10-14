// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Download statistics for the prototype browser builds listed under
// "Prototype Browser Implementations" on the Awesome Cross-Origin Storage
// page. Independent of the extension's telemetry: it reads the browser list
// from that page, asks the GitHub API how often each release asset was
// downloaded, and writes two tabs:
//
//   - Downloads: per-browser totals with a grand total, downloads per browser
//     and platform, and every release asset. Rebuilt on every run.
//   - Download history: each browser's running total, one row per browser
//     per day, so growth over time can be charted. GitHub only reports
//     running totals, so this is the only record of when downloads happened.
//
// Run updateDownloadStats() by hand, or installDailyDownloadStats() once to
// have it run every day. Unauthenticated GitHub API calls are limited per IP
// address, and Apps Script shares its addresses with other scripts, so a
// GitHub token (no scopes needed for public repositories) in the script
// property GITHUB_TOKEN avoids running into that limit.

const DOWNLOADS_PAGE_URL =
  'https://tomayac.github.io/awesome-cross-origin-storage/';
const DOWNLOADS_SECTION_ID = 'prototype-browser-implementations';
const DOWNLOADS_SHEET = 'Downloads';
const DOWNLOAD_HISTORY_SHEET = 'Download history';

// Used if the page can't be read or its layout changes.
const FALLBACK_BROWSERS = [
  { name: 'Chromium', owner: 'tomayac', repo: 'Chromium' },
  { name: 'Firefox', owner: 'tomayac', repo: 'firefox' },
  { name: 'Ladybird', owner: 'tomayac', repo: 'ladybird' },
  { name: 'Servo', owner: 'tomayac', repo: 'servo' },
  { name: 'WebKit', owner: 'tomayac', repo: 'WebKit' },
];

function updateDownloadStats() {
  const browsers = listPrototypeBrowsers();
  const assets = [];
  for (const browser of browsers) {
    for (const release of fetchReleases(browser)) {
      if (release.draft) continue;
      for (const asset of release.assets) {
        assets.push({
          browser: browser.name,
          release: release.tag_name,
          published: (release.published_at || '').slice(0, 10),
          prerelease: release.prerelease,
          asset: asset.name,
          platform: platformOf(asset.name),
          sizeMB: Math.round((asset.size / 1e6) * 10) / 10,
          downloads: asset.download_count,
          url: asset.browser_download_url,
        });
      }
    }
  }
  writeDownloadsSheet(browsers, assets);
  appendDownloadHistory(browsers, assets);
}

// Runs updateDownloadStats() once a day. Run this once; running it again
// replaces the trigger instead of adding a second one.
function installDailyDownloadStats() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'updateDownloadStats') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  ScriptApp.newTrigger('updateDownloadStats')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
}

// The browsers in the page's "Prototype Browser Implementations" list: each
// item's first link names the browser, and its binaries link points at a
// GitHub releases page.
function listPrototypeBrowsers() {
  try {
    const html = UrlFetchApp.fetch(DOWNLOADS_PAGE_URL).getContentText();
    const start = html.indexOf(`id="${DOWNLOADS_SECTION_ID}"`);
    if (start < 0) throw new Error('section not found');
    const end = html.indexOf('<h2', start + 1);
    const section = html.slice(start, end < 0 ? undefined : end);
    const browsers = [];
    for (const [, item] of section.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
      const name = item.match(/<a [^>]*>([^<]+)<\/a>/)?.[1].trim();
      const repo = item.match(
        /href="https:\/\/github\.com\/([^/"]+)\/([^/"]+)\/releases\/?"/,
      );
      if (name && repo) {
        browsers.push({ name, owner: repo[1], repo: repo[2] });
      }
    }
    if (!browsers.length) throw new Error('no release links found');
    return browsers;
  } catch (error) {
    console.warn(`Using the built-in browser list: ${error.message}`);
    return FALLBACK_BROWSERS;
  }
}

function fetchReleases({ owner, repo }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token =
    PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases = [];
  let url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
  while (url) {
    const response = UrlFetchApp.fetch(url, {
      headers,
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) {
      throw new Error(
        `GitHub API ${response.getResponseCode()} for ${owner}/${repo}: ${response.getContentText().slice(0, 200)}`,
      );
    }
    releases.push(...JSON.parse(response.getContentText()));
    const link = response.getHeaders().Link || response.getHeaders().link || '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return releases;
}

// A readable platform from an asset's file name, such as "macOS arm64" or
// "Linux x64". Names that say nothing about the platform are "Other".
function platformOf(name) {
  const os = /mac|darwin|\.dmg$/i.test(name)
    ? 'macOS'
    : /win|\.exe$|msvc/i.test(name)
      ? 'Windows'
      : /linux|gtk/i.test(name)
        ? 'Linux'
        : 'Other';
  const arch = /arm64|aarch64/i.test(name)
    ? 'arm64'
    : /x86_64|x64|amd64|win64/i.test(name)
      ? 'x64'
      : '';
  return arch ? `${os} ${arch}` : os;
}

function sum(rows, key = 'downloads') {
  return rows.reduce((total, row) => total + row[key], 0);
}

function writeDownloadsSheet(browsers, assets) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet =
    spreadsheet.getSheetByName(DOWNLOADS_SHEET) ||
    spreadsheet.insertSheet(DOWNLOADS_SHEET);
  sheet.clear();
  const blocks = [];
  let row = 1;
  const put = (values, { bold = false, header = false } = {}) => {
    const width = values[0].length;
    const range = sheet.getRange(row, 1, values.length, width);
    range.setValues(values);
    if (header) {
      sheet.getRange(row, 1, 1, width).setFontWeight('bold');
    }
    if (bold) {
      sheet
        .getRange(row + values.length - 1, 1, 1, width)
        .setFontWeight('bold');
    }
    blocks.push({ row, height: values.length, width });
    row += values.length + 1;
  };

  sheet
    .getRange(row, 1, 1, 2)
    .setValues([
      [
        'Prototype browser downloads',
        `Updated ${Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm')} UTC from GitHub releases`,
      ],
    ]);
  sheet.getRange(row, 1).setFontWeight('bold').setFontSize(12);
  row += 2;

  // Per browser, with a total.
  const perBrowser = browsers.map(({ name }) => {
    const own = assets.filter((a) => a.browser === name);
    const releases = [...new Set(own.map((a) => a.release))];
    const latest = own
      .slice()
      .sort((a, b) => b.published.localeCompare(a.published))[0];
    const latestDownloads = latest
      ? sum(own.filter((a) => a.release === latest.release))
      : 0;
    const top = own.slice().sort((a, b) => b.downloads - a.downloads)[0];
    return [
      name,
      releases.length,
      own.length,
      sum(own),
      latest ? `${latest.release} (${latest.published})` : '',
      latestDownloads,
      top && top.downloads ? `${top.asset} (${top.downloads})` : '',
    ];
  });
  perBrowser.sort((a, b) => b[3] - a[3]);
  put(
    [
      [
        'Browser',
        'Releases',
        'Assets',
        'Downloads',
        'Latest release',
        'Latest release downloads',
        'Most downloaded asset',
      ],
      ...perBrowser,
      [
        'Total',
        sum(
          perBrowser.map((r) => ({ v: r[1] })),
          'v',
        ),
        assets.length,
        sum(assets),
        '',
        sum(
          perBrowser.map((r) => ({ v: r[5] })),
          'v',
        ),
        '',
      ],
    ],
    { header: true, bold: true },
  );

  // Per browser and platform.
  const platforms = [...new Set(assets.map((a) => a.platform))].sort();
  const byPlatform = perBrowser.map(([name]) => {
    const own = assets.filter((a) => a.browser === name);
    return [
      name,
      ...platforms.map((p) => sum(own.filter((a) => a.platform === p))),
      sum(own),
    ];
  });
  put(
    [
      ['Downloads by platform', ...platforms, 'Total'],
      ...byPlatform,
      [
        'Total',
        ...platforms.map((p) => sum(assets.filter((a) => a.platform === p))),
        sum(assets),
      ],
    ],
    { header: true, bold: true },
  );

  // Every asset.
  const detail = assets
    .slice()
    .sort(
      (a, b) =>
        a.browser.localeCompare(b.browser) ||
        b.published.localeCompare(a.published) ||
        b.downloads - a.downloads,
    )
    .map((a) => [
      a.browser,
      a.release,
      a.published,
      a.prerelease ? 'yes' : '',
      a.asset,
      a.platform,
      a.sizeMB,
      a.downloads,
    ]);
  put(
    [
      [
        'Browser',
        'Release',
        'Published',
        'Pre-release',
        'Asset',
        'Platform',
        'Size (MB)',
        'Downloads',
      ],
      ...detail,
    ],
    { header: true },
  );

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 8);
}

// One row per browser and a total per day; a second run on the same day
// replaces that day's rows.
function appendDownloadHistory(browsers, assets) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(DOWNLOAD_HISTORY_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(DOWNLOAD_HISTORY_SHEET);
    sheet
      .getRange(1, 1, 1, 3)
      .setValues([['Date', 'Browser', 'Downloads']])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const last = sheet.getLastRow();
  if (last > 1) {
    const dates = sheet.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i][0] === today) sheet.deleteRow(i + 2);
    }
  }
  const rows = browsers.map(({ name }) => [
    today,
    name,
    sum(assets.filter((a) => a.browser === name)),
  ]);
  rows.push([today, 'Total', sum(assets)]);
  const range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3);
  range.setNumberFormats(rows.map(() => ['@', '@', '0']));
  range.setValues(rows);
}
