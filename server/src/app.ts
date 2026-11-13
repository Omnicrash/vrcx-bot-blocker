// The plugin-facing API. Plugins run inside VRCX's page, so any origin may call it.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { LIMIT_PER_INSTALL, LIMIT_PER_IP, LIST_PAGE, VERSION } from './config'
import { changesSince, counts, receive } from './reports'
import { loginState } from './vrchat'

export const app = new Hono()
app.use('/v1/*', cors())

const USER_ID = /^usr_[0-9a-f-]{36}$/
const report = z.object({
    install: z.string().regex(/^[0-9a-f-]{36}$/),
    userId: z.string().regex(USER_ID),
    displayName: z.string().max(64),
    grounds: z
        .object({
            name: z.boolean().optional(),
            robot: z.boolean().optional(),
            visitor: z.boolean().optional(),
            bio: z.string().max(100).optional(),
            nuisance: z.boolean().optional(),
            probable: z.boolean().optional(),
            age: z.number().int().min(0).max(100000).optional()
        })
        .strict()
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
    return c.json({ result: receive({ ...r, ip }) })
})

app.get('/v1/list', (c) => {
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0)
    return c.json(changesSince(since, LIST_PAGE))
})

app.get('/healthz', (c) => c.json({ version: VERSION, vrchat: loginState, ...counts() }))
