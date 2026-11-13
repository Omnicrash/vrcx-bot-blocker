// The management page: the acceptance rules, the words, group reports waiting for review, and the
// shared list itself. Its port is only reachable from the LAN; on top of that it wants a password
// (VAPI_ADMIN_PASSWORD_HASH), refuses requests made from other sites, and refuses non-private
// addresses. Anything that would move the list shows a preview first.
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { timingSafeEqual } from 'node:crypto'
import { adminPasswordHash, reviewToken } from './config'
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

// 10/8, 172.16/12, 192.168/16, loopback, and their IPv6 forms.
export function isPrivate(address: string | undefined): boolean {
    const a = (address ?? '').replace(/^::ffff:/, '')
    if (a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a)) {
        return true
    }
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
    if (!m) {
        return false
    }
    const [x, y] = [Number(m[1]), Number(m[2])]
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
}

const SIGN_LABELS: Record<Sign, string> = {
    name: 'Default display name',
    robot: 'Robot avatar',
    visitor: 'Visitor rank',
    age: 'New account'
}
const COOKIE = 'vapi_admin'
const sessions = new Map<string, number>() // token -> expires at
const loginTries: number[] = []

const groundsText = (g: Grounds) =>
    g.group
        ? `group: ${g.group}`
        : [g.name && 'Default name', g.robot && 'Robot avatar', g.visitor && 'Visitor rank', g.age !== undefined && `${g.age} days old`, g.bio && `"${g.bio}"`]
              .filter(Boolean)
              .join(', ')
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const recBox = (r: { verdict: string; reasoning: string } | undefined) =>
    r ? html`<div class="muted" style="margin-bottom:4px">Review suggests <b>${r.verdict}</b>: ${r.reasoning}</div>` : ''
const vrcUser = (id: string, name: string) => html`<a href="https://vrchat.com/home/user/${id}" target="_blank">${name}</a>`

function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
    return html`<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>${title}</title>
                <style>
                    body { font: 14px system-ui, sans-serif; background: #1e1e1e; color: #e6e6e6; margin: 24px; max-width: 1100px; }
                    h1 { font-size: 20px; } h2 { font-size: 13px; margin-top: 28px; color: #aaa; text-transform: uppercase; letter-spacing: .04em; }
                    table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #333; vertical-align: top; }
                    th { color: #888; font-weight: 500; } a { color: #8ab4f8; } .muted { color: #888; } .warn { color: #e5a03b; }
                    button { background: #333; color: #e6e6e6; border: 1px solid #555; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
                    button.ok { border-color: #3a7; } button.no { border-color: #b44; } form.inline { display: inline; }
                    input[type=number], input[type=text], input[type=password] { background: #111; color: #e6e6e6; border: 1px solid #555; border-radius: 4px; padding: 4px 6px; }
                </style>
            </head>
            <body>
                ${body}
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
        if ((site && site !== 'same-origin' && site !== 'none') || (origin && host && origin !== `http://${host}`)) {
            return c.text('Forbidden', 403)
        }
    }
    await next()
})

// Everything but the login itself wants a session.
admin.use('*', async (c, next) => {
    if (c.req.path === '/login') {
        return next()
    }
    // The daily review signs in with its own token instead of a session.
    if (c.req.path.startsWith('/api/')) {
        const sent = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer /, ''))
        const token = Buffer.from(reviewToken())
        if (!token.length || sent.length !== token.length || !timingSafeEqual(sent, token)) {
            return c.json({ error: 'unauthorized' }, 401)
        }
        return next()
    }
    const token = getCookie(c, COOKIE)
    if (!token || (sessions.get(token) ?? 0) < Date.now()) {
        return c.redirect('/login')
    }
    await next()
})

admin.get('/login', (c) =>
    c.html(
        page(
            'Bot Blocker - sign in',
            adminPasswordHash()
                ? html`<h1>Bot Blocker</h1>
                      ${c.req.query('failed') === 'busy'
                          ? html`<p class="warn">Too many tries: wait a minute.</p>`
                          : c.req.query('failed')
                            ? html`<p class="warn">Wrong password.</p>`
                            : ''}
                      <form method="post" action="/login">
                          <input type="password" name="password" autofocus /> <button class="ok">Sign in</button>
                      </form>`
                : html`<h1>Bot Blocker</h1>
                      <p class="warn">No password set yet (admin.hash in the data folder), so nobody can sign in.</p>`
        )
    )
)

admin.post('/login', async (c) => {
    const now = Date.now()
    while (loginTries.length && loginTries[0]! < now - 60_000) loginTries.shift()
    loginTries.push(now)
    const password = String((await c.req.parseBody()).password ?? '')
    const hash = adminPasswordHash()
    if (loginTries.length > 5) {
        console.log('management page: sign-in refused, too many tries')
        return c.redirect('/login?failed=busy')
    }
    const ok = !!hash && (await Bun.password.verify(password, hash).catch(() => false))
    console.log(`management page: sign-in ${ok ? 'ok' : 'failed (wrong password)'}`)
    if (!ok) {
        return c.redirect('/login?failed=1')
    }
    const token = randomBytes(32).toString('hex')
    sessions.set(token, now + 30 * 86_400_000)
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 30 * 86_400 })
    return c.redirect('/')
})

admin.post('/logout', (c) => {
    const token = getCookie(c, COOKIE)
    if (token) sessions.delete(token)
    return c.redirect('/login')
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
            'Bot Blocker - management',
            html`<h1>Bot Blocker</h1>
                <div class="muted">
                    VRChat login: ${loginState} · lookups today: ${b.usedToday} of ${b.perDay}${b.pausedUntil ? html` · <span class="warn">paused until ${when(b.pausedUntil)}</span>` : ''} ·
                    listed: ${n.listed} · waiting for a lookup: ${n.pending} · plugins connected: ${streams()}
                    <form class="inline" method="post" action="/logout"><button>Sign out</button></form>
                </div>
                ${done ? html`<p class="warn">${done}</p>` : ''}

                <h2>Acceptance rules</h2>
                <form method="post" action="/rules/preview">
                    <table>
                        <tr><th>Sign</th><th>Counts</th></tr>
                        ${SIGNS.map(
                            (s) => html`<tr><td>${SIGN_LABELS[s]}</td><td><input type="checkbox" name="${s}" ${r.counted[s] ? 'checked' : ''} /></td></tr>`
                        )}
                    </table>
                    <p>At least <input type="number" name="needed" min="1" max="4" value="${r.needed}" style="width:50px" /> of the counted signs.
                        New account: younger than <input type="number" name="ageDays" min="1" max="3650" value="${r.ageDays}" style="width:70px" /> days when first seen.</p>
                    <p class="muted">An approved word lists a player on its own.</p>
                    <button>Preview</button>
                </form>

                <h2>Words</h2>
                <table>
                    <tr><th>Approved</th><th></th></tr>
                    ${w.approved.map(
                        (word) => html`<tr><td>${word}</td><td><form class="inline" method="post" action="/words/remove/preview"><input type="hidden" name="word" value="${word}" /><button class="no">Remove</button></form></td></tr>`
                    )}
                </table>
                <form method="post" action="/words/approve/preview" style="margin-top:8px">
                    <input type="text" name="word" placeholder="Add a word or site" /> <button>Preview</button>
                </form>
                ${w.pending.length
                    ? html`<table style="margin-top:12px">
                          <tr><th>Reported, not decided</th><th>Reports</th><th></th></tr>
                          ${w.pending.map(
                              (p) => html`<tr><td>${p.word}</td><td>${p.reports}</td><td>
                                  ${recBox(recommendationFor(`word:${p.word}`))}
                                  <form class="inline" method="post" action="/words/approve/preview"><input type="hidden" name="word" value="${p.word}" /><button class="ok">Approve</button></form>
                                  <form class="inline" method="post" action="/words/reject"><input type="hidden" name="word" value="${p.word}" /><button class="no">Reject</button></form>
                              </td></tr>`
                          )}
                      </table>`
                    : ''}

                <h2>Group reports to review</h2>
                ${queue.length
                    ? html`<table>
                          <tr><th>Player</th><th>Group</th><th>Reporters</th><th>First report</th><th></th></tr>
                          ${queue.map(
                              (q) => html`<tr>
                                  <td>${vrcUser(q.userId, q.displayName)}</td>
                                  <td>${q.groups.map(
                                      (g) => html`<div>${g.name} · ${g.id ? html`<a href="https://vrchat.com/home/group/${g.id}" target="_blank">group page</a>` : html`<span class="muted">no link</span>`}</div>`
                                  )}</td>
                                  <td>${q.reporters}</td>
                                  <td class="muted">${when(q.firstAt)}</td>
                                  <td>
                                      ${recBox(recommendationFor(`group:${q.userId}`))}
                                      <form class="inline" method="post" action="/review/${q.userId}/approve"><button class="ok">Approve</button></form>
                                      <form class="inline" method="post" action="/review/${q.userId}/reject"><button class="no">Reject</button></form>
                                      <form class="inline" method="post" action="/whitelist/${q.userId}"><button>Whitelist</button></form>
                                  </td>
                              </tr>`
                          )}
                      </table>`
                    : html`<div class="muted">Nothing to review.</div>`}

                <h2>Shared list (${listed.length})</h2>
                ${listed.length
                    ? html`<table>
                          <tr><th>Player</th><th>Grounds</th><th>Listed</th><th></th></tr>
                          ${listed.map(
                              (e) => html`<tr>
                                  <td>${vrcUser(e.userId, e.displayName)}</td>
                                  <td class="muted">${groundsText(e.grounds as Grounds)}</td>
                                  <td class="muted">${when(e.addedAt)}</td>
                                  <td>
                                      <form class="inline" method="post" action="/remove/${e.userId}"><button class="no">Remove</button></form>
                                      <form class="inline" method="post" action="/whitelist/${e.userId}"><button>Whitelist</button></form>
                                  </td>
                              </tr>`
                          )}
                      </table>`
                    : html`<div class="muted">Empty.</div>`}

                <h2>Whitelist (${whitelistCount()})</h2>
                <form method="post" action="/whitelist">
                    <input type="text" name="user" placeholder="Profile link or usr_ id" style="width:380px" /> <button>Whitelist and delete their data</button>
                </form>

                ${byHand.length
                    ? html`<h2>Removed by hand</h2>
                          <table>
                              ${byHand.map(
                                  (e) => html`<tr>
                                      <td>${vrcUser(e.userId, e.displayName)}</td>
                                      <td class="muted">${groundsText(e.grounds as Grounds)}</td>
                                      <td><form class="inline" method="post" action="/restore/${e.userId}"><button>Let the rules decide again</button></form></td>
                                  </tr>`
                              )}
                          </table>`
                    : ''}`
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
        list.length ? html`${list.slice(0, 50).map((p) => html`${vrcUser(p.userId, p.displayName)} `)}${list.length > 50 ? html` and ${list.length - 50} more` : ''}` : html`<span class="muted">none</span>`
    return page(
        'Bot Blocker - confirm',
        html`<h1>${what}</h1>
            <p>Adds <b>${change.add.length}</b> to the shared list: ${names(change.add)}</p>
            <p>Removes <b>${change.remove.length}</b>: ${names(change.remove)}</p>
            <form method="post" action="${action}">
                ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
                <button class="ok">Apply</button> <a href="/">Cancel</a>
            </form>`
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

// For tests: sign in without the form.
export function testSession(): string {
    const token = randomBytes(32).toString('hex')
    sessions.set(token, Date.now() + 60_000)
    return `${COOKIE}=${token}`
}
