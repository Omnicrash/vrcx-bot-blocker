; VRC Bot Blocker installer (NSIS, Modern UI). Per user, no admin rights. The wizard keeps a copy
; of the plugin and the helper in %LOCALAPPDATA%\VRCX Bot Blocker (the folder keeps its old name);
; the helper adds the plugin to VRCX's custom.js (leaving anything else in that file alone) and
; restarts VRCX when it runs, and installs it in VRCNext as a theme.
; build.sh compiles this: makensis -DVERSION=... -DSRC=installer -DDIST=... -DOUT=... installer/bot-blocker.nsi

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

Name "VRC Bot Blocker"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\VRCX Bot Blocker"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "VRC Bot Blocker ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "VRC Bot Blocker"
VIAddVersionKey "FileDescription" "VRC Bot Blocker setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Omnicrash"
VIAddVersionKey "LegalCopyright" "MIT License"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VRCXBotBlocker"
!define CUSTOM_JS "$APPDATA\VRCX\custom.js"
!define VRCNEXT_THEME "$APPDATA\VRCNext\custom-themes\Bot Blocker"
!define VRCNEXT_SETTINGS "$APPDATA\VRCNext\settings.json"

!define MUI_ICON "${DIST}/icon.ico"
!define MUI_UNICON "${DIST}/icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "VRC Bot Blocker ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Blocks the data-gathering bots that join VRChat instances on fresh accounts, for example with a default display name and the default Robot avatar. You can also list groups whose members get blocked.$\r$\n$\r$\nThis adds a small plugin to VRCX and VRCNext, whichever you have. If one of them is running, it restarts by itself at the end so the plugin loads. VRChat keeps running."
!define MUI_FINISHPAGE_TEXT "VRC Bot Blocker is installed. From now on these bots are blocked as soon as they join. The Bot Blocker entry in VRCX's side menu, or in VRCNext's Tools, holds your rules and your list of blocked groups.$\r$\n$\r$\nTo remove it, uninstall VRC Bot Blocker from Windows' Apps list."
!define MUI_FINISHPAGE_LINK "How it decides who is a bot"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/Omnicrash/vrcx-bot-blocker#what-it-checks"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${SRC}/../LICENSE"
Page custom SharePage SharePageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; The shared blocklist: on unless unchecked here (or /NOSHARE on a silent install).
Var Share
Var ShareBox
Var Reset
Var ResetBox
Var HadBefore
Var HasVRCX
Var HasVRCNext
Function SharePage
    !insertmacro MUI_HEADER_TEXT "Shared blocklist" ""
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 0 100% 12u "Use the shared blocklist"
    Pop $ShareBox
    ${NSD_CreateLabel} 12u 16u -12u 52u "Blocks the bots other users have reported, often before they reach you, and reports the bots you block that pass the shared list's checks. The server checks every report on VRChat itself before it is listed.$\r$\n$\r$\nSent: the blocked player's ID and name, what they were caught on, and a random ID for this install.$\r$\n$\r$\nYou can switch it off later on the Bot Blocker page."
    Pop $0
    ${If} $Share == 1
        ${NSD_Check} $ShareBox
    ${EndIf}
    ; Only when updating: a fresh install already has the recommended settings.
    ${If} $HadBefore == 1
        ${NSD_CreateCheckbox} 0 74u 100% 12u "Reset options to recommended defaults"
        Pop $ResetBox
        ${If} $Reset == 1
            ${NSD_Check} $ResetBox
        ${EndIf}
    ${EndIf}
    nsDialogs::Show
FunctionEnd
Function SharePageLeave
    ${NSD_GetState} $ShareBox $Share
    ${If} $HadBefore == 1
        ${NSD_GetState} $ResetBox $Reset
    ${EndIf}
FunctionEnd

Function .onInit
    StrCpy $Share 1
    StrCpy $Reset 0
    StrCpy $HadBefore 0
    ; A previous version leaves its entry in Windows' Apps list.
    ReadRegStr $0 HKCU "${UNINST_KEY}" "DisplayVersion"
    ${If} $0 != ""
        StrCpy $HadBefore 1
    ${EndIf}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/NOSHARE" $1
    ${IfNot} ${Errors}
        StrCpy $Share 0
    ${EndIf}
    StrCpy $HasVRCX 0
    StrCpy $HasVRCNext 0
    ${If} ${FileExists} "$APPDATA\VRCX\*.*"
        StrCpy $HasVRCX 1
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\VRCNext\*.*"
        StrCpy $HasVRCNext 1
    ${EndIf}
    ${If} $HasVRCX == 0
    ${AndIf} $HasVRCNext == 0
        MessageBox MB_OK|MB_ICONSTOP "Neither VRCX nor VRCNext seems to be installed for this Windows user.$\r$\n$\r$\nInstall one of them and start it once, then run this setup again."
        Abort
    ${EndIf}
FunctionEnd

; Restarts VRCX when it runs, so the change takes effect now. One body for both directions.
!macro RestartVRCXBody
    nsExec::Exec '"$INSTDIR\botblocker-helper.exe" running'
    Pop $0
    ${If} $0 == 0
        DetailPrint "Restarting VRCX so the change takes effect..."
        nsExec::Exec '"$INSTDIR\botblocker-helper.exe" restart'
        Pop $0
        ${If} $0 != 0
            DetailPrint "Couldn't restart VRCX (code $0). Close and reopen it yourself."
        ${EndIf}
    ${EndIf}
!macroend

; VRCNext saves its settings when it closes, so it's closed before its theme list changes and
; started again after, when it was running.
!macro VRCNextThemeBody ON
    nsExec::ExecToStack '"$INSTDIR\botblocker-helper.exe" stop-vrcnext'
    Pop $0
    Pop $1
    ${If} ${ON} == 1
        nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" theme "${VRCNEXT_THEME}" "$INSTDIR\bot-blocker.js" share=$Share reset=$Reset'
        Pop $2
        nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" vrcnext-theme on "${VRCNEXT_SETTINGS}"'
        Pop $3
    ${Else}
        nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" vrcnext-theme off "${VRCNEXT_SETTINGS}"'
        Pop $3
        nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" theme-remove "${VRCNEXT_THEME}"'
        Pop $2
    ${EndIf}
    ${If} $0 == 0
        DetailPrint "Starting VRCNext again..."
        nsExec::Exec '"$INSTDIR\botblocker-helper.exe" start "$1"'
        Pop $0
    ${EndIf}
!macroend

Section "VRC Bot Blocker" SecMain
    SectionIn RO
    SetOutPath "$INSTDIR"
    File "${DIST}/botblocker-helper.exe"
    File "${DIST}/bot-blocker.js"
    File "${DIST}/icon.ico"

    ${If} $HasVRCX == 1
        DetailPrint "Adding the plugin to VRCX..."
        nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" install "${CUSTOM_JS}" "$INSTDIR\bot-blocker.js" share=$Share reset=$Reset'
        Pop $0
        ${If} $0 != 0
            MessageBox MB_OK|MB_ICONSTOP "Couldn't add the plugin to $APPDATA\VRCX\custom.js (code $0). Nothing was changed."
            Abort
        ${EndIf}
        !insertmacro RestartVRCXBody
    ${EndIf}

    ${If} $HasVRCNext == 1
        DetailPrint "Adding the plugin to VRCNext..."
        !insertmacro VRCNextThemeBody 1
        ${If} $2 != 0
        ${OrIf} $3 != 0
            MessageBox MB_OK|MB_ICONEXCLAMATION "Couldn't add the plugin to VRCNext (code $2, $3). Turn on the Bot Blocker theme in VRCNext's settings yourself."
        ${EndIf}
    ${EndIf}

    WriteUninstaller "$INSTDIR\uninstall.exe"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "VRC Bot Blocker"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Omnicrash"
    WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/Omnicrash/vrcx-bot-blocker"
    WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 150
SectionEnd

Section "Uninstall"
    DetailPrint "Taking the plugin out of VRCX..."
    nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" uninstall "${CUSTOM_JS}"'
    Pop $0
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Couldn't remove the plugin from $APPDATA\VRCX\custom.js (code $0). Nothing was changed."
        Abort
    ${EndIf}

    ; Players it already blocked stay blocked: those are VRChat blocks, not ours to undo.
    !insertmacro RestartVRCXBody

    ${If} ${FileExists} "${VRCNEXT_THEME}\*.*"
        DetailPrint "Taking the plugin out of VRCNext..."
        !insertmacro VRCNextThemeBody 0
    ${EndIf}

    Delete "$INSTDIR\botblocker-helper.exe"
    Delete "$INSTDIR\bot-blocker.js"
    Delete "$INSTDIR\icon.ico"
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"
    DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
