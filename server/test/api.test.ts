import { expect, test } from 'bun:test'
import { app } from '../src/app'
import { unlist } from '../src/reports'
import { calls, users } from './setup'

const BOT = 'usr_00000000-0000-0000-0000-00000000f478'
const HEXER = 'usr_11111111-1111-1111-1111-111111111111'
const TROLL = 'usr_22222222-2222-2222-2222-222222222222'
const LIAR = 'usr_33333333-3333-3333-3333-333333333333'
const GONE = 'usr_44444444-4444-4444-4444-444444444444'
const ROBOT = 'https://api.vrchat.cloud/api/1/image/file_0e8c4e32-7444-44ea-ade4-313c010d4bae/1/256'
const NEWCOMER = 'usr_55555555-5555-5555-5555-55555555abcd'
users.set(BOT, { id: BOT, displayName: 'Ulvor6ex f478', tags: [], iconUrl: ROBOT })
users.set(NEWCOMER, { id: NEWCOMER, displayName: 'Plimb abcd', tags: [], iconUrl: 'https://api.vrchat.cloud/api/1/image/file_12b39aaf-c132-4156-9251-b63652cb4d79/1/256' })
users.set(HEXER, { id: HEXER, displayName: 'Hexer', bio: 'cheats at hexed(.)cc', tags: ['system_trust_basic', 'system_trust_known'] })
users.set(TROLL, { id: TROLL, displayName: 'Troll', tags: ['system_trust_basic', 'system_troll'] })
users.set(LIAR, { id: LIAR, displayName: 'Real Person', tags: ['system_trust_basic'] })

const install = () => crypto.randomUUID()
const post = (body: unknown, ip = '203.0.113.1') =>
    app.request('/v1/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify(body)
    })
const report = async (userId: string, grounds: object, displayName = 'x', inst = install()) =>
    (await (await post({ install: inst, userId, displayName, grounds })).json()) as { result?: string; error?: string }
const list = async (since = 0) => (await (await app.request(`/v1/list?since=${since}`)).json()) as {
    seq: number
    more: boolean
    added: { userId: string; grounds: Record<string, unknown> }[]
    removed: string[]
}
const settle = () => Bun.sleep(150)

test('reports that hold up go on the shared list, with the grounds that held', async () => {
    expect((await report(BOT, { name: true, robot: true, visitor: true })).result).toBe('queued')
    expect((await report(HEXER, { bio: 'hexed.cc' })).result).toBe('queued')
    expect((await report(TROLL, { nuisance: true })).result).toBe('queued')
    await settle()
    const l = await list()
    const by = Object.fromEntries(l.added.map((e) => [e.userId, e.grounds]))
    expect(by[BOT]).toEqual({ name: true, robot: true, visitor: true })
    expect(by[HEXER]).toEqual({ bio: 'hexed.cc' })
    expect(by[TROLL]).toEqual({ nuisance: true })
    expect(calls).toContain('POST /api/1/auth/twofactorauth/totp/verify')
})

test('claims that do not hold up are rejected', async () => {
    expect((await report(LIAR, { name: true, robot: true, visitor: true })).result).toBe('queued')
    expect((await report(LIAR, { bio: 'hexed.cc' })).result).toBe('queued')
    expect((await report(GONE, { nuisance: true })).result).toBe('queued')
    // A real newcomer with a default name, falsely reported as wearing the Robot.
    expect((await report(NEWCOMER, { name: true, robot: true, visitor: true })).result).toBe('queued')
    await settle()
    const ids = (await list()).added.map((e) => e.userId)
    expect(ids).not.toContain(LIAR)
    expect(ids).not.toContain(GONE)
    expect(ids).not.toContain(NEWCOMER)
})

test('below the minimum is refused without a lookup, a second report of a listed player is known', async () => {
    expect((await report(LIAR, { name: true, visitor: true })).result).toBe('below minimum')
    expect((await report(BOT, { name: true, robot: true, visitor: true })).result).toBe('known')
})

test('sync hands over only what changed, removals included', async () => {
    const first = await list()
    expect((await list(first.seq)).added).toEqual([])
    unlist(TROLL)
    const next = await list(first.seq)
    expect(next.removed).toEqual([TROLL])
    expect(next.seq).toBeGreaterThan(first.seq)
})

test('malformed reports and floods are turned away', async () => {
    expect((await post({ install: 'nope', userId: BOT, displayName: 'x', grounds: {} })).status).toBe(400)
    expect((await post({ install: install(), userId: BOT, displayName: 'x', grounds: { evil: true } })).status).toBe(400)
    const one = install()
    const statuses = []
    for (let i = 0; i < 7; i++) {
        statuses.push((await post({ install: one, userId: BOT, displayName: 'x', grounds: { nuisance: true } }, '198.51.100.9')).status)
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
})

test('cross-origin calls from VRCX are allowed', async () => {
    const res = await app.request('/v1/list', { headers: { Origin: 'file://vrcx' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
})

test('health shows the VRChat login and the counts', async () => {
    const h = (await (await app.request('/healthz')).json()) as { vrchat: string; listed: number }
    expect(h.vrchat).toBe('ok')
    expect(h.listed).toBe(2)
})
