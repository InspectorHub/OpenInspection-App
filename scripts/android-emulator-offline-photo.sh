#!/usr/bin/env bash
# Golden flows G3 and G4 on an already-running emulator (CI starts it with android-emulator-runner).
#   G3: sign in, download today's work, switch the engine OFF, add a photo from the library, kill the app, start it again: the photo is
#       still there, still waiting. Then switch the engine ON and the photo uploads, once.
#   G4: after the restart, with the engine still off, the photo's tile looks like THAT photo (colours judged and matched to the fixture's, see
#       scripts/lib/thumbnail-check.mjs), not a placeholder or another picture.
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
# What the app's WebView prints (console, uncaught errors), recorded through DevTools for the whole run: logcat has none of it in this
# build, and a flow that fails after "the photo was picked" needs the page's own words (CI runs 41432932375 and 41458862876).
console_pid=""
stop_console() {
  [ -n "$console_pid" ] || return 0
  kill "$console_pid" 2>/dev/null || true
  # Bounded: a recorder stuck on a dead socket must never hold the job (it exits by itself on SIGTERM; this is the belt to those braces).
  local waited
  for waited in 1 2 3 4 5 6 7 8; do
    kill -0 "$console_pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$console_pid" 2>/dev/null || true
  wait "$console_pid" 2>/dev/null || true
  console_pid=""
}
trap stop_console EXIT
on_error() {
  local status=$?
  echo "::error::android-emulator-offline-photo failed (exit $status)"
  # Before the recorder stops: what the page shows now.
  timeout 30 node "$HERE/lib/webview-console.mjs" snapshot "$OUT/webview-snapshot.txt" || true
  stop_console
  if [ -s "$OUT/webview-console.jsonl" ]; then
    echo "--- the WebView's console (last 40 of $(wc -l < "$OUT/webview-console.jsonl" | tr -d ' ') lines; full: webview-console.jsonl) ---"
    tail -40 "$OUT/webview-console.jsonl" || true
  fi
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
# The recorder's own adb calls go to the same device as the flow's.
export ANDROID_SERIAL="$serial"

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
node "$HERE/lib/webview-console.mjs" collect "$OUT/webview-console.jsonl" &
console_pid=$!

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
# The row must be the file just pushed: this name AND this size. An old row of the same name from an earlier run, or another file with the
# name, does not count. The output is read into a variable, not piped into grep: under pipefail an early-exiting grep can fail a pipeline
# by SIGPIPE and the loop would call an indexed file "not indexed".
fixture_size="$(wc -c < maestro/fixtures/roof-photo.jpg | tr -d ' ')"
indexed=0
for _ in $(seq 1 30); do
  rows="$(adb shell "content query --uri content://media/external/images/media --where \"_display_name='roof-photo.jpg'\" --projection _display_name:_size" || true)"
  case "$rows" in *"_size=$fixture_size"*) indexed=1; break ;; esac
  sleep 2
done
[ "$indexed" = 1 ] || fail "the media index does not list roof-photo.jpg ($fixture_size bytes) after 60 s"
echo "ok: roof-photo.jpg is in the media index"
# The picker takes the newest tile. Say so when it is not the only picture on the device.
images="$(adb shell "content query --uri content://media/external/images/media --projection _id" || true)"
image_count="$(grep -c '^Row:' <<< "$images" || true)"
[ "${image_count:-0}" -le 1 ] || echo "::warning::$image_count pictures are in the media index; the picker takes the newest tile, which must be roof-photo.jpg"

# --- G3 part A: sign in, download, engine off, add the photo ---
adb shell pm clear "$APP_ID"
start_app "Choose your server"
echo "ok: the app is running, starting part A against $ENGINE_ORIGIN (engine control $CONTROL_URL)"
timeout 900 maestro --device "$serial" test -e "SERVER_URL=$ENGINE_ORIGIN" -e "CONTROL_URL=$CONTROL_URL" --format junit --output "$OUT/maestro-g3-a.xml" --debug-output "$OUT/maestro-debug-a" --test-output-dir "$OUT/maestro-a-files" maestro/golden/g3-a-offline-photo.yaml
echo "ok: part A passed (the photo was added with the engine off)"

# The engine was off for the whole of part A: nothing may have reached it. A dead control server fails here too, it is not "nothing".
node "$HERE/lib/engine-state.mjs" "$CONTROL_URL" none-uploaded

# --- kill and restart: the photo must survive ---
adb shell am force-stop "$APP_ID"
[ -z "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || fail "the app is still running after force-stop"
# After the restart the work list is first, or the app's own offer to show upload progress, which is asked while a photo is waiting.
start_app "Work list|Show upload progress"
# An earlier run on the same output directory must not satisfy the check below.
rm -rf "$OUT/maestro-b-files" "$OUT/g4-thumbnail-offline.png"
timeout 900 maestro --device "$serial" test --format junit --output "$OUT/maestro-g3-b.xml" --debug-output "$OUT/maestro-debug-b" --test-output-dir "$OUT/maestro-b-files" maestro/golden/g3-b-after-restart.yaml
echo "ok: part B passed (the photo and its thumbnail survived the restart, engine still off)"
# G4: the screenshot of the tile that part B took. It must exist (a flow that took none proves nothing) and be a picture.
tile="$(find "$OUT/maestro-b-files" -name 'g4-thumbnail-offline.png' -print -quit 2>/dev/null || true)"
[ -n "$tile" ] || fail "part B took no screenshot of the tile (no g4-thumbnail-offline.png under $OUT/maestro-b-files)"
cp "$tile" "$OUT/g4-thumbnail-offline.png"
node "$HERE/lib/thumbnail-check.mjs" "$OUT/g4-thumbnail-offline.png" --like "$HERE/lib/fixtures/thumbnail-picture.png"
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
stop_console
if [ -f "$OUT/webview-console.jsonl" ]; then
  echo "the WebView console: $(grep -c '"level":"error"' "$OUT/webview-console.jsonl" || true) error line(s) in $(wc -l < "$OUT/webview-console.jsonl" | tr -d ' ') (webview-console.jsonl)"
else
  echo "::warning::the WebView console recorder wrote no file"
fi
echo "android-emulator-offline-photo: G3 and G4 passed; evidence is in $OUT"
