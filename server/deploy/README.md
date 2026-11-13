# Deploying the shared blocklist API

Target is **xdisk** (Unraid), like Vibenator: the image is built on xdisk from `git archive HEAD`,
no registry. Public path: Cloudflare (proxied `vapi.omnicrash.net`) → NPMplus on xdisk (TLS) →
`172.17.0.1:3060` over plain HTTP. The API is public on purpose: every plugin calls it.

## Publishing a new version

```sh
DEPLOY_OK=1 server/deploy/deploy.sh   # builds HEAD on xdisk, recreates, prints /healthz
```

Only committed work ships. A restart pauses the API for a few seconds; plugins keep their reports
queued and sync again on their own. `/healthz` reports the version, the VRChat login state, how
many accounts are listed and how many reports wait for a check.

## Management page

`http://192.168.1.10:3061` from the home network: group reports waiting for review, the acceptance
rules (what the server needs before it lists a player), and the shared list with a Remove button.
Its port is published by the container but never forwarded or proxied, and the page also refuses
any address that isn't private. No login.

## One-time setup

- **Data:** `/mnt/user/appdata/vrcx-bot-blocker`, owned by `1002:100` (the container's user).
- **Template:** `server/deploy/vapi.xml` with the VRChat login from `~/.config/vapi/vrchat.env`
  filled in, at `/boot/config/plugins/dockerMan/templates-user/my-VrcxBotBlocker.xml`. Create the
  first container from it and put `VrcxBotBlocker` on the autostart list
  (`/var/lib/docker/unraid-autostart`), or every `rebuild_container` leaves it stopped.
- **NPMplus** (UI only): a proxy host `vapi.omnicrash.net` → `http://172.17.0.1:3060`, the
  `omnicrash.net` certificate, Force SSL, no forward-auth. "Block some user agents" off: the
  plugin calls from inside VRCX.
- **Cloudflare:** a proxied record for `vapi.omnicrash.net` like the zone's other app names.
