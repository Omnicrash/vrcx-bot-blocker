#!/bin/bash
# Makes a release: ./release.sh 2.0.1
# Puts the version in VERSION and the plugin, signs the plugin with the release key so the
# plugins' updater accepts it, commits, tags and pushes; GitHub Actions then builds and publishes
# the release. The key stays off GitHub, in ~/.config/botb/release-key.jwk (BOTB_RELEASE_KEY).
set -euo pipefail
cd "$(dirname "$0")"

v=${1:-}
if ! [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Usage: ./release.sh <major.minor.patch>" >&2
    exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Commit your changes first." >&2
    exit 1
fi
if git rev-parse -q --verify "refs/tags/v$v" >/dev/null; then
    echo "v$v exists already." >&2
    exit 1
fi

echo "$v" > VERSION
sed -i "s/^    const VERSION = '[^']*';/    const VERSION = '$v';/" bot-blocker.js
grep -q "^    const VERSION = '$v';" bot-blocker.js
bun installer/sign.ts bot-blocker.js > bot-blocker.js.sig

git add VERSION bot-blocker.js bot-blocker.js.sig
git commit -q -m "BOTB-1: Version $v"
git tag "v$v"
git push -q origin HEAD "v$v"
echo "Pushed v$v; GitHub Actions builds and publishes the release."
