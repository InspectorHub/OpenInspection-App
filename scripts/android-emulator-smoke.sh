#!/usr/bin/env bash
# Launch smoke for the Android debug APK on an already-running emulator (CI starts it with android-emulator-runner).
# Usage: scripts/android-emulator-smoke.sh <path to app-debug.apk> [output directory]
#
# It does these things and nothing else: install the APK, start the app, require the process to stay alive, require the first
# screen ("Choose your server") in the UI tree, require that no crash was logged, and keep a screenshot, the UI tree and the
# logcat as evidence. It signs in to nothing and contacts no server. "The process is alive" is not "the app works", which is
# why the screen is checked: the iOS simulator job once stayed green while the app sat on its could-not-open screen.
set -Eeuo pipefail

APP_ID="io.inspectorhub.app"
APK="${1:?usage: android-emulator-smoke.sh <path to app-debug.apk> [output directory]}"
OUT="${2:-${SMOKE_OUT:-$PWD/android-smoke-out}}"
SETTLE_SECONDS="${SMOKE_SETTLE_SECONDS:-15}"
mkdir -p "$OUT"
# shellcheck source=lib/dismiss-not-responding.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/dismiss-not-responding.sh"

fail() { echo "::error::$*"; return 1; }
on_error() {
  local status=$?
  echo "::error::android-emulator-smoke failed (exit $status)"
  adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
  adb exec-out screencap -p > "$OUT/screen-at-failure.png" 2>/dev/null || true
  echo "--- last logcat lines ---"
  tail -40 "$OUT/logcat.txt" 2>/dev/null || true
  exit "$status"
}
trap on_error ERR

[ -f "$APK" ] || fail "no APK at $APK"

adb wait-for-device
waited=0
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || [ "$waited" -ge 180 ]; do sleep 2; waited=$((waited + 2)); done
[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || fail "the emulator did not finish booting in 180 s"
echo "ok: the emulator finished booting ($(adb shell getprop ro.build.version.release | tr -d '\r'), api $(adb shell getprop ro.build.version.sdk | tr -d '\r'))"

adb install -r "$APK"
adb logcat -c
adb shell am start -n "$APP_ID/.MainActivity"

waited=0
until [ -n "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || [ "$waited" -ge 60 ]; do sleep 2; waited=$((waited + 2)); done
[ -n "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || fail "the app process did not start within 60 s"
sleep "$SETTLE_SECONDS"
[ -n "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || fail "the app process is gone $SETTLE_SECONDS seconds after launch"
echo "ok: the app is running"

adb exec-out screencap -p > "$OUT/screen.png"
[ -s "$OUT/screen.png" ] || fail "the screenshot is empty"

# The WebView's accessibility tree is built the first time something asks for it, so the first dump can hold only the native shell
# (run 41295240990: 7 nodes, no text, while the screenshot taken just before showed the screen). Ask again until the text is there.
# 15 looks by default; a test that runs this whole script against a stand-in adb sets fewer, because every stand-in call is a process.
MAX_UI_ATTEMPTS="${SMOKE_UI_ATTEMPTS:-15}"
attempts=0
dismissed=0
until [ "$attempts" -ge "$MAX_UI_ATTEMPTS" ]; do
  attempts=$((attempts + 1))
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null || true
  adb pull /sdcard/ui.xml "$OUT/ui.xml" > /dev/null
  # A system "isn't responding" dialog can sit in front of a healthy app (CI run 41367506059): press Wait and look again.
  if dismiss_not_responding "$OUT/ui.xml"; then dismissed=1; sleep 2; continue; fi
  dismissed=0
  if grep -q "Choose your server" "$OUT/ui.xml"; then break; fi
  sleep 2
done
# If the last look found a dialog and pressed Wait, ui.xml still shows that dialog: look once more, so the checks below read the screen
# after the press and not the dialog (which would fail the run with a message about another window).
if [ "$dismissed" -eq 1 ]; then
  sleep 2
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null || true
  adb pull /sdcard/ui.xml "$OUT/ui.xml" > /dev/null
fi
echo "UI tree read in $attempts attempt(s)"
# Control first: a UI tree that does not even name the app's package proves nothing about what is on screen.
grep -q "package=\"$APP_ID\"" "$OUT/ui.xml" || fail "the UI tree does not belong to $APP_ID (is another window in front?)"
if grep -q "could not open" "$OUT/ui.xml"; then fail "the app is on its could-not-open screen"; fi
grep -q "Choose your server" "$OUT/ui.xml" || fail "the first screen \"Choose your server\" is not in the UI tree after $attempts attempts (see ui.xml and screen.png)"
echo "ok: the first screen is \"Choose your server\""

adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
# Only a crash of the APP's own process counts (its "Process:" line names the package). The emulator's test tooling can log a
# FATAL EXCEPTION of its own (UiAutomation, the accessibility channel behind uiautomator dump) with nothing wrong in the app.
if grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "Process: $APP_ID"; then
  grep -A8 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -20
  fail "the app crashed (FATAL EXCEPTION in the app process, see logcat.txt)"
fi
if grep -q "FATAL EXCEPTION" "$OUT/logcat.txt"; then echo "note: a FATAL EXCEPTION of another process is in logcat.txt (not the app); ignored"; fi
echo "ok: no crash in logcat"
echo "android-emulator-smoke: all checks passed; evidence is in $OUT"
