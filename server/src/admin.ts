// The management page: the acceptance rules, the words, group reports waiting for review, and the
// shared list itself. Only Docker's networks reach its port; people come in through the proxy,
// which signs them in with OSign. It refuses requests made from other sites. Anything that would
// move the list shows a preview first.
import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { timingSafeEqual } from 'node:crypto'
import { reviewToken } from './config'
import {
    allEntries,
    approvedWords,
    dropRecommendation,
    recommend,
    recommendationFor,
    reviewItems,
    markReviewed,
    whitelistCount,
    whitelistPlayer,
    counts,
    decideGroup,
    preview,
    reevaluate,
    removeByHand,
    restore,
    reviewQueue,
    saveRules,
    serverRules,
    setWord,
    streams,
    wordsByStatus
} from './reports'
import { type Grounds, SIGNS, type ServerRules, type Sign } from './rules'
import { budget, loginState } from './vrchat'

// Docker's own networks (172.16/12) and loopback: NPMplus and the other containers on the host.
// The LAN itself can't reach the management port directly; people come in through NPMplus,
// which signs them in with OSign and is LAN-only for this host.
export function fromDocker(address: string | undefined): boolean {
    const a = (address ?? '').replace(/^::ffff:/, '')
    if (a === '::1' || a === '127.0.0.1') {
        return true
    }
    const m = /^172\.(\d+)\.\d+\.\d+$/.exec(a)
    return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31
}

const SIGN_LABELS: Record<Sign, string> = {
    name: 'Default display name',
    robot: 'Robot avatar',
    visitor: 'Visitor rank',
    age: 'New account'
}

// The reasons a player is listed, as short tags.
const groundsTags = (g: Grounds) =>
    g.group
        ? [`Group: ${g.group}`]
        : ([g.name && 'Default name', g.robot && 'Robot avatar', g.visitor && 'Visitor rank', g.age !== undefined && `${g.age} ${g.age === 1 ? 'day' : 'days'} old`, g.bio && `"${g.bio}"`].filter(Boolean) as string[])
const tags = (g: Grounds) => html`<span class="tags">${groundsTags(g).map((t) => html`<span class="tag">${t}</span>`)}</span>`

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
function ago(ms: number) {
    const min = Math.round((Date.now() - ms) / 60_000)
    const text = min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`
    return html`<time title="${stamp(ms)}">${text}</time>`
}
const recBox = (r: { verdict: string; reasoning: string } | undefined) =>
    r ? html`<p class="rec rec-${r.verdict}"><b>Review suggests ${r.verdict === 'approve' ? 'approving' : 'rejecting'}.</b> ${r.reasoning}</p>` : ''
const vrcUser = (id: string, name: string) => html`<a class="player" href="https://vrchat.com/home/user/${id}" target="_blank" rel="noopener">${name}</a>`
// A button in a form of its own. Whitelisting can't be undone, so it asks first.
const action = (path: string, label: string, kind: string, ask?: string) =>
    html`<form class="inline" method="post" action="${path}" ${ask ? html`data-ask="${ask}"` : ''}><button class="${kind}">${label}</button></form>`
const whitelistButton = (userId: string, name: string) =>
    action(`/whitelist/${userId}`, 'Whitelist', 'safe', `Whitelist ${name}? Everything stored about them is deleted. This can't be undone.`)

const STYLE = `
:root {
    --bg: #131620; --panel: #1a1e2a; --raise: #232838; --line: #2b3142; --text: #e5e7ee; --muted: #8a92a6;
    --lilac: #a48dff; --lilac-ink: #17132b; --amber: #f2b553; --mint: #52cf9f; --red: #ff7a7a;
    color-scheme: dark;
}
@media (prefers-color-scheme: light) {
    :root {
        --bg: #f3f4f8; --panel: #ffffff; --raise: #eceef5; --line: #dde0ea; --text: #1c2030; --muted: #646c80;
        --lilac: #6a4fe0; --lilac-ink: #ffffff; --amber: #b7790f; --mint: #18865d; --red: #c93838;
        color-scheme: light;
    }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 'Atkinson Hyperlegible Next', system-ui, sans-serif; }
a { color: var(--lilac); text-decoration: none; } a:hover { text-decoration: underline; }
.wrap { max-width: 1240px; margin: 0 auto; padding: 28px 24px 64px; }
header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 26px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
header .out { margin-left: auto; color: var(--muted); }
.status { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 10px 0 24px; color: var(--muted); }
.status b { color: var(--text); font-weight: 600; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--red); margin-right: 6px; }
.dot.ok { background: var(--mint); }
.flash { background: color-mix(in srgb, var(--mint) 14%, var(--panel)); border: 1px solid color-mix(in srgb, var(--mint) 45%, transparent); padding: 10px 14px; border-radius: 10px; margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
@media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin-bottom: 24px; }
h2 { font-size: 17px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; gap: 10px; }
h2 .n { font-size: 13px; font-weight: 600; color: var(--muted); background: var(--raise); padding: 1px 9px; border-radius: 99px; }
section.todo h2 .n { background: var(--amber); color: #1d1606; }
.empty { color: var(--muted); margin: 0; }
.item { padding: 14px 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; align-items: start; }
.item:first-of-type { border-top: 0; padding-top: 2px; }
.item .what { font-weight: 600; }
.item .meta { color: var(--muted); font-size: 13px; }
.item .rec { grid-column: 1 / -1; }
.buttons { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.rec { margin: 4px 0 0; padding: 8px 12px; border-radius: 8px; background: var(--raise); font-size: 14px; }
.rec-approve b { color: var(--mint); } .rec-reject b { color: var(--red); }
table { border-collapse: collapse; width: 100%; }
td { padding: 9px 8px; border-top: 1px solid var(--line); vertical-align: middle; }
tr:first-child td { border-top: 0; }
td.when { color: var(--muted); white-space: nowrap; font-size: 13px; }
td.act { text-align: right; white-space: nowrap; }
.player { font-weight: 600; color: var(--text); }
.tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 12.5px; padding: 1px 8px; border-radius: 6px; background: var(--raise); color: var(--muted); white-space: nowrap; }
.find { width: 100%; margin-bottom: 8px; }
button { font: inherit; font-size: 14px; font-weight: 600; border-radius: 8px; padding: 5px 12px; cursor: pointer; border: 1px solid var(--line); background: var(--raise); color: var(--text); }
button:hover { border-color: var(--muted); }
button.primary { background: var(--lilac); border-color: var(--lilac); color: var(--lilac-ink); }
button.ok { color: var(--mint); } button.safe { color: var(--mint); } button.no { color: var(--red); }
button.ok:hover, button.safe:hover { border-color: var(--mint); } button.no:hover { border-color: var(--red); }
button.quiet { background: none; border-color: transparent; color: var(--muted); padding: 2px 6px; }
button.quiet:hover { color: var(--red); border-color: transparent; }
:focus-visible { outline: 2px solid var(--lilac); outline-offset: 2px; }
form.inline { display: inline; }
input[type=text], input[type=number], input[type=search] { font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
input:focus { border-color: var(--lilac); outline: none; }
.row { display: flex; gap: 8px; } .row input { flex: 1; min-width: 0; }
.check { display: flex; align-items: center; gap: 10px; padding: 6px 0; cursor: pointer; }
.check input { width: 18px; height: 18px; accent-color: var(--lilac); }
.rules p { margin: 10px 0; }
.rules input[type=number] { width: 64px; text-align: center; }
.words { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-wrap: wrap; gap: 6px; }
.words li { display: inline-flex; align-items: center; gap: 2px; background: var(--raise); border-radius: 8px; padding: 2px 2px 2px 10px; font-weight: 600; }
.note { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.change { margin: 18px 0; }
.change .tags { margin-top: 6px; }
aside .item { grid-template-columns: 1fr; } aside .buttons { justify-content: flex-start; }
@media (max-width: 700px) {
    .wrap { padding: 20px 16px 48px; }
    #listed tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; padding: 10px 0; border-top: 1px solid var(--line); }
    #listed tr:first-child { border-top: 0; }
    #listed td { display: block; border: 0; padding: 0; }
    #listed td.act { grid-row: 1; grid-column: 2; }
    #listed td:nth-child(2) { grid-column: 1 / -1; }
    #listed td.when { display: none; }
    #listed tr[hidden] { display: none; }
    .item { grid-template-columns: 1fr; } .buttons { justify-content: flex-start; }
}
`

// Whitelisting asks before it posts; the shared list filters as you type.
const SCRIPT = `
document.addEventListener('submit', (e) => {
    const ask = e.target.dataset && e.target.dataset.ask
    if (ask && !confirm(ask)) e.preventDefault()
})
const find = document.getElementById('find')
if (find) find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase()
    for (const tr of document.querySelectorAll('#listed tr')) tr.hidden = q !== '' && !tr.dataset.find.includes(q)
})
`

function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
    return html`<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>${title}</title>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
                <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;600;700&display=swap" rel="stylesheet" />
                <style>${raw(STYLE)}</style>
            </head>
            <body>
                <div class="wrap">${body}</div>
                <script>${raw(SCRIPT)}</script>
            </body>
        </html>`
}

export const admin = new Hono()

// Requests made by another site (a page opened anywhere on the LAN posting a form here) are refused.
admin.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && !c.req.path.startsWith('/api/')) {
        const site = c.req.header('sec-fetch-site')
        const origin = c.req.header('origin')
        const host = c.req.header('host')
        const originHost = origin ? origin.replace(/^https?:\/\//, '') : null
        if ((site && site !== 'same-origin' && site !== 'none') || (originHost && host && originHost !== host)) {
            return c.text('Forbidden', 403)
        }
    }
    await next()
})

// The daily review signs in with its own token; people through OSign, whose forward-auth in
// NPMplus puts the signed-in user in Remote-User.
admin.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) {
        const sent = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer /, ''))
        const token = Buffer.from(reviewToken())
        if (!token.length || sent.length !== token.length || !timingSafeEqual(sent, token)) {
            return c.json({ error: 'unauthorized' }, 401)
        }
        return next()
    }
    if (!c.req.header('remote-user')) {
        return c.text('Open this page through its OSign address.', 401)
    }
    await next()
})

admin.get('/', (c) => {
    const n = counts()
    const r = serverRules()
    const w = wordsByStatus()
    const queue = reviewQueue()
    const entries = allEntries()
    const listed = entries.filter((e) => !e.removed)
    const byHand = entries.filter((e) => e.removed && e.removedBy === 'admin')
    const b = budget()
    const done = c.req.query('done')
    return c.html(
        page(
            'Bot Blocker',
            html`<header>
                    <h1>Bot Blocker</h1>
                    <a class="out" href="/_osign/logout">Sign out</a>
                </header>
                <div class="status">
                    <span><span class="dot ${loginState === 'ok' ? 'ok' : ''}"></span>VRChat login: <b>${loginState}</b></span>
                    <span>Lookups today: <b>${b.usedToday}</b> of ${b.perDay}${b.pausedUntil ? html` <span style="color:var(--amber)">(paused until ${stamp(b.pausedUntil)})</span>` : ''}</span>
                    <span>Waiting for a lookup: <b>${n.pending}</b></span>
                    <span>Plugins connected: <b>${streams()}</b></span>
                </div>
                ${done ? html`<div class="flash" role="status">${done}</div>` : ''}

                <div class="grid">
                    <main>
                        <section class="${queue.length ? 'todo' : ''}">
                            <h2>Group reports to review ${queue.length ? html`<span class="n">${queue.length}</span>` : ''}</h2>
                            ${queue.length
                                ? queue.map(
                                      (q) => html`<div class="item">
                                          <div>
                                              <div class="what">${vrcUser(q.userId, q.displayName)}</div>
                                              <div class="meta">
                                                  ${q.groups.map(
                                                      (g, i) => html`${i ? ', ' : ''}${g.id ? html`<a href="https://vrchat.com/home/group/${g.id}" target="_blank" rel="noopener">${g.name}</a>` : g.name}`
                                                  )}
                                                  - ${q.reporters} ${q.reporters === 1 ? 'reporter' : 'reporters'}, first ${ago(q.firstAt)}
                                              </div>
                                          </div>
                                          <div class="buttons">
                                              ${action(`/review/${q.userId}/approve`, 'Approve', 'ok')} ${action(`/review/${q.userId}/reject`, 'Reject', 'no')}
                                              ${whitelistButton(q.userId, q.displayName)}
                                          </div>
                                          ${recBox(recommendationFor(`group:${q.userId}`))}
                                      </div>`
                                  )
                                : html`<p class="empty">Nothing to review.</p>`}
                        </section>

                        ${w.pending.length
                            ? html`<section class="todo">
                                  <h2>Reported words <span class="n">${w.pending.length}</span></h2>
                                  ${w.pending.map(
                                      (p) => html`<div class="item">
                                          <div>
                                              <div class="what">${p.word}</div>
                                              <div class="meta">${p.reports} ${p.reports === 1 ? 'report' : 'reports'}</div>
                                          </div>
                                          <div class="buttons">
                                              <form class="inline" method="post" action="/words/approve/preview"><input type="hidden" name="word" value="${p.word}" /><button class="ok">Approve</button></form>
                                              <form class="inline" method="post" action="/words/reject"><input type="hidden" name="word" value="${p.word}" /><button class="no">Reject</button></form>
                                          </div>
                                          ${recBox(recommendationFor(`word:${p.word}`))}
                                      </div>`
                                  )}
                              </section>`
                            : ''}

                        <section>
                            <h2>Shared list <span class="n">${n.listed}</span></h2>
                            ${listed.length
                                ? html`${listed.length > 8 ? html`<input id="find" class="find" type="search" placeholder="Find a player" aria-label="Find a player" />` : ''}
                                      <table>
                                          <tbody id="listed">
                                              ${listed.map(
                                                  (e) => html`<tr data-find="${[e.displayName, ...groundsTags(e.grounds as Grounds)].join(' ').toLowerCase()}">
                                                      <td>${vrcUser(e.userId, e.displayName)}</td>
                                                      <td>${tags(e.grounds as Grounds)}</td>
                                                      <td class="when">${ago(e.addedAt)}</td>
                                                      <td class="act">${action(`/remove/${e.userId}`, 'Remove', 'no')} ${whitelistButton(e.userId, e.displayName)}</td>
                                                  </tr>`
                                              )}
                                          </tbody>
                                      </table>`
                                : html`<p class="empty">Empty.</p>`}
                        </section>
                    </main>

                    <aside>
                        <section class="rules">
                            <h2>Acceptance rules</h2>
                            <form method="post" action="/rules/preview">
                                ${SIGNS.map(
                                    (s) => html`<label class="check"><input type="checkbox" name="${s}" ${r.counted[s] ? 'checked' : ''} /> ${SIGN_LABELS[s]}</label>`
                                )}
                                <p>At least <input type="number" name="needed" min="1" max="4" value="${r.needed}" aria-label="Signs needed" /> of the checked signs.</p>
                                <p>New account: younger than <input type="number" name="ageDays" min="1" max="3650" value="${r.ageDays}" aria-label="Days" /> days when first seen.</p>
                                <button class="primary">Preview</button>
                                <p class="note">An approved word lists a player on its own.</p>
                            </form>
                        </section>

                        <section>
                            <h2>Words <span class="n">${w.approved.length}</span></h2>
                            <ul class="words">
                                ${w.approved.map(
                                    (word) => html`<li>${word}<form class="inline" method="post" action="/words/remove/preview"><input type="hidden" name="word" value="${word}" /><button class="quiet" aria-label="Remove ${word}" title="Remove">×</button></form></li>`
                                )}
                            </ul>
                            <form class="row" method="post" action="/words/approve/preview">
                                <input type="text" name="word" placeholder="Add a word or site" aria-label="Add a word or site" required /> <button>Preview</button>
                            </form>
                        </section>

                        <section>
                            <h2>Whitelist <span class="n">${whitelistCount()}</span></h2>
                            <form class="row" method="post" action="/whitelist" data-ask="Whitelist this player? Everything stored about them is deleted. This can't be undone.">
                                <input type="text" name="user" placeholder="Profile link or usr_ id" aria-label="Profile link or usr_ id" required /> <button class="safe">Whitelist</button>
                            </form>
                        </section>

                        ${byHand.length
                            ? html`<section>
                                  <h2>Removed by hand <span class="n">${byHand.length}</span></h2>
                                  ${byHand.map(
                                      (e) => html`<div class="item">
                                          <div>
                                              <div class="what">${vrcUser(e.userId, e.displayName)}</div>
                                              <div class="meta">${tags(e.grounds as Grounds)}</div>
                                          </div>
                                          <div class="buttons">${action(`/restore/${e.userId}`, 'Let the rules decide again', '')}</div>
                                      </div>`
                                  )}
                              </section>`
                            : ''}
                    </aside>
                </div>`
        )
    )
})

// ---- changes that can move the list: a preview, then a confirmed apply ------------------------

function rulesFrom(form: Record<string, unknown>): ServerRules {
    const counted = Object.fromEntries(SIGNS.map((s) => [s, form[s] === 'on'])) as Record<Sign, boolean>
    return {
        counted,
        needed: Math.max(1, Math.min(4, Math.round(Number(form.needed)) || 2)),
        ageDays: Math.max(1, Math.min(3650, Math.round(Number(form.ageDays)) || 7))
    }
}

function confirmPage(what: string, change: ReturnType<typeof preview>, action: string, hidden: Record<string, string>) {
    const names = (list: { userId: string; displayName: string }[]) =>
        list.length
            ? html`<div class="tags">${list.slice(0, 50).map((p) => html`<span class="tag">${vrcUser(p.userId, p.displayName)}</span>`)}${list.length > 50 ? html`<span class="tag">and ${list.length - 50} more</span>` : ''}</div>`
            : ''
    return page(
        'Bot Blocker - confirm',
        html`<section style="max-width:760px;margin:40px auto">
            <h2>${what}</h2>
            <div class="change"><b>Adds ${change.add.length}</b> to the shared list. ${names(change.add)}</div>
            <div class="change"><b>Removes ${change.remove.length}.</b> ${names(change.remove)}</div>
            <form class="row" method="post" action="${action}" style="align-items:center">
                ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
                <button class="primary">Apply</button> <a href="/">Cancel</a>
            </form>
        </section>`
    )
}

admin.post('/rules/preview', async (c) => {
    const form = await c.req.parseBody()
    const r = rulesFrom(form)
    const hidden: Record<string, string> = { needed: String(r.needed), ageDays: String(r.ageDays) }
    for (const s of SIGNS) if (r.counted[s]) hidden[s] = 'on'
    return c.html(confirmPage('Change the acceptance rules', preview(r, approvedWords()), '/rules/apply', hidden))
})

admin.post('/rules/apply', async (c) => {
    saveRules(rulesFrom(await c.req.parseBody()))
    const { added, removed } = reevaluate()
    return c.redirect(`/?done=${encodeURIComponent(`Rules saved: ${added} added, ${removed} removed.`)}`)
})

admin.post('/words/:action/preview', async (c) => {
    const action = c.req.param('action')
    const word = String((await c.req.parseBody()).word ?? '').trim()
    if (!word || (action !== 'approve' && action !== 'remove')) {
        return c.redirect('/')
    }
    const current = approvedWords()
    const next = action === 'approve' ? [...new Set([...current, word])] : current.filter((w) => w !== word)
    const title = action === 'approve' ? `Approve "${word}"` : `Remove "${word}"`
    return c.html(confirmPage(title, preview(serverRules(), next), `/words/${action}/apply`, { word }))
})

admin.post('/words/:action/apply', async (c) => {
    const action = c.req.param('action')
    const word = String((await c.req.parseBody()).word ?? '').trim()
    if (word && (action === 'approve' || action === 'remove')) {
        setWord(word, action === 'approve' ? 'approved' : 'removed')
    }
    const { added, removed } = reevaluate()
    return c.redirect(`/?done=${encodeURIComponent(`"${word}" ${action === 'approve' ? 'approved' : 'removed'}: ${added} added, ${removed} removed.`)}`)
})

// Rejecting a reported word moves nothing: it just won't be asked about again.
admin.post('/words/reject', async (c) => {
    setWord(String((await c.req.parseBody()).word ?? ''), 'rejected')
    return c.redirect('/')
})

admin.post('/review/:userId/:verdict', (c) => {
    const verdict = c.req.param('verdict')
    if (verdict === 'approve' || verdict === 'reject') {
        decideGroup(c.req.param('userId'), verdict === 'approve')
    }
    return c.redirect('/')
})

admin.post('/remove/:userId', (c) => {
    removeByHand(c.req.param('userId'))
    return c.redirect('/')
})

admin.post('/restore/:userId', (c) => {
    restore(c.req.param('userId'))
    return c.redirect('/')
})

// ---- the daily review's API (token, see reviewToken) --------------------------------------------

admin.get('/api/review', (c) => c.json(reviewItems()))

admin.post('/api/whitelist', async (c) => {
    const { userId } = (await c.req.json().catch(() => ({}))) as { userId?: string }
    if (!userId || !/^usr_[0-9a-f-]{36}$/.test(userId)) {
        return c.json({ error: 'bad user id' }, 400)
    }
    whitelistPlayer(userId)
    return c.json({ ok: true })
})

// A group report or a word: decided (`decide: true`, only for the clear cases the review
// instructions allow) or left as a recommendation for a person.
admin.post('/api/groups/:userId', async (c) => {
    const { verdict, reasoning, decide } = (await c.req.json().catch(() => ({}))) as { verdict?: string; reasoning?: string; decide?: boolean }
    if (verdict !== 'approve' && verdict !== 'reject') {
        return c.json({ error: 'verdict must be approve or reject' }, 400)
    }
    const userId = c.req.param('userId')
    if (decide) {
        decideGroup(userId, verdict === 'approve')
        dropRecommendation(`group:${userId}`)
    } else {
        recommend(`group:${userId}`, verdict, reasoning ?? '')
    }
    return c.json({ ok: true })
})

admin.post('/api/words', async (c) => {
    const { word, verdict, reasoning, decide } = (await c.req.json().catch(() => ({}))) as { word?: string; verdict?: string; reasoning?: string; decide?: boolean }
    if (!word || (verdict !== 'approve' && verdict !== 'reject')) {
        return c.json({ error: 'word and verdict (approve or reject) needed' }, 400)
    }
    if (decide) {
        setWord(word, verdict === 'approve' ? 'approved' : 'rejected')
        dropRecommendation(`word:${word}`)
        const { added } = verdict === 'approve' ? reevaluate() : { added: 0 }
        return c.json({ ok: true, added })
    }
    recommend(`word:${word}`, verdict, reasoning ?? '')
    return c.json({ ok: true })
})

admin.post('/api/review/done', (c) => c.json({ reviewedAt: markReviewed() }))

// ---- whitelisting from the page --------------------------------------------------------------

admin.post('/whitelist', async (c) => {
    const raw = String((await c.req.parseBody()).user ?? '')
    const userId = /usr_[0-9a-f-]{36}/.exec(raw)?.[0]
    if (!userId) {
        return c.redirect(`/?done=${encodeURIComponent('No user id found in that.')}`)
    }
    whitelistPlayer(userId)
    return c.redirect(`/?done=${encodeURIComponent('Whitelisted, and everything stored about them deleted.')}`)
})

admin.post('/whitelist/:userId', (c) => {
    whitelistPlayer(c.req.param('userId'))
    return c.redirect(`/?done=${encodeURIComponent('Whitelisted, and everything stored about them deleted.')}`)
})

// For tests: the header OSign's forward-auth adds for a signed-in user.
export const TEST_USER = { 'Remote-User': 'tester' }
