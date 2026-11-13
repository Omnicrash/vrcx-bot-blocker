// VRCX Bot Blocker - https://github.com/Omnicrash/vrcx-bot-blocker (MIT)
// Lives in %AppData%\VRCX\custom.js, which VRCX runs once at startup; the setup puts it there.
//
// A player gets blocked the moment they join when the rules on the Bot Blocker page fit:
//
// - Rules without "Always block" count together: every one of them that's checked must fit. The
//   default set catches the data-gathering bots that join on fresh accounts: the default display
//   name VRChat hands out ("Ulvor6ex f478" - a word, a space, then the last 4 hex digits of the
//   user id), the default Robot avatar, and Visitor rank. None of those alone is enough: plenty of
//   real people keep a default name.
// - Rules with "Always block" block on their own: a bio advertising hexed.cc and Nuisance rank
//   (on by default), Almost Nuisance and new accounts (off by default).
// - Members of the groups on the page's list are always blocked.
// - Friends are left alone unless "Exclude friends" is switched off.
//
// Nobody is ever blocked twice: anyone this script blocked before, and anyone you unblock in
// VRCX yourself, is left alone from then on.
(function () {
    const VERSION = '2.0.1'; // build.sh checks it against the VERSION file
    const UPDATE_KEY = 'botBlocker.update'; // a newer release, downloaded and its signature checked

    // A newer release the updater downloaded runs in place of this copy. If it fails to start,
    // this copy throws it away and carries on.
    if (!window.botBlockerVersion) {
        let staged = null;
        try {
            staged = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null');
        } catch {}
        if (staged && newerVersion(staged.version, VERSION)) {
            const script = document.createElement('script');
            script.textContent = staged.code;
            document.head.appendChild(script);
            if (window.botBlockerVersion === staged.version) {
                return;
            }
            console.warn('[BotBlocker]', `update ${staged.version} didn't start, running ${VERSION}`);
            localStorage.removeItem(UPDATE_KEY);
        } else if (staged && staged.version !== VERSION) {
            localStorage.removeItem(UPDATE_KEY); // an installer put a newer version in place since
        }
    }
    window.botBlockerVersion = VERSION;

    function newerVersion(a, b) {
        const pa = String(a).split('.').map(Number);
        const pb = String(b).split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) {
                return (pa[i] || 0) > (pb[i] || 0);
            }
        }
        return false;
    }

    const DRY_RUN = false; // true: only log what would be blocked
    const BOT_AVATAR = 'Robot';
    const BLOCKED_KEY = 'botBlocker.blocked';
    const UNBLOCKED_KEY = 'botBlocker.unblocked';
    const GROUPS_KEY = 'botBlocker.groups';
    const TAG = '[BotBlocker]';
    const LOOKUP_GAP_MS = 400; // between group lookups, to stay clear of VRChat's rate limits
    const API = 'https://vapi.omnicrash.net/v1'; // the shared blocklist
    // The installer's "shared blocklist" checkbox and when it ran; both lines are rewritten by it.
    const SHARE_DEFAULT = true; // @SHARE_DEFAULT@
    const INSTALL_STAMP = 'dev'; // @INSTALL_STAMP@
    const RESET_RULES = false; // @RESET_RULES@ - the installer's "Reset options to recommended defaults"
    const SYNC_EVERY_MS = 30 * 60_000; // the fallback; changes arrive through the stream at once
    const SHARED_BLOCK_GAP_MS = 15_000; // listed accounts are blocked one at a time, this far apart

    const avatarByName = new Map(); // display name -> last avatar name seen in the log
    const present = new Map(); // user id -> display name, everyone in the instance right now
    // Everyone we blocked before or the user unblocked: never touched again.
    const handled = new Set([
        ...loadList(BLOCKED_KEY).map((e) => e.userId),
        ...loadList(UNBLOCKED_KEY).map((e) => e.userId)
    ]);
    const checking = new Set(); // user ids with a check in flight
    const recheckAfter = new Map(); // user id -> rechecks asked for while a check was in flight

    // ---- storage -------------------------------------------------------------------------------

    function loadList(key) {
        try {
            return JSON.parse(localStorage.getItem(key) || '[]');
        } catch {
            return [];
        }
    }

    function saveList(key, list) {
        try {
            localStorage.setItem(key, JSON.stringify(list));
        } catch {}
    }

    // Kept whole on purpose: dropping old entries would let those players be blocked again.
    function remember(key, entry) {
        const list = loadList(key);
        list.push(entry);
        saveList(key, list);
    }

    const groups = () => loadList(GROUPS_KEY);

    // The rules, all switchable on the Bot Blocker page. Every checked rule without "always" has to
    // fit for a block; a checked rule with "always" blocks by itself. "Always" starts off for the
    // default name, the Robot avatar and Visitor rank: each of those alone catches real people.
    const SETTINGS_KEY = 'botBlocker.rules';
    const RULES = ['name', 'robot', 'visitor', 'bio', 'nuisance', 'probable', 'age'];
    const RULE_LABELS = {
        name: 'Default name',
        robot: 'Robot avatar',
        visitor: 'Visitor rank',
        bio: 'in bio',
        nuisance: 'Nuisance',
        probable: 'Almost Nuisance',
        age: 'New account'
    };
    // VRChat's own nuisance marks: likely real people the user doesn't want around. Blocks they
    // cause stay out of the shared list entirely, reports and whitelist alike.
    const PERSONAL_RULES = ['nuisance', 'probable'];
    const DEFAULT_SETTINGS = {
        excludeFriends: true,
        share: SHARE_DEFAULT, // report blocks to the shared blocklist and block what's on it
        // Also sync group blocks: send this user's group blocks for manual review on the server, and
        // block other users' group blocks once a person approved them there.
        syncGroups: false,
        // When the shared list clears someone as a real player: undo every block Bot Blocker made
        // on them. Off: only the blocks that came from the list or that this install reported.
        unblockCleared: true,
        autoUpdate: true, // download new releases from GitHub; they run from the next start
        ageDays: 7,
        bioWords: ['hexed.cc'], // keywords and websites the bio rule looks for
        // The checked rules without "always" block once at least this many of them fit. The
        // default, 2 of default name, Robot and a new account, matches the shared list's rules;
        // Visitor rank stays off since nearly every new account is still a Visitor.
        needed: 2,
        rules: {
            name: { on: true, always: false },
            robot: { on: true, always: false },
            visitor: { on: false, always: false },
            bio: { on: true, always: true },
            nuisance: { on: false, always: true },
            probable: { on: false, always: true },
            age: { on: true, always: false }
        }
    };

    function settings() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch {}
        const rules = {};
        for (const r of RULES) {
            rules[r] = { ...DEFAULT_SETTINGS.rules[r], ...(saved.rules?.[r] || {}) };
        }
        // Settings from before the "at least" number required every checked rule; they keep
        // working that way until the user changes the number.
        const needed =
            saved.needed ?? (saved.rules ? Math.max(1, RULES.filter((r) => rules[r].on && !rules[r].always).length) : DEFAULT_SETTINGS.needed);
        return { ...DEFAULT_SETTINGS, ...saved, rules, needed };
    }

    function saveSettings(next) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {}
        // A change can only add blocks: check everyone already here against the new rules.
        for (const [userId, name] of present) {
            evaluate(name, userId, { rule: 'all' });
        }
    }

    // Settings that would block a lot of real people, as warnings for the page. Default name, the
    // Robot avatar, Visitor rank and a new account each fit plenty of real people on their own, and
    // Visitor rank and a new account fit almost every new player together, so those two count as one.
    const WEAK_RULES = ['name', 'robot', 'visitor', 'age'];
    const WEAK_TITLES = { name: 'Default display name', robot: 'Robot avatar', visitor: 'Visitor rank', age: 'Account younger than' };
    function riskWarnings(s) {
        const warnings = [];
        const on = (r) => s.rules[r].on;
        for (const r of WEAK_RULES.filter((r) => on(r) && s.rules[r].always)) {
            warnings.push(`Always block on ${WEAK_TITLES[r]} blocks a lot of real people.`);
        }
        const together = WEAK_RULES.filter((r) => on(r) && !s.rules[r].always);
        if (together.length && s.needed <= 1) {
            warnings.push('With 1 needed, one rule is enough to block someone. That blocks a lot of real people.');
        } else if (together.includes('visitor') && together.includes('age') && s.needed <= 2) {
            warnings.push('Visitor rank and a new account fit almost every new player. With 2 needed, that blocks a lot of real people.');
        }
        if (!s.excludeFriends) {
            warnings.push('Your friends can be blocked too.');
        }
        return warnings;
    }

    function setRule(rule, field, value) {
        const s = settings();
        s.rules[rule][field] = !!value;
        saveSettings(s);
    }

    function setSyncGroups(value) {
        saveSettings({ ...settings(), syncGroups: !!value });
    }

    function setShare(value) {
        saveSettings({ ...settings(), share: !!value });
        if (value) {
            sendHistory();
            syncShared();
            listen();
        } else {
            stream?.close();
            stream = null;
        }
    }

    function setExcludeFriends(value) {
        saveSettings({ ...settings(), excludeFriends: !!value });
    }

    function setBioWords(words) {
        const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
        saveSettings({ ...settings(), bioWords: clean });
        return clean;
    }

    function setNeeded(n) {
        const v = Math.max(1, Math.min(RULES.length, Math.round(Number(n)) || DEFAULT_SETTINGS.needed));
        saveSettings({ ...settings(), needed: v });
        return v;
    }

    function setAgeDays(days) {
        const n = Math.max(1, Math.min(3650, Math.round(Number(days)) || DEFAULT_SETTINGS.ageDays));
        saveSettings({ ...settings(), ageDays: n });
        return n;
    }

    const isListed = (groupId) => groups().some((g) => g.id === groupId);

    // ---- the rules -----------------------------------------------------------------------------

    // A website on the bio list also matches the spellings used to get past filters:
    // site(.)cc, site[.]cc, site (dot) cc, site dot cc, and spaces around the dot.
    const DOT = String.raw`\s*(?:\.|\(\.\)|\[\.\]|\(dot\)|\[dot\]|\bdot\b)\s*`;
    const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function wordPattern(word) {
        const isSite = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(word);
        return new RegExp(isSite ? word.split('.').map(escapeRe).join(DOT) : escapeRe(word), 'i');
    }

    // The first word from the list the profile's free text mentions, or null. The bots advertise
    // in their pronouns as much as in the bio, so every field a player writes is read.
    function bioMention(user, words) {
        const text = [user.bio || '', ...(user.bioLinks || []), user.pronouns || '', user.statusDescription || ''].join(' ');
        return words.find((w) => wordPattern(w).test(text)) || null;
    }

    // The default Robot avatar's picture. Without a VRChat+ icon of their own, a player's profile
    // icon is their current avatar's thumbnail: a second way to see the Robot when the log missed it.
    const ROBOT_ICON = 'file_0e8c4e32-7444-44ea-ade4-313c010d4bae';
    const wearsRobot = (user) => (user.iconUrl || '').includes(ROBOT_ICON);

    function hasDefaultName(displayName, userId) {
        const m = /^\S+ ([0-9a-f]{4})$/.exec(displayName || '');
        return !!m && !!userId && userId.toLowerCase().endsWith(m[1]);
    }

    // One API call at a time, spaced out: a busy instance can bring dozens of joins at once.
    let queue = Promise.resolve();
    function queued(fn) {
        const run = queue.then(fn);
        queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, LOOKUP_GAP_MS)));
        return run;
    }

    async function getUser(userId) {
        return (await window.request.userRequest.getUser({ userId })).json;
    }

    async function userGroupIds(userId) {
        const list = (await window.request.groupRequest.getGroups({ userId })).json || [];
        return list.map((g) => ({ id: g.groupId, name: g.name }));
    }

    // Checks one player against the rules. `only` asks for a recheck of a player already here:
    // { rule: 'groups', groupIds } after adding a group, { rule: 'all' } after a settings change.
    async function evaluate(displayName, userId, only = null) {
        if (!userId || handled.has(userId)) {
            return;
        }
        if (checking.has(userId)) {
            // A check that started before a setting changed wouldn't see it: run once more after.
            if (only) {
                recheckAfter.set(userId, [...(recheckAfter.get(userId) || []), [displayName, only]]);
            }
            return;
        }
        const s = settings();
        const on = (r) => s.rules[r].on;
        const alone = RULES.filter((r) => on(r) && s.rules[r].always);
        const together = RULES.filter((r) => on(r) && !alone.includes(r));
        const fromLog = {
            name: hasDefaultName(displayName, userId),
            robot: avatarByName.get(displayName) === BOT_AVATAR
        };
        // At least `needed` of the checked rules must fit; never more than there are checked.
        const needed = Math.min(s.needed, together.length);
        const togetherPossible = together.length > 0;
        // Seen in the log with enough signs already (a default name and the Robot), a bot is looked
        // up and blocked even after it left again; anyone else only while still here.
        const logSigns = together.filter((r) => (r === 'name' || r === 'robot') && fromLog[r]);
        const fromLogOnly = togetherPossible && needed > 0 && logSigns.length >= needed;
        const groupIds = !only || only.rule !== 'all' ? only?.groupIds || groups().map((g) => g.id) : groups().map((g) => g.id);
        // Everything else only looks at players still here: the startup replay of the log brings
        // back hours of joins, and checking all of those would flood the API.
        const needsHere = togetherPossible || alone.length || groupIds.length;
        if (!fromLogOnly && !(needsHere && present.has(userId))) {
            return;
        }

        checking.add(userId);
        try {
            // Cleared by the shared list as a real player: only the personal rules (Nuisance,
            // Almost Nuisance, groups) still apply to them.
            const cleared = await isCleared(userId);
            // Asked again once it's this player's turn: the replay has finished by then, so
            // someone who already left is skipped instead of looked up.
            const user = await queued(() => (fromLogOnly || present.has(userId) ? getUser(userId) : null));
            if (!user || (s.excludeFriends && user.isFriend)) {
                return;
            }
            const here = present.has(userId);
            const tags = user.tags || [];
            const days = user.date_joined ? (Date.now() - Date.parse(user.date_joined)) / 86400000 : Infinity;
            const fits = {
                ...fromLog,
                robot: fromLog.robot || wearsRobot(user),
                visitor: !tags.includes('system_trust_basic'),
                bio: bioMention(user, s.bioWords),
                nuisance: tags.includes('system_troll'),
                probable: tags.includes('system_probable_troll'),
                age: days < s.ageDays,
                ageDays: days
            };
            if (cleared) {
                for (const r of RULES) {
                    if (!PERSONAL_RULES.includes(r)) {
                        fits[r] = false;
                    }
                }
            }
            let reason = null;
            let caughtBy = null; // which of this user's rules fired: sent along as research data
            const fitting = together.filter((r) => fits[r]);
            if (togetherPossible && (fromLogOnly || here) && fitting.length >= needed) {
                reason = fitting.map((r) => (r === 'bio' ? `"${fits.bio}" in bio` : RULE_LABELS[r])).join(' + ');
                caughtBy = { together: [...together], needed, fitting };
            }
            const hit = here && alone.find((r) => fits[r]);
            if (!reason && hit) {
                caughtBy = { always: hit };
                reason =
                    hit === 'age'
                        ? `account ${Math.max(0, Math.floor(days))} day(s) old`
                        : hit === 'bio'
                          ? `"${fits.bio}" in bio`
                          : RULE_LABELS[hit];
            }
            let viaGroup = null;
            if (!reason && here && groupIds.length) {
                const theirs = await queued(() => userGroupIds(userId));
                const member = theirs.find((g) => groupIds.includes(g.id));
                if (member) {
                    reason = `member of ${member.name}`;
                    viaGroup = member;
                    caughtBy = { group: true };
                }
            }
            if (reason) {
                // Rule blocks are reported; group blocks only with "Also sync group blocks", and
                // then as group reports, which wait for manual review on the server.
                // Nuisance players are likely real people the user just doesn't want around: a block
                // where a Nuisance mark fired stays personal and is never reported.
                const personal = PERSONAL_RULES.some((r) => caughtBy?.always === r || caughtBy?.fitting?.includes(r));
                let grounds = personal ? null : groundsOf(fits);
                if (viaGroup) {
                    grounds = s.syncGroups && !personal ? { ...grounds, group: viaGroup.name, groupId: viaGroup.id } : null;
                }
                await block(displayName, userId, reason, grounds, false, caughtBy, personal || !!viaGroup);
            }
        } catch (err) {
            console.warn(TAG, 'could not check', displayName, userId, err);
        } finally {
            checking.delete(userId);
            const again = recheckAfter.get(userId);
            recheckAfter.delete(userId);
            for (const [name, rule] of again || []) {
                evaluate(name, userId, rule);
            }
        }
    }

    // `grounds`: what the player was caught on, reported to the shared list. `shared`: the block
    // came from that list, so it is neither reported back nor announced, and is undone again when
    // the list drops the player. Returns whether VRChat took the block.
    // `personal`: a Nuisance or group block, the user's own call, which the shared list's
    // whitelist never undoes.
    async function block(displayName, userId, reason, grounds = null, shared = false, caughtBy = null, personal = false) {
        if (DRY_RUN) {
            console.info(TAG, 'would block', displayName, userId, `(${reason})`);
            return false;
        }
        handled.add(userId);
        try {
            await window.request.playerModerationRequest.sendPlayerModeration({ moderated: userId, type: 'block' });
            remember(BLOCKED_KEY, { userId, displayName, reason, at: new Date().toISOString(), ...(personal ? { personal: true } : {}) });
            console.info(TAG, 'blocked', displayName, userId, `(${reason})`);
            if (shared) {
                saveList(SHARED_BLOCKS_KEY, [...new Set([...loadList(SHARED_BLOCKS_KEY), userId])]);
            } else {
                try {
                    AppApi.DesktopNotification('Bot Blocker', `Blocked ${displayName}: ${reason}`, '');
                } catch {}
                if (grounds) {
                    report(userId, displayName, grounds, caughtBy);
                }
            }
            renderPanel();
            return true;
        } catch (err) {
            handled.delete(userId); // let a later join retry
            console.error(TAG, 'block failed for', displayName, userId, err);
            return false;
        }
    }

    // ---- the shared blocklist ------------------------------------------------------------------
    //
    // Blocks go to vapi.omnicrash.net with what the plugin saw; the server looks the player up
    // itself and lists them when its own rules say so. Every plugin keeps a copy of that list,
    // told about changes the moment they happen through a kept-open stream, and blocks what's on
    // it a few accounts a minute, each looked up first. When the server can't be reached nothing is
    // shown: reports wait in a queue and the stream reconnects by itself.

    const INSTALL_KEY = 'botBlocker.install';
    const OUTBOX_KEY = 'botBlocker.outbox';
    const SHARED_KEY = 'botBlocker.shared';
    const SHARED_SEQ_KEY = 'botBlocker.sharedSeq';
    const CLEARED_SEQ_KEY = 'botBlocker.clearedSeq'; // the whitelist change last checked against
    const SHARED_BLOCKS_KEY = 'botBlocker.sharedBlocks'; // blocks that came from the list
    const SERVER_RULES_KEY = 'botBlocker.serverRules';
    const REPORTED_KEY = 'botBlocker.reported'; // players this install reported to the list
    const CLEARED_KEY = 'botBlocker.cleared'; // hashes of players the list cleared as real people

    // The server names whitelisted players only by this hash of their user id.
    async function idHash(userId) {
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId)));
        return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    }
    const isCleared = async (userId) => loadList(CLEARED_KEY).includes(await idHash(userId));
    let unblockQuietly = null; // VRCX's own unblock, without our never-block-again hook

    function installId() {
        let id = localStorage.getItem(INSTALL_KEY);
        if (!id) {
            id = crypto.randomUUID();
            try {
                localStorage.setItem(INSTALL_KEY, id);
            } catch {}
        }
        return id;
    }

    // What the plugin saw, in the server's terms. Only the signs the server knows are sent.
    function groundsOf(fits) {
        const g = {};
        for (const r of ['name', 'robot', 'visitor']) {
            if (fits[r]) {
                g[r] = true;
            }
        }
        if (fits.bio) {
            g.bio = fits.bio;
        }
        if (Number.isFinite(fits.ageDays)) {
            g.age = Math.max(0, Math.floor(fits.ageDays));
        }
        return g;
    }

    // Whether the server would take the report: its own rules (fetched with every sync), else the
    // defaults. Any word counts, since a word the server doesn't know yet goes to its review.
    function worthReporting(g) {
        let r = null;
        try {
            r = JSON.parse(localStorage.getItem(SERVER_RULES_KEY) || 'null');
        } catch {}
        if (!r?.counted) {
            r = { counted: { name: true, robot: true, visitor: false, age: true }, needed: 2, ageDays: 7 };
        }
        const holds = { name: !!g.name, robot: !!g.robot, visitor: !!g.visitor, age: Number.isFinite(g.age) && g.age < r.ageDays };
        return Object.keys(holds).filter((k) => r.counted[k] && holds[k]).length >= r.needed || !!g.bio;
    }

    function report(userId, displayName, grounds, caughtBy = null) {
        // Group reports go to manual review, so they don't have to meet the server's rules.
        if (!settings().share || !(grounds.group || worthReporting(grounds))) {
            return;
        }
        saveList(REPORTED_KEY, [...new Set([...loadList(REPORTED_KEY), userId])].slice(-5000));
        const outbox = loadList(OUTBOX_KEY);
        outbox.push({ userId, displayName, grounds, caughtBy });
        saveList(OUTBOX_KEY, outbox.slice(-3000));
        flushOutbox();
    }

    let flushing = false;
    async function flushOutbox() {
        if (flushing) {
            return;
        }
        flushing = true;
        try {
            let outbox = loadList(OUTBOX_KEY);
            while (outbox.length) {
                const item = outbox[0];
                let res;
                try {
                    res = await fetch(`${API}/reports`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ install: installId(), ...item })
                    });
                } catch {
                    return; // offline: try again on the next round
                }
                // Only a real answer from the API counts: anything else (a proxy's error or a
                // placeholder page while the server is away) keeps the report for later.
                const body = res.status === 400 ? null : await res.json().catch(() => null);
                if (res.status !== 400 && !(res.ok && body?.result)) {
                    return;
                }
                // Taken, or refused for good (a 400): either way it leaves the queue.
                outbox = loadList(OUTBOX_KEY).slice(1);
                saveList(OUTBOX_KEY, outbox);
            }
        } finally {
            flushing = false;
        }
    }

    function sharedList() {
        try {
            return JSON.parse(localStorage.getItem(SHARED_KEY) || '{}');
        } catch {
            return {};
        }
    }

    let syncing = false;
    let syncAgain = false;
    async function syncShared() {
        if (!settings().share) {
            return;
        }
        if (syncing) {
            syncAgain = true; // a change arrived mid-sync: one more round after this one
            return;
        }
        syncing = true;
        try {
            try {
                const rules = await fetch(`${API}/rules`).then((res) => (res.ok ? res.json() : null));
                if (rules?.counted) {
                    localStorage.setItem(SERVER_RULES_KEY, JSON.stringify(rules));
                }
            } catch {}
            const list = sharedList();
            const dropped = [];
            const gone = new Set(); // accounts VRChat no longer has: nothing to unblock
            let whitelistSeq = null;
            let since = Number(localStorage.getItem(SHARED_SEQ_KEY) || 0);
            for (let page = 0; page < 50; page++) {
                const res = await fetch(`${API}/list?since=${since}`);
                const body = res.ok ? await res.json().catch(() => null) : null;
                if (!body || !Number.isFinite(body.seq)) {
                    return;
                }
                for (const e of body.added || []) {
                    list[e.userId] = { displayName: e.displayName, grounds: e.grounds };
                }
                for (const id of body.gone || []) {
                    gone.add(id);
                }
                for (const id of body.removed || []) {
                    delete list[id];
                    dropped.push(id);
                }
                if (Number.isFinite(body.whitelistSeq)) {
                    whitelistSeq = body.whitelistSeq;
                }
                since = body.seq;
                localStorage.setItem(SHARED_KEY, JSON.stringify(list));
                localStorage.setItem(SHARED_SEQ_KEY, String(since));
                if (!body.more) {
                    break;
                }
            }
            await undoSharedBlocks(dropped.filter((id) => !gone.has(id)));
            if (gone.size) {
                saveList(SHARED_BLOCKS_KEY, loadList(SHARED_BLOCKS_KEY).filter((id) => !gone.has(id)));
            }
            // The whitelist changed, or this is the first sync since VRCX started: ask about the
            // players this install blocked or holds from the list.
            if (whitelistSeq !== null && (!checkedThisRun || String(whitelistSeq) !== localStorage.getItem(CLEARED_SEQ_KEY))) {
                if (await checkCleared(list)) {
                    checkedThisRun = true;
                    localStorage.setItem(CLEARED_SEQ_KEY, String(whitelistSeq));
                    localStorage.setItem(SHARED_KEY, JSON.stringify(list));
                }
            }
            renderPanel();
        } catch {
        } finally {
            syncing = false;
            if (syncAgain) {
                syncAgain = false;
                syncShared();
            }
        }
    }

    // The list dropped these players: blocks that came from it are undone. Blocks the user's own
    // rules made stay.
    async function undoSharedBlocks(ids) {
        const fromList = new Set(loadList(SHARED_BLOCKS_KEY));
        for (const userId of ids) {
            if (!fromList.has(userId) || !unblockQuietly) {
                continue;
            }
            try {
                await unblockQuietly({ moderated: userId, type: 'block' });
                fromList.delete(userId);
                handled.delete(userId); // the user's own rules may still catch them later
                console.info(TAG, 'unblocked, dropped from the shared list:', userId);
            } catch {}
        }
        saveList(SHARED_BLOCKS_KEY, [...fromList]);
    }

    // The server never hands out its whitelist: the plugin sends the hashes of the players it
    // blocked or holds from the list, and gets back only those the list cleared as real people.
    // They leave the local copy, their blocks are undone as the user chose, and this install's
    // rules leave them alone from now on. Nuisance and group blocks are the user's own call and
    // blocks made by hand aren't Bot Blocker's: neither is ever touched.
    let checkedThisRun = false;
    async function checkCleared(list) {
        const blocked = loadBlocked();
        // Records from before `personal` existed are recognized by their reason.
        const personal = new Set(blocked.filter((b) => b.personal || /Nuisance|member of /.test(b.reason || '')).map((b) => b.userId));
        const ours = new Set(blocked.map((b) => b.userId).filter((id) => !personal.has(id)));
        const tied = new Set([...loadList(SHARED_BLOCKS_KEY), ...loadList(REPORTED_KEY)].filter((id) => !personal.has(id)));
        const byHash = new Map();
        for (const userId of new Set([...ours, ...tied, ...Object.keys(list)])) {
            byHash.set(await idHash(userId), userId);
        }
        const hashes = [...byHash.keys()];
        const cleared = [];
        for (let i = 0; i < hashes.length; i += 1000) {
            try {
                const res = await fetch(`${API}/cleared`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ hashes: hashes.slice(i, i + 1000) })
                });
                if (!res.ok) {
                    return false; // asked again on the next sync
                }
                cleared.push(...((await res.json()).cleared || []));
            } catch {
                return false;
            }
        }
        saveList(CLEARED_KEY, [...new Set([...loadList(CLEARED_KEY), ...cleared])]);
        const undo = [];
        for (const h of cleared) {
            const userId = byHash.get(h);
            if (!userId) {
                continue;
            }
            delete list[userId];
            handled.add(userId);
            if (settings().unblockCleared ? ours.has(userId) : tied.has(userId)) {
                undo.push(userId);
            }
        }
        for (const userId of undo) {
            try {
                await unblockQuietly?.({ moderated: userId, type: 'block' });
                console.info(TAG, 'unblocked, cleared by the shared list:', userId);
            } catch {}
        }
        saveList(SHARED_BLOCKS_KEY, loadList(SHARED_BLOCKS_KEY).filter((id) => !undo.includes(id)));
        return true;
    }

    // Whether this user's own rules would block an account with these grounds.
    function rulesAllow(g, s) {
        // A group block someone approved on the server: only with "Also sync group blocks".
        if (g.group) {
            return !!s.syncGroups;
        }
        const fits = {
            name: !!g.name,
            robot: !!g.robot,
            visitor: !!g.visitor,
            bio: !!g.bio,
            nuisance: false,
            probable: false,
            age: Number.isFinite(g.age) && g.age < s.ageDays
        };
        const on = RULES.filter((r) => s.rules[r].on);
        const alone = on.filter((r) => s.rules[r].always);
        const together = on.filter((r) => !s.rules[r].always);
        const needed = Math.min(s.needed, together.length);
        return alone.some((r) => fits[r]) || (together.length > 0 && together.filter((r) => fits[r]).length >= needed);
    }

    // Accounts that couldn't be checked or blocked wait before the next try, and are given up on
    // after a few; nothing is retried every tick.
    const sharedSkips = new Map(); // user id -> { until, tries }
    function skipShared(userId) {
        const tries = (sharedSkips.get(userId)?.tries ?? 0) + 1;
        sharedSkips.set(userId, { until: tries >= 4 ? Infinity : Date.now() + tries * 3_600_000, tries });
    }

    // One listed account per tick: the next one this user's rules allow. It's looked up right
    // before: a friend (or anyone who can't be looked up) is never blocked from the list.
    let blockingShared = false;
    async function blockNextShared() {
        const s = settings();
        if (!s.share || DRY_RUN || blockingShared) {
            return;
        }
        blockingShared = true;
        try {
            const list = sharedList();
            for (const [userId, e] of Object.entries(list)) {
                if (handled.has(userId) || (sharedSkips.get(userId)?.until ?? 0) > Date.now() || !rulesAllow(e.grounds, s)) {
                    continue;
                }
                let user = null;
                try {
                    user = await queued(() => getUser(userId));
                } catch {}
                if (!user) {
                    skipShared(userId);
                    return;
                }
                if (s.excludeFriends && user.isFriend) {
                    handled.add(userId); // never again, for this session
                    return;
                }
                const why = e.grounds.group
                    ? [`group ${e.grounds.group}`]
                    : ['name', 'robot', 'visitor', 'bio'].filter((r) => e.grounds[r]).map((r) => (r === 'bio' ? `"${e.grounds.bio}" in bio` : RULE_LABELS[r]));
                if (!(await block(e.displayName, userId, `Shared list: ${why.join(' + ')}`, null, true))) {
                    skipShared(userId);
                }
                return;
            }
        } finally {
            blockingShared = false;
        }
    }

    // Blocks made before sharing was on (or before this version) go to the list too, once: the
    // server looks every player up itself, so the grounds read back from the old reason text only
    // decide whether a report is worth sending. Blocks that came from the list never go back.
    const HISTORY_SENT_KEY = 'botBlocker.historySentUpTo';
    function groundsFromReason(reason) {
        const r = (reason || '').toLowerCase();
        const g = {};
        if (r.includes('default name') || r.includes('default account')) g.name = true;
        if (r.includes('robot')) g.robot = true;
        if (r.includes('visitor') || r.includes('default account')) g.visitor = true;
        const word = /"([^"]+)" in bio/.exec(reason || '')?.[1];
        if (word) g.bio = word;
        const days = /account (\d+) day/.exec(r)?.[1];
        if (days !== undefined) g.age = Number(days);
        else if (r.includes('new account')) g.age = 0;
        return g;
    }

    function sendHistory() {
        const s = settings();
        if (!s.share) {
            return;
        }
        const since = localStorage.getItem(HISTORY_SENT_KEY) || '';
        const fromList = new Set(loadList(SHARED_BLOCKS_KEY));
        const old = loadBlocked().filter(
            (b) => b.at > since && !fromList.has(b.userId) && !/^shared list/i.test(b.reason || '') && (s.syncGroups || !/^member of/i.test(b.reason || ''))
        );
        for (const b of old) {
            report(b.userId, b.displayName, groundsFromReason(b.reason), { history: true });
        }
        try {
            localStorage.setItem(HISTORY_SENT_KEY, new Date().toISOString());
        } catch {}
    }

    // Each installer run applies its choices once: the sharing checkbox, and, only when its
    // "Reset options to recommended defaults" box was ticked, the default rules. After that the page
    // decides. The group list, the block history and the never-block-again list always stay.
    function applyInstallChoice() {
        if (INSTALL_STAMP === 'dev' || localStorage.getItem('botBlocker.installStamp') === INSTALL_STAMP) {
            return;
        }
        try {
            const base = RESET_RULES ? DEFAULT_SETTINGS : settings();
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...base, share: SHARE_DEFAULT }));
            localStorage.setItem('botBlocker.installStamp', INSTALL_STAMP);
        } catch {}
    }

    // The server pushes a 'change' event the moment the list changes; the browser reconnects the
    // stream by itself after a drop. A slow poll covers anything the stream missed.
    let stream = null;
    function listen() {
        if (stream || typeof EventSource === 'undefined' || !settings().share) {
            return;
        }
        try {
            stream = new EventSource(`${API}/stream`);
            stream.addEventListener('change', (ev) => {
                if (Number(ev.data) !== Number(localStorage.getItem(SHARED_SEQ_KEY) || 0)) {
                    syncShared();
                }
            });
        } catch {
            stream = null;
        }
    }

    function startShared() {
        applyInstallChoice();
        sendHistory();
        syncShared();
        flushOutbox();
        listen();
        setInterval(() => {
            syncShared();
            flushOutbox();
            listen();
        }, SYNC_EVERY_MS);
        setInterval(blockNextShared, SHARED_BLOCK_GAP_MS);
    }

    // ---- reading the game log ------------------------------------------------------------------

    function inspect(entry) {
        if (entry.type === 'avatar-change') {
            avatarByName.set(entry.displayName, entry.avatarName);
            // The avatar line normally comes before the join; if the join won the race, the
            // default-account rule gets its second chance here.
            for (const [userId, name] of present) {
                if (name === entry.displayName && entry.avatarName === BOT_AVATAR) {
                    evaluate(name, userId);
                }
            }
        } else if (entry.type === 'player-joined' && entry.userId) {
            present.set(entry.userId, entry.displayName);
            evaluate(entry.displayName, entry.userId);
        } else if (entry.type === 'player-left') {
            avatarByName.delete(entry.displayName);
            present.delete(entry.userId);
        } else if (entry.type === 'location') {
            avatarByName.clear();
            present.clear();
        }
    }

    // VRCX's own unblock goes through this request object, so wrapping it catches every manual unblock.
    function watchUnblocks(moderation) {
        if (moderation.deletePlayerModeration.__botBlocker) {
            return;
        }
        const original = moderation.deletePlayerModeration.bind(moderation);
        unblockQuietly = original; // undoing a shared-list block must not land on the never-block list
        const wrapped = function (params) {
            if (params?.type === 'block' && params.moderated) {
                handled.add(params.moderated);
                remember(UNBLOCKED_KEY, { userId: params.moderated, at: new Date().toISOString() });
                console.info(TAG, 'unblocked by you, will never block again:', params.moderated);
            }
            return original(params);
        };
        wrapped.__botBlocker = true;
        moderation.deletePlayerModeration = wrapped;
    }

    // ---- the group list ------------------------------------------------------------------------

    // Accepts a group id, any link containing one, or a group code like ABCD.1234 / vrc.group link.
    async function resolveGroup(input) {
        const text = (input || '').trim();
        const byId = /grp_[0-9a-f-]{36}/i.exec(text);
        let groupId = byId?.[0];
        if (!groupId) {
            const code = /([A-Za-z0-9]{3,6})\.(\d{4})\s*$/.exec(text);
            if (!code) {
                throw new Error('Paste a group link, a grp_ id or a group code like ABCD.1234.');
            }
            const res = (await window.request.groupRequest.groupStrictsearch({ query: `${code[1]}.${code[2]}` })).json || [];
            const match = res.find(
                (g) => g.shortCode?.toUpperCase() === code[1].toUpperCase() && String(g.discriminator) === code[2]
            );
            if (!match) {
                throw new Error(`No group found with code ${code[1]}.${code[2]}.`);
            }
            groupId = match.id;
        }
        const g = (await window.request.groupRequest.getGroup({ groupId })).json;
        return { id: g.id, name: g.name, code: `${g.shortCode}.${g.discriminator}` };
    }

    function addGroup(group) {
        if (isListed(group.id)) {
            return;
        }
        saveList(GROUPS_KEY, [...groups(), { ...group, addedAt: new Date().toISOString() }]);
        console.info(TAG, 'now blocking members of', group.name, group.id);
        // Members already in the instance get checked right away.
        for (const [userId, name] of present) {
            evaluate(name, userId, { rule: 'groups', groupIds: [group.id] });
        }
        renderPanel();
        syncGroupDialog();
    }

    function removeGroup(groupId) {
        saveList(GROUPS_KEY, groups().filter((g) => g.id !== groupId));
        renderPanel();
        syncGroupDialog();
    }

    // ---- VRCX's own state ----------------------------------------------------------------------

    function store(id) {
        const app = document.querySelector('#root')?.__vue_app__;
        return app?.config?.globalProperties?.$pinia?._s?.get(id);
    }

    // ---- UI: styles ----------------------------------------------------------------------------

    function addStyles() {
        if (document.getElementById('bb-styles')) {
            return;
        }
        const css = document.createElement('style');
        css.id = 'bb-styles';
        css.textContent = `
            .bb-overlay { position: fixed; inset: 0; z-index: 4000; background: rgb(0 0 0 / .5);
                display: flex; align-items: center; justify-content: center; }
            .bb-card { width: min(920px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow: auto;
                background: var(--card, var(--background)); color: var(--foreground);
                border: 1px solid var(--border); border-radius: calc(var(--radius, .375rem) * 2);
                box-shadow: 0 10px 40px rgb(0 0 0 / .4); padding: 20px; font-size: 14px; }
            .bb-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
            .bb-head h2 { font-size: 18px; font-weight: 600; margin: 0; flex: 1; }
            .bb-card h3 { font-size: 13px; font-weight: 600; margin: 18px 0 8px; text-transform: uppercase;
                letter-spacing: .04em; color: var(--muted-foreground); }
            .bb-row { display: flex; align-items: center; gap: 8px; padding: 7px 0;
                border-bottom: 1px solid var(--border); }
            .bb-row .bb-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .bb-muted { color: var(--muted-foreground); font-size: 12px; white-space: nowrap; }
            .bb-add { display: flex; gap: 8px; }
            .bb-input { flex: 1; background: transparent; color: inherit; border: 1px solid var(--border);
                border-radius: var(--radius, .375rem); padding: 6px 10px; font: inherit; outline: none; }
            .bb-input:focus { border-color: var(--ring); }
            .bb-rule { display: flex; gap: 10px; align-items: center; padding: 5px 0; }
            .bb-rule input[type="checkbox"] { margin-top: 3px; accent-color: var(--primary); }
            .bb-rule > label:first-child { display: flex; gap: 10px; align-items: center; flex: 1; cursor: pointer; }
            .bb-always { display: flex; gap: 6px; align-items: center; font-size: 12px; cursor: pointer;
                color: var(--muted-foreground); white-space: nowrap; }
            .bb-always:has(input:disabled) { opacity: .5; cursor: default; }
            .bb-days { width: 64px; flex: none; padding: 2px 6px; margin: 0 4px; }
            .bb-words { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 0 6px 26px;
                max-height: 92px; overflow-y: auto; }
            .bb-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
            .bb-cols > section { min-width: 0; }
            .bb-scroll { max-height: 300px; overflow-y: auto; }
            /* Recently blocked fills the right column down to the bottom of the rules. */
            .bb-cols > section:last-child { display: flex; flex-direction: column; }
            .bb-recent { flex: 1 1 0; contain: size; max-height: none; min-height: 200px; }
            @media (max-width: 760px) {
                .bb-cols { grid-template-columns: 1fr; }
                .bb-recent { flex: none; contain: none; max-height: 560px; }
            }
            .bb-recent .bb-row { flex-wrap: wrap; row-gap: 0; }
            .bb-recent .bb-row .bb-muted:last-child { flex-basis: 100%; white-space: normal; }
            .bb-chip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 4px 1px 8px; font-size: 12px;
                border: 1px solid var(--border); border-radius: 999px; }
            .bb-chip button { background: none; border: 0; color: var(--muted-foreground); cursor: pointer; padding: 0 2px; }
            .bb-chip button:hover { color: var(--destructive); }
            .bb-word-add { flex: 1; min-width: 140px; }
            .bb-word-add .bb-input { width: 100%; padding: 2px 8px; font-size: 12px; }
            .bb-btn { background: var(--primary); color: var(--primary-foreground, var(--background));
                border: 0; border-radius: var(--radius, .375rem); padding: 6px 14px; font: inherit;
                cursor: pointer; white-space: nowrap; }
            .bb-btn:disabled { opacity: .5; cursor: default; }
            .bb-btn.bb-ghost { background: transparent; color: var(--muted-foreground); padding: 4px 8px; }
            .bb-btn.bb-ghost:hover { color: var(--destructive); }
            .bb-risks { color: var(--warning, #e5a03b); font-size: 13px; }
            .bb-risks > div { padding: 2px 0; }
            .bb-error { color: var(--destructive); font-size: 13px; margin-top: 6px; min-height: 1em; }
            .bb-empty { color: var(--muted-foreground); padding: 8px 0; }
            .bb-groupbar { display: flex; align-items: center; gap: 10px; margin: 0 0 10px;
                padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius, .375rem);
                font-size: 13px; }
            .bb-groupbar .bb-name { flex: 1; }
            .bb-groupbar.bb-on { border-color: var(--destructive); }
            .bb-toast { position: fixed; right: 20px; bottom: 20px; z-index: 3000; display: flex; gap: 10px;
                align-items: center; max-width: 420px; padding: 10px 10px 10px 16px; font-size: 13px;
                background: var(--popover, var(--background)); color: var(--popover-foreground, var(--foreground));
                border: 1px solid var(--border); border-radius: var(--radius, .375rem);
                box-shadow: 0 8px 24px rgba(0, 0, 0, .35); }
            .bb-toast span { flex: 1; }
        `;
        document.head.appendChild(css);
    }

    // Lands in VRCX's log file too, which is how to tell the UI hooks still fit after a VRCX update.
    const logged = new Set();
    function logOnce(key, message) {
        if (!logged.has(key)) {
            logged.add(key);
            console.info(TAG, message);
        }
    }

    const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

    // ---- UI: the Bot Blocker page --------------------------------------------------------------

    let panel = null;

    function openPanel() {
        addStyles();
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'bb-overlay';
            panel.addEventListener('mousedown', (e) => e.target === panel && closePanel());
            document.addEventListener('keydown', (e) => e.key === 'Escape' && panel?.isConnected && closePanel());
        }
        document.body.appendChild(panel);
        renderPanel();
        panel.querySelector('.bb-input')?.focus();
    }

    function closePanel() {
        panel?.remove();
    }

    function renderPanel() {
        if (!panel?.isConnected) {
            return;
        }
        const list = groups();
        const s = settings();
        const ruleRow = (rule, title) => {
            const r = s.rules[rule];
            const always = `<label class="bb-always" title="If on, this rule will apply independently of the rest.">
                    <input type="checkbox" data-always="${rule}" ${r.always ? 'checked' : ''} ${r.on ? '' : 'disabled'} />
                    Always block</label>`;
            return `<div class="bb-rule"><label>
                    <input type="checkbox" data-rule="${rule}" ${r.on ? 'checked' : ''} />
                    <span>${title}</span></label>${always}</div>`;
        };
        const recent = loadBlocked().slice(-100).reverse();
        const time = (iso) =>
            new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        panel.innerHTML = `
            <div class="bb-card">
                <div class="bb-head">
                    <i class="ri-robot-2-line" style="font-size:20px"></i>
                    <h2>Bot Blocker</h2>
                    <button class="bb-btn bb-ghost" data-act="close" title="Close"><i class="ri-close-line"></i></button>
                </div>
                <div class="bb-cols">
                <section>
                <h3>Block rules</h3>
                <div class="bb-rule"><label>
                    <input type="checkbox" data-act="friends" ${s.excludeFriends ? 'checked' : ''} />
                    <span>Exclude friends</span></label></div>
                ${ruleRow('name', 'Default display name')}
                ${ruleRow('robot', 'Robot avatar')}
                ${ruleRow('age', `Account younger than
                    <input class="bb-input bb-days" type="number" min="1" max="3650" value="${s.ageDays}" /> days`)}
                ${ruleRow('visitor', 'Visitor rank')}
                ${ruleRow('bio', 'Bio mentions')}
                <div class="bb-words">
                    ${s.bioWords
                        .map((w) => `<span class="bb-chip">${esc(w)}<button data-word="${esc(w)}" title="Remove">
                            <i class="ri-close-line"></i></button></span>`)
                        .join('')}
                    <form class="bb-word-add"><input class="bb-input" placeholder="Keyword or website" /></form>
                </div>
                ${ruleRow('nuisance', 'Nuisance')}
                ${ruleRow('probable', 'Almost Nuisance')}
                <div class="bb-rule">At least
                    <input class="bb-input bb-days" data-act="needed" type="number" min="1" max="7" value="${s.needed}" />
                    of the checked rules without Always</div>
                <div class="bb-risks">${riskWarnings(s).map((w) => `<div>${esc(w)}</div>`).join('')}</div>
                <h3>Blocked groups</h3>
                <form class="bb-add">
                    <input class="bb-input" placeholder="Group link, ID or code" />
                    <button class="bb-btn" type="submit">Add</button>
                </form>
                <div class="bb-error"></div>
                <div class="bb-scroll bb-groups">${
                    list.length
                        ? list
                              .map(
                                  (g) => `<div class="bb-row">
                                    <span class="bb-name">${esc(g.name)}</span>
                                    <span class="bb-muted">${esc(g.code)}</span>
                                    <button class="bb-btn bb-ghost" data-act="remove" data-id="${esc(g.id)}" title="Remove">
                                        <i class="ri-close-line"></i></button></div>`
                              )
                              .join('')
                        : '<div class="bb-empty">No groups yet.</div>'
                }</div>
                <h3>Shared blocklist</h3>
                <div class="bb-rule"><label title="Block bots others have reported, and share reports of bots you have blocked.">
                    <input type="checkbox" data-act="share" ${s.share ? 'checked' : ''} />
                    <span>Use the shared blocklist</span></label>
                    <span class="bb-muted">${Object.keys(sharedList()).length} accounts</span></div>
                <div class="bb-rule"><label>
                    <input type="checkbox" data-act="sync-groups" ${s.syncGroups ? 'checked' : ''} ${s.share ? '' : 'disabled'} />
                    <span>Also sync group blocks</span></label></div>
                <div class="bb-rule"><label title="When the shared list clears someone as a real player, undo any block Bot Blocker made on them.">
                    <input type="checkbox" data-act="unblock-cleared" ${s.unblockCleared ? 'checked' : ''} ${s.share ? '' : 'disabled'} />
                    <span>Unblock players the shared list clears</span></label></div>
                <h3>Updates</h3>
                <div class="bb-rule"><label>
                    <input type="checkbox" data-act="auto-update" ${s.autoUpdate ? 'checked' : ''} />
                    <span>Update automatically</span></label>
                    <span class="bb-muted">${esc(VERSION)}</span></div>
                ${
                    readyUpdate()
                        ? `<div class="bb-rule"><span>${esc(readyUpdate())} is ready. Restart VRCX to update.</span>
                            <button class="bb-btn" data-act="restart">Restart</button></div>`
                        : `<div class="bb-rule"><button class="bb-btn" data-act="check-update">Check for updates</button>
                            <span class="bb-muted bb-update-result"></span></div>`
                }
                </section>
                <section>
                <h3>Recently blocked</h3>
                <div class="bb-scroll bb-recent">${
                    recent.length
                        ? recent
                              .map(
                                  (b) => `<div class="bb-row">
                                    <span class="bb-muted">${esc(time(b.at))}</span>
                                    <span class="bb-name">${esc(b.displayName)}</span>
                                    <span class="bb-muted">${esc(capitalize(b.reason || 'Default account'))}</span></div>`
                              )
                              .join('')
                        : '<div class="bb-empty">Nobody blocked yet.</div>'
                }</div>
                </section>
                </div>
            </div>`;

        panel.querySelector('[data-act="close"]').onclick = closePanel;
        panel.querySelectorAll('[data-rule]').forEach((box) => {
            box.onchange = () => {
                setRule(box.dataset.rule, 'on', box.checked);
                renderPanel();
            };
        });
        const showRisks = () => {
            panel.querySelector('.bb-risks').innerHTML = riskWarnings(settings())
                .map((w) => `<div>${esc(w)}</div>`)
                .join('');
        };
        panel.querySelectorAll('[data-always]').forEach((box) => {
            box.onchange = () => {
                setRule(box.dataset.always, 'always', box.checked);
                showRisks();
            };
        });
        panel.querySelector('[data-act="friends"]').onchange = (e) => {
            setExcludeFriends(e.target.checked);
            showRisks();
        };
        panel.querySelector('[data-act="share"]').onchange = (e) => {
            setShare(e.target.checked);
            renderPanel();
        };
        panel.querySelector('[data-act="sync-groups"]').onchange = (e) => setSyncGroups(e.target.checked);
        panel.querySelector('[data-act="unblock-cleared"]').onchange = (e) => saveSettings({ ...settings(), unblockCleared: e.target.checked });
        const check = panel.querySelector('[data-act="check-update"]');
        if (check) {
            check.onclick = async () => {
                const result = panel.querySelector('.bb-update-result');
                check.disabled = true;
                result.textContent = 'Checking...';
                const got = await checkForUpdate(true);
                if (got !== 'latest' && got !== 'failed') {
                    renderPanel();
                    return;
                }
                check.disabled = false;
                result.textContent = got === 'latest' ? 'Up to date' : "Couldn't check for updates";
            };
        }
        const restart = panel.querySelector('[data-act="restart"]');
        if (restart) {
            restart.onclick = restartVrcx;
        }
        panel.querySelector('[data-act="auto-update"]').onchange = (e) => {
            saveSettings({ ...settings(), autoUpdate: e.target.checked });
            e.target.checked && checkForUpdate();
        };
        panel.querySelectorAll('[data-word]').forEach((btn) => {
            btn.onclick = () => {
                setBioWords(settings().bioWords.filter((w) => w !== btn.dataset.word));
                renderPanel();
            };
        });
        panel.querySelector('.bb-word-add').onsubmit = (e) => {
            e.preventDefault();
            const input = e.target.querySelector('input');
            setBioWords([...settings().bioWords, input.value]);
            renderPanel();
            panel.querySelector('.bb-word-add input')?.focus();
        };
        const days = panel.querySelector('.bb-days');
        days.onclick = (e) => e.preventDefault(); // a click in the field shouldn't toggle the rule
        days.onchange = () => (days.value = setAgeDays(days.value));
        const needed = panel.querySelector('[data-act="needed"]');
        needed.onchange = () => {
            needed.value = setNeeded(needed.value);
            showRisks();
        };
        panel.querySelectorAll('[data-act="remove"]').forEach((btn) => {
            btn.onclick = () => removeGroup(btn.dataset.id);
        });
        const form = panel.querySelector('.bb-add');
        form.onsubmit = async (e) => {
            e.preventDefault();
            const input = form.querySelector('.bb-input');
            const button = form.querySelector('button');
            const error = panel.querySelector('.bb-error');
            button.disabled = true;
            error.textContent = '';
            try {
                addGroup(await resolveGroup(input.value));
            } catch (err) {
                button.disabled = false;
                error.textContent = err?.message || String(err);
            }
        };
    }

    function loadBlocked() {
        return loadList(BLOCKED_KEY);
    }

    // ---- UI: the side menu entry ---------------------------------------------------------------

    // A copy of one of VRCX's own menu entries, so it looks and collapses exactly like the others.
    // People choose which entries their menu shows, so it goes at the end of the main menu (the
    // one with the most entries) rather than next to any particular one.
    // VRCX's Manage entry (the gear): ours always sits right in front of it.
    function settingsEntry() {
        const gear = [...document.querySelectorAll('[data-sidebar="menu-item"] i.ri-settings-3-line')].pop();
        return gear?.closest('[data-sidebar="menu-item"]') || null;
    }

    // Puts ours in front of the gear, or at the end of its menu when there is no gear.
    function placeMenuEntry(entry) {
        const gear = settingsEntry();
        if (gear) {
            if (gear.previousElementSibling !== entry) {
                gear.before(entry);
            }
            return;
        }
        const last = [...entry.parentElement.querySelectorAll(':scope > [data-sidebar="menu-item"]')]
            .filter((el) => el !== entry)
            .pop();
        if (last && last.nextElementSibling !== entry) {
            last.after(entry);
        }
    }

    const hasLabel = (el) => [...el.querySelectorAll('*')].some((c) => !c.children.length && c.textContent.trim());

    function ensureMenuEntry() {
        const menus = [...document.querySelectorAll('[data-sidebar="menu"]')];
        const items = (menu) => [...menu.querySelectorAll(':scope > [data-sidebar="menu-item"]')];
        const menu = menus.sort((a, b) => items(b).length - items(a).length)[0];
        // Any plain entry will do as the model, just not the gear: that one opens a dropdown.
        const model =
            menu &&
            items(menu)
                .filter((el) => el.querySelector('i[class*="ri-"]') && !el.querySelector('i.ri-settings-3-line') && !el.hasAttribute('data-bot-blocker-menu'))
                .pop();
        const placed = document.querySelector('[data-bot-blocker-menu]');
        if (placed) {
            // A copy made while the menu was collapsed has no name: make it again once it expands,
            // and the other way round.
            if (!model || hasLabel(model) === hasLabel(placed)) {
                // VRCX adds and redraws entries as it goes; put ours back where it belongs.
                placeMenuEntry(placed);
                return;
            }
            placed.remove();
        }
        if (!model) {
            logOnce('nomenu', `no menu entry to copy yet (${menus.length} menus)`);
            return;
        }
        const entry = model.cloneNode(true);
        entry.setAttribute('data-bot-blocker-menu', '');
        entry.querySelectorAll('[data-active]').forEach((el) => el.setAttribute('data-active', 'false'));
        entry.querySelectorAll('[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
        const icon = entry.querySelector('i[class*="ri-"]');
        if (icon) {
            icon.className = icon.className.replace(/\bri-[a-z0-9-]+/g, '').trim() + ' ri-robot-2-line';
        }
        // The label is the innermost element with text of its own.
        const label = [...entry.querySelectorAll('*')].find((el) => !el.children.length && el.textContent.trim());
        if (label) {
            label.textContent = 'Bot Blocker';
        }
        entry.querySelectorAll('[title]').forEach((el) => (el.title = 'Bot Blocker'));
        entry.querySelectorAll('[aria-label]').forEach((el) => el.setAttribute('aria-label', 'Bot Blocker'));
        entry.addEventListener(
            'click',
            (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            },
            true
        );
        model.after(entry);
        placeMenuEntry(entry);
        logOnce('menu', settingsEntry() ? 'added the Bot Blocker menu entry before Manage' : 'added the Bot Blocker menu entry');
    }

    // ---- UI: the toggle in VRCX's group dialog -------------------------------------------------

    function syncGroupDialog() {
        const dialog = store('Group')?.groupDialog;
        const old = document.querySelector('.bb-groupbar');
        if (!dialog?.visible || !dialog.id) {
            old?.remove();
            return;
        }
        // VRCX's group dialog is the open dialog that shows this group's name.
        const name = dialog.ref?.name;
        const host = [...document.querySelectorAll('[role="dialog"]')]
            .reverse()
            .find((d) => name && d.textContent.includes(name));
        if (!host) {
            return;
        }
        addStyles();
        let bar = host.querySelector('.bb-groupbar');
        if (!bar) {
            old?.remove();
            bar = document.createElement('div');
            bar.className = 'bb-groupbar';
            const content = host.querySelector('[data-slot="dialog-content"]') || host;
            content.prepend(bar);
            logOnce('groupbar', 'added the toggle to the group dialog');
        }
        const on = isListed(dialog.id);
        if (bar.dataset.state === `${dialog.id}:${on}`) {
            return;
        }
        bar.dataset.state = `${dialog.id}:${on}`;
        bar.classList.toggle('bb-on', on);
        bar.innerHTML = `
            <i class="ri-robot-2-line"></i>
            <span class="bb-name">Bot Blocker</span>
            <button class="bb-btn">${on ? 'Stop blocking members' : 'Auto-block members'}</button>`;
        bar.querySelector('button').onclick = () => {
            if (isListed(dialog.id)) {
                removeGroup(dialog.id);
            } else {
                const ref = dialog.ref || {};
                addGroup({ id: dialog.id, name: ref.name || dialog.id, code: `${ref.shortCode}.${ref.discriminator}` });
            }
        };
    }

    // ---- start ---------------------------------------------------------------------------------

    // ---- updates ---------------------------------------------------------------------------------
    // New releases come from GitHub. A release only runs if it carries a signature from the
    // release key, which isn't on GitHub: taking over the repository isn't enough to ship code.
    const UPDATE_REPO = 'Omnicrash/vrcx-bot-blocker';
    const UPDATE_EVERY_MS = 6 * 3_600_000;
    const RELEASE_KEY = { kty: 'EC', crv: 'P-256', x: 'T_O2s-sQ3VgyfqTX3k6eqe7HcL8jJSJnre5lXw3C5AI', y: 'rp9TekxTHY2sMq7wKBRsioXn1A67li1H_g3VS6ihQRs' };
    let updateShown = false;

    async function signedRelease(code, signature) {
        const key = await crypto.subtle.importKey('jwk', RELEASE_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const sig = Uint8Array.from(atob(signature.trim()), (c) => c.charCodeAt(0));
        return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(code));
    }

    // Returns the newer version that's ready, 'latest', or 'failed'. `byHand`: the Check for
    // updates button, which works with automatic updates off too and shows the notice again.
    async function checkForUpdate(byHand = false) {
        if (!byHand && !settings().autoUpdate) {
            return 'latest';
        }
        try {
            const release = await (await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)).json();
            const version = String(release.tag_name || '').replace(/^v/, '');
            if (!/^\d+\.\d+\.\d+$/.test(version)) {
                return 'failed';
            }
            if (!newerVersion(version, VERSION)) {
                return 'latest';
            }
            let staged = null;
            try {
                staged = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null');
            } catch {}
            if (staged?.version !== version) {
                const raw = `https://raw.githubusercontent.com/${UPDATE_REPO}/v${version}/`;
                const get = async (file) => {
                    const res = await fetch(raw + file, { cache: 'no-store' });
                    if (!res.ok) {
                        throw new Error(`${file}: ${res.status}`);
                    }
                    return res.text();
                };
                const [code, signature] = await Promise.all([get('bot-blocker.js'), get('bot-blocker.js.sig')]);
                if (!code.includes(`const VERSION = '${version}';`) || !(await signedRelease(code, signature))) {
                    console.warn(TAG, `update ${version} isn't signed by the release key, skipped`);
                    return 'failed';
                }
                localStorage.setItem(UPDATE_KEY, JSON.stringify({ version, code }));
                console.info(TAG, `update ${version} downloaded, runs from the next start`);
            }
            showUpdateNotice(version, byHand);
            renderPanel();
            return version;
        } catch (err) {
            console.warn(TAG, 'update check failed', String(err));
            return 'failed';
        }
    }

    function showUpdateNotice(version, again = false) {
        if ((updateShown && !again) || !document.body) {
            return;
        }
        document.querySelector('.bb-toast')?.remove();
        updateShown = true;
        addStyles();
        const notice = document.createElement('div');
        notice.className = 'bb-toast';
        notice.setAttribute('role', 'status');
        notice.innerHTML = `<span>Bot Blocker ${esc(version)} is ready. Restart VRCX to update.</span>
            <button class="bb-btn" data-act="restart">Restart</button>
            <button class="bb-btn bb-ghost" data-act="close" title="Close"><i class="ri-close-line"></i></button>`;
        notice.querySelector('[data-act="restart"]').onclick = restartVrcx;
        notice.querySelector('[data-act="close"]').onclick = () => notice.remove();
        document.body.appendChild(notice);
    }

    // VRCX's own restart. On Windows it starts a new VRCX and exits; without the upgrade flag the
    // new one sees this one still running, hands over to it and quits, and nothing is left.
    async function restartVrcx() {
        try {
            await window.VRCXStorage?.Save?.();
        } catch {}
        if (window.electron?.restartApp) {
            window.electron.restartApp();
        } else {
            AppApi.RestartApplication(true);
        }
    }

    // The newer version that's downloaded and runs from the next start, if any.
    function readyUpdate() {
        try {
            const staged = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null');
            return staged && newerVersion(staged.version, VERSION) ? staged.version : null;
        } catch {
            return null;
        }
    }

    function startUpdates() {
        setTimeout(checkForUpdate, 10_000);
        setInterval(checkForUpdate, UPDATE_EVERY_MS);
    }

    function installHooks() {
        const service = window.gameLogService;
        if (!service?.parseRawGameLog || !window.request?.playerModerationRequest || !window.request?.groupRequest) {
            return false;
        }
        if (service.parseRawGameLog.__botBlocker) {
            return true;
        }
        // Every log line passes through here: the batch VRCX reads at startup and each line
        // the game pushes while it runs. (Hooking only the startup batch missed every live join.)
        const original = service.parseRawGameLog.bind(service);
        const wrapped = function (...args) {
            const entry = original(...args);
            try {
                inspect(entry);
            } catch (err) {
                console.error(TAG, err);
            }
            return entry;
        };
        wrapped.__botBlocker = true;
        service.parseRawGameLog = wrapped;
        watchUnblocks(window.request.playerModerationRequest);
        startShared();
        startUpdates();
        console.info(TAG, 'watching joins', DRY_RUN ? '(dry run)' : '', `- ${groups().length} blocked group(s)`);
        return true;
    }

    function installUi() {
        if (!document.body) {
            return;
        }
        // VRCX re-renders its menu and dialogs at will; put our pieces back whenever that happens.
        let pending = false;
        const tick = () => {
            pending = false;
            try {
                ensureMenuEntry();
                syncGroupDialog();
            } catch (err) {
                console.error(TAG, 'ui', err);
            }
        };
        new MutationObserver(() => {
            if (!pending) {
                pending = true;
                requestAnimationFrame(tick);
            }
        }).observe(document.body, { childList: true, subtree: true });
        tick();
    }

    // custom.js can run before the app has set up its globals; retry for a minute.
    let tries = 0;
    const timer = setInterval(() => {
        if (installHooks() || ++tries > 60) {
            clearInterval(timer);
        }
    }, 1000);
    installHooks() && clearInterval(timer);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installUi);
    } else {
        installUi();
    }

    window.botBlocker = {
        blocked: loadBlocked,
        unblocked: () => loadList(UNBLOCKED_KEY),
        groups,
        settings,
        setRule,
        setExcludeFriends,
        setShare,
        setSyncGroups,
        syncShared,
        shared: sharedList,
        setAgeDays,
        setNeeded,
        setBioWords,
        addGroup: async (input) => addGroup(await resolveGroup(input)),
        removeGroup,
        open: openPanel,
        checkForUpdate,
        risks: () => riskWarnings(settings()),
        hasDefaultName
    };
})();
