#!/usr/bin/env bash
# Smoke test for a Debug build compiled for the iOS simulator. Run it on macOS after:
#   xcodebuild ... -sdk iphonesimulator -derivedDataPath <dir> build
# Usage: scripts/ios-simulator-smoke.sh <path to App.app> [output directory]
#
# It does these things and nothing else:
#   1. plutil -lint Info.plist and PrivacyInfo.xcprivacy, and require the privacy manifest inside the .app
#   2. boot one iPhone and one iPad simulator, install and launch the app, and require the process to stay alive
#   3. open the sign-in callback URL and require the process to stay alive (the private scheme is routed to the app)
#   4. require com.apple.MobileBackup on every directory listed in ios/App/App/BackupExclusion.swift
#   5. save one screenshot per device
# Nothing here signs in, talks to a server or uses a secret.
# -E: functions inherit the ERR trap, otherwise a failure inside smoke_device prints no log tail at all.
set -Eeuo pipefail

APP_ID="io.inspectorhub.app"
APP_PATH="${1:?usage: ios-simulator-smoke.sh <path to App.app> [output directory]}"
OUT="${2:-${SMOKE_OUT:-$PWD/ios-smoke-out}}"
SETTLE_SECONDS="${SMOKE_SETTLE_SECONDS:-12}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_SOURCE="$REPO_ROOT/ios/App/App/BackupExclusion.swift"
mkdir -p "$OUT"

CURRENT_UDID=""
on_error() {
  local status=$?
  echo "::error::ios-simulator-smoke failed (exit $status)"
  if [ -n "$CURRENT_UDID" ]; then
    echo "--- last 2 minutes of the app's log on $CURRENT_UDID ---"
    xcrun simctl spawn "$CURRENT_UDID" log show --last 2m --predicate 'process == "App"' 2>&1 | tail -80 || true
  fi
  exit "$status"
}
trap on_error ERR

fail() { echo "::error::$*"; return 1; }

# ---- 1. static checks on the built bundle -------------------------------------------------------
[ -d "$APP_PATH" ] || fail "no app bundle at $APP_PATH"
plutil -lint "$APP_PATH/Info.plist"
[ -f "$APP_PATH/PrivacyInfo.xcprivacy" ] || fail "PrivacyInfo.xcprivacy is not inside the built app"
plutil -lint "$APP_PATH/PrivacyInfo.xcprivacy"
echo "ok: Info.plist and the privacy manifest are valid and the manifest is inside the app"

# ---- the directories that must be excluded from backup, read from the Swift source --------------
[ -f "$SWIFT_SOURCE" ] || fail "missing $SWIFT_SOURCE"
BACKUP_DIRS="$(sed -n 's/.*relativeDirectories: *\[String\] *= *\[\(.*\)\].*/\1/p' "$SWIFT_SOURCE" | tr -d '" ' | tr ',' ' ')"
[ -n "$BACKUP_DIRS" ] || fail "could not read relativeDirectories from $SWIFT_SOURCE"
echo "backup-excluded directories under Library: $BACKUP_DIRS"

# ---- helpers ------------------------------------------------------------------------------------
# The newest available simulator whose name starts with the given prefix.
pick_device() {
  xcrun simctl list devices available -j | jq -r --arg prefix "$1" '
    [.devices | to_entries[] | select(.key | contains("iOS")) | .value[] | select(.name | startswith($prefix))]
    | last | .udid // empty'
}

app_is_running() {
  # `launchctl list` prints "<pid> <status> UIKitApplication:<id>[...]"; a dash instead of the pid means not running.
  local line
  line="$(xcrun simctl spawn "$1" launchctl list | grep "UIKitApplication:$APP_ID" || true)"
  [ -n "$line" ] && ! printf '%s' "$line" | awk '{print $1}' | grep -qx -- '-'
}

# Which extended attribute marks "excluded from backup" is NOT assumed: the legacy key is com.apple.MobileBackup, and
# URLResourceValues.isExcludedFromBackup is documented to write its own metadata attribute. The first CI run found the
# legacy one missing, so both are accepted and every attribute is printed; narrow this once a run shows which one is real.
BACKUP_ATTRIBUTES=("com.apple.MobileBackup" "com.apple.metadata:com_apple_backup_excludeItem")
has_backup_attribute() {
  local attribute
  for attribute in "${BACKUP_ATTRIBUTES[@]}"; do
    if xattr -p "$attribute" "$1" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

# Everything the app logged since launch, kept as an artifact, with the lines that matter printed.
save_app_log() {
  local label="$1" udid="$2"
  xcrun simctl spawn "$udid" log show --last 10m --info --debug --predicate 'process == "App"' > "$OUT/${label}.log" 2>&1 || true
  echo "--- $label: app log lines about errors, storage, keychain or backup exclusion (full log: ${label}.log) ---"
  grep -iE 'error|fail|sqlite|keychain|secret|BackupExclusion|entitlement' "$OUT/${label}.log" | tail -60 || echo "(none)"
  if grep -q 'BackupExclusion failed' "$OUT/${label}.log"; then fail "$label: BackupExclusion.apply reported a failure (see the log above)"; fi
}

smoke_device() {
  local label="$1" udid="$2"
  CURRENT_UDID="$udid"
  echo "=== $label ($udid) ==="
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl install "$udid" "$APP_PATH"
  xcrun simctl launch "$udid" "$APP_ID"
  sleep "$SETTLE_SECONDS"
  app_is_running "$udid" || fail "$label: the app is not running $SETTLE_SECONDS seconds after launch"
  echo "ok: $label: the app is still running after launch"

  xcrun simctl io "$udid" screenshot "$OUT/${label}.png"
  [ -s "$OUT/${label}.png" ] || fail "$label: the screenshot is empty"

  xcrun simctl openurl "$udid" "$APP_ID:/oauth/callback?code=x&state=y"
  sleep 4
  app_is_running "$udid" || fail "$label: the app is not running after the callback URL was opened"
  echo "ok: $label: the callback URL was routed and the app survived it"

  local data
  data="$(xcrun simctl get_app_container "$udid" "$APP_ID" data)"
  echo "--- $label: Library ---"
  ls -la "$data/Library"
  save_app_log "$label" "$udid"
  local shown
  for shown in $BACKUP_DIRS; do
    echo "--- $label: extended attributes of Library/$shown ---"
    xattr -l "$data/Library/$shown" || true
  done
  # Control: a directory nobody marked must NOT carry the attribute, otherwise the check below could never fail.
  local control="$data/Library/smoke-control-$$"
  mkdir -p "$control"
  if has_backup_attribute "$control"; then fail "$label: control directory unexpectedly has com.apple.MobileBackup"; fi
  rmdir "$control"
  local dir
  for dir in $BACKUP_DIRS; do
    [ -d "$data/Library/$dir" ] || fail "$label: Library/$dir does not exist after launch"
    has_backup_attribute "$data/Library/$dir" || fail "$label: Library/$dir is not excluded from backup (no com.apple.MobileBackup)"
    echo "ok: $label: Library/$dir is excluded from backup"
  done

  xcrun simctl terminate "$udid" "$APP_ID" 2>/dev/null || true
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  CURRENT_UDID=""
}

IPHONE="$(pick_device iPhone)"
IPAD="$(pick_device iPad)"
[ -n "$IPHONE" ] || fail "no available iPhone simulator"
[ -n "$IPAD" ] || fail "no available iPad simulator"

smoke_device iphone "$IPHONE"
smoke_device ipad "$IPAD"
echo "ios-simulator-smoke: all checks passed; screenshots are in $OUT"
