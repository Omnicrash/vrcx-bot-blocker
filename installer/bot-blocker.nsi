; VRCX Bot Blocker installer (NSIS, Modern UI). Per user, no admin rights. The wizard keeps a copy
; of the plugin and the helper in %LOCALAPPDATA%\VRCX Bot Blocker; the helper adds the plugin to
; VRCX's custom.js (leaving anything else in that file alone) and restarts VRCX when it runs.
; build.sh compiles this: makensis -DVERSION=... -DSRC=installer -DDIST=... -DOUT=... installer/bot-blocker.nsi

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

Name "VRCX Bot Blocker"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\VRCX Bot Blocker"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "VRCX Bot Blocker ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "VRCX Bot Blocker"
VIAddVersionKey "FileDescription" "VRCX Bot Blocker setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Omnicrash"
VIAddVersionKey "LegalCopyright" "MIT License"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VRCXBotBlocker"
!define CUSTOM_JS "$APPDATA\VRCX\custom.js"

!define MUI_ICON "${DIST}/icon.ico"
!define MUI_UNICON "${DIST}/icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "VRCX Bot Blocker ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Blocks the data-gathering bots that join VRChat instances on fresh accounts: a default display name, the default Robot avatar and Visitor rank. You can also list groups whose members get blocked.$\r$\n$\r$\nThis adds a small plugin to VRCX. If VRCX is running, it restarts by itself at the end so the plugin loads. VRChat keeps running."
!define MUI_FINISHPAGE_TEXT "VRCX Bot Blocker is installed. From now on VRCX blocks these bots as soon as they join. The Bot Blocker entry in VRCX's side menu manages your list of blocked groups.$\r$\n$\r$\nTo remove it, uninstall VRCX Bot Blocker from Windows' Apps list."
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
Function SharePage
    !insertmacro MUI_HEADER_TEXT "Shared blocklist" ""
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 0 100% 12u "Use the shared blocklist"
    Pop $ShareBox
    ${NSD_CreateLabel} 12u 16u -12u 52u "Blocks the bots other users have reported, often before they reach you, and reports the bots you block that pass the shared list's checks. The server checks every report on VRChat itself before it is listed.$\r$\n$\r$\nSent: the blocked player's ID and name, what they were caught on, and a random ID for this install.$\r$\n$\r$\nYou can switch it off later on the Bot Blocker page in VRCX."
    Pop $0
    ${If} $Share == 1
        ${NSD_Check} $ShareBox
    ${EndIf}
    ; Only when updating: a fresh install already has the recommended settings.
    ${If} $HadBefore == 1
        ${NSD_CreateCheckbox} 0 74u 100% 12u "Change to recommended settings (highly recommended for this update)"
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
        StrCpy $Reset 1
    ${EndIf}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/NOSHARE" $1
    ${IfNot} ${Errors}
        StrCpy $Share 0
    ${EndIf}
    ${IfNot} ${FileExists} "$APPDATA\VRCX\*.*"
        MessageBox MB_OK|MB_ICONSTOP "VRCX doesn't seem to be installed for this Windows user (there is no $APPDATA\VRCX folder).$\r$\n$\r$\nInstall VRCX and start it once, then run this setup again."
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

Section "VRCX Bot Blocker" SecMain
    SectionIn RO
    SetOutPath "$INSTDIR"
    File "${DIST}/botblocker-helper.exe"
    File "${DIST}/bot-blocker.js"
    File "${DIST}/icon.ico"

    DetailPrint "Adding the plugin to VRCX..."
    nsExec::ExecToLog '"$INSTDIR\botblocker-helper.exe" install "${CUSTOM_JS}" "$INSTDIR\bot-blocker.js" share=$Share reset=$Reset'
    Pop $0
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Couldn't add the plugin to $APPDATA\VRCX\custom.js (code $0). Nothing was changed."
        Abort
    ${EndIf}

    !insertmacro RestartVRCXBody

    WriteUninstaller "$INSTDIR\uninstall.exe"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "VRCX Bot Blocker"
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

    Delete "$INSTDIR\botblocker-helper.exe"
    Delete "$INSTDIR\bot-blocker.js"
    Delete "$INSTDIR\icon.ico"
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"
    DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
