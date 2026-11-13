// The plugin-facing API. Plugins run inside VRCX's page, so any origin may call it.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { LIMIT_PER_INSTALL, LIMIT_PER_IP, LIST_PAGE, VERSION } from './config'
import { changesSince, clearedAmong, counts, currentSeq, onChange, receive, serverRules, streams } from './reports'
import { budget, loginState } from './vrchat'

export const app = new Hono()
app.use('/v1/*', cors())

const USER_ID = /^usr_[0-9a-f-]{36}$/
// Unknown grounds (an older plugin's `nuisance`) are dropped, not refused: a refusal makes the
// plugin throw the report away.
const report = z.object({
    install: z.string().regex(/^[0-9a-f-]{36}$/),
    userId: z.string().regex(USER_ID),
    displayName: z.string().max(64),
    grounds: z.object({
        name: z.boolean().optional(),
        robot: z.boolean().optional(),
        visitor: z.boolean().optional(),
        bio: z.string().max(100).optional(),
        age: z.number().int().min(0).max(100000).optional(),
        group: z.string().max(100).optional(),
        groupId: z.string().regex(/^grp_[0-9a-f-]{36}$/).optional()
    }),
    // Which of the reporter's own rules caught the player: research data, never a decision.
    caughtBy: z.unknown().optional()
})

// Reports per hour, counted in memory: a restart forgets, which is fine for a limit.
const hits = new Map<string, number[]>()
function overLimit(key: string, limit: number): boolean {
    const hourAgo = Date.now() - 3_600_000
    const recent = (hits.get(key) ?? []).filter((t) => t > hourAgo)
    recent.push(Date.now())
    hits.set(key, recent)
    return recent.length > limit
}
setInterval(() => {
    const hourAgo = Date.now() - 3_600_000
    for (const [k, v] of hits) {
        if (!v.some((t) => t > hourAgo)) {
            hits.delete(k)
        }
    }
}, 600_000).unref()

// Cloudflare puts the visitor's address in CF-Connecting-IP; locally there is none.
const addressOf = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

app.post('/v1/reports', async (c) => {
    const parsed = report.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
        return c.json({ error: 'bad report' }, 400)
    }
    const r = parsed.data
    const ip = addressOf(c)
    if (overLimit(`i:${r.install}`, LIMIT_PER_INSTALL) || overLimit(`a:${ip}`, LIMIT_PER_IP)) {
        return c.json({ error: 'too many reports' }, 429)
    }
    const caughtBy = JSON.stringify(r.caughtBy ?? null).length <= 2000 ? r.caughtBy : null
    return c.json({ result: receive({ ...r, caughtBy }) })
})

// Which of the sender's own blocks (as hashes) the list cleared as real players. Answers only
// about hashes sent, so the whitelist can't be fetched; checking someone takes their user id
// already. Capped per address, so it can't be used to sweep a large set of ids. Not stored.
const CLEARED_PER_HOUR = 5000
const clearedAsked = new Map<string, { at: number; n: number }[]>()
app.post('/v1/cleared', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null
    const hashes = Array.isArray(body?.hashes) ? body.hashes : null
    if (!hashes || hashes.length > 1000 || !hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{32}$/.test(h))) {
        return c.json({ error: 'bad request' }, 400)
    }
    const key = addressOf(c)
    const hourAgo = Date.now() - 3_600_000
    const recent = (clearedAsked.get(key) ?? []).filter((r) => r.at > hourAgo)
    if (recent.reduce((n, r) => n + r.n, 0) + hashes.length > CLEARED_PER_HOUR) {
        return c.json({ error: 'too many' }, 429)
    }
    recent.push({ at: Date.now(), n: hashes.length })
    clearedAsked.set(key, recent)
    return c.json({ cleared: clearedAmong(hashes as string[]) })
})
setInterval(() => {
    const hourAgo = Date.now() - 3_600_000
    for (const [k, v] of clearedAsked) {
        if (!v.some((r) => r.at > hourAgo)) {
            clearedAsked.delete(k)
        }
    }
}, 600_000).unref()

app.get('/v1/list', (c) => {
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0)
    return c.json(changesSince(since, LIST_PAGE))
})

// What the server accepts, so plugins only report what can be listed.
app.get('/v1/rules', (c) => c.json(serverRules()))

// Pushes a 'change' event with the list's latest number the moment it changes, so plugins
// don't have to poll. A comment every 30 s keeps Cloudflare and NPMplus from closing it.
app.get('/v1/stream', (c) => {
    c.header('X-Accel-Buffering', 'no')
    c.header('Cache-Control', 'no-cache')
    return streamSSE(c, async (stream) => {
        let alive = true
        const off = onChange((seq) => void stream.writeSSE({ event: 'change', data: String(seq) }))
        stream.onAbort(() => {
            alive = false
            off()
        })
        await stream.writeSSE({ event: 'change', data: String(currentSeq()) })
        while (alive) {
            await stream.sleep(30_000)
            if (alive) {
                await stream.write(': keep-alive\n\n')
            }
        }
    })
})

app.get('/healthz', (c) => c.json({ version: VERSION, vrchat: loginState, ...counts(), streams: streams(), lookups: budget() }))
