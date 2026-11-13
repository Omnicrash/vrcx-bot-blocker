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
    const DRY_RUN = false; // true: only log what would be blocked
    const BOT_AVATAR = 'Robot';
    const BLOCKED_KEY = 'botBlocker.blocked';
    const UNBLOCKED_KEY = 'botBlocker.unblocked';
    const GROUPS_KEY = 'botBlocker.groups';
    const TAG = '[BotBlocker]';
    const LOOKUP_GAP_MS = 400; // between group lookups, to stay clear of VRChat's rate limits

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
    const FROM_LOG = ['name', 'robot']; // known from the game log, the rest needs the profile
    const RULE_LABELS = {
        name: 'default name',
        robot: 'Robot avatar',
        visitor: 'Visitor rank',
        bio: 'in bio',
        nuisance: 'Nuisance',
        probable: 'Almost Nuisance',
        age: 'new account'
    };
    const DEFAULT_SETTINGS = {
        excludeFriends: true,
        ageDays: 7,
        bioWords: ['hexed.cc'], // keywords and websites the bio rule looks for
        rules: {
            name: { on: true, always: false },
            robot: { on: true, always: false },
            visitor: { on: true, always: false },
            bio: { on: true, always: true },
            nuisance: { on: true, always: true },
            probable: { on: false, always: true },
            age: { on: false, always: true }
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
        return { ...DEFAULT_SETTINGS, ...saved, rules };
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

    function setRule(rule, field, value) {
        const s = settings();
        s.rules[rule][field] = !!value;
        saveSettings(s);
    }

    function setExcludeFriends(value) {
        saveSettings({ ...settings(), excludeFriends: !!value });
    }

    function setBioWords(words) {
        const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
        saveSettings({ ...settings(), bioWords: clean });
        return clean;
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

    // The first word from the list the bio (or its links) mentions, or null.
    function bioMention(user, words) {
        const text = [user.bio || '', ...(user.bioLinks || [])].join(' ');
        return words.find((w) => wordPattern(w).test(text)) || null;
    }

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
        // The checked rules the log can already answer must fit before the profile is worth a look.
        const togetherPossible = together.length > 0 && together.every((r) => !FROM_LOG.includes(r) || fromLog[r]);
        // Matched from the log alone, a bot is blocked even after it left again.
        const fromLogOnly = togetherPossible && together.some((r) => FROM_LOG.includes(r));
        const groupIds = !only || only.rule !== 'all' ? only?.groupIds || groups().map((g) => g.id) : groups().map((g) => g.id);
        // Everything else only looks at players still here: the startup replay of the log brings
        // back hours of joins, and checking all of those would flood the API.
        const needsHere = togetherPossible || alone.length || groupIds.length;
        if (!fromLogOnly && !(needsHere && present.has(userId))) {
            return;
        }

        checking.add(userId);
        try {
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
                visitor: !tags.includes('system_trust_basic'),
                bio: bioMention(user, s.bioWords),
                nuisance: tags.includes('system_troll'),
                probable: tags.includes('system_probable_troll'),
                age: days < s.ageDays
            };
            let reason = null;
            if (togetherPossible && (fromLogOnly || here) && together.every((r) => fits[r])) {
                reason = together.map((r) => (r === 'bio' ? `"${fits.bio}" in bio` : RULE_LABELS[r])).join(' + ');
            }
            const hit = here && alone.find((r) => fits[r]);
            if (!reason && hit) {
                reason =
                    hit === 'age'
                        ? `account ${Math.max(0, Math.floor(days))} day(s) old`
                        : hit === 'bio'
                          ? `"${fits.bio}" in bio`
                          : RULE_LABELS[hit];
            }
            if (!reason && here && groupIds.length) {
                const theirs = await queued(() => userGroupIds(userId));
                const member = theirs.find((g) => groupIds.includes(g.id));
                if (member) {
                    reason = `member of ${member.name}`;
                }
            }
            if (reason) {
                await block(displayName, userId, reason);
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

    async function block(displayName, userId, reason) {
        if (DRY_RUN) {
            console.info(TAG, 'would block', displayName, userId, `(${reason})`);
            return;
        }
        handled.add(userId);
        try {
            await window.request.playerModerationRequest.sendPlayerModeration({ moderated: userId, type: 'block' });
            remember(BLOCKED_KEY, { userId, displayName, reason, at: new Date().toISOString() });
            console.info(TAG, 'blocked', displayName, userId, `(${reason})`);
            try {
                AppApi.DesktopNotification('Bot Blocker', `Blocked ${displayName}: ${reason}`, '');
            } catch {}
            renderPanel();
        } catch (err) {
            handled.delete(userId); // let a later join retry
            console.error(TAG, 'block failed for', displayName, userId, err);
        }
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
            @media (max-width: 760px) { .bb-cols { grid-template-columns: 1fr; } }
            .bb-scroll { max-height: 300px; overflow-y: auto; }
            .bb-recent { max-height: 560px; }
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
            .bb-error { color: var(--destructive); font-size: 13px; margin-top: 6px; min-height: 1em; }
            .bb-empty { color: var(--muted-foreground); padding: 8px 0; }
            .bb-groupbar { display: flex; align-items: center; gap: 10px; margin: 0 0 10px;
                padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius, .375rem);
                font-size: 13px; }
            .bb-groupbar .bb-name { flex: 1; }
            .bb-groupbar.bb-on { border-color: var(--destructive); }
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
                ${ruleRow('age', `Account younger than
                    <input class="bb-input bb-days" type="number" min="1" max="3650" value="${s.ageDays}" /> days`)}
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
                                    <span class="bb-muted">${esc(b.reason || 'default account')}</span></div>`
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
        panel.querySelectorAll('[data-always]').forEach((box) => {
            box.onchange = () => setRule(box.dataset.always, 'always', box.checked);
        });
        panel.querySelector('[data-act="friends"]').onchange = (e) => setExcludeFriends(e.target.checked);
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
    function ensureMenuEntry() {
        if (document.querySelector('[data-bot-blocker-menu]')) {
            return;
        }
        const menus = [...document.querySelectorAll('[data-sidebar="menu"]')];
        const items = (menu) => [...menu.querySelectorAll(':scope > [data-sidebar="menu-item"]')];
        const menu = menus.sort((a, b) => items(b).length - items(a).length)[0];
        const model = menu && items(menu).filter((el) => el.querySelector('i[class*="ri-"]')).pop();
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
        logOnce('menu', 'added the Bot Blocker menu entry');
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
        setAgeDays,
        setBioWords,
        addGroup: async (input) => addGroup(await resolveGroup(input)),
        removeGroup,
        open: openPanel,
        hasDefaultName
    };
})();
