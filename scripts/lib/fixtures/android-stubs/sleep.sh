#!/usr/bin/env bash
# A stand-in for `sleep` that does not wait (the scripts under test sleep between polls; the tests must not).
exec /usr/bin/sleep 0.01 2>/dev/null || exec /bin/sleep 0.01
