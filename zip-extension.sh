#!/bin/bash
# Copyright 2025 Google LLC.
# SPDX-License-Identifier: Apache-2.0

# A script to zip the necessary files for the extension.
# Usage: ./zip-extension.sh [chrome|firefox|safari]  (defaults to chrome)
#
# Each browser's loadable extension lives in its own subfolder
# (chrome/, firefox/, safari/), made up of symlinks into the shared source
# files at the repo root plus a browser-specific manifest.json (and any
# other browser-exclusive real files). This script dereferences those
# symlinks (cp -L) into a build/ dir and zips the result.

BROWSER="${1:-chrome}"

case "$BROWSER" in
  chrome|firefox|safari) ;;
  *) echo "Usage: $0 [chrome|firefox|safari]" >&2; exit 1 ;;
esac

OUTPUT_ZIP="cross-origin-storage-extension-${BROWSER}.zip"

if [ -f "$OUTPUT_ZIP" ]; then
  echo "Removing old archive: $OUTPUT_ZIP"
  rm "$OUTPUT_ZIP"
fi

rm -rf build
mkdir -p build
cp -RL "$BROWSER"/. build/
echo "Prepared build directory from '$BROWSER/'."

if [ "$BROWSER" = "chrome" ]; then
  # Strip dev-only localhost/test patterns for Web Store compatibility.
  echo "Transforming manifest.json to remove localhost patterns..."
  jq '
    .content_scripts |= map(.matches |= map(select(test("http://(localhost|.*\\.test)") | not))) |
    .web_accessible_resources |= map(.matches |= map(select(test("http://(localhost|.*\\.test)") | not)))
  ' build/manifest.json > build/manifest.json.tmp
  mv build/manifest.json.tmp build/manifest.json
fi

echo "Creating new archive named '$OUTPUT_ZIP'..."
cd build
zip "../$OUTPUT_ZIP" *
cd ..

rm -rf build
echo "Cleaned up build directory."

echo "✅ Successfully created '$OUTPUT_ZIP'."
