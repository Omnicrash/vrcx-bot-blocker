# VRCX Bot Blocker

Lately VRChat has been full of bots and bot groups quietly collecting data on everyone they meet.
VRCX Bot Blocker gets rid of them: it blocks them the moment they join your instance.

It's a plugin for [VRCX](https://github.com/vrcx-team/VRCX) and works on Windows, macOS and Linux.

## Install

Download the file for your system from the
[latest release](https://github.com/Omnicrash/vrcx-bot-blocker/releases/latest):

| System | File | How |
| --- | --- | --- |
| Windows | `VRCX-Bot-Blocker-<version>-setup.exe` | Run it and click through. No administrator rights needed. |
| macOS | `VRCX-Bot-Blocker-<version>-macos.pkg` | Open it and click through. |
| Linux | `VRCX-Bot-Blocker-<version>-linux.sh` | Run `sh VRCX-Bot-Blocker-<version>-linux.sh` in a terminal. |

If VRCX is running, the installer restarts it at the end so the plugin loads. VRChat itself
keeps running.

The installers aren't signed, so the first time your system may warn about them:

- **Windows:** SmartScreen says it protected your PC. Click **More info**, then **Run anyway**.
- **macOS:** macOS says it can't verify the developer. Open **System Settings > Privacy &
  Security**, scroll down and click **Open Anyway**.

To update, install the newer version over the old one.

### Installing by hand

The release also has `bot-blocker.js`, the plugin by itself. VRCX runs a file called `custom.js`
from its data folder when it starts:

- Windows: `%APPDATA%\VRCX\custom.js`
- macOS: `~/Library/Application Support/VRCX/custom.js`
- Linux: `~/.config/VRCX/custom.js`

Paste the contents of `bot-blocker.js` into that file (create it if it doesn't exist) and
restart VRCX.

## Uninstall

- **Windows:** uninstall **VRCX Bot Blocker** from **Settings > Apps**.
- **macOS:** double-click **Uninstall VRCX Bot Blocker** in
  `~/Library/Application Support/VRCX Bot Blocker`.
- **Linux:** run the installer again with `--uninstall`.

Players it already blocked stay blocked.

## Blocking groups

Open **Bot Blocker** in VRCX's side menu, below Moderation. Paste a group link, its `grp_` ID or
its code (like `ABCD.1234`) and click **Add**. Or open the group in VRCX and click
**Auto-block members** at the top of its window.

From then on, anyone who isn't your friend and shows that group on their profile is blocked
when they join. Players already in your instance are checked as soon as you add the group.
People can hide a group from their profile; nothing can see those.

The same page lists the players blocked most recently, and why.

## What it checks

The rules live on the **Bot Blocker** page in VRCX's side menu. Each one can be switched on or off:

| Rule | Default |
| --- | --- |
| Default display name (a word, a space, then the last four characters of the account ID) | on |
| Robot avatar | on |
| Account younger than a number of days (7 to start with) | on |
| Visitor rank | off |
| Bio mentions a word or site from your list, hexed.cc to start (also written `hexed(.)cc`, `hexed dot cc` and so on). Reads the bio, its links, the pronouns and the status text | on, always block |
| Nuisance rank | on, always block |
| Almost Nuisance rank | off |

How they combine:

- Rules without **Always block** count together: a player is blocked once **at least 2** of the
  checked ones fit (the number is on the page). By default that's two of a default name, the
  Robot avatar and a new account. Plenty of real people keep a default name, and nearly every new
  account is still a Visitor, which is why Visitor rank starts off.
- Rules with **Always block** block on their own.
- **Exclude friends** (on by default) keeps friends out of all of it.
- Members of a group on your list are always blocked (see above).

Changing a rule also checks everyone already in your instance. Installing a new version resets
the rules to these defaults; your group list and block history stay.

**Nobody is blocked twice.** The plugin remembers everyone it has blocked and never checks them
again. So if you unblock someone it caught, in VRChat or in VRCX, they stay unblocked. It also
notices when you unblock anyone in VRCX yourself, and leaves that person alone from then on.

## Shared blocklist

Players you block are reported to a shared list at `vapi.omnicrash.net`. The server doesn't take
the report's word for anything: it looks each player up on VRChat itself, once, and lists them
when its own rules say so:

- **at least 2 of** a default display name, the Robot avatar (seen through the profile picture),
  and an account under a week old when the server first saw it, **or**
- a word or site on the server's approved list (hexed.cc to start) in the bio, its links, the
  pronouns or the status.

New words that plugins report wait for a person to approve them. Nuisance rank is never shared.
Players blocked for being in one of your groups are only sent when you tick **Also sync group
blocks**, and a person reviews those by hand before anyone else blocks them.

Every plugin then blocks the listed accounts too: a few a minute, each looked up first, never a
friend, and only the ones your own rules would block. Changes reach every running plugin within
seconds. If a player is taken off the list, the blocks that came from the list are undone again;
your own blocks stay.

It's on by default. Uncheck it in the installer, or switch off **Use the shared blocklist** on the
Bot Blocker page. Off means nothing is sent and nothing is fetched.

When sharing is switched on (or a new version turns it on), the players your rules blocked
earlier are sent once as well, a few at a time.

What leaves your computer: the blocked player's ID and display name, what the plugin saw (default
name, Robot avatar, Visitor rank, account age, a word from the bio), which of your rules caught
them, and a random ID this install made up for itself. Nothing about you or your VRChat account.
The server keeps the install ID and your address only as scrambled hashes, for rate limits. It
keeps the reports, and what it saw of each reported player, including their profile text, for
good, so it can apply changed rules to the whole list again.

When the server can't be reached, nothing changes for you: blocking works as before, reports
wait, and syncing picks up again by itself.

## Options

Near the top of the bot blocker section in `custom.js`:

The rules and the group list are kept by VRCX and survive updates. For testing, `DRY_RUN = true`
near the top of the bot blocker section in `custom.js` only logs who *would* be blocked; restart
VRCX after changing it, and note that an update puts it back.

To see what it's doing, look in VRCX's log files (the `logs` folder next to `custom.js`): the
plugin's lines start with `[BotBlocker]`. In VRCX's developer console, `botBlocker.blocked()`
lists everyone it has blocked and `botBlocker.groups()` your group list.

## How it works

The installers add the bot blocker to `custom.js` between two marker lines and leave anything
else in that file alone, byte for byte. They keep a backup of the old file as `custom.js.bak`.

The plugin reads the same VRChat log lines VRCX already reads: the "switching to avatar" line
and the "player joined" line. When a player matches, it checks their profile, and their groups
if you have a list, and sends the block through your own logged-in VRCX session.

The plugin hooks into VRCX's internals, so a big VRCX update can break it. It's tested on
VRCX 2026.09.16. If it stops working, the `[BotBlocker] watching joins` line no longer shows up
in VRCX's log at startup - please open an issue.

## Building

`./build.sh` builds into `dist/` whatever the machine can: the Windows setup and the Linux
installer on Linux or WSL (needs `gcc-mingw-w64-x86-64`, `nsis`, `librsvg2-bin`, `imagemagick`),
the macOS package on a Mac. Pushing a version tag (`v1.2.3`) makes GitHub Actions build all of
them and publish the release.

## License

MIT
