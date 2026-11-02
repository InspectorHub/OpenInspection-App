#!/usr/bin/env bash
# A stand-in for `adb`, used by scripts/lib/android-scripts.test.ts to run the whole Android emulator scripts without an emulator.
# Every call is appended to $STATE/calls.log. What a test varies comes in through environment variables:
#   UI_SEQUENCE  comma-separated kinds of screen the Nth `uiautomator dump` sees: dialog | app | blank (the last one repeats)
#   XML_DIR      a directory holding dialog.xml, app.xml and blank.xml
#   LOGCAT_TEXT  what `logcat -d` prints
#   PIDOF_EMPTY  set: the app has no process (`pidof` prints nothing)
#   DUMP_FAILS_AFTER the Nth `uiautomator dump` and every later one fails and writes nothing (default: they all work)
set -u
echo "adb $*" >> "$STATE/calls.log"
cmd="${1:-}"
shift || true
case "$cmd" in
  install) echo "Success" ;;
  devices) printf 'List of devices attached\nemulator-5554\tdevice\n' ;;
  logcat) if [ "${1:-}" = "-d" ]; then printf '%s\n' "${LOGCAT_TEXT:-}"; fi ;;
  exec-out) printf 'PNGDATA' ;;
  pull)
    [ -f "$STATE/dev$1" ] || exit 1
    cp "$STATE/dev$1" "$2"
    ;;
  shell)
    sub="${1:-}"
    shift || true
    case "$sub" in
      getprop)
        case "${1:-}" in
          sys.boot_completed) printf '1\r\n' ;;
          ro.build.version.release) printf '14\r\n' ;;
          ro.build.version.sdk) printf '34\r\n' ;;
        esac
        ;;
      pidof) [ -n "${PIDOF_EMPTY:-}" ] || printf '1234\r\n' ;;
      rm) rm -f "$STATE/dev${!#}" ;;
      uiautomator)
        # Maestro and uiautomator would share one UiAutomation channel (that crashed it before): a dump while the Maestro stand-in runs is refused.
        if [ -e "$STATE/maestro.running" ]; then echo "OVERLAP: uiautomator while maestro runs" >> "$STATE/calls.log"; exit 1; fi
        path="$2"
        n="$(cat "$STATE/dumps" 2>/dev/null || echo 0)"
        n=$((n + 1))
        echo "$n" > "$STATE/dumps"
        if [ -n "${DUMP_FAILS_AFTER:-}" ] && [ "$n" -gt "$DUMP_FAILS_AFTER" ]; then exit 1; fi
        IFS=',' read -r -a seq <<< "${UI_SEQUENCE:-app}"
        idx=$((n - 1))
        [ "$idx" -lt "${#seq[@]}" ] || idx=$((${#seq[@]} - 1))
        mkdir -p "$(dirname "$STATE/dev$path")"
        cp "$XML_DIR/${seq[$idx]}.xml" "$STATE/dev$path"
        printf 'UI hierarchy dumped to: %s\n' "$path"
        ;;
    esac
    ;;
esac
exit 0
