#!/usr/bin/env bash
# Golden flow G5 on the iOS simulator (macOS runner): a report that was published. The same behaviour as scripts/android-emulator-published.sh:
#   Part A: sign in, download, open the inspection: it is read-only with the version in a banner; Edit and republish opens it; a publish
#           with nothing said answers "nothing changed". The engine must then have seen ONE publish, unchanged, with no notice choice.
#   Part B: open it again, publish with a summary and the notice box ticked. The engine must then hold version 4, locked, and have seen
#           the choice (notifyClient true) and the summary.
# The flows are maestro/ios/g5-a-published-report.yaml and g5-b-republish-with-notice.yaml (sign-in: maestro/ios/sign-in.yaml); the engine
# questions go through scripts/lib/report-state.mjs, because the screen can say "queued" for a request that never went out.
#
# Usage: scripts/ios-simulator-published.sh <path to App.app> <engine origin as the app sees it> <control server url> <certificate pem> [output directory]
#
# The app is the ordinary simulator build (no App Transport Security exception, no development switch). So the engine must be a fake engine
# started with `--scenario published` over HTTPS, and <certificate pem> is the certificate it serves: it is added to the simulator's trusted
# roots before the app starts. <engine origin> is then https://localhost:<port> (the certificate must name localhost). <control server url> is
# the one the engine printed (plain http on the host's loopback; only this script and the host read it).
# SIM_UDID pins a simulator (default: the newest available iPhone).
set -Eeuo pipefail

APP_ID="io.inspectorhub.app"
# The summary typed in part B (the flow reads it from the environment) and the one the engine must have received.
SUMMARY="Corrected the roof rating"
USAGE="usage: ios-simulator-published.sh <App.app> <engine origin> <control url> <certificate pem> [output directory]"
APP_PATH="${1:?$USAGE}"
ENGINE_ORIGIN="${2:?$USAGE}"
CONTROL_URL="${3:?$USAGE}"
CERT_PEM="${4:?$USAGE}"
OUT="${5:-${SMOKE_OUT:-$PWD/ios-published-out}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
FLOWS="$REPO_ROOT/maestro/ios"
mkdir -p "$OUT"

fail() { echo "::error::$*"; return 1; }

# fail() must exist before the library is read (it stops the script when GNU timeout is missing).
# shellcheck source=lib/ios-simulator.sh
. "$HERE/lib/ios-simulator.sh"

UDID=""
on_error() {
  local status=$?
  echo "::error::ios-simulator-published failed (exit $status)"
  if [ -n "$UDID" ]; then
    "$TIMEOUT_BIN" -k 2 60 xcrun simctl io "$UDID" screenshot "$OUT/screen-at-failure.png" > /dev/null 2>&1 || true
    "$TIMEOUT_BIN" -k 2 120 xcrun simctl spawn "$UDID" log show --last 15m --info --debug --predicate 'process == "App"' > "$OUT/app.log" 2>&1 || true
    echo "--- last app log lines ---"
    tail -40 "$OUT/app.log" 2>/dev/null || true
  fi
  "$TIMEOUT_BIN" -k 2 20 curl -fsS "$CONTROL_URL/__test__/state" > "$OUT/engine-state-at-failure.json" 2>/dev/null || true
  exit "$status"
}
trap on_error ERR

[ -d "$APP_PATH" ] || fail "no app bundle at $APP_PATH"
[ -s "$CERT_PEM" ] || fail "no certificate at $CERT_PEM"
command -v maestro > /dev/null || fail "maestro is not on PATH"
command -v node > /dev/null || fail "node is not on PATH"
case "$ENGINE_ORIGIN" in https://*) ;; *) fail "the engine origin must be https (the app has no App Transport Security exception): $ENGINE_ORIGIN" ;; esac

# The newest available iPhone, as in ios-simulator-smoke.sh.
pick_iphone() {
  xcrun simctl list devices available -j | jq -r '
    [.devices | to_entries[] | select(.key | contains("iOS")) | .value[] | select(.name | startswith("iPhone"))]
    | last | .udid // empty'
}
UDID="${SIM_UDID:-$(pick_iphone)}"
[ -n "$UDID" ] || fail "no available iPhone simulator"
echo "device: $UDID"

# Trust the engine's certificate in the simulator (the app's web view and the sign-in browser both use the system trust store).
# Added while the device is still shut down, so no networking process has cached a verdict about the host. If the tool refuses a shut-down
# device on some Xcode, boot it and add the root then: the app is not installed yet either way.
if ! "$TIMEOUT_BIN" -k 2 120 xcrun simctl keychain "$UDID" add-root-cert "$CERT_PEM"; then
  echo "::warning::the certificate could not be added to a shut-down simulator; booting it and adding the root there"
  boot_simulator iphone "$UDID"
  "$TIMEOUT_BIN" -k 2 120 xcrun simctl keychain "$UDID" add-root-cert "$CERT_PEM"
else
  boot_simulator iphone "$UDID"
fi
echo "ok: the engine's certificate is a trusted root in the simulator"

# A clean install. (Secure-store items live in the keychain and survive an uninstall: on a simulator that has been used before, erase it first.)
xcrun simctl uninstall "$UDID" "$APP_ID" > /dev/null 2>&1 || true
"$TIMEOUT_BIN" -k 2 300 xcrun simctl install "$UDID" "$APP_PATH"
marker="$(mktemp)"
"$TIMEOUT_BIN" -k 2 120 xcrun simctl launch "$UDID" "$APP_ID"
wait_for_app "$UDID" "${SMOKE_RECHECK_SECONDS:-60}" || fail "the app is not running after launch"
sleep "${SMOKE_SETTLE_SECONDS:-8}"
"$TIMEOUT_BIN" -k 2 60 xcrun simctl io "$UDID" screenshot "$OUT/00-launched.png"
echo "ok: the app is running, starting part A against $ENGINE_ORIGIN (engine control $CONTROL_URL)"

# The engine starts as a published report, locked at version 3, with nothing published and nothing reopened. A run that is repeated on the
# same engine would start from the end of the last one, so say what is expected instead of assuming it.
node "$HERE/lib/report-state.mjs" "$CONTROL_URL" locked 3 '[]' 5

# --- part A ---
"$TIMEOUT_BIN" -k 10 900 maestro --platform ios --device "$UDID" test -e "SERVER_URL=$ENGINE_ORIGIN" --format junit --output "$OUT/maestro-g5-a.xml" --debug-output "$OUT/maestro-debug-a" "$FLOWS/g5-a-published-report.yaml"
echo "ok: G5 part A passed on screen"
"$TIMEOUT_BIN" -k 2 60 xcrun simctl io "$UDID" screenshot "$OUT/01-after-part-a.png" || true
# The screen said "Nothing to publish": the engine must agree. One publish, nothing said, so no new version; locked again at 3; the app sent no
# notice choice (an unticked box is not sent, which is what the engine answers to as "no").
node "$HERE/lib/report-state.mjs" "$CONTROL_URL" locked 3 '[{"notifyClient":null,"summary":null,"outcome":"unchanged"}]' 20
echo "ok: the engine saw one publish, unchanged, with no notice choice, and the report is locked at version 3"

# --- part B: the same app session, nothing cleared or restarted between the parts ---
"$TIMEOUT_BIN" -k 10 900 maestro --platform ios --device "$UDID" test -e "SUMMARY=$SUMMARY" --format junit --output "$OUT/maestro-g5-b.xml" --debug-output "$OUT/maestro-debug-b" "$FLOWS/g5-b-republish-with-notice.yaml"
echo "ok: G5 part B passed on screen"
"$TIMEOUT_BIN" -k 2 60 xcrun simctl io "$UDID" screenshot "$OUT/02-after-part-b.png" || true
node "$HERE/lib/report-state.mjs" "$CONTROL_URL" locked 4 '[{"notifyClient":null,"summary":null,"outcome":"unchanged"},{"notifyClient":true,"summary":"'"$SUMMARY"'","outcome":"new_version"}]' 20
echo "ok: the engine holds version 4, locked, and saw notifyClient true with the summary"

"$TIMEOUT_BIN" -k 2 120 xcrun simctl spawn "$UDID" log show --last 30m --info --debug --predicate 'process == "App"' > "$OUT/app.log" 2>&1 || true
# The app's own crash reports only (the process is called App), newer than the start of this run.
crash_dir="${SMOKE_CRASH_DIR:-$HOME/Library/Logs/DiagnosticReports}"
crashes="$(find "$crash_dir" -maxdepth 1 \( -name 'App-*' -o -name 'App_*' \) -newer "$marker" 2>/dev/null | head -3 || true)"
rm -f "$marker"
if [ -n "$crashes" ]; then
  printf '%s\n' "$crashes"
  fail "the app crashed during G5 (a crash report appeared while it ran)"
fi
echo "ok: no crash report for the app"
echo "ios-simulator-published: G5 passed; evidence is in $OUT"
