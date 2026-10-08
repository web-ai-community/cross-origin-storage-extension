<!--
  Copyright 2026 Google LLC.
  SPDX-License-Identifier: Apache-2.0
-->

# Telemetry backend

The extension's anonymous usage reports (see [`telemetry.js`](../telemetry.js))
go to a Google Apps Script web app, which appends them to a Google Sheet with
three data tabs:

- **Installs**: one row per install per week, with the cache totals the popup
  shows: resources, bytes, origins, sites, and deduplication savings.
- **Population**: one row per Public Hash List resource in an install's cache
  per week, with its MIME type, size, visibility tier, and how many origins and
  sites used it. Resources not on the list are folded into `other` rows, one per
  top-level MIME type (`font/*`).
- **Usage**: daily counts of hits, misses, and stores per Public Hash List hash,
  with bytes, the API path, and for hits, whether the requester is same-site
  with the storer. Other hashes are counted under `other`.

## Setup

1. Create a Google Sheet. The script creates the data tabs on first use.
2. In the sheet, open **Extensions → Apps Script**, replace the contents of
   `Code.gs` with [`Code.gs`](Code.gs), and save.
3. In the editor, select `setUpSummaries` in the function menu and click
   **Run**. This creates the summary tabs (see below), and asks you once to
   authorize the script to edit the spreadsheet.
4. Choose **Deploy → New deployment**, select the **Web app** type, set
   **Execute as** to **Me** and **Who has access** to **Anyone**, and deploy.
   Anyone means anonymous access, which the extension needs: it sends reports
   without cookies.
5. Copy the web app URL (it ends in `/exec`) into `TELEMETRY_ENDPOINT` in
   [`telemetry.js`](../telemetry.js).

To ship a change to `Code.gs` without changing the URL, use **Deploy → Manage
deployments**, edit the existing deployment, and pick **New version**. A new
deployment gets a new URL, which would strand every installed extension on the
old one.

Opening the URL in a browser runs `doGet()`, which answers with a one-line
status, as a quick check that the deployment is live.

## Summary tabs

`setUpSummaries()` adds tabs that rank the data with live `QUERY` formulas, so
they stay current as reports arrive. Except for Overview and Installs by
browser, each shows one ISO week, picked in cell B1: the latest week by default,
or any `YYYY-Www` typed over it. An install counts as participating in a week
when it sent that week's snapshot, which every opted-in install does once a
week, even with an empty cache. Versions before 0.1.32 sent monthly snapshots,
filed under their month (`YYYY-MM`).

| Tab                 | Ranks                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Overview            | Per week: installs, resources, bytes, origins and sites per install, dedup savings       |
| Installs by browser | Per week: participating installs per browser                                             |
| Installs by version | Participating installs per extension version, split by browser                           |
| Most stored         | Public Hash List resources by the number of installs storing them                        |
| Most shared         | Public Hash List resources by distinct sites using them, summed over installs            |
| Most hit            | Public Hash List resources by hits, with bytes served                                    |
| Hits by relation    | Hits per resource, split into same-site, cross-site, and unknown                         |
| Events              | Hits, misses, and stores per API, for the hit ratio                                      |
| MIME types          | Stored resources and bytes per MIME type, with unlisted resources by top-level type only |

Running `setUpSummaries()` again deletes and rebuilds these tabs, so put your
own analysis in other tabs.

## Resetting the data

To start over, for example after testing, select `resetData` in the editor's
function menu and click **Run**. It clears every row below the headers in
Installs, Population, and Usage, and the summary tabs empty themselves. There is
no undo in the editor, but **File → Version history** in the spreadsheet still
has the old data.

## Testing from a development install

Unpacked (development) installs never send to `TELEMETRY_ENDPOINT`, so your own
test runs don't land in the sheet. They log each report to the background
console instead. To send them somewhere for testing, set a debug endpoint from
the extension's service worker console:

```js
await chrome.storage.local.set({
  telemetryDebugEndpoint: 'https://script.google.com/macros/s/…/exec',
});
```

The 24-hour grace period after the notice, the time of the next daily report,
and the weekly snapshot can all be reset from the same console:

```js
await chrome.storage.local.remove([
  'telemetryNotBefore',
  'telemetryNextReport',
  'telemetrySnapshotWeek',
]);
```

The extension checks hourly whether a report is due. The service worker console
has no direct handle on the module, so the way to trigger that check is to fire
the alarm early (30 seconds is the shortest delay Chrome allows):

```js
await chrome.alarms.create('cos-telemetry-flush', {
  delayInMinutes: 0.5,
  periodInMinutes: 60,
});
```

## Report format

```json
{
  "schema": 1,
  "id": "random UUID, replaced every ISO week (UTC)",
  "version": "extension version",
  "browser": "chrome | firefox | safari",
  "phlVersion": "Public Hash List version used to classify hashes, or null",
  "usage": [
    {
      "hash": "64 hex digits, or other",
      "mimeType": "full type for listed hashes, top-level type (font/*) for other",
      "event": "hit | miss | store",
      "relation": "same | cross | unknown for hits, empty otherwise",
      "api": "getFileHandle | declarative | fetch | css",
      "count": 1,
      "bytes": "bytes served (hit) or written (store); rounded for other"
    }
  ],
  "snapshot": {
    "week": "YYYY-Www, the ISO week (UTC)",
    "install": {
      "resources": 3,
      "listedResources": 1,
      "bytes": "total size, rounded to two significant digits",
      "origins": 4,
      "sites": 3,
      "dedupBytes": "storage saved by sharing, rounded to two significant digits"
    },
    "resources": [
      {
        "hash": "64 hex digits, or other",
        "mimeType": "as in usage",
        "size": "exact for listed hashes, the rounded total for other",
        "visibility": "global | list | same-site, empty for other",
        "origins": "origins that used it, null for other",
        "sites": "distinct sites among those origins, null for other",
        "count": "1, or the number of resources in an other row"
      }
    ]
  }
}
```

`snapshot` is present in the first report of each week. `relation` says whether
the page that got a hit is same-site with the page that stored the resource;
`unknown` covers resources stored before the extension tracked storers. Origin
and site counts leave out `localhost` and `.test` origins. Deduplication savings
follow the popup: each origin past the first that uses a resource would
otherwise have stored its own copy.

## Limits

A Google Sheet holds at most 10 million cells, about 750,000 Usage rows. Once
the sheet nears that, move older rows to an archive spreadsheet, or replace them
with weekly totals.

The endpoint is public, so the numbers are indicative: anyone can post
well-formed reports. `Code.gs` rejects anything that doesn't match the format
above.
