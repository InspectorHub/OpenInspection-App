#!/usr/bin/env bash
# Golden flows G3 and G4 on an already-running emulator (CI starts it with android-emulator-runner).
#   G3: sign in, download today's work, switch the engine OFF, add a photo from the library, kill the app, start it again: the photo is
#       still there, still waiting. Then switch the engine ON and the photo uploads, once.
#   G4: after the restart, with the engine still off, the photo's tile looks like the photo (compared with a reference), not a placeholder.
# The flows are maestro/golden/g3-a-offline-photo.yaml and g3-b-after-restart.yaml; the engine questions go through scripts/lib/engine-state.mjs.
# Usage: scripts/android-emulator-offline-photo.sh <dev-server APK> <fake engine origin as the app sees it> <control server url> [output directory]
#
# The engine must be a SECOND fake engine started with `--scenario inspection` (the default scenario has no inspection to open), and its
# control server url is the one it printed. Everything else is as for android-emulator-golden.sh, which explains the APK and the reverse ports.
set -Eeuo pipefail

APP_ID="io.inspectorhub.app"
APK="${1:?usage: android-emulator-offline-photo.sh <dev-server apk> <engine origin> <control url> [output directory]}"
ENGINE_ORIGIN="${2:?usage: android-emulator-offline-photo.sh <dev-server apk> <engine origin> <control url> [output directory]}"
CONTROL_URL="${3:?usage: android-emulator-offline-photo.sh <dev-server apk> <engine origin> <control url> [output directory]}"
OUT="${4:-${SMOKE_OUT:-$PWD/android-offline-photo-out}}"
HERE="$(dirname "${BASH_SOURCE[0]}")"
mkdir -p "$OUT"
# shellcheck source=lib/dismiss-not-responding.sh
. "$HERE/lib/dismiss-not-responding.sh"
# shellcheck source=lib/android-start-app.sh
. "$HERE/lib/android-start-app.sh"

fail() { echo "::error::$*"; return 1; }
on_error() {
  local status=$?
  echo "::error::android-emulator-offline-photo failed (exit $status)"
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

engine_port="${ENGINE_ORIGIN##*:}"
# The sign-in goes through Chrome. Same best effort as android-emulator-golden.sh, repeated here so this script does not depend on G2 having run
# first in the same emulator: ask Chrome to skip its first-run screen.
adb shell 'echo "_ --no-first-run --disable-fre --no-default-browser-check" > /data/local/tmp/chrome-command-line' || true
adb shell am set-debug-app --persistent com.android.chrome > /dev/null 2>&1 || true

adb reverse tcp:5173 tcp:5173
adb reverse "tcp:$engine_port" "tcp:$engine_port"
adb install -r "$APK"
adb logcat -c
adb shell settings put global hide_error_dialogs 1 || true

# Switch the engine ON before anything starts: an earlier run on the same engine may have left it off. Written down, not assumed.
set_engine() { # true = switched off
  curl -fsS -X POST -H 'content-type: application/json' -d "{\"value\":$1}" "$CONTROL_URL/__test__/unavailable" > /dev/null
}
set_engine false

# --- the photo the flow will pick ---
# Put into the device's media index well BEFORE the flow opens the picker. Maestro's addMedia did it just before, and on API 34 the picker then
# listed nothing ("No photos or videos", CI run 41415156795): the index lags the file. Here the sign-in and the download give it minutes, and the
# script does not go on until the index itself lists the file (a query, not a sleep).
adb push maestro/fixtures/roof-photo.jpg /sdcard/Pictures/roof-photo.jpg
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/roof-photo.jpg > /dev/null
indexed=0
for _ in $(seq 1 30); do
  if adb shell content query --uri content://media/external/images/media --projection _display_name | grep -q 'roof-photo.jpg'; then indexed=1; break; fi
  sleep 2
done
[ "$indexed" = 1 ] || fail "the media index does not list roof-photo.jpg after 60 s"
echo "ok: roof-photo.jpg is in the media index"

# --- G3 part A: sign in, download, engine off, add the photo ---
adb shell pm clear "$APP_ID"
start_app "Choose your server"
echo "ok: the app is running, starting part A against $ENGINE_ORIGIN (engine control $CONTROL_URL)"
timeout 900 maestro --device "$serial" test -e "SERVER_URL=$ENGINE_ORIGIN" -e "CONTROL_URL=$CONTROL_URL" --format junit --output "$OUT/maestro-g3-a.xml" --debug-output "$OUT/maestro-debug-a" maestro/golden/g3-a-offline-photo.yaml
echo "ok: part A passed (the photo was added with the engine off)"

# The engine was off for the whole of part A: nothing may have reached it. A dead control server fails here too, it is not "nothing".
node "$HERE/lib/engine-state.mjs" "$CONTROL_URL" none-uploaded

# --- kill and restart: the photo must survive ---
adb shell am force-stop "$APP_ID"
[ -z "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || fail "the app is still running after force-stop"
# After the restart the work list is first, or the app's own offer to show upload progress, which is asked while a photo is waiting.
start_app "Work list|Show upload progress"
timeout 900 maestro --device "$serial" test --format junit --output "$OUT/maestro-g3-b.xml" --debug-output "$OUT/maestro-debug-b" --test-output-dir "$OUT/maestro-b-files" maestro/golden/g3-b-after-restart.yaml
echo "ok: part B passed (the photo and its thumbnail survived the restart, engine still off)"
# G4: the screenshot of the tile that part B took. It must exist (a flow that took none proves nothing) and be a picture.
tile="$(find "$OUT/maestro-b-files" -name 'g4-thumbnail-offline.png' | head -1)"
[ -n "$tile" ] || fail "part B took no screenshot of the tile (no g4-thumbnail-offline.png under $OUT/maestro-b-files)"
cp "$tile" "$OUT/g4-thumbnail-offline.png"
node "$HERE/lib/thumbnail-check.mjs" "$OUT/g4-thumbnail-offline.png"
node "$HERE/lib/engine-state.mjs" "$CONTROL_URL" none-uploaded

# --- the engine comes back: the photo is uploaded, once ---
# The wait is longer than it looks needed: after a restart the app's own retry waits 15 s, then 30 s, 60 s, ... (src/media/native-uploader.ts,
# jittered, in-process), and the engine may come back just after a failed try. The check then keeps watching for 15 s more for a second copy.
set_engine false
node "$HERE/lib/engine-state.mjs" "$CONTROL_URL" one-uploaded 420 15
echo "ok: the photo was uploaded exactly once after the engine came back"

adb exec-out screencap -p > "$OUT/screen-after-g3.png" || true
adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
if grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "Process: $APP_ID"; then
  grep -A8 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -20
  fail "the app crashed during G3 (FATAL EXCEPTION in the app process, see logcat.txt)"
fi
if grep -q "FATAL EXCEPTION" "$OUT/logcat.txt"; then echo "note: a FATAL EXCEPTION of another process is in logcat.txt (not the app); ignored"; fi
echo "ok: no crash in logcat"
echo "android-emulator-offline-photo: G3 and G4 passed; evidence is in $OUT"
