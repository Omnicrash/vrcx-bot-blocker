#!/bin/bash
# Builds the release files into dist/:
#   bot-blocker.js                          the plugin by itself
#   VRCX-Bot-Blocker-<v>-setup.exe          Windows (NSIS)         - on Linux/WSL
#   VRCX-Bot-Blocker-<v>-linux.sh           Linux (shell installer) - anywhere
#   VRCX-Bot-Blocker-<v>-macos.pkg          macOS (Installer pkg)  - on a Mac only
#
#   ./build.sh                  everything this machine can build
#   ./build.sh windows linux    just those
#
# Windows needs x86_64-w64-mingw32-gcc, makensis, rsvg-convert and ImageMagick's convert;
# macOS needs pkgbuild and productbuild (Xcode command line tools). The version is $VERSION if
# set (the release workflow passes the tag), else the VERSION file.
set -euo pipefail
cd "$(dirname "$0")"

version=${VERSION:-$(tr -d "[:space:]" < VERSION)}
version=${version#v}
mkdir -p dist
cp bot-blocker.js dist/bot-blocker.js

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
    if [ "$(uname -s)" = Darwin ]; then targets=(linux macos); else targets=(windows linux); fi
fi

# Copies template $1 to $2, putting common.sh in place of the #@COMMON@ line, the plugin in
# place of the @PLUGIN@ line, and the version for @VERSION@.
fill() {
    awk -v version="$version" '
        $0 == "#@COMMON@" { while ((getline l < "installer/unix/common.sh") > 0) print l; next }
        $0 == "@PLUGIN@" { while ((getline l < "bot-blocker.js") > 0) print l; next }
        { gsub(/@VERSION@/, version); print }' "$1" > "$2"
}

build_windows() {
    local stage=dist/build/windows
    rm -rf "$stage"
    mkdir -p "$stage"
    x86_64-w64-mingw32-gcc -municode -O2 -s -static -Wall -Wextra \
        -o "$stage/botblocker-helper.exe" installer/helper.c -lshell32
    cp bot-blocker.js "$stage/"
    for size in 16 24 32 48 64 128 256; do
        rsvg-convert -w $size -h $size installer/icon.svg -o "$stage/icon-$size.png"
    done
    convert "$stage"/icon-{16,24,32,48,64,128,256}.png "$stage/icon.ico"
    local out="dist/VRCX-Bot-Blocker-$version-setup.exe"
    makensis -V2 -DVERSION="$version" -DSRC="$PWD/installer" -DDIST="$PWD/$stage" -DOUT="$PWD/$out" \
        installer/bot-blocker.nsi
    echo "built $out"
}

build_linux() {
    local out="dist/VRCX-Bot-Blocker-$version-linux.sh"
    fill installer/unix/linux.sh "$out"
    chmod +x "$out"
    sh -n "$out"
    echo "built $out"
}

build_macos() {
    local stage=dist/build/macos
    rm -rf "$stage"
    mkdir -p "$stage/scripts" "$stage/resources"
    cp installer/macos/postinstall installer/unix/common.sh bot-blocker.js "$stage/scripts/"
    fill installer/macos/uninstall.command "$stage/scripts/Uninstall VRCX Bot Blocker.command"
    chmod +x "$stage/scripts/postinstall" "$stage/scripts/Uninstall VRCX Bot Blocker.command"
    fill installer/macos/welcome.html "$stage/resources/welcome.html"
    fill installer/macos/conclusion.html "$stage/resources/conclusion.html"
    cp LICENSE "$stage/resources/LICENSE.txt"
    fill installer/macos/distribution.xml "$stage/distribution.xml"
    pkgbuild --nopayload --scripts "$stage/scripts" --identifier net.omnicrash.vrcx-bot-blocker \
        --version "$version" "$stage/component.pkg"
    local out="dist/VRCX-Bot-Blocker-$version-macos.pkg"
    productbuild --distribution "$stage/distribution.xml" --resources "$stage/resources" \
        --package-path "$stage" "$out"
    echo "built $out"
}

for t in "${targets[@]}"; do
    "build_$t"
done
