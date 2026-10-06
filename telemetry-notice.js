// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

import './input-switch-polyfill.js';
import { bindTelemetrySwitch } from './telemetry-switch.js';

bindTelemetrySwitch(document.getElementById('telemetry'));

if (typeof globalThis.browser?.runtime?.getBrowserInfo === 'function') {
  document.getElementById('firefox-note').hidden = false;
}
