// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Connects a checkbox to the telemetry setting, for telemetry-notice.html
// and options.html.

import { isTelemetryEnabled, setTelemetryEnabled } from './telemetry.js';

/**
 * @param {HTMLInputElement} checkbox
 * @param {() => void} [onSaved] Called after each change is saved.
 */
function bindTelemetrySwitch(checkbox, onSaved) {
  isTelemetryEnabled().then((enabled) => {
    checkbox.checked = enabled;
  });
  checkbox.addEventListener('change', async () => {
    // On Firefox, the browser's consent prompt can turn down the change, so
    // the checkbox shows the result.
    checkbox.checked = await setTelemetryEnabled(checkbox.checked);
    onSaved?.();
  });
}

export { bindTelemetrySwitch };
