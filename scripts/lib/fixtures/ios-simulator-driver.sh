#!/usr/bin/env bash
# Driver for scripts/lib/ios-simulator.test.ts: loads scripts/lib/ios-simulator.sh with a stand-in xcrun (an executable, see fixtures/ios-stubs/
# xcrun.sh: its scenarios are listed there) and stubbed script, killall and sleep, then evals $SCENARIO. Everything a test varies comes in
# through environment variables; every call the library makes is appended to $STATE/calls.log, which the test reads back.
#
#   CRASH_ON_LAUNCH  set: every launch leaves a crash report behind (CRASH_NAME: its file name, default App-2026-11-02-crash.ips)
set -Eeuo pipefail
: "${LIB:?}" "${STATE:?}" "${SCENARIO:?}"
LOG="$STATE/calls.log"
: > "$LOG"
export STATE
export APP_ID=io.inspectorhub.app
OUT="$STATE/out"
SMOKE_CRASH_DIR="$STATE/crash"
mkdir -p "$OUT" "$SMOKE_CRASH_DIR" "$STATE/bin"
export SMOKE_CRASH_DIR SMOKE_POLL_SECONDS="${SMOKE_POLL_SECONDS:-0}"

# The stand-in xcrun is a program on PATH: GNU timeout starts programs, not shell functions.
cp "$(dirname "${BASH_SOURCE[0]}")/ios-stubs/xcrun.sh" "$STATE/bin/xcrun"
chmod +x "$STATE/bin/xcrun"
# PATH is colon-separated: a Windows path (C:/Users/...) from the test would be split at its colon, so the directory is given as a POSIX path.
export PATH="$(cd "$STATE/bin" && pwd):$PATH"

fail() { echo "FAIL: $*"; return 1; }
sleep() { command sleep 0.05; }
killall() { echo "killall $*" >> "$LOG"; }

script() {
  echo "script $*" >> "$LOG"
  local n
  n="$(cat "$STATE/launches" 2>/dev/null || echo 0)"
  echo $((n + 1)) > "$STATE/launches"
  # The crash report is there at once, with a modification time in the FUTURE: newer than the marker however slowly this machine got here.
  if [ -n "${CRASH_ON_LAUNCH:-}" ]; then
    : > "$SMOKE_CRASH_DIR/${CRASH_NAME:-App-2026-11-02-crash.ips}"
    touch -d '+1 hour' "$SMOKE_CRASH_DIR/${CRASH_NAME:-App-2026-11-02-crash.ips}"
  fi
}

# shellcheck source=../ios-simulator.sh
. "$LIB"
eval "$SCENARIO"
