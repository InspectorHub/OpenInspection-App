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

# app_is_running, boot_simulator, launch_app and what they wait for: see the comments in that file (they are tested with a stubbed xcrun).
# shellcheck source=lib/ios-simulator.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/ios-simulator.sh"

# ---- 1. static checks on the built bundle -------------------------------------------------------
[ -d "$APP_PATH" ] || fail "no app bundle at $APP_PATH"
plutil -lint "$APP_PATH/Info.plist"
[ -f "$APP_PATH/PrivacyInfo.xcprivacy" ] || fail "PrivacyInfo.xcprivacy is not inside the built app"
plutil -lint "$APP_PATH/PrivacyInfo.xcprivacy"
echo "ok: Info.plist and the privacy manifest are valid and the manifest is inside the app"

# ---- 1b. what "Save photos I take to my gallery" needs, read from the BUILT app (not from the source files) --------
# The simulator has no camera and the release build has no Diagnostics screen, so a photo cannot be taken and saved here.
# What can be proved on the built bundle: (1) the text iOS shows when the app first adds a photo to the library is in
# Info.plist (without it the system ends the app at the first save), and (2) the media plugin that does the save is in the
# list of native plugins Capacitor registers at launch (a plugin that is in package.json but not in that list answers every
# call with "not implemented", and the person's photos would never be copied).
ADD_TEXT="$(plutil -extract NSPhotoLibraryAddUsageDescription raw -o - "$APP_PATH/Info.plist" 2>/dev/null || true)"
[ -n "$ADD_TEXT" ] || fail "the built Info.plist has no NSPhotoLibraryAddUsageDescription (the first save to the photo library would end the app)"
echo "ok: the built Info.plist explains why the app adds photos to the library"
registered_plugin() { jq -e --arg name "$1" '(.packageClassList // []) | index($name) != null' "$APP_PATH/capacitor.config.json" >/dev/null 2>&1; }
# Control first: a name nobody registered must not be found, otherwise the check below could never fail.
if registered_plugin "NoSuchPluginForTheControl"; then fail "the plugin-list check found a plugin that does not exist"; fi
registered_plugin "MediaPlugin" || fail "MediaPlugin is not in packageClassList of the built app's capacitor.config.json (saving to the gallery would answer 'not implemented')"
echo "ok: MediaPlugin is registered in the built app"

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

# What URLResourceValues.isExcludedFromBackup really writes, observed in CI run 41263679703 on the simulator: an attribute
# NAMED com.apple.metadata:com_apple_backup_excludeItem whose VALUE is com.apple.MobileBackup. (The first version of this
# check looked for an attribute named com.apple.MobileBackup and failed on a directory that was correctly excluded.)
BACKUP_ATTRIBUTES=("com.apple.metadata:com_apple_backup_excludeItem")
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
  # Control first: a capture that saw nothing proves nothing. Capacitor prints lines of its own while it loads, so an empty
  # capture means the capture is blind (or logging is off in this build) and a green result would be meaningless.
  tr -d '\r\004' < "$OUT/${label}.typescript" 2>/dev/null | sed 's/^\^D//' > "$OUT/${label}.console" || true
  echo "--- $label: what the app printed to stdout/stderr ($(wc -l < "$OUT/${label}.console" | tr -d ' ') lines; full: ${label}.console) ---"
  head -40 "$OUT/${label}.console" || true
  [ -s "$OUT/${label}.console" ] || fail "$label: nothing was captured from the app's stdout/stderr, so this check cannot see its errors"
  # Native lines alone are not enough: the JavaScript console and the plugin bridge only print when Capacitor logging is on
  # (the CI job syncs with OI_NATIVE_LOGGING=debug; capacitor.config.ts is otherwise silent on purpose). Capacitor prints
  # "To Native" for every plugin call, and the app makes several while it starts, so its absence means the capture is blind.
  grep -q 'To Native' "$OUT/${label}.console" || fail "$label: no plugin-call lines in the capture, so JavaScript errors would be invisible (was the app synced with OI_NATIVE_LOGGING=debug?)"
  # "The process is alive" is not "the app works": the app prints this line when it lands on its could-not-open screen.
  if grep -q 'storage open failed' "$OUT/${label}.console" "$OUT/${label}.log"; then
    grep -h 'storage open failed' "$OUT/${label}.console" "$OUT/${label}.log" | head -3
    fail "$label: the app could not open its storage (see the line above)"
  fi
}

smoke_device() {
  local label="$1" udid="$2"
  CURRENT_UDID="$udid"
  echo "=== $label ($udid) ==="
  boot_simulator "$label" "$udid"
  xcrun simctl install "$udid" "$APP_PATH"
  # The app's JavaScript console reaches the native side through Swift print() on stdout, not the unified log that
  # `log show` reads. Redirected to a FILE, stdout is block-buffered and stays empty until the buffer fills (runs 41266804318
  # and 41267660047 captured 0 bytes of it), so the app gets a PTY (--console-pty), which makes its stdout line-buffered.
  # simctl itself needs a terminal for that and CI has none (run 41268388426: the backgrounded launcher died silently and the
  # app never started), so it runs under script(1), whose -F flushes the capture after every write instead of at exit.
  launch_app "$label" "$udid"
  # Then give the web app SETTLE_SECONDS to start and try to open its storage.
  sleep "$SETTLE_SECONDS"
  tr -d '\r\004' < "$OUT/${label}.typescript" 2>/dev/null | sed 's/^\^D//' > "$OUT/${label}.console" || true
  if ! wait_for_app "$udid" "${SMOKE_RECHECK_SECONDS:-30}"; then
    echo "--- $label: what simctl launch printed ---"
    cat "$OUT/${label}.console" 2>/dev/null || true
    fail "$label: the app is not running $SETTLE_SECONDS seconds after launch"
  fi
  echo "ok: $label: the app is still running after launch"

  xcrun simctl io "$udid" screenshot "$OUT/${label}.png"
  [ -s "$OUT/${label}.png" ] || fail "$label: the screenshot is empty"

  xcrun simctl openurl "$udid" "$APP_ID:/oauth/callback?code=x&state=y"
  sleep 4
  wait_for_app "$udid" "${SMOKE_RECHECK_SECONDS:-30}" || fail "$label: the app is not running after the callback URL was opened"
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
  kill "$LAUNCH_PID" 2>/dev/null || true
  wait "$LAUNCH_PID" 2>/dev/null || true
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  CURRENT_UDID=""
}

# SMOKE_DEVICES: iphone, ipad or both (default). CI runs one device per job so the two boots happen in parallel.
case "${SMOKE_DEVICES:-both}" in
  iphone|ipad|both) ;;
  *) fail "SMOKE_DEVICES must be iphone, ipad or both (got: ${SMOKE_DEVICES})" ;;
esac
if [ "${SMOKE_DEVICES:-both}" != "ipad" ]; then
  IPHONE="$(pick_device iPhone)"
  [ -n "$IPHONE" ] || fail "no available iPhone simulator"
  smoke_device iphone "$IPHONE"
fi
if [ "${SMOKE_DEVICES:-both}" != "iphone" ]; then
  IPAD="$(pick_device iPad)"
  [ -n "$IPAD" ] || fail "no available iPad simulator"
  smoke_device ipad "$IPAD"
fi
echo "ios-simulator-smoke: all checks passed; screenshots are in $OUT"
