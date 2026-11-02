#!/usr/bin/env bash
# A stand-in for `maestro`: records when it started and ended (a test asserts what the script does between the two) and exits with
# $MAESTRO_EXIT (default 0).
echo "maestro start $*" >> "$STATE/calls.log"
: > "$STATE/maestro.running"
if [ -x /usr/bin/sleep ]; then /usr/bin/sleep 0.2; else /bin/sleep 0.2; fi
rm -f "$STATE/maestro.running"
echo "maestro end" >> "$STATE/calls.log"
exit "${MAESTRO_EXIT:-0}"
