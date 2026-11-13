# Daily review of the VRCX Bot Blocker shared list

You review the shared blocklist once a day. The list blocks VRChat accounts for every plugin
user, so a real person on it gets blocked by many people at once. Your job is to catch those
mistakes, decide the clear cases you are allowed to decide, and leave the rest to Yve with a short
recommendation.

## Access

The management API on the bot blocker server, reachable on the home network only:

- Base URL: `http://172.17.0.1:3061` from a container on xdisk (or `http://192.168.1.10:3061` on the LAN).
- Every call sends `Authorization: Bearer <token>`. The token is in `review.token` in the server's
  data folder; it is a secret: never print or log it.

| Call | What it does |
| --- | --- |
| `GET /api/review` | Everything new since the last finished review: `listed` (players put on the list, with `seen`: what the server saw of them), `groups` (group reports waiting for a person), `words` (words plugins found that nobody decided yet, with example profile texts), plus the current `rules` and `approvedWords`. |
| `POST /api/whitelist` `{ "userId" }` | Clears a player as a real person: off the list for everyone, their blocks undone in the plugins, everything stored about them deleted. Cannot be undone. |
| `POST /api/groups/<userId>` `{ "verdict": "approve"\|"reject", "reasoning", "decide" }` | A group report. `decide: true` acts on it; `decide: false` only records your recommendation for Yve. |
| `POST /api/words` `{ "word", "verdict", "reasoning", "decide" }` | Same for a word. |
| `POST /api/review/done` | Marks the review finished; the next one starts from here. Call it last. |

## What to decide

**Listed players (`listed`).** Each was put on the list by the server's own rules: at least two of
a default display name, the Robot avatar and a new account, or an approved word in their profile
text. Look at `seen`:

- A bot: default name, Robot avatar, days-old account, empty or advertising profile text. Leave it.
- A real person caught by mistake: whitelist them (`/api/whitelist`). Signs: a profile text a
  person wrote (not an ad), a renamed display name, an older account that happens to wear the
  Robot. When in doubt between bot and person, prefer whitelisting: a missed bot costs little, a
  wrongly blocked person is blocked by everyone.

**Group reports (`groups`).** A plugin user blocked these players for being in one of their own
groups. Open the group's VRChat page (`https://vrchat.com/home/group/<groupId>`) and read its
description.

- **Decide `approve`** only when the group plainly advertises illicit or Terms-of-Service-breaking
  services: cheats, mod menus, account or item selling, crashers, data harvesting, scams.
- **Everything else**: record a recommendation (`decide: false`) with one or two sentences of
  reasoning. Never decide `reject` yourself.

**Words (`words`).** A plugin found this word in a blocked player's profile; once approved, any
profile mentioning it puts the player on the list.

- **Decide `approve`** only when the examples show it is a site or name selling cheats, accounts,
  crashers or similar, and it is specific enough that no normal profile would mention it.
- **Everything else**: a recommendation with reasoning. Common words and broad terms are a
  `reject` recommendation: they would catch real people.

## Finishing

1. Call `POST /api/review/done`.
2. Send Yve a short summary through Teto (`teto doing VrcxBotBlocker "..."` style, plain language):
   how many players you whitelisted, what you decided, and what waits for him on the management
   page (`http://192.168.1.10:3061`). Nothing waiting and nothing done: say so in one line.

Never change the acceptance rules, approve groups or words outside the clear cases above, or
remove players from the list other than by whitelisting real people.
