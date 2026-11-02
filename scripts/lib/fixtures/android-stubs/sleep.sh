#!/usr/bin/env bash
# A stand-in for `sleep` that does not wait (the scripts under test sleep between polls; the tests must not).
if [ -x /usr/bin/sleep ]; then exec /usr/bin/sleep 0.01; fi
exec /bin/sleep 0.01
