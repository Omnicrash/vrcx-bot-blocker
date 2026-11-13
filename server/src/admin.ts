// The management page: group reports waiting for review, and the shared list itself. It runs on
// its own port that only the LAN can reach, and refuses every address that isn't private.
import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { RULE_NAMES, type RuleName, type Grounds, type ServerRules } from './rules'
import { counts, decide, listed, reviewQueue, saveRules, serverRules, unlist } from './reports'
import { loginState } from './vrchat'

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

const groundsText = (g: Grounds) =>
    Object.entries(g)
        .filter(([k]) => k !== 'groupId' && k !== 'reviewed')
        .map(([k, v]) => (v === true ? k : `${k}: ${v}`))
        .join(', ')
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const RULE_LABELS: Record<RuleName, string> = {
    name: 'Default display name',
    robot: 'Robot avatar',
    visitor: 'Visitor rank',
    bio: 'Bio mentions a word from the list',
    nuisance: 'Nuisance',
    probable: 'Almost Nuisance',
    age: 'Account younger than the days below'
}

export const admin = new Hono()

admin.get('/', (c) => {
    const queue = reviewQueue()
    const entries = listed()
    const n = counts()
    const r = serverRules()
    return c.html(html`<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>Bot Blocker - management</title>
                <style>
                    body { font: 14px system-ui, sans-serif; background: #1e1e1e; color: #e6e6e6; margin: 24px; }
                    h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 28px; color: #aaa; text-transform: uppercase; }
                    table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #333; vertical-align: top; }
                    th { color: #888; font-weight: 500; } a { color: #8ab4f8; } .muted { color: #888; }
                    button { background: #333; color: #e6e6e6; border: 1px solid #555; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
                    button.ok { border-color: #3a7; } button.no { border-color: #b44; } form { display: inline; }
                </style>
            </head>
            <body>
                <h1>Bot Blocker</h1>
                <div class="muted">VRChat login: ${loginState} · listed: ${n.listed} · waiting for a check: ${n.pending} · waiting for review: ${n.review}</div>

                <h2>Acceptance rules</h2>
                <form method="post" action="/rules" class="rules">
                    <table>
                        <tr><th>Rule</th><th>On</th><th title="If on, this rule will apply independently of the rest.">Always</th></tr>
                        ${RULE_NAMES.map(
                            (k) => html`<tr>
                                <td>${RULE_LABELS[k]}</td>
                                <td><input type="checkbox" name="${k}.on" ${r.rules[k].on ? 'checked' : ''} /></td>
                                <td><input type="checkbox" name="${k}.always" ${r.rules[k].always ? 'checked' : ''} /></td>
                            </tr>`
                        )}
                    </table>
                    <p>Account age under <input name="ageDays" type="number" min="1" max="3650" value="${r.ageDays}" style="width:70px" /> days</p>
                    <p>Bio words and sites, one per line<br /><textarea name="bioWords" rows="4" cols="40">${r.bioWords.join('\n')}</textarea></p>
                    <button class="ok">Save</button>
                </form>

                <h2>Group reports to review</h2>
                ${queue.length
                    ? html`<table>
                          <tr><th>Player</th><th>Group</th><th>Reporters</th><th>Also seen</th><th>First report</th><th></th></tr>
                          ${queue.map(
                              (q) => html`<tr>
                                  <td><a href="https://vrchat.com/home/user/${q.userId}" target="_blank">${q.displayName}</a></td>
                                  <td>${q.groups.map((g, i) => html`<a href="https://vrchat.com/home/group/${q.groupIds[i] ?? ''}" target="_blank">${g}</a> `)}</td>
                                  <td>${q.reporters}</td>
                                  <td class="muted">${groundsText({ ...q.grounds, group: undefined } as Grounds)}</td>
                                  <td class="muted">${when(q.firstAt)}</td>
                                  <td>
                                      <form method="post" action="/review/${q.userId}/approve"><button class="ok">Approve</button></form>
                                      <form method="post" action="/review/${q.userId}/reject"><button class="no">Reject</button></form>
                                  </td>
                              </tr>`
                          )}
                      </table>`
                    : html`<div class="muted">Nothing to review.</div>`}

                <h2>Shared list</h2>
                ${entries.length
                    ? html`<table>
                          <tr><th>Player</th><th>Grounds</th><th>Listed</th><th></th></tr>
                          ${entries.map(
                              (e) => html`<tr>
                                  <td><a href="https://vrchat.com/home/user/${e.userId}" target="_blank">${e.displayName}</a></td>
                                  <td class="muted">${groundsText(e.grounds as Grounds)}${(e.grounds as Grounds).reviewed ? raw(' <span title="approved by review">✓</span>') : ''}</td>
                                  <td class="muted">${when(e.addedAt)}</td>
                                  <td><form method="post" action="/unlist/${e.userId}"><button class="no">Remove</button></form></td>
                              </tr>`
                          )}
                      </table>`
                    : html`<div class="muted">Empty.</div>`}
            </body>
        </html>`)
})

admin.post('/rules', async (c) => {
    const form = await c.req.parseBody()
    const next: ServerRules = { rules: { ...serverRules().rules }, ageDays: 7, bioWords: [] }
    for (const k of RULE_NAMES) {
        next.rules[k] = { on: form[`${k}.on`] === 'on', always: form[`${k}.always`] === 'on' }
    }
    next.ageDays = Math.max(1, Math.min(3650, Math.round(Number(form.ageDays)) || 7))
    next.bioWords = [...new Set(String(form.bioWords ?? '').split(/[\n,]/).map((w) => w.trim()).filter(Boolean))]
    saveRules(next)
    return c.redirect('/')
})

admin.post('/review/:userId/:verdict', (c) => {
    const verdict = c.req.param('verdict')
    if (verdict === 'approve' || verdict === 'reject') {
        decide(c.req.param('userId'), verdict === 'approve')
    }
    return c.redirect('/')
})

admin.post('/unlist/:userId', (c) => {
    unlist(c.req.param('userId'))
    return c.redirect('/')
})
