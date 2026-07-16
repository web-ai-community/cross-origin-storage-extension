#!/bin/bash
# Copyright 2026 Google LLC.
# SPDX-License-Identifier: Apache-2.0
#
# Builds the Safari web extension, wraps it in a native Xcode project
# (safari-app/), archives it, and uploads it straight to App Store Connect
# -- bypassing Xcode Cloud, which has been unreliable for packaging this
# extension.
#
# The Xcode project under safari-app/xcode-project/ is committed to git:
# extension file *contents* are referenced from safari-app/safari-extension-src/
# (regenerated fresh from the repo on every run), so editing background.js
# etc. needs no project regeneration. Only the *file list* is baked into
# the project at generation time -- if zip-extension.sh's file list
# changes (a file added/removed), pass --regenerate once to resync it,
# which will discard any manual Xcode customizations (icons, entitlements)
# made since the project was last generated.
#
# Requires a Mac with Xcode installed, signed into an Apple ID that's a
# member of the relevant App Store Connect team, and an App Store Connect
# API key (.p8 file) for that team.
#
# Usage:
#   ./upload-safari-build.sh [--marketing-version X.Y[.Z]] [options]
#
# Options:
#   --marketing-version X.Y[.Z]  The native app's App Store version
#                                (CFBundleShortVersionString). Independent
#                                of manifest.json's "version" -- Apple
#                                requires it to strictly increase over the
#                                app's *entire* App Store history on each
#                                platform. Omit to reuse the last version
#                                recorded in safari-app/release-state.json
#                                and just bump the build number.
#   --build-number N             Override the auto-incremented build
#                                number (CFBundleVersion).
#   --platform macos|ios|both    Which platform(s) to build and upload.
#                                Default: both.
#   --regenerate                 Regenerate the Xcode project from
#                                scratch (needed after the extension's
#                                file list changes; wipes manual Xcode
#                                customizations made since it was last
#                                generated).
#   --key-path PATH               Path to the App Store Connect API
#                                private key (.p8). Overrides Keychain/.env.
#   --store-key-in-keychain PATH  One-time setup: import a .p8 file into
#                                the macOS Keychain so future runs don't
#                                need --key-path at all, then exit.
#   -h, --help                   Show this help and exit.
#
# Credentials, in priority order:
#   1. --key-path
#   2. ASC_API_KEY_PATH (env var, e.g. from a gitignored .env file)
#   3. macOS Keychain (see --store-key-in-keychain)
#   4. A fallback search in ~/Downloads and ~/.appstoreconnect -- fine for
#      one-off use, but the key sits in plaintext there; prefer Keychain.
#
# ASC_KEY_ID / ASC_ISSUER_ID / ASC_TEAM_ID identify the key and team --
# not secret (visible in App Store Connect), so they default below to
# this project's existing values. Override via .env or the environment if
# they ever change (e.g. rotating the key). The private key itself is the
# only real secret, and this script never logs or copies it outside a
# private temp file that's removed on exit.

set -euo pipefail

APP_NAME="Cross-Origin Storage"
BUNDLE_ID="com.tomayac.crossoriginstorage"

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

ASC_KEY_ID="${ASC_KEY_ID:-B78MTCSY2V}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-69a6de6f-b54e-47e3-e053-5b8c7c11a4d1}"
ASC_TEAM_ID="${ASC_TEAM_ID:-58S46496RD}"
ASC_API_KEY_PATH="${ASC_API_KEY_PATH:-}"
KEYCHAIN_SERVICE="AppStoreConnect API Key ($ASC_KEY_ID)"

MARKETING_VERSION=""
BUILD_NUMBER_OVERRIDE=""
PLATFORM="both"
REGENERATE="false"
STORE_KEY_PATH=""

print_help() {
  sed -n '2,63p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --marketing-version) MARKETING_VERSION="$2"; shift 2 ;;
    --build-number) BUILD_NUMBER_OVERRIDE="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --regenerate) REGENERATE="true"; shift ;;
    --key-path) ASC_API_KEY_PATH="$2"; shift 2 ;;
    --store-key-in-keychain) STORE_KEY_PATH="$2"; shift 2 ;;
    -h|--help) print_help; exit 0 ;;
    *) echo "Unknown option: $1" >&2; print_help; exit 1 ;;
  esac
done

if [ -n "$STORE_KEY_PATH" ]; then
  if [ ! -f "$STORE_KEY_PATH" ]; then
    echo "error: $STORE_KEY_PATH not found." >&2
    exit 1
  fi
  security add-generic-password -U -a "$ASC_KEY_ID" -s "$KEYCHAIN_SERVICE" \
    -w "$(cat "$STORE_KEY_PATH")"
  echo "Stored $STORE_KEY_PATH in Keychain as \"$KEYCHAIN_SERVICE\"."
  echo "You can now delete $STORE_KEY_PATH and drop --key-path from future runs."
  exit 0
fi

case "$PLATFORM" in
  macos|ios|both) ;;
  *) echo "error: --platform must be macos, ios, or both." >&2; exit 1 ;;
esac

BUILD_DIR="$REPO_ROOT/safari-app"
XCODE_PROJECT_DIR="$BUILD_DIR/xcode-project"
PBXPROJ="$XCODE_PROJECT_DIR/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"
STATE_FILE="$BUILD_DIR/release-state.json"
LOG_DIR="$BUILD_DIR/logs"

# --- Resolve the API key -----------------------------------------------

KEY_TEMP_FILE=""
cleanup() {
  [ -n "$KEY_TEMP_FILE" ] && rm -f "$KEY_TEMP_FILE"
}
trap cleanup EXIT

if [ -z "$ASC_API_KEY_PATH" ]; then
  if KEY_MATERIAL="$(security find-generic-password -a "$ASC_KEY_ID" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"; then
    KEY_TEMP_FILE="$(mktemp -t "AuthKey_${ASC_KEY_ID}")"
    chmod 600 "$KEY_TEMP_FILE"
    printf '%s' "$KEY_MATERIAL" > "$KEY_TEMP_FILE"
    ASC_API_KEY_PATH="$KEY_TEMP_FILE"
    echo "==> Using API key from Keychain (\"$KEYCHAIN_SERVICE\")"
  fi
fi

if [ -z "$ASC_API_KEY_PATH" ]; then
  for candidate in \
    "$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8" \
    "$HOME/Downloads/AuthKey_${ASC_KEY_ID}.p8" \
    "$HOME/Downloads/AuthKey_${ASC_KEY_ID}.p8.txt"
  do
    if [ -f "$candidate" ]; then
      ASC_API_KEY_PATH="$candidate"
      echo "warning: falling back to $candidate -- consider:" >&2
      echo "  ./upload-safari-build.sh --store-key-in-keychain \"$candidate\"" >&2
      break
    fi
  done
fi

if [ -z "$ASC_API_KEY_PATH" ] || [ ! -f "$ASC_API_KEY_PATH" ]; then
  echo "error: couldn't find the App Store Connect API private key." >&2
  echo "Run: ./upload-safari-build.sh --store-key-in-keychain /path/to/AuthKey_${ASC_KEY_ID}.p8" >&2
  echo "or pass --key-path, or set ASC_API_KEY_PATH (e.g. in a gitignored .env)." >&2
  exit 1
fi

# --- Resolve marketing version / build number (auto-increment) --------

mkdir -p "$BUILD_DIR"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

STATE_VERSION="$(jq -r '.marketingVersion // empty' "$STATE_FILE")"

if [ -z "$MARKETING_VERSION" ]; then
  if [ -z "$STATE_VERSION" ]; then
    echo "error: no prior release recorded in $STATE_FILE -- pass --marketing-version" >&2
    echo "for the first release. Check App Store Connect for the current" >&2
    echo "approved/in-review version on each platform before picking one." >&2
    exit 1
  fi
  MARKETING_VERSION="$STATE_VERSION"
  VERSION_CHANGED="false"
else
  [ "$MARKETING_VERSION" = "$STATE_VERSION" ] && VERSION_CHANGED="false" || VERSION_CHANGED="true"
fi

next_build_number() {
  local platform_key="$1"
  if [ -n "$BUILD_NUMBER_OVERRIDE" ]; then
    echo "$BUILD_NUMBER_OVERRIDE"
    return
  fi
  if [ "$VERSION_CHANGED" = "true" ]; then
    echo 1
    return
  fi
  local last
  last="$(jq -r --arg p "$platform_key" '.[$p].buildNumber // 0' "$STATE_FILE")"
  echo $((last + 1))
}

echo "==> Version $MARKETING_VERSION for platform(s): $PLATFORM"

# --- Build the extension and stage its source --------------------------

echo "==> Rebuilding the Safari extension zip"
bash "$REPO_ROOT/zip-extension.sh" safari

echo "==> Refreshing extension source (safari-app/safari-extension-src)"
rm -rf "$BUILD_DIR/safari-extension-src"
mkdir -p "$BUILD_DIR/safari-extension-src" "$LOG_DIR"
unzip -q -o "$REPO_ROOT/cross-origin-storage-extension-safari.zip" -d "$BUILD_DIR/safari-extension-src"

# --- Generate the Xcode project, only if missing or --regenerate ------

apply_project_patches() {
  # App Store Connect rejects the generated macOS App target at upload
  # time ("No App Category") without this key -- insert it once, right
  # after the display-name key in both Debug and Release configs.
  if ! grep -q "INFOPLIST_KEY_LSApplicationCategoryType" "$PBXPROJ"; then
    python3 - "$PBXPROJ" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
old = '\t\t\t\tINFOPLIST_FILE = "macOS (App)/Info.plist";\n\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "Cross-Origin Storage";\n\t\t\t\tINFOPLIST_KEY_NSMainStoryboardFile = Main;'
new = '\t\t\t\tINFOPLIST_FILE = "macOS (App)/Info.plist";\n\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "Cross-Origin Storage";\n\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.utilities";\n\t\t\t\tINFOPLIST_KEY_NSMainStoryboardFile = Main;'
count = content.count(old)
if count == 0:
    print("warning: LSApplicationCategoryType anchor not found; Xcode project structure may have changed upstream.", file=sys.stderr)
else:
    content = content.replace(old, new)
    with open(path, 'w') as f:
        f.write(content)
    print(f"Patched {count} macOS App config(s) with LSApplicationCategoryType.")
PYEOF
  fi
}

if [ "$REGENERATE" = "true" ] || [ ! -f "$PBXPROJ" ]; then
  echo "==> Generating the Xcode wrapper project"
  rm -rf "$XCODE_PROJECT_DIR"
  xcrun safari-web-extension-packager \
    "$BUILD_DIR/safari-extension-src" \
    --project-location "$XCODE_PROJECT_DIR" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --swift \
    --no-open \
    --no-prompt \
    --force
  apply_project_patches
  echo "==> New Xcode project generated at safari-app/xcode-project -- review and commit it."
else
  echo "==> Reusing existing Xcode project (pass --regenerate to resync its file list)"
fi

if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ]; then
  if ! xcrun simctl list runtimes 2>/dev/null | grep -q "iOS"; then
    echo "error: no iOS Simulator runtime installed. The iOS archive step" >&2
    echo "needs one even for a device build (asset catalog compilation)." >&2
    echo "Run: xcodebuild -downloadPlatform iOS   (this is an ~8GB download)" >&2
    exit 1
  fi
fi

cat > "$BUILD_DIR/UploadOptions.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>destination</key>
	<string>upload</string>
</dict>
</plist>
EOF

archive_and_upload() {
  local platform_key="$1" platform_label="$2" scheme="$3" destination_flag="$4"
  local build_number
  build_number="$(next_build_number "$platform_key")"

  echo "==> [$platform_label] Setting version $MARKETING_VERSION ($build_number)"
  sed -i '' \
    -e "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $MARKETING_VERSION;/g" \
    -e "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = $build_number;/g" \
    "$PBXPROJ"

  local archive_path="$XCODE_PROJECT_DIR/build/${platform_label}.xcarchive"
  local export_path="$BUILD_DIR/upload/${platform_label}"
  local archive_log="$LOG_DIR/archive-${platform_label}.log"
  local upload_log="$LOG_DIR/upload-${platform_label}.log"

  echo "==> [$platform_label] Archiving"
  rm -rf "$archive_path"
  # shellcheck disable=SC2086
  if ! xcodebuild archive \
    -project "$XCODE_PROJECT_DIR/$APP_NAME/$APP_NAME.xcodeproj" \
    -scheme "$scheme" \
    -archivePath "$archive_path" \
    $destination_flag \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$ASC_TEAM_ID" \
    -authenticationKeyPath "$ASC_API_KEY_PATH" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" > "$archive_log" 2>&1
  then
    echo "error: [$platform_label] archive failed. See $archive_log" >&2
    tail -40 "$archive_log" >&2
    return 1
  fi

  echo "==> [$platform_label] Exporting and uploading to App Store Connect"
  rm -rf "$export_path"
  if ! xcodebuild -exportArchive \
    -archivePath "$archive_path" \
    -exportPath "$export_path" \
    -exportOptionsPlist "$BUILD_DIR/UploadOptions.plist" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$ASC_API_KEY_PATH" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" > "$upload_log" 2>&1
  then
    if grep -q "Invalid Version\|must contain a higher version" "$upload_log"; then
      echo "error: [$platform_label] rejected -- version $MARKETING_VERSION ($build_number) is" >&2
      echo "not higher than the current approved/in-review version on this platform." >&2
      echo "Check App Store Connect and retry with a higher --marketing-version." >&2
    else
      echo "error: [$platform_label] upload failed. See $upload_log" >&2
    fi
    tail -40 "$upload_log" >&2
    return 1
  fi

  jq --arg v "$MARKETING_VERSION" --arg p "$platform_key" --argjson b "$build_number" \
    '.marketingVersion = $v | .[$p].buildNumber = $b' \
    "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

  echo "==> [$platform_label] Uploaded: $MARKETING_VERSION ($build_number)"
}

STATUS=0
if [ "$PLATFORM" = "macos" ] || [ "$PLATFORM" = "both" ]; then
  archive_and_upload "macos" "macOS" "$APP_NAME (macOS)" "" || STATUS=1
fi
if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ]; then
  archive_and_upload "ios" "iOS" "$APP_NAME (iOS)" '-destination generic/platform=iOS' || STATUS=1
fi

if [ $STATUS -eq 0 ]; then
  echo "==> Done. $STATE_FILE was updated -- commit it (and the Xcode project, if regenerated)."
fi
exit $STATUS
