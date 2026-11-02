# Sourced by scripts/android-emulator-offline-photo.sh (and exercised by scripts/lib/android-start-app.test.ts with a stand-in adb).
# The caller defines: fail() (prints an error and returns 1), APP_ID, OUT (a directory for evidence), and has sourced dismiss-not-responding.sh.
#
# Why this exists: CI run 41417726030 started the app and handed it to Maestro after one look at "an app window is in front". For 60 s the
# app never drew its first screen and the launcher was in front at the end: nothing in the log said why. An app that is started and not
# looked at again is a flake with no evidence. So the first screen is waited for, by its text, and an app that does not show it is stopped
# and started again (visibly: a ::warning::, a screenshot of what was there), a few times, before the run gives up.

# wait_for_screen_text <pattern> <seconds>: true as soon as a dump of the screen holds <pattern> (an extended regular expression), false when
# it did not within <seconds>. A system "isn't responding" dialog found on the way is dismissed (Wait, never Close app). Always looks once.
wait_for_screen_text() {
  local pattern="$1" limit="$2" waited=0
  while :; do
    # A dump that failed must not leave an earlier one to be read: remove the old file on the device and here first.
    adb shell rm -f /sdcard/ui-wait.xml > /dev/null 2>&1 || true
    rm -f "$OUT/ui-wait.xml"
    adb shell uiautomator dump /sdcard/ui-wait.xml > /dev/null 2>&1 || true
    adb pull /sdcard/ui-wait.xml "$OUT/ui-wait.xml" > /dev/null 2>&1 || true
    dismiss_not_responding "$OUT/ui-wait.xml" || true
    # grep on the file, not on a pipe: under pipefail an early-exiting grep can fail a pipeline by SIGPIPE.
    if [ -f "$OUT/ui-wait.xml" ] && grep -qE "$pattern" "$OUT/ui-wait.xml"; then return 0; fi
    [ "$waited" -lt "$limit" ] || return 1
    sleep 3
    waited=$((waited + 3))
  done
}

# start_app <pattern> [attempts]: starts the app and waits (START_SCREEN_SECONDS, default 90) for <pattern> on screen. When it does not
# come, saves a screenshot and the screen tree, stops the app, and starts it again, up to [attempts] (default 3) in all.
start_app() {
  local pattern="$1" attempts="${2:-3}" attempt waited
  for attempt in $(seq 1 "$attempts"); do
    adb shell am start -n "$APP_ID/io.inspectorhub.app.MainActivity"
    waited=0
    until [ -n "$(adb shell pidof "$APP_ID" | tr -d '\r')" ] || [ "$waited" -ge "${START_PID_SECONDS:-60}" ]; do sleep 2; waited=$((waited + 2)); done
    if [ -z "$(adb shell pidof "$APP_ID" | tr -d '\r')" ]; then
      echo "::warning::the app process did not start within ${START_PID_SECONDS:-60} s (attempt $attempt of $attempts)"
    elif wait_for_screen_text "$pattern" "${START_SCREEN_SECONDS:-90}"; then
      echo "start_app: \"$pattern\" after $attempt launch(es)" >> "$OUT/start-attempts.txt"
      if [ "$attempt" -gt 1 ]; then
        echo "::warning::the app needed $attempt launches before it showed its first screen (see first-screen-attempt-*.png)"
        # In the job summary too, where a green run that needed a relaunch is not lost among the annotations.
        [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "- The app needed $attempt launches before it showed \"$pattern\" (a relaunch hides a flake; see first-screen-attempt-*.png)" >> "$GITHUB_STEP_SUMMARY"
      fi
      return 0
    else
      echo "::warning::the app did not show \"$pattern\" within ${START_SCREEN_SECONDS:-90} s (attempt $attempt of $attempts)"
    fi
    adb exec-out screencap -p > "$OUT/first-screen-attempt-$attempt.png" 2>/dev/null || true
    cp "$OUT/ui-wait.xml" "$OUT/first-screen-attempt-$attempt.xml" 2>/dev/null || true
    adb shell am force-stop "$APP_ID" || true
  done
  fail "the app did not show \"$pattern\" in $attempts launches"
}
