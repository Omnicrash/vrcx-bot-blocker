import { expect, test } from 'bun:test'
import { app } from '../src/app'
import { removeByHand, setWord } from '../src/reports'
import { calls, users } from './setup'

const ROBOT = 'https://api.vrchat.cloud/api/1/image/file_0e8c4e32-7444-44ea-ade4-313c010d4bae/1/256'
const OTHER_ICON = 'https://api.vrchat.cloud/api/1/image/file_12b39aaf-c132-4156-9251-b63652cb4d79/1/256'
const today = new Date().toISOString().slice(0, 10)

const BOT = 'usr_00000000-0000-0000-0000-00000000f478'
const OLDTIMER = 'usr_11111111-1111-1111-1111-11111111abcd' // default name, years old, not in the Robot
const SELLER = 'usr_22222222-2222-2222-2222-222222222222' // a new site in the pronouns
const GONE = 'usr_44444444-4444-4444-4444-444444444444'
users.set(BOT, { id: BOT, displayName: 'Ulvor6ex f478', tags: [], iconUrl: ROBOT, date_joined: today })
users.set(OLDTIMER, { id: OLDTIMER, displayName: 'Plimb abcd', tags: [], iconUrl: OTHER_ICON, date_joined: '2021-01-01' })
users.set(SELLER, { id: SELLER, displayName: 'Seller', pronouns: 'cheap at shady(.)shop', tags: ['system_trust_basic'], iconUrl: OTHER_ICON, date_joined: '2020-01-01' })

const install = () => crypto.randomUUID()
const post = (body: unknown, ip = '203.0.113.1') =>
    app.request('/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) })
const report = async (userId: string, grounds: object, caughtBy?: unknown) => {
    const res = await post({ install: install(), userId, displayName: 'x', grounds, caughtBy })
    return ((await res.json()) as { result?: string }).result ?? `HTTP ${res.status}`
}
const list = async (since = 0) =>
    (await (await app.request(`/v1/list?since=${since}`)).json()) as { seq: number; added: { userId: string; grounds: Record<string, unknown> }[]; removed: string[] }
const ids = async () => (await list()).added.map((e) => e.userId)
const lookups = (id: string) => calls.filter((c) => c === `GET /api/1/users/${id}`).length
const settle = () => Bun.sleep(150)

test('a bot is looked up once and listed with every sign that held', async () => {
    expect(await report(BOT, { name: true, robot: true, visitor: true, age: 0 }, { together: ['name', 'robot', 'visitor'] })).toBe('queued')
    await settle()
    const entry = (await list()).added.find((e) => e.userId === BOT)
    expect(entry?.grounds).toEqual({ name: true, robot: true, visitor: true, age: 0 })
    expect(calls).toContain('POST /api/1/auth/twofactorauth/totp/verify')
})

test('repeat reports reuse the stored check: no second lookup', async () => {
    const before = lookups(BOT)
    expect(await report(BOT, { name: true, robot: true })).toBe('known')
    expect(await report(BOT, { name: true, robot: true })).toBe('known')
    await settle()
    expect(lookups(BOT)).toBe(before)
})

test('one sign is not enough, whatever the reporter claims', async () => {
    expect(await report(OLDTIMER, { name: true, robot: true })).toBe('queued') // claims the Robot
    expect(await report(GONE, { name: true, robot: true })).toBe('queued')
    await settle()
    expect(await ids()).not.toContain(OLDTIMER)
    expect(await ids()).not.toContain(GONE)
})

test('a new word waits for approval; approving it lists the player without a new lookup', async () => {
    expect(await report(SELLER, { bio: 'shady.shop' })).toBe('queued')
    await settle()
    expect(await ids()).not.toContain(SELLER)
    const before = lookups(SELLER)
    setWord('shady.shop', 'approved')
    const { reevaluate } = await import('../src/reports')
    expect(reevaluate().added).toBe(1)
    expect(await ids()).toContain(SELLER)
    expect(lookups(SELLER)).toBe(before)
})

test('a hand removal sticks: new reports do not put the player back', async () => {
    removeByHand(BOT)
    expect(await report(BOT, { name: true, robot: true })).toBe('known')
    await settle()
    expect(await ids()).not.toContain(BOT)
    expect((await list(0)).removed).toContain(BOT)
})

test("an older plugin's extra grounds are dropped, not refused", async () => {
    expect(await report(OLDTIMER, { name: true, robot: true, nuisance: true, probable: true })).not.toMatch(/HTTP/)
})

test('below the rules is refused without a lookup', async () => {
    expect(await report('usr_99999999-9999-9999-9999-999999999999', { name: true, visitor: true })).toBe('below minimum')
    expect(lookups('usr_99999999-9999-9999-9999-999999999999')).toBe(0)
})

test('malformed reports and floods are turned away', async () => {
    expect((await post({ install: 'nope', userId: BOT, displayName: 'x', grounds: {} })).status).toBe(400)
    const one = install()
    const statuses = []
    for (let i = 0; i < 7; i++) {
        statuses.push((await post({ install: one, userId: BOT, displayName: 'x', grounds: { name: true, robot: true } }, '198.51.100.9')).status)
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
})

test('the stream tells a plugin about changes as they happen', async () => {
    const res = await app.request('/v1/stream')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: change')
    setWord('shady.shop', 'removed')
    const { reevaluate } = await import('../src/reports')
    reevaluate()
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain('event: change')
    await reader.cancel()
})

test('rules and health for plugins and monitoring; cross-origin allowed', async () => {
    const rules = (await (await app.request('/v1/rules')).json()) as { counted: Record<string, boolean>; needed: number }
    expect(rules.needed).toBe(2)
    expect(rules.counted).toEqual({ name: true, robot: true, visitor: false, age: true })
    const res = await app.request('/v1/list', { headers: { Origin: 'file://vrcx' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const h = (await (await app.request('/healthz')).json()) as { vrchat: string; lookups: { usedToday: number } }
    expect(h.vrchat).toBe('ok')
    expect(h.lookups.usedToday).toBeGreaterThan(0)
})
