#!/bin/bash

# A script to zip the necessary files for the Chrome extension,
# automatically stripping localhost patterns for Web Store compatibility.

# Define the name of the output zip file.
OUTPUT_ZIP="cross-origin-storage-extension.zip"

# Define the list of files to be included in the archive.
FILES_TO_ZIP=(
  "resource-manager.js"
  "popup.js"
  "popup.html"
  "options.html"
  "options.js"
  "styles.css"
  "offscreen.js"
  "offscreen.html"
  "manifest.json"
  "main-world.js"
  "logo-cos.svg"
  "logo-cos.png"
  "content.js"
  "background.js"
)

# Check if an old zip file exists and remove it.
if [ -f "$OUTPUT_ZIP" ]; then
  echo "Removing old archive: $OUTPUT_ZIP"
  rm "$OUTPUT_ZIP"
fi

# Create a build directory for a clean zip.
mkdir -p build
echo "Prepared build directory."

# Copy files to the build directory.
for file in "${FILES_TO_ZIP[@]}"; do
  cp "$file" build/
done

# Transform manifest.json for Web Store compatibility.
echo "Transforming manifest.json to remove localhost patterns..."
jq '
  .content_scripts |= map(.matches |= map(select(test("http://localhost") | not))) |
  .web_accessible_resources |= map(.matches |= map(select(test("http://localhost") | not)))
' manifest.json > build/manifest.json

echo "Creating new archive named '$OUTPUT_ZIP'..."

# Create the zip file from the build directory.
cd build
zip "../$OUTPUT_ZIP" *
cd ..

# Clean up.
rm -rf build
echo "Cleaned up build directory."

echo "✅ Successfully created '$OUTPUT_ZIP'."
echo "You can now upload this file to the Chrome Web Store."
