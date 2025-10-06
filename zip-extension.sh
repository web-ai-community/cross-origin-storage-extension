#!/bin/bash

# A simple script to zip the necessary files for the Chrome extension.

# Define the name of the output zip file.
OUTPUT_ZIP="cross-origin-storage-extension.zip"

# Define the list of files to be included in the archive.
FILES_TO_ZIP=(
  "resource-manager.js"
  "popup.js"
  "popup.html"
  "offscreen.js"
  "offscreen.html"
  "manifest.json"
  "main-world.js"
  "logo-cos.svg"
  "logo-cos.png"
  "content.js"
  "background.js"
)

# Check if an old zip file exists and remove it to ensure a clean build.
if [ -f "$OUTPUT_ZIP" ]; then
  echo "Removing old archive: $OUTPUT_ZIP"
  rm "$OUTPUT_ZIP"
fi

echo "Creating new archive named '$OUTPUT_ZIP'..."

# Create the zip file with the specified resources.
# The "${FILES_TO_ZIP[@]}" syntax ensures all files in the array are included.
zip "$OUTPUT_ZIP" "${FILES_TO_ZIP[@]}"

echo "✅ Successfully created '$OUTPUT_ZIP'."
echo "You can now upload this file to the Chrome Web Store."

