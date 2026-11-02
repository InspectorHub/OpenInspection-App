; Custom NSIS include (electron-builder nsis.include).
; The app registers the io.inspectorhub.app sign-in protocol for the current user at runtime
; (HKCU\Software\Classes\io.inspectorhub.app); the installer never creates it, so the stock uninstaller
; leaves it behind. Remove it on a real uninstall, but only when its command launches the executable in
; the install directory being removed. A stale key that points elsewhere, or another install's key, is
; left alone. No prompts: safe under /S. Skipped during an update, where the new version re-registers.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $R8 HKCU "Software\Classes\io.inspectorhub.app\shell\open\command" ""
    StrCpy $R9 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    StrLen $R7 $R9
    StrCpy $R6 $R8 $R7
    ${if} $R8 != ""
    ${andIf} $R6 == $R9
      DeleteRegKey HKCU "Software\Classes\io.inspectorhub.app"
    ${endIf}
  ${endIf}
!macroend
