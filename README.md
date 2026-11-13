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
| Visitor rank | on |
| Bio mentions hexed.cc (also written `hexed(.)cc`, `hexed dot cc` and so on) | on, always block |
| Nuisance rank | on, always block |
| Almost Nuisance rank | off |
| Account younger than a number of days (7 to start with) | off |

How they combine:

- Rules without **Always block** count together: a player is blocked only when every one of them
  that's checked fits. The three defaults together describe the data-gathering bots. Plenty of
  real people keep a default name, so none of them alone is enough.
- Rules with **Always block** block on their own. Every rule has it; it starts on for the bio,
  Nuisance, Almost Nuisance and account age, and off for the three that each catch real people
  alone.
- **Exclude friends** (on by default) keeps friends out of all of it.
- Members of a group on your list are always blocked (see above).

Changing a rule also checks everyone already in your instance.

**Nobody is blocked twice.** The plugin remembers everyone it has blocked and never checks them
again. So if you unblock someone it caught, in VRChat or in VRCX, they stay unblocked. It also
notices when you unblock anyone in VRCX yourself, and leaves that person alone from then on.

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
