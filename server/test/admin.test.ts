import { expect, test } from 'bun:test'
import { admin, isPrivate } from '../src/admin'
import { saveRules } from '../src/reports'
import { DEFAULT_RULES } from '../src/rules'
import { app } from '../src/app'
import { users } from './setup'

const MEMBER = 'usr_66666666-6666-6666-6666-666666666666'
const GROUP = 'grp_77777777-7777-7777-7777-777777777777'
users.set(MEMBER, { id: MEMBER, displayName: 'Scraper', tags: ['system_trust_basic', 'system_trust_known'] })

const groupReport = () =>
    app.request('/v1/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ install: crypto.randomUUID(), userId: MEMBER, displayName: 'Scraper', grounds: { group: 'Scraper Club', groupId: GROUP } })
    })
const listIds = async () => ((await (await app.request('/v1/list?since=0')).json()) as { added: { userId: string; grounds: Record<string, unknown> }[] }).added

test('only private addresses reach the management page', () => {
    for (const a of ['192.168.1.20', '10.0.0.5', '172.17.0.1', '127.0.0.1', '::1', '::ffff:192.168.1.20', 'fd12:3456::1']) {
        expect(isPrivate(a)).toBe(true)
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '213.219.143.117', '2a02:181f:1::1', undefined]) {
        expect(isPrivate(a)).toBe(false)
    }
})

test('group reports wait for review and are listed only once approved', async () => {
    expect(((await (await groupReport()).json()) as { result: string }).result).toBe('review')
    await groupReport()
    await Bun.sleep(150)
    expect((await listIds()).map((e) => e.userId)).not.toContain(MEMBER)

    const page = await (await admin.request('/')).text()
    expect(page).toContain('Scraper Club')
    expect(page).toMatch(/<td>2<\/td>/) // two installs reported them

    await admin.request(`/review/${MEMBER}/approve`, { method: 'POST' })
    const entry = (await listIds()).find((e) => e.userId === MEMBER)
    expect(entry?.grounds).toEqual({ group: 'Scraper Club', reviewed: true })
    expect(await (await admin.request('/')).text()).toContain('Nothing to review.')
})

test('a listed player can be taken off the list from the page', async () => {
    await admin.request(`/unlist/${MEMBER}`, { method: 'POST' })
    expect((await listIds()).map((e) => e.userId)).not.toContain(MEMBER)
})

test('acceptance rules are saved from the page and served to plugins', async () => {
    const form = new URLSearchParams({ 'name.on': 'on', 'probable.on': 'on', 'probable.always': 'on', ageDays: '3', bioWords: 'hexed.cc\nfree robux' })
    await admin.request('/rules', { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    const served = (await (await app.request('/v1/rules')).json()) as { rules: Record<string, { on: boolean; always: boolean }>; ageDays: number }
    expect(served.rules.probable).toEqual({ on: true, always: true })
    expect(served.rules.robot!.on).toBe(false)
    expect(served.ageDays).toBe(3)
    expect(await (await admin.request('/')).text()).toContain('free robux')
    saveRules(DEFAULT_RULES) // the other test files share this database
})
