#!/bin/bash
# Copyright 2025 Google LLC.
# SPDX-License-Identifier: Apache-2.0

# A script to zip the necessary files for the extension.
# Usage: ./zip-extension.sh [chrome|firefox|safari]  (defaults to chrome)

BROWSER="${1:-chrome}"

case "$BROWSER" in
  chrome|firefox|safari) ;;
  *) echo "Usage: $0 [chrome|firefox|safari]" >&2; exit 1 ;;
esac

OUTPUT_ZIP="cross-origin-storage-extension-${BROWSER}.zip"

COMMON_FILES=(
  "resource-manager.js"
  "popup.js"
  "popup.html"
  "options.html"
  "options.js"
  "styles.css"
  "main-world.js"
  "logo-cos.svg"
  "logo-cos.png"
  "content.js"
  "background.js"
  "sha256.js"
  "viewer.html"
  "viewer.js"
  "input-switch-polyfill.js"
  "input-switch-polyfill.css"
  "relay-extension.html"
  "relay-extension.js"
  "public-hash-list.js"
  "public-suffix-list.js"
  "same-site.js"
)

if [ "$BROWSER" = "chrome" ]; then
  EXTRA_FILES=("offscreen.js" "offscreen.html")
else
  # Firefox and Safari both run the background code as a non-persistent
  # background page rather than a service worker, so they share this file.
  EXTRA_FILES=("background.html")
fi

FILES_TO_ZIP=("${COMMON_FILES[@]}" "${EXTRA_FILES[@]}")

if [ -f "$OUTPUT_ZIP" ]; then
  echo "Removing old archive: $OUTPUT_ZIP"
  rm "$OUTPUT_ZIP"
fi

mkdir -p build
echo "Prepared build directory."

for file in "${FILES_TO_ZIP[@]}"; do
  cp "$file" build/
done

if [ "$BROWSER" = "chrome" ]; then
  # Strip dev-only localhost/test patterns for Web Store compatibility.
  echo "Transforming manifest.chrome.json to remove localhost patterns..."
  jq '
    .content_scripts |= map(.matches |= map(select(test("http://(localhost|.*\\.test)") | not))) |
    .web_accessible_resources |= map(.matches |= map(select(test("http://(localhost|.*\\.test)") | not)))
  ' manifest.chrome.json > build/manifest.json
else
  # Firefox and Safari manifests already use localhost/* (no port wildcard); copy as-is.
  cp "manifest.$BROWSER.json" build/manifest.json
fi

echo "Creating new archive named '$OUTPUT_ZIP'..."
cd build
zip "../$OUTPUT_ZIP" *
cd ..

rm -rf build
echo "Cleaned up build directory."

echo "✅ Successfully created '$OUTPUT_ZIP'."
