#!/usr/bin/env bash
# Driver for scripts/lib/ios-simulator.test.ts: loads scripts/lib/ios-simulator.sh with a stubbed xcrun, script, killall and sleep, then
# evals $SCENARIO. Everything a test varies comes in through environment variables; every call the library makes is appended to
# $STATE/calls.log, which the test reads back.
#
#   BOOTSTATUS_TEXT  what `simctl bootstatus -b` prints (default: it ended well)
#   BOOTSTATUS_HANG  seconds that bootstatus takes to end (default: at once)
#   ANSWER_AFTER     the first N `launchctl list` probes fail, then it answers (default 0)
#   NEVER_ANSWER     set: `launchctl list` never answers
#   LIST             springboard (default) | none: whether the answer lists SpringBoard with a pid
#   SPRINGBOARD_AFTER with LIST=none: SpringBoard is listed from the probe after this many (a SpringBoard that shows up late)
#   APP_UP_AT_LAUNCH the app process exists once this many launches were started (0 = never)
#   APP_DASH         set: the app is listed but with a dash instead of a pid (not running)
#   CRASH_ON_LAUNCH  set: every launch leaves a crash report behind
set -Eeuo pipefail
: "${LIB:?}" "${STATE:?}" "${SCENARIO:?}"
LOG="$STATE/calls.log"
: > "$LOG"
APP_ID=io.inspectorhub.app
OUT="$STATE/out"
SMOKE_CRASH_DIR="$STATE/crash"
mkdir -p "$OUT" "$SMOKE_CRASH_DIR"
export SMOKE_CRASH_DIR SMOKE_POLL_SECONDS="${SMOKE_POLL_SECONDS:-0}"

fail() { echo "FAIL: $*"; return 1; }
sleep() { command sleep 0.05; }
killall() { echo "killall $*" >> "$LOG"; }

counter() { local n; n="$(cat "$STATE/$1" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$STATE/$1"; echo "$n"; }

script() {
  echo "script $*" >> "$LOG"
  counter launches > /dev/null
  if [ -n "${CRASH_ON_LAUNCH:-}" ]; then command sleep 0.4; : > "$SMOKE_CRASH_DIR/App-2026-11-02-crash.ips"; fi
}

xcrun() {
  echo "xcrun $*" >> "$LOG"
  [ "$1" = simctl ] || return 0
  case "$2" in
    bootstatus)
      [ -z "${BOOTSTATUS_HANG:-}" ] || command sleep "$BOOTSTATUS_HANG"
      printf '%s\n' "${BOOTSTATUS_TEXT:-Device already booted, nothing to do.}" ;;
    spawn)
      local n launches
      n="$(counter probes)"
      [ -z "${NEVER_ANSWER:-}" ] || return 1
      [ "$n" -gt "${ANSWER_AFTER:-0}" ] || return 1
      if [ "${LIST:-springboard}" = springboard ] || { [ -n "${SPRINGBOARD_AFTER:-}" ] && [ "$n" -gt "$SPRINGBOARD_AFTER" ]; }; then printf '123\t0\tcom.apple.SpringBoard\n'; else printf -- '-\t0\tcom.apple.something\n'; fi
      launches="$(cat "$STATE/launches" 2>/dev/null || echo 0)"
      if [ "${APP_UP_AT_LAUNCH:-0}" -gt 0 ] && [ "$launches" -ge "${APP_UP_AT_LAUNCH:-0}" ]; then
        if [ -n "${APP_DASH:-}" ]; then printf -- '-\t0\tUIKitApplication:%s[abcd]\n' "$APP_ID"; else printf '4242\t0\tUIKitApplication:%s[abcd]\n' "$APP_ID"; fi
      fi ;;
  esac
  return 0
}

# shellcheck source=../ios-simulator.sh
. "$LIB"
eval "$SCENARIO"
