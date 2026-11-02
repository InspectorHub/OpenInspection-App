# Sourced by scripts/ios-simulator-smoke.sh (and exercised by scripts/lib/ios-simulator.test.ts with a stubbed xcrun and script).
# The caller defines: fail() (prints an error and returns 1), APP_ID, OUT (a directory for the evidence files).
#
# What the CI logs showed, and why the functions below are shaped as they are:
#  - `simctl bootstatus -b` ends with `Status=4294967295, isTerminal=YES` after 1-2 minutes on the macOS runner. That is bootstatus giving
#    up WAITING, not the boot failing: run 41372183809 passed on a plain retry (the next boot printed "Device already booted" and the
#    app ran), and a retry that shut everything down, restarted CoreSimulatorService and erased the device (run 41374220395) interrupted
#    the boot that was about to finish and failed six times out of six. So a boot bootstatus gave up on is left alone and waited for.
#  - Answering `launchctl list` only says launchd is up, which happens long before the home screen is: a simulator that "answered" then
#    showed no app process for 72 s (run 41375830738). So the wait is for SpringBoard to be listed with a pid, with a short grace period
#    so that a label this code guessed wrong costs seconds, not minutes (the full list is printed then, so the next log shows the real one).
#  - Every wait is a deadline on the wall clock ($SECONDS), not a count of sleeps: a probe against a wedged simulator can itself take a
#    long time.
#
# Overridable for tests: SMOKE_BOOT_LIMIT (bootstatus, 240 s), SMOKE_ANSWER_QUICK (30), SMOKE_ANSWER_LIMIT (240), SMOKE_SPRINGBOARD_GRACE (20),
# SMOKE_LAUNCH_LIMIT (60), SMOKE_POLL_SECONDS (3), SMOKE_CRASH_DIR (the host's DiagnosticReports).

# A line for the job summary, when there is one (GitHub sets GITHUB_STEP_SUMMARY; elsewhere this does nothing).
summary_line() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$*" >> "$GITHUB_STEP_SUMMARY"; }

app_is_running() {
  # `launchctl list` prints "<pid> <status> UIKitApplication:<id>[...]"; a dash instead of the pid means not running.
  local line
  line="$(xcrun simctl spawn "$1" launchctl list | grep "UIKitApplication:$APP_ID" || true)"
  [ -n "$line" ] && ! printf '%s' "$line" | awk '{print $1}' | grep -qx -- '-'
}

# simulator_answers <udid> <seconds> [name]: true once `launchctl list` runs inside the simulator and lists SpringBoard with a pid. If it runs
# but SpringBoard is not listed within the grace period (or the label is not what was guessed), it goes on with a warning and the whole
# list. False when it never ran within <seconds>.
simulator_answers() {
  local udid="$1" limit="$2" name="${3:-simulator}" end out seen answered_at="" grace="${SMOKE_SPRINGBOARD_GRACE:-20}" last=""
  end=$((SECONDS + limit))
  while :; do
    if out="$(xcrun simctl spawn "$udid" launchctl list 2>/dev/null)"; then
      last="$out"
      [ -n "$answered_at" ] || answered_at="$SECONDS"
      seen="$(printf '%s\n' "$out" | grep -Ei '^[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+.*SpringBoard' | head -1 || true)"
      if [ -n "$seen" ]; then
        # Written down on EVERY run: whether SpringBoard is the label to wait for was a guess, and this is how a run settles it.
        echo "ok: $name: SpringBoard is listed as: $(printf '%s' "$seen" | tr -s '[:space:]' ' ')"
        summary_line "- $name: SpringBoard listed as \`$(printf '%s' "$seen" | tr -s '[:space:]' ' ')\`"
        return 0
      fi
      if [ "$SECONDS" -ge $((answered_at + grace)) ]; then
        echo "::warning::$name: the simulator answers launchctl but no SpringBoard line with a pid showed up in ${grace} s; going on. What it lists:"
        printf '%s\n' "$last" | head -40
        summary_line "- $name: **SpringBoard was NOT listed** within ${grace} s; the simulator lists: $(printf '%s\n' "$last" | awk '{print $3}' | head -15 | tr '\n' ' ')"
        return 0
      fi
    fi
    [ "$SECONDS" -lt "$end" ] || break
    sleep "${SMOKE_POLL_SECONDS:-3}"
  done
  # It answered but was cut off by the overall limit before the grace period ended: it did answer.
  [ -z "$answered_at" ] || return 0
  return 1
}

# bootstatus_bounded <udid> <seconds>: `simctl bootstatus -b` for at most <seconds>. Its output goes to BOOTSTATUS_OUT (and its tail is
# printed). Returns 0 when it ended by itself and 124 when it was still running at the deadline and was stopped.
bootstatus_bounded() {
  local udid="$1" limit="$2" file pid end rc=0
  file="$(mktemp)"
  xcrun simctl bootstatus "$udid" -b > "$file" 2>&1 &
  pid=$!
  end=$((SECONDS + limit))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$end" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      echo "bootstatus was still running after ${limit} s and was stopped" >> "$file"
      rc=124
      break
    fi
    sleep 1
  done
  [ "$rc" -eq 124 ] || wait "$pid" 2>/dev/null || true
  BOOTSTATUS_OUT="$(cat "$file")"
  rm -f "$file"
  printf '%s\n' "$BOOTSTATUS_OUT" | tail -3
  return "$rc"
}

# boot_simulator <label> <udid>: boots one simulator and waits until it is usable, or fails saying it is the runner's simulator.
boot_simulator() {
  local label="$1" udid="$2" attempt rc
  for attempt in 1 2 3; do
    xcrun simctl boot "$udid" 2>/dev/null || true
    rc=0
    bootstatus_bounded "$udid" "${SMOKE_BOOT_LIMIT:-240}" || rc=$?
    if [ "$rc" -ne 124 ] && ! printf '%s' "$BOOTSTATUS_OUT" | grep -q 'Status=4294967295'; then
      simulator_answers "$udid" "${SMOKE_ANSWER_QUICK:-30}" "$label" && return 0
    else
      echo "::warning::$label: bootstatus gave up (attempt $attempt of 3); leaving the boot alone and waiting for the simulator to answer"
      simulator_answers "$udid" "${SMOKE_ANSWER_LIMIT:-240}" "$label" && return 0
    fi
    # Nothing to reset for: after the last attempt the failure is reported with the simulator as it is.
    [ "$attempt" -lt 3 ] || break
    echo "::warning::$label: the simulator never answered (attempt $attempt of 3); resetting CoreSimulator"
    xcrun simctl shutdown all 2>/dev/null || true
    killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
    sleep 5
    xcrun simctl erase "$udid" 2>/dev/null || true
  done
  fail "$label: the simulator did not boot after 3 attempts; this is the runner's simulator, not the app"
}

# launch_app <label> <udid>: starts the app under script(1) (see smoke_device for why) and waits for its process. A launch that produced
# no process in the limit is repeated ONCE, unless the app crashed meanwhile (a crash report newer than the launch): a crash is not slowness,
# and retrying it could turn a build that crashes on half its launches green. A launch that needed the second attempt is said so in the log
# and in the job summary. Giving up is not decided here: the caller's check after the settle time still fails the run with the app's message.
launch_app() {
  local label="$1" udid="$2" attempt marker end crashes crash_dir="${SMOKE_CRASH_DIR:-$HOME/Library/Logs/DiagnosticReports}"
  for attempt in 1 2; do
    marker="$(mktemp)"
    script -q -F "$OUT/${label}.typescript" xcrun simctl launch --console-pty "$udid" "$APP_ID" > /dev/null 2>&1 &
    LAUNCH_PID=$!
    end=$((SECONDS + ${SMOKE_LAUNCH_LIMIT:-60}))
    until app_is_running "$udid" || [ "$SECONDS" -ge "$end" ]; do sleep 2; done
    if app_is_running "$udid"; then
      rm -f "$marker"
      if [ "$attempt" -gt 1 ]; then
        echo "::warning::$label: the app needed a second launch to start (the first produced no process in ${SMOKE_LAUNCH_LIMIT:-60} s)"
        [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "- $label: the app needed a second launch to start" >> "$GITHUB_STEP_SUMMARY"
      fi
      return 0
    fi
    echo "::warning::$label: no app process ${SMOKE_LAUNCH_LIMIT:-60} s after launch (attempt $attempt of 2)"
    echo "--- $label: what the simulator was doing ---"
    xcrun simctl list devices | grep -E "Booted|$udid" || true
    xcrun simctl spawn "$udid" launchctl list 2>&1 | grep -iE "SpringBoard|backboardd|UIKitApplication|PID" | head -12 || true
    crashes="$(find "$crash_dir" -maxdepth 1 -name 'App*' -newer "$marker" 2>/dev/null | head -3 || true)"
    rm -f "$marker"
    if [ -n "$crashes" ]; then
      printf '%s\n' "$crashes"
      # Explicit, not left to `set -e`: in a conditional context errexit is off, and the loop would go on and launch again.
      fail "$label: the app crashed on launch (a crash report appeared while it started); not repeating the launch" || return 1
    fi
    kill "$LAUNCH_PID" 2>/dev/null || true
    xcrun simctl terminate "$udid" "$APP_ID" > /dev/null 2>&1 || true
    sleep 3
  done
  return 0
}
