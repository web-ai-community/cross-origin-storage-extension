### Privacy Policy for Cross-Origin Storage

**Effective Date:** October 6, 2026

#### 1. Introduction

This Privacy Policy governs the manner in which the "Cross-Origin Storage"
browser extension (hereinafter referred to as "the Extension") handles user
data. The privacy of our users is of paramount importance to us. The Extension's
functionality runs entirely on your device. The only data it sends anywhere is
the anonymous usage statistics described in section 3, which you can turn off.

We are committed to transparency and protecting your privacy. This policy aims
to clearly inform you about our data practices.

#### 2. Data Collection and Usage

**The Extension does not collect, store, transmit, or share any personally
identifiable information (PII), browsing history, or content of the pages you
visit.**

All functionality of the Extension is performed locally on your computer. We do
not have access to your browsing history, personal information, or any content
you interact with. Apart from the anonymous usage statistics in section 3, the
Extension contacts the network only to download public reference lists from
GitHub (the Public Suffix List, and the Public Hash List when needed).

#### 3. Anonymous Usage Statistics

To guide the development of the Cross-Origin Storage API, the Extension sends
anonymous usage statistics. This is on by default. When the Extension is
installed, or first updated to a version with this feature, it opens a page
explaining the statistics with a switch to turn them off. The same switch is in
the Extension's options. In Firefox, the setting is Firefox's "technical and
interaction data" permission. Nothing is sent until a day after that page
opened.

A report contains:

- **Once a month, per file on the Public Hash List:** for each file in your
  Cross-Origin Storage cache that is on the
  [Public Hash List](https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation),
  a public list of widely deployed files: its SHA-256 hash, size, MIME type,
  sharing setting (everyone, listed origins, or same-site), and the number of
  origins and sites that have used it. Other files are only counted, grouped by
  their top-level MIME type (such as `font/*`), with their total size rounded to
  two significant digits.
- **Once a month, cache totals:** the number of files, their total size, the
  number of origins and sites that have used the cache, and the storage saved by
  sharing, with sizes rounded to two significant digits.
- **Once a day:** for files on the Public Hash List, how often each was found,
  not found, or stored, the bytes involved, through which part of the API, and,
  for files found, whether the requesting site is the one that stored the file.
  Other files are again only counted.
- The Extension version, the browser (Chrome, Firefox, or Safari), and a random
  identifier that is replaced every calendar month.

Reports never contain URLs, origins, site names, or the hash of any file outside
the Public Hash List. Origins and sites are only counted. Activity on
`localhost` and `.test` domains is not counted. Reports are sent without cookies
to a Google Apps Script web app, which stores them in a Google Sheet accessible
to the Extension's maintainers. The script does not receive or store IP
addresses. The statistics are used only in aggregate, to understand which
resources are shared through Cross-Origin Storage and how often they are reused.

#### 4. Explanation of Required Permissions

The Chrome Web Store requires us to declare the permissions the Extension needs
to function. Below is an explanation of why each permission is necessary for the
operation of the Extension, and how they are used in a way that respects your
privacy.

- **`storage` and `unlimitedStorage`**:
  - **Purpose:** These permissions are fundamental to the core functionality of
    the Extension, which is to implement and demonstrate the Cross-Origin
    Storage API. The `storage` permission allows the Extension to save its own
    settings and data on your local machine using the `chrome.storage` API. The
    `unlimitedStorage` permission allows the Extension to request more than the
    standard storage quota, which may be necessary for its intended purpose.
  - **Privacy Assurance:** All data saved using these permissions is stored
    _locally_ on your device. It is never transmitted off your computer and is
    not accessible by us or any third party.

- **`tabs`**:
  - **Purpose:** This permission is required for the Extension's content scripts
    to interact with the web pages you visit and properly coordinate
    cross-origin storage operations between different tabs.
  - **Privacy Assurance:** While this permission provides access to tab
    properties like the URL, the Extension only uses this information
    ephemerally to execute its core function. It does **not** log, store, or
    transmit your browsing history or tab information.

- **`alarms`**:
  - **Purpose:** This permission schedules the daily usage statistics report
    described in section 3.
  - **Privacy Assurance:** Alarms only wake the Extension at a set time. They
    give the Extension no access to any data.

- **`offscreen`**:
  - **Purpose:** This permission allows the Extension to create an offscreen
    document to perform tasks that are not possible in a background service
    worker. This is used for technical implementation details of the
    Cross-Origin Storage API.
  - **Privacy Assurance:** The offscreen document runs locally and does not have
    access to your personal data. It is a sandboxed environment used solely for
    the technical operation of the Extension. No data from this process is
    collected or transmitted.

- **Content Scripts on `https://*/*`**:
  - **Purpose:** The Extension uses content scripts to inject the necessary
    JavaScript code into web pages. This is how it provides the Cross-Origin
    Storage API to the page, which is the stated purpose of the Extension.
  - **Privacy Assurance:** The content scripts are strictly limited to providing
    the Extension's functionality. They do **not** read, modify, or collect any
    personal data, form inputs, or other sensitive information from the web
    pages you visit.

#### 5. Third-Party Services

The Extension does not integrate with any third-party analytics frameworks. The
usage statistics in section 3 go to a Google Apps Script web app operated by the
Extension's maintainers.

#### 6. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be
reflected in an updated version of the Extension and this policy document. We
encourage you to periodically review this policy for the latest information on
our privacy practices.

#### 7. Contact Us

If you have any questions or concerns about this Privacy Policy, please contact
us at: **tomac@google.com**
