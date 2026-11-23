; Installer hooks (bundle > windows > nsis > installerHooks in tauri.conf.json).
;
; The MSI keeps the upgrade code it had as "Hearth" (bundle > windows > wix > upgradeCode, which
; Tauri would otherwise work out from the product name), so it replaces the old MSI install.

; Hearth was renamed HearthfireVTT in 0.2.0. The installer keys its install by the product
; name, so it wouldn't see the old "Hearth" and the two would sit side by side. Uninstall the
; old one quietly first. Worlds, settings and packages live in the app data folder
; (org.hearthvtt.desktop, unchanged), which a quiet uninstall never touches.
!macro NSIS_HOOK_PREINSTALL
  Push $R8
  Push $R9
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hearth" "UninstallString"
  ; The install folder, unquoted (the uninstall key's InstallLocation is quoted).
  ReadRegStr $R9 HKCU "Software\hearthvtt\Hearth" ""
  ${If} $R8 != ""
  ${AndIf} $R9 != ""
    DetailPrint "Removing the old Hearth install (your worlds are kept)"
    ; _?= runs the uninstaller in place, so ExecWait waits for it to finish.
    ExecWait '$R8 /S _?=$R9'
    Delete "$R9\uninstall.exe"
    RMDir "$R9"
    ; In case the old uninstaller was missing or failed, don't leave a stale entry.
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hearth"
    DeleteRegKey HKCU "Software\hearthvtt\Hearth"
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend
