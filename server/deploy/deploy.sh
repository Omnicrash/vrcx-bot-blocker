#!/bin/bash
# Build the committed HEAD on xdisk and recreate the VrcxBotBlocker container from its Unraid
# template. Run from the repo root, as DEPLOY_OK=1 server/deploy/deploy.sh once the go-ahead is given.
# A restart only pauses the API for a few seconds: plugins keep their reports queued and sync again.
set -eu

IMAGE=ghcr.io/omnicrash/vrcx-bot-blocker-api:latest
SHA="$(git rev-parse --short HEAD)"
git diff --quiet HEAD -- server || echo "Note: uncommitted server changes are not in the build (it is HEAD, $SHA)."
VERSION="$(date -u +%y%m%d.%H%M)-$SHA"

echo "Live now: $(ssh -o ConnectTimeout=5 xdisk 'curl -s http://localhost:3060/healthz || echo "not running"')"
git archive HEAD server | ssh -o ConnectTimeout=5 xdisk bash -c "'sudo docker build -q --pull --build-arg APP_VERSION=$VERSION -f server/deploy/Dockerfile -t $IMAGE -'"
# rebuild_container prints nothing when it works: /healthz's version is the check.
ssh -o ConnectTimeout=5 xdisk 'sudo /usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container VrcxBotBlocker'
sleep 5
echo "Built $VERSION; live: $(ssh -o ConnectTimeout=5 xdisk 'curl -s http://localhost:3060/healthz')"
