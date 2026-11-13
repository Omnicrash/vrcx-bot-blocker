# Shared by the Linux installer and the macOS package scripts (POSIX sh, sourced, not run).
# Adds or removes our block in VRCX's custom.js, between the same two marker lines the Windows
# helper uses, and leaves every other byte of the file alone (awk runs in the C locale, which
# passes any encoding through untouched).

BB_START='// ==== vrcx-bot-blocker start (added by the VRCX Bot Blocker installer - uninstall it instead of editing here) ===='
BB_START_PREFIX='// ==== vrcx-bot-blocker start'
BB_END='// ==== vrcx-bot-blocker end ===='

# Where VRCX keeps custom.js for the user whose home is $1, on this system.
bb_vrcx_dir() {
    case "$(uname -s)" in
        Darwin) echo "$1/Library/Application Support/VRCX" ;;
        *) echo "${XDG_CONFIG_HOME:-$1/.config}/VRCX" ;;
    esac
}

# Prints custom.js ($1) without our block and without trailing blank lines.
bb_without_block() {
    [ -f "$1" ] || return 0
    LC_ALL=C awk -v start="$BB_START_PREFIX" -v end="$BB_END" '
        index($0, start) == 1 { skip = 1; next }
        skip && index($0, end) == 1 { skip = 0; next }
        !skip { lines[++n] = $0 }
        END {
            while (n > 0 && lines[n] ~ /^[ \t\r]*$/) n--
            for (i = 1; i <= n; i++) print lines[i]
        }' "$1"
}

# bb_install <custom.js> <bot-blocker.js>
bb_install() {
    target=$1
    plugin=$2
    tmp="$target.tmp.$$"
    [ -f "$target" ] && cp -p "$target" "$target.bak"
    {
        rest=$(bb_without_block "$target")
        if [ -n "$(printf '%s' "$rest" | tr -d ' \t\r\n')" ]; then
            printf '%s\n\n' "$rest"
        fi
        printf '%s\n' "$BB_START"
        LC_ALL=C awk '{ lines[++n] = $0 } END { while (n > 0 && lines[n] ~ /^[ \t\r]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }' "$plugin"
        printf '%s\n' "$BB_END"
    } > "$tmp" && mv -f "$tmp" "$target"
}

# bb_uninstall <custom.js>; deletes the file when nothing else was in it.
bb_uninstall() {
    target=$1
    [ -f "$target" ] && grep -q "^$BB_START_PREFIX" "$target" || return 0
    cp -p "$target" "$target.bak"
    rest=$(bb_without_block "$target")
    if [ -n "$(printf '%s' "$rest" | tr -d ' \t\r\n')" ]; then
        printf '%s\n' "$rest" > "$target.tmp.$$" && mv -f "$target.tmp.$$" "$target"
    else
        rm -f "$target"
    fi
}
