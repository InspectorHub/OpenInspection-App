#!/usr/bin/env bash
# Golden flow G5 on an already-running emulator (CI starts it with android-emulator-runner): a report that was published.
#   Part A: sign in, download, open the inspection: it is read-only with the version in a banner; Edit and republish opens it; a publish
#           with nothing said answers "nothing changed". The engine must then have seen ONE publish, unchanged, with no notice choice.
#   Part B: open it again, publish with a summary and the notice box ticked. The engine must then hold version 4, locked, and have seen
#           the choice (notifyClient true) and the summary.
# The flows are maestro/golden/g5-a-published-report.yaml and g5-b-republish-with-notice.yaml; the engine questions go through
# scripts/lib/report-state.mjs, because the screen can say "queued" for a request that never went out.
# Usage: scripts/android-emulator-published.sh <dev-server APK> <fake engine origin as the app sees it> <control server url> [output directory]
#
# The engine must be a fake engine started with `--scenario published`, its control server url the one it printed. Everything else is as for
# android-emulator-golden.sh, which explains the APK and the reverse ports.
set -Eeuo pipefail

APP_ID="io.inspectorhub.app"
APK="${1:?usage: android-emulator-published.sh <dev-server apk> <engine origin> <control url> [output directory]}"
ENGINE_ORIGIN="${2:?usage: android-emulator-published.sh <dev-server apk> <engine origin> <control url> [output directory]}"
CONTROL_URL="${3:?usage: android-emulator-published.sh <dev-server apk> <engine origin> <control url> [output directory]}"
OUT="${4:-${SMOKE_OUT:-$PWD/android-published-out}}"
HERE="$(dirname "${BASH_SOURCE[0]}")"
mkdir -p "$OUT"
# shellcheck source=lib/dismiss-not-responding.sh
. "$HERE/lib/dismiss-not-responding.sh"
# shellcheck source=lib/android-start-app.sh
. "$HERE/lib/android-start-app.sh"

fail() { echo "::error::$*"; return 1; }
on_error() {
  local status=$?
  echo "::error::android-emulator-published failed (exit $status)"
  adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
  adb exec-out screencap -p > "$OUT/screen-at-failure.png" 2>/dev/null || true
  adb shell uiautomator dump /sdcard/ui-failure.xml > /dev/null 2>&1 || true
  adb pull /sdcard/ui-failure.xml "$OUT/ui-at-failure.xml" > /dev/null 2>&1 || true
  curl -fsS "$CONTROL_URL/__test__/state" > "$OUT/engine-state-at-failure.json" 2>/dev/null || true
  echo "--- last logcat lines ---"
  tail -40 "$OUT/logcat.txt" 2>/dev/null || true
  exit "$status"
}
trap on_error ERR

[ -f "$APK" ] || fail "no APK at $APK"
command -v maestro > /dev/null || fail "maestro is not on PATH"
command -v node > /dev/null || fail "node is not on PATH"

adb wait-for-device
# ANDROID_SERIAL (adb reads it too) pins the device on a machine with a phone attached; on a CI runner there is only the emulator.
serial="${ANDROID_SERIAL:-$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')}"
[ -n "$serial" ] || fail "no emulator is attached"
echo "device: $serial"
export ANDROID_SERIAL="$serial"

engine_port="${ENGINE_ORIGIN##*:}"
adb shell 'echo "_ --no-first-run --disable-fre --no-default-browser-check" > /data/local/tmp/chrome-command-line' || true
adb shell am set-debug-app --persistent com.android.chrome > /dev/null 2>&1 || true

adb reverse tcp:5173 tcp:5173
adb reverse "tcp:$engine_port" "tcp:$engine_port"
adb install -r "$APK"
adb logcat -c
adb shell settings put global hide_error_dialogs 1 || true

# The engine starts as a published report, locked at version 3, with nothing published and nothing reopened. A run that is repeated on the
# same engine would start from the end of the last one, so say what is expected instead of assuming it.
node "$HERE/lib/report-state.mjs" "$CONTROL_URL" locked 3 '[]' 5

adb shell pm clear "$APP_ID"
start_app "Choose your server"
echo "ok: the app is running, starting part A against $ENGINE_ORIGIN (engine control $CONTROL_URL)"
adb shell uiautomator dump /sdcard/ui-preflight.xml > /dev/null 2>&1 || true
adb pull /sdcard/ui-preflight.xml "$OUT/ui-preflight.xml" > /dev/null 2>&1 || true
dismiss_not_responding "$OUT/ui-preflight.xml" || true

# --- part A ---
timeout 900 maestro --device "$serial" test -e "SERVER_URL=$ENGINE_ORIGIN" --format junit --output "$OUT/maestro-g5-a.xml" --debug-output "$OUT/maestro-debug-a" maestro/golden/g5-a-published-report.yaml
echo "ok: G5 part A passed on screen"
# The screen said "Nothing to publish": the engine must agree. One publish, nothing said, so no new version; locked again at 3; the app sent no
# notice choice (an unticked box is not sent, which is what the engine answers to as "no").
node "$HERE/lib/report-state.mjs" "$CONTROL_URL" locked 3 '[{"notifyClient":null,"summary":null,"outcome":"unchanged"}]' 20
echo "ok: the engine saw one publish, unchanged, with no notice choice, and the report is locked at version 3"

# --- part B: the same app session, nothing cleared or restarted between the parts ---
timeout 900 maestro --device "$serial" test --format junit --output "$OUT/maestro-g5-b.xml" --debug-output "$OUT/maestro-debug-b" maestro/golden/g5-b-republish-with-notice.yaml
echo "ok: G5 part B passed on screen"
node "$HERE/lib/report-state.mjs" "$CONTROL_URL" locked 4 '[{"notifyClient":null,"summary":null,"outcome":"unchanged"},{"notifyClient":true,"summary":"Corrected the roof rating","outcome":"new_version"}]' 20
echo "ok: the engine holds version 4, locked, and saw notifyClient true with the summary"

adb exec-out screencap -p > "$OUT/screen-after-g5.png" || true
adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
# Only a crash of the APP's own process counts: the test tooling can log its own FATAL EXCEPTION.
if grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "Process: $APP_ID"; then
  grep -A8 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -20
  fail "the app crashed during G5 (FATAL EXCEPTION in the app process, see logcat.txt)"
fi
echo "ok: no crash in logcat"
echo "android-emulator-published: G5 passed; evidence is in $OUT"
