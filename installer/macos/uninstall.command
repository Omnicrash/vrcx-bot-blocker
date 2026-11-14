#!/bin/sh
# Uninstall VRCX Bot Blocker - double-click in Finder; it opens in Terminal.
# Takes the plugin out of VRCX's custom.js (anything else in that file stays), restarts VRCX
# when it runs, and removes this folder. Players it already blocked stay blocked.
set -eu

#@COMMON@

target="$HOME/Library/Application Support/VRCX/custom.js"
bb_uninstall "$target"

if pgrep -x VRCX >/dev/null 2>&1; then
    echo "Restarting VRCX..."
    osascript -e 'quit app "VRCX"' >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -x VRCX >/dev/null 2>&1 || break
        sleep 1
    done
    pkill -x VRCX 2>/dev/null || true
    sleep 1
    open -a VRCX || true
fi

rm -rf "$HOME/Library/Application Support/VRCX Bot Blocker"
pkgutil --pkgs 2>/dev/null | grep -q '^net.omnicrash.vrcx-bot-blocker$' && echo "(The installer's receipt stays in macOS's package list; it is harmless.)"
echo "VRC Bot Blocker is removed. You can close this window."
