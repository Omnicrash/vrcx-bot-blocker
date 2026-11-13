import { expect, test } from 'bun:test'
import { admin, TEST_USER } from '../src/admin'
import { app } from '../src/app'
import { db, schema } from '../src/db'
import { hash } from '../src/reports'
import { users } from './setup'
import { eq } from 'drizzle-orm'

const ROBOT = 'https://api.vrchat.cloud/api/1/image/file_0e8c4e32-7444-44ea-ade4-313c010d4bae/1/256'
const REAL = 'usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb5678' // a real newcomer caught by the signs
const GROUPIE = 'usr_cccccccc-cccc-cccc-cccc-cccccccccccc'
users.set(REAL, { id: REAL, displayName: 'Newbie 5678', tags: [], iconUrl: ROBOT, date_joined: new Date().toISOString().slice(0, 10), bio: 'hi i am new' })
users.set(GROUPIE, { id: GROUPIE, displayName: 'Groupie', tags: ['system_trust_basic'] })

const reportPlayer = (userId: string, grounds: object) =>
    app.request('/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install: crypto.randomUUID(), userId, displayName: 'x', grounds }) })
const api = (path: string, body?: object, token = 'review-test-token') =>
    admin.request(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Host: 'xdisk:3061' }, body: body ? JSON.stringify(body) : undefined })
const list = async (since = 0) => (await (await app.request(`/v1/list?since=${since}`)).json()) as { seq: number; added: { userId: string }[]; whitelistSeq: number }

test('whitelisting takes a player off the list and deletes everything stored about them', async () => {
    await reportPlayer(REAL, { name: true, robot: true })
    await Bun.sleep(150)
    const before = await list()
    expect(before.added.map((e) => e.userId)).toContain(REAL)

        await admin.request(`/whitelist/${REAL}`, { method: 'POST', headers: { ...TEST_USER, Host: 'xdisk:3061', Origin: 'http://xdisk:3061', 'Sec-Fetch-Site': 'same-origin' } })
    const after = await list(before.seq)
    expect(after.whitelistSeq).toBeGreaterThan(0)
    expect(JSON.stringify(after)).not.toContain(hash(REAL)) // the whitelist itself never goes out
    expect(JSON.stringify(await list())).not.toContain(hash(REAL))
    const ask = async (hashes: string[]) =>
        (await (await app.request('/v1/cleared', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes }) })).json()) as { cleared: string[] }
    expect((await ask([hash(REAL), hash(GROUPIE)])).cleared).toEqual([hash(REAL)])
    expect((await ask([])).cleared).toEqual([])
    expect((await list()).added.map((e) => e.userId)).not.toContain(REAL)
    expect(db.select().from(schema.reports).where(eq(schema.reports.userId, REAL)).all()).toEqual([])
    expect(db.select().from(schema.checks).where(eq(schema.checks.userId, REAL)).all()).toEqual([])
    expect(JSON.stringify(db.select().from(schema.whitelist).all())).not.toContain(REAL)
})

test('new reports about a whitelisted player are dropped unread', async () => {
    const res = (await (await reportPlayer(REAL, { name: true, robot: true })).json()) as { result: string }
    expect(res.result).toBe('whitelisted')
    expect(db.select().from(schema.reports).where(eq(schema.reports.userId, REAL)).all()).toEqual([])
})

test('the review API wants its token', async () => {
    expect((await api('/api/review', undefined, 'wrong')).status).toBe(401)
    expect((await api('/api/review')).status).toBe(200)
})

test('the review sees new items, can decide clear group cases and recommend the rest', async () => {
    await reportPlayer(GROUPIE, { group: 'Totally Legit Cheats', groupId: 'grp_dddddddd-dddd-dddd-dddd-dddddddddddd' })
    const items = (await (await api('/api/review')).json()) as { groups: { userId: string }[]; listed: unknown[] }
    expect(items.groups.map((g) => g.userId)).toContain(GROUPIE)

    await api(`/api/groups/${GROUPIE}`, { verdict: 'approve', reasoning: 'Sells cheats.', decide: false })
        const page = await (await admin.request('/', { headers: { ...TEST_USER, Host: 'xdisk:3061' } })).text()
    expect(page).toContain('Review suggests <b>approve</b>: Sells cheats.')

    await api(`/api/groups/${GROUPIE}`, { verdict: 'approve', decide: true })
    expect((await list()).added.map((e) => e.userId)).toContain(GROUPIE)

    await api('/api/review/done', {})
    const later = (await (await api('/api/review')).json()) as { listed: unknown[]; groups: unknown[] }
    expect(later.listed).toEqual([])
    expect(later.groups).toEqual([])
})
