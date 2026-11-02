#!/usr/bin/env bash
# A stand-in for `xcrun`, an EXECUTABLE (GNU timeout, which the library uses to bound every call to the simulator, can start a program but not
# a shell function). Used by scripts/lib/ios-simulator.test.ts through fixtures/ios-simulator-driver.sh. Every call is appended to
# $STATE/calls.log. What a test varies comes in through environment variables:
#   BOOTSTATUS_TEXT   what `simctl bootstatus -b` prints (default: it ended well)
#   BOOTSTATUS_HANG   seconds that bootstatus takes to end (default: at once)
#   ANSWER_AFTER      the first N `launchctl list` probes fail, then it answers (default 0)
#   NEVER_ANSWER      set: `launchctl list` never answers
#   SPAWN_HANG_FIRST  the first N `launchctl list` probes hang for 30 s (a wedged simulator)
#   LIST              springboard (default) | none: whether the answer lists SpringBoard with a pid
#   SPRINGBOARD_AFTER with LIST=none: SpringBoard is listed from the probe after this many
#   IGNORE_TERM       set: a hanging call ignores SIGTERM, so `timeout -k` has to kill it (its status is then 137, not 124)
#   APP_UP_AT_LAUNCH  the app process exists once this many launches were started (0 = never)
#   APP_DASH          set: the app is listed but with a dash instead of a pid (not running)
#   APP_TWO_LINES     set: a dash line AND a pid line are listed for the app
echo "xcrun $*" >> "$STATE/calls.log"
[ "${1:-}" = simctl ] || exit 0

# A hang that does not end on SIGTERM. A loop of short sleeps, not one long one: a long `sleep` left behind after the kill would keep the
# caller's command substitution open until it ended.
hang() {
  if [ -n "${IGNORE_TERM:-}" ]; then trap '' TERM; while :; do sleep 1; done; fi
  exec sleep "$1"
}

counter() {
  local n
  n="$(cat "$STATE/$1" 2>/dev/null || echo 0)"
  n=$((n + 1))
  echo "$n" > "$STATE/$1"
  echo "$n"
}

case "${2:-}" in
  bootstatus)
    [ -z "${BOOTSTATUS_HANG:-}" ] || hang "$BOOTSTATUS_HANG"
    printf '%s\n' "${BOOTSTATUS_TEXT:-Device already booted, nothing to do.}"
    ;;
  spawn)
    n="$(counter probes)"
    if [ "$n" -le "${SPAWN_HANG_FIRST:-0}" ]; then hang 30; fi
    [ -z "${NEVER_ANSWER:-}" ] || exit 1
    [ "$n" -gt "${ANSWER_AFTER:-0}" ] || exit 1
    if [ "${LIST:-springboard}" = springboard ] || { [ -n "${SPRINGBOARD_AFTER:-}" ] && [ "$n" -gt "$SPRINGBOARD_AFTER" ]; }; then
      printf '123\t0\tcom.apple.SpringBoard\n'
    else
      printf -- '-\t0\tcom.apple.something\n'
    fi
    launches="$(cat "$STATE/launches" 2>/dev/null || echo 0)"
    if [ "${APP_UP_AT_LAUNCH:-0}" -gt 0 ] && [ "$launches" -ge "${APP_UP_AT_LAUNCH:-0}" ]; then
      if [ -n "${APP_TWO_LINES:-}" ]; then printf -- '-\t0\tUIKitApplication:%s[abcd]\n' "$APP_ID"; fi
      if [ -n "${APP_DASH:-}" ]; then printf -- '-\t0\tUIKitApplication:%s[abcd]\n' "$APP_ID"; else printf '4242\t0\tUIKitApplication:%s[abcd]\n' "$APP_ID"; fi
    fi
    ;;
esac
exit 0
