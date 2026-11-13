#!/bin/sh
# VRCX Bot Blocker installer for Linux - https://github.com/Omnicrash/vrcx-bot-blocker (MIT)
#
#   sh vrcx-bot-blocker-linux.sh              install or update
#   sh vrcx-bot-blocker-linux.sh --uninstall  take it out again
#   sh vrcx-bot-blocker-linux.sh --no-share   install without the shared blocklist
#
# Adds the plugin to VRCX's custom.js (anything else in that file stays as it was) and restarts
# VRCX when it runs, so the change takes effect right away. No root needed.
set -eu

#@COMMON@

VERSION='@VERSION@'

say() { printf '%s\n' "$*"; }

# Restarts a running VRCX. The AppImage is found through the APPIMAGE variable the running
# process carries; an installed binary through /proc. Prints a hint when neither works.
restart_vrcx() {
    pids=$(pgrep -i -x vrcx 2>/dev/null || true)
    [ -n "$pids" ] || return 0
    launch=''
    for pid in $pids; do
        app=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^APPIMAGE=//p' | head -n 1)
        if [ -n "$app" ] && [ -f "$app" ]; then
            launch=$app
            break
        fi
        exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
        case "$exe" in
            /tmp/.mount_* | '') ;;
            *) launch=$exe ;;
        esac
    done
    if [ -z "$launch" ]; then
        say "VRCX is running: close and reopen it so the change takes effect."
        return 0
    fi
    say "Restarting VRCX so the change takes effect..."
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -i -x vrcx >/dev/null 2>&1 || break
        sleep 0.5
    done
    (setsid "$launch" >/dev/null 2>&1 &) || nohup "$launch" >/dev/null 2>&1 &
}

dir=$(bb_vrcx_dir "$HOME")
target="$dir/custom.js"

if [ "${1:-}" = "--uninstall" ]; then
    bb_uninstall "$target"
    say "VRCX Bot Blocker is removed. Players it already blocked stay blocked."
    restart_vrcx
    exit 0
fi

if [ ! -d "$dir" ]; then
    say "VRCX doesn't seem to be set up for this user: $dir is missing."
    say "Install VRCX and start it once, then run this again."
    exit 1
fi

plugin=$(mktemp)
trap 'rm -f "$plugin"' EXIT
cat > "$plugin" <<'BOT_BLOCKER_PLUGIN_EOF'
@PLUGIN@
BOT_BLOCKER_PLUGIN_EOF

share=1
if [ "${1:-}" = "--no-share" ]; then
    share=0
elif [ -t 0 ]; then
    say "Shared blocklist: blocks the bots other users have reported, often before they reach you,"
    say "and reports the bots you block that pass the shared list's checks. The server checks every"
    say "report on VRChat itself before it is listed."
    say "Sent: the blocked player's ID and name, what they were caught on, and a random ID for this"
    say "install. Switch it off later on the Bot Blocker page."
    printf 'Use and contribute to the shared blocklist? [Y/n] '
    read -r answer || answer=''
    case "$answer" in n* | N*) share=0 ;; esac
fi

# Only offered when a previous version is in place: a fresh install has the defaults anyway.
reset=0
if [ -f "$target" ] && grep -q "^$BB_START_PREFIX" "$target" && [ -t 0 ]; then
    printf 'Reset options to recommended defaults? [y/N] '
    read -r answer || answer=''
    case "$answer" in y* | Y*) reset=1 ;; esac
fi

bb_install "$target" "$plugin" "$share" "$reset"
say "VRCX Bot Blocker $VERSION is installed in $target"
restart_vrcx
say "Done. To remove it later: sh $(basename "$0") --uninstall"
