# Sourced by the Android emulator scripts. Provides dismiss_not_responding.
#
# On a small CI emulator the system itself can stop responding ("Pixel Launcher isn't responding", CI run 41367506059) and Android puts an
# ANR dialog in front of the app under test. The app is fine, but a uiautomator dump then shows only that dialog, and a script that waits
# for the app's own text reads the same dialog until it gives up. The dialog's "Wait" button has the stable resource id
# android:id/aerr_wait (the label changes with the language), and the dump gives its bounds.
#
# dismiss_not_responding <path to a uiautomator dump>
#   returns 0 after tapping the middle of "Wait", 1 when the dump holds no such dialog (or cannot be read). Only "Wait" is ever tapped:
#   never "Close app", which would kill the process behind the dialog.

dismiss_not_responding() {
  local xml="$1" box x1 y1 x2 y2
  [ -r "$xml" ] || return 1
  box="$(grep -o 'resource-id="android:id/aerr_wait"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' "$xml" \
    | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | head -1 || true)"
  [ -n "$box" ] || return 1
  read -r x1 y1 x2 y2 <<< "$(printf '%s' "$box" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1 \2 \3 \4/')"
  echo "::warning::a system 'isn't responding' dialog is in front of the app; tapping Wait at $(( (x1 + x2) / 2 )),$(( (y1 + y2) / 2 ))"
  adb shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))"
}
