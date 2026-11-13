import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { app } from '../src/app'
import { db, schema } from '../src/db'
import { recheckSome, reevaluate } from '../src/reports'
import { users } from './setup'

const ROBOT = 'https://api.vrchat.cloud/api/1/image/file_0e8c4e32-7444-44ea-ade4-313c010d4bae/1/256'
const DOOMED = 'usr_dddddddd-0000-0000-0000-00000000dead'
users.set(DOOMED, { id: DOOMED, displayName: 'Krell dead', tags: [], iconUrl: ROBOT, date_joined: new Date().toISOString().slice(0, 10) })

const list = async (since = 0) =>
    (await (await app.request(`/v1/list?since=${since}`)).json()) as { seq: number; added: { userId: string }[]; removed: string[]; gone: string[] }

test('an account VRChat no longer has leaves the list at its re-check, for good', async () => {
    await app.request('/v1/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ install: crypto.randomUUID(), userId: DOOMED, displayName: 'x', grounds: { name: true, robot: true } })
    })
    await Bun.sleep(150)
    const before = await list()
    expect(before.added.map((e) => e.userId)).toContain(DOOMED)

    users.delete(DOOMED) // banned or deleted: VRChat answers 404
    db.update(schema.checks).set({ checkedAt: 0 }).where(eq(schema.checks.userId, DOOMED)).run()
    await recheckSome()
    const after = await list(before.seq)
    expect(after.removed).toContain(DOOMED)
    expect(after.gone).toContain(DOOMED)
    expect(db.select().from(schema.entries).where(eq(schema.entries.userId, DOOMED)).get()?.removedBy).toBe('gone')

    reevaluate() // the rules never put it back from the old check
    expect((await list()).added.map((e) => e.userId)).not.toContain(DOOMED)
})

test('re-checks wait while reports are pending, and only spend spare lookups', async () => {
    const { recheckAllowance } = await import('../src/reports')
    expect(recheckAllowance()).toBeGreaterThan(0)
    db.insert(schema.reports)
        .values({ userId: 'usr_eeeeeeee-0000-0000-0000-00000000eeee', displayName: 'x', grounds: {}, install: 'x', ip: '', receivedAt: Date.now(), outcome: 'pending' })
        .run()
    expect(recheckAllowance()).toBe(0)
    db.delete(schema.reports).where(eq(schema.reports.userId, 'usr_eeeeeeee-0000-0000-0000-00000000eeee')).run()
})
