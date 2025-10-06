### Privacy Policy for Cross-Origin Storage

**Effective Date:** October 7, 2025

#### 1. Introduction

This Privacy Policy governs the manner in which the "Cross-Origin Storage"
Chrome Extension (hereinafter referred to as "the Extension") handles user data.
The privacy of our users is of paramount importance to us. This Extension is
designed to be a purely client-side tool.

We are committed to transparency and protecting your privacy. This policy aims
to clearly inform you about our data practices.

#### 2. Data Collection and Usage

**The Extension does not collect, store, transmit, or share any personally
identifiable information (PII) or any other form of user data.**

All functionality of the Extension is performed locally on your computer. No
data is ever sent to any remote server or third-party service. We do not have
access to your browsing history, personal information, or any content you
interact with.

#### 3. Explanation of Required Permissions

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

#### 4. Third-Party Services

The Extension does not integrate with any third-party services, APIs, or
analytics frameworks. All code is self-contained and operates without external
communication.

#### 5. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be
reflected in an updated version of the Extension and this policy document. We
encourage you to periodically review this policy for the latest information on
our privacy practices.

#### 6. Contact Us

If you have any questions or concerns about this Privacy Policy, please contact
us at: **tomac@google.com**
