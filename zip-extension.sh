#!/bin/bash
# Copyright 2025 Google LLC.
# SPDX-License-Identifier: Apache-2.0

# A script to zip the necessary files for the extension.
# Usage: ./zip-extension.sh [chrome|firefox|safari]  (defaults to chrome)

# Fail loudly rather than shipping a broken archive. Without this, a missing
# source file only wrote to stderr while the loop carried on, and a failed jq
# left a zero-byte manifest.json -- both producing a zip that looked fine and
# ended with a success message.
set -euo pipefail

BROWSER="${1:-chrome}"

case "$BROWSER" in
  chrome|firefox|safari) ;;
  *) echo "Usage: $0 [chrome|firefox|safari]" >&2; exit 1 ;;
esac

OUTPUT_ZIP="cross-origin-storage-extension-${BROWSER}.zip"
BUILD_DIR="build"

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

# Always clean up, including on an early exit, so a failed run can't leave a
# partial build/ behind for the next one to pick up. That matters when
# switching browsers: stale offscreen.* from a chrome build would otherwise be
# swept into a firefox archive.
cleanup() { rm -rf "$BUILD_DIR"; }
trap cleanup EXIT

if [ "$BROWSER" = "chrome" ] && ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required to build the chrome archive (it strips dev-only" >&2
  echo "       localhost/.test match patterns from the manifest)." >&2
  exit 1
fi

# Check every source file up front and report all of them at once, rather than
# stopping at whichever happens to be missing first.
MISSING=()
for file in "${FILES_TO_ZIP[@]}"; do
  [ -f "$file" ] || MISSING+=("$file")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "Error: ${#MISSING[@]} file(s) listed in this script are missing:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  echo "Update FILES_TO_ZIP, or restore the file(s)." >&2
  exit 1
fi

if [ -f "$OUTPUT_ZIP" ]; then
  echo "Removing old archive: $OUTPUT_ZIP"
  rm "$OUTPUT_ZIP"
fi

rm -rf "$BUILD_DIR"
mkdir "$BUILD_DIR"
echo "Prepared build directory."

for file in "${FILES_TO_ZIP[@]}"; do
  cp "$file" "$BUILD_DIR/"
done

if [ "$BROWSER" = "chrome" ]; then
  # Strip dev-only localhost/test patterns for Web Store compatibility.
  echo "Transforming manifest.chrome.json to remove localhost patterns..."
  jq '
    .content_scripts |= map(.matches |= map(select(test("http://(localhost|.*\\.test)") | not))) |
    .web_accessible_resources |= map(.matches |= map(select(test("http://(localhost|.*\\.test)") | not)))
  ' manifest.chrome.json > "$BUILD_DIR/manifest.json"
else
  # Firefox and Safari manifests already use localhost/* (no port wildcard); copy as-is.
  cp "manifest.$BROWSER.json" "$BUILD_DIR/manifest.json"
fi

# A manifest that is empty or malformed makes an archive that installs as a
# broken extension, so verify it parses and still declares a version.
if ! jq -e '.version and .manifest_version' "$BUILD_DIR/manifest.json" >/dev/null 2>&1; then
  echo "Error: $BUILD_DIR/manifest.json is empty, malformed, or missing required keys." >&2
  exit 1
fi
MANIFEST_VERSION="$(jq -r .version "$BUILD_DIR/manifest.json")"

echo "Creating new archive named '$OUTPUT_ZIP'..."
( cd "$BUILD_DIR" && zip -q "../$OUTPUT_ZIP" ./* )

# The archive is the deliverable, so assert it actually contains everything
# instead of trusting that each step above succeeded.
EXPECTED=$(( ${#FILES_TO_ZIP[@]} + 1 ))  # + manifest.json
ACTUAL=$(unzip -Z1 "$OUTPUT_ZIP" | wc -l | tr -d '[:space:]')
if [ "$ACTUAL" -ne "$EXPECTED" ]; then
  echo "Error: '$OUTPUT_ZIP' has $ACTUAL entries, expected $EXPECTED." >&2
  unzip -Z1 "$OUTPUT_ZIP" >&2
  exit 1
fi

echo "✅ Successfully created '$OUTPUT_ZIP' (v$MANIFEST_VERSION, $ACTUAL files)."
