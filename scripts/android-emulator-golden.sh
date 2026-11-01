#!/usr/bin/env bash
# Golden flow G2 on an already-running emulator (CI starts it with android-emulator-runner): controlled sign-in through the fake engine,
# then the work list with nothing waiting to upload and the status dot Online. The flow itself is maestro/golden/g2-controlled-sign-in.yaml.
# Usage: scripts/android-emulator-golden.sh <path to the dev-server APK> <fake engine origin as the emulator sees it> [output directory]
#
# The APK is NOT the one the launch smoke installs. Only a development bundle served by Vite accepts plain http, and the fake engine is
# plain http, so the workflow builds a second debug APK whose WebView loads http://localhost:5173 (capacitor.config.ts, OI_EMULATOR_DEV_SERVER). The emulator's localhost is made to reach the
# host with `adb reverse` below, because localhost is a secure context (crypto.randomUUID and crypto.subtle exist) and the emulator's host-alias address is not.
# The caller has already started the fake engine and the Vite server on the host. This script contacts neither of them from here: it
# starts from a cleared app (pm clear + am start; Maestro's own launch does not bring the app to the front on some phones), runs Maestro
# and keeps its report, a screenshot, the UI tree and the logcat as evidence.
set -Eeuo pipefail

APP_ID="io.inspectorhub.app"
APK="${1:?usage: android-emulator-golden.sh <dev-server apk> <engine origin> [output directory]}"
ENGINE_ORIGIN="${2:?usage: android-emulator-golden.sh <dev-server apk> <engine origin> [output directory]}"
OUT="${3:-${SMOKE_OUT:-$PWD/android-golden-out}}"
FLOW="maestro/golden/g2-controlled-sign-in.yaml"
mkdir -p "$OUT"

fail() { echo "::error::$*"; return 1; }
on_error() {
  local status=$?
  echo "::error::android-emulator-golden failed (exit $status)"
  adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
  adb exec-out screencap -p > "$OUT/screen-at-failure.png" 2>/dev/null || true
  adb shell uiautomator dump /sdcard/ui-failure.xml > /dev/null 2>&1 || true
  adb pull /sdcard/ui-failure.xml "$OUT/ui-at-failure.xml" > /dev/null 2>&1 || true
  echo "--- last logcat lines ---"
  tail -40 "$OUT/logcat.txt" 2>/dev/null || true
  exit "$status"
}
trap on_error ERR

[ -f "$APK" ] || fail "no APK at $APK"
[ -f "$FLOW" ] || fail "no flow at $FLOW"
command -v maestro > /dev/null || fail "maestro is not on PATH"

adb wait-for-device
serial="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
[ -n "$serial" ] || fail "no emulator is attached"
echo "device: $serial"

# Chrome's first-run screen would sit in front of the sign-in page on a fresh image. Best effort: ask Chrome to skip it. Whether the
# image honours this is checked by the run itself (the flow waits for the work list), not here.
adb shell 'echo "_ --no-first-run --disable-fre --no-default-browser-check" > /data/local/tmp/chrome-command-line' || true
adb shell am set-debug-app --persistent com.android.chrome > /dev/null 2>&1 || true

# The app and the WebView both use the emulator's own localhost: forward the Vite and fake engine ports to the runner.
adb reverse tcp:5173 tcp:5173
adb reverse tcp:8791 tcp:8791
adb install -r "$APK"
adb logcat -c
adb shell pm clear "$APP_ID"
adb shell am start -n "$APP_ID/io.inspectorhub.app.MainActivity"

waited=0
until [ -n "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || [ "$waited" -ge 60 ]; do sleep 2; waited=$((waited + 2)); done
[ -n "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || fail "the app process did not start within 60 s"
echo "ok: the app is running, starting $FLOW against $ENGINE_ORIGIN"

# Maestro exits non-zero when the flow fails; `set -e` and the ERR trap then keep the evidence.
maestro --device "$serial" test -e "SERVER_URL=$ENGINE_ORIGIN" --format junit --output "$OUT/maestro-g2.xml" --debug-output "$OUT/maestro-debug" "$FLOW"
echo "ok: G2 passed (controlled sign-in, work list, Online, nothing waiting to upload)"

adb exec-out screencap -p > "$OUT/screen-after-g2.png" || true
adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
# Only a crash of the APP's own process counts (see android-emulator-smoke.sh): the test tooling can log its own FATAL EXCEPTION.
if grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "Process: $APP_ID"; then
  grep -A8 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -20
  fail "the app crashed during G2 (FATAL EXCEPTION in the app process, see logcat.txt)"
fi
if grep -q "FATAL EXCEPTION" "$OUT/logcat.txt"; then echo "note: a FATAL EXCEPTION of another process is in logcat.txt (not the app); ignored"; fi
echo "ok: no crash in logcat"
echo "android-emulator-golden: G2 passed; evidence is in $OUT"
