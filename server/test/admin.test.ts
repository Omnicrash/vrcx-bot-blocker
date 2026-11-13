import { expect, test } from 'bun:test'
import { admin, fromDocker, TEST_USER } from '../src/admin'
import { app } from '../src/app'
import { saveRules } from '../src/reports'
import { DEFAULT_RULES } from '../src/rules'
import { users } from './setup'

const ROBOT = 'https://api.vrchat.cloud/api/1/image/file_0e8c4e32-7444-44ea-ade4-313c010d4bae/1/256'
const MEMBER = 'usr_66666666-6666-6666-6666-666666666666'
const GROUP = 'grp_77777777-7777-7777-7777-777777777777'
const NEWBIE = 'usr_88888888-8888-8888-8888-88888888abcd' // default name + new, no Robot
users.set(MEMBER, { id: MEMBER, displayName: 'Scraper', tags: ['system_trust_basic', 'system_trust_known'] })
users.set(NEWBIE, { id: NEWBIE, displayName: 'Glorp abcd', tags: [], date_joined: new Date().toISOString().slice(0, 10), iconUrl: 'x' })

const get = (path: string, headers: Record<string, string> = {}) => admin.request(path, { headers: { ...TEST_USER, Host: 'xdisk:3061', ...headers } })
const form = (path: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    admin.request(path, {
        method: 'POST',
        body: new URLSearchParams(fields),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...TEST_USER, Host: 'xdisk:3061', Origin: 'http://xdisk:3061', 'Sec-Fetch-Site': 'same-origin', ...headers }
    })
const ids = async () => ((await (await app.request('/v1/list?since=0')).json()) as { added: { userId: string; grounds: Record<string, unknown> }[] }).added
const reportPlayer = (userId: string, grounds: object) =>
    app.request('/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install: crypto.randomUUID(), userId, displayName: 'x', grounds }) })

test('only Docker networks reach the management port, not the LAN', () => {
    for (const a of ['172.17.0.1', '172.17.0.5', '127.0.0.1', '::1', '::ffff:172.17.0.9']) {
        expect(fromDocker(a)).toBe(true)
    }
    for (const a of ['192.168.1.20', '10.0.0.5', '8.8.8.8', '172.32.0.1', '::ffff:192.168.1.20', 'fd12:3456::1', undefined]) {
        expect(fromDocker(a)).toBe(false)
    }
})

test('without an OSign user nothing opens', async () => {
    expect((await admin.request('/', { headers: { Host: 'xdisk:3061' } })).status).toBe(401)
    expect((await admin.request('/remove/x', { method: 'POST', headers: { Host: 'xdisk:3061' } })).status).toBe(401)
})

test('a form from the page itself over https is accepted', async () => {
    const res = await form('/remove/x', {}, { Host: 'botblocker.omnicrash.be', Origin: 'https://botblocker.omnicrash.be' })
    expect(res.status).toBe(302)
})

test('a form posted from another site is refused, even with a session', async () => {
    expect((await form('/remove/x', {}, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' })).status).toBe(403)
    expect((await form('/remove/x', {}, { 'Sec-Fetch-Site': 'same-site', Origin: 'http://other.lan' })).status).toBe(403)
})

test('group reports wait for review; an approved one stays whatever the rules say', async () => {
    await reportPlayer(MEMBER, { group: 'Scraper Club', groupId: GROUP })
    await reportPlayer(MEMBER, { group: 'Scraper Club', groupId: GROUP })
    await Bun.sleep(100)
    expect((await ids()).map((e) => e.userId)).not.toContain(MEMBER)
    const page = await (await get('/')).text()
    expect(page).toContain('Scraper Club')
    await form(`/review/${MEMBER}/approve`)
    expect((await ids()).find((e) => e.userId === MEMBER)?.grounds).toEqual({ group: 'Scraper Club', reviewed: true })
})

test('changing the rules shows a preview first, and applies only when confirmed', async () => {
    await reportPlayer(NEWBIE, { name: true, age: 0 })
    await Bun.sleep(150)
    expect((await ids()).map((e) => e.userId)).toContain(NEWBIE) // name + new = 2

    // Require all three signs: the newbie would drop off.
    const strict = { name: 'on', robot: 'on', age: 'on', needed: '3', ageDays: '7' }
    const preview = await (await form('/rules/preview', strict)).text()
    expect(preview).toMatch(/<b>Removes 1\.<\/b>/)
    expect((await ids()).map((e) => e.userId)).toContain(NEWBIE) // nothing applied yet
    await form('/rules/apply', strict)
    const after = (await ids()).map((e) => e.userId)
    expect(after).not.toContain(NEWBIE)
    expect(after).toContain(MEMBER) // the approved group block is a person's decision
    saveRules(DEFAULT_RULES)
    await form('/rules/apply', { name: 'on', robot: 'on', age: 'on', needed: '2', ageDays: '7' })
    expect((await ids()).map((e) => e.userId)).toContain(NEWBIE)
})

test('a word can be added with a preview, and removing one previews too', async () => {
    const p = await (await form('/words/approve/preview', { word: 'scam.example' })).text()
    expect(p).toContain('Approve &quot;scam.example&quot;')
    await form('/words/approve/apply', { word: 'scam.example' })
    expect(await (await get('/')).text()).toContain('scam.example')
    await form('/words/remove/apply', { word: 'scam.example' })
    expect(await (await get('/')).text()).not.toContain('scam.example')
})

test('the robot avatar sign uses the icon: a default-named player in the Robot is listed', async () => {
    const id = 'usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1234'
    users.set(id, { id, displayName: 'Zub 1234', tags: [], iconUrl: ROBOT, date_joined: '2020-01-01' })
    await reportPlayer(id, { name: true, robot: true })
    await Bun.sleep(150)
    expect((await ids()).map((e) => e.userId)).toContain(id)
})
