import { expect, test } from 'bun:test'
import { DEFAULT_RULES, type Facts, factsOf, hasDefaultName, judge, mention, ROBOT_ICON, worthReporting } from '../src/rules'
import { totp } from '../src/vrchat'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-13T12:00:00Z')
const facts = (f: Partial<Facts>): Facts => ({ displayName: 'x', name: false, robot: false, visitor: false, joinedAt: NOW - 400 * DAY, text: '', ...f })
const listed = (f: Partial<Facts>, words = ['hexed.cc']) => judge(facts(f), NOW, DEFAULT_RULES, words).listed

test('default display name ends in the last 4 hex digits of the user id', () => {
    expect(hasDefaultName('Ulvor6ex f478', 'usr_c768200e-f3db-4b7f-90e0-51323b70f478')).toBe(true)
    expect(hasDefaultName('Ulvor6ex f479', 'usr_c768200e-f3db-4b7f-90e0-51323b70f478')).toBe(false)
    expect(hasDefaultName('Some Name f478', 'usr_c768200e-f3db-4b7f-90e0-51323b70f478')).toBe(false)
})

test('words: websites match their disguised spellings, keywords match as written', () => {
    const words = ['hexed.cc', 'free robux']
    for (const t of ['hexed.cc', 'HEXED . CC', 'hexed(.)cc', 'hexed[.]cc', 'hexed (dot) cc', 'hexed [dot] cc', 'hexed dot cc']) {
        expect(mention(t, words)).toBe('hexed.cc')
    }
    for (const t of ['hexedcc', 'hexed.com', 'i got hexed, cc me', 'freerobux']) {
        expect(mention(t, words)).toBeNull()
    }
})

test('the profile text covers bio, links, pronouns and status; the Robot comes from the icon', () => {
    const f = factsOf({
        id: 'usr_00000000-0000-0000-0000-00000000f478',
        displayName: 'Ulvor6ex f478',
        pronouns: 'hexed.cc BUY',
        statusDescription: 'hi',
        bioLinks: ['https://x.y'],
        iconUrl: `https://api.vrchat.cloud/api/1/image/${ROBOT_ICON}/1/256`,
        tags: [],
        date_joined: '2026-11-12'
    })
    expect(f).toMatchObject({ name: true, robot: true, visitor: true })
    expect(mention(f.text, ['hexed.cc'])).toBe('hexed.cc')
})

test('2 of default name, Robot and new account; Visitor rank does not count by default', () => {
    const fresh = NOW - 1 * DAY
    expect(listed({ robot: true, joinedAt: fresh })).toBe(true) // Robot + new
    expect(listed({ name: true, joinedAt: fresh })).toBe(true) // name + new
    expect(listed({ name: true, robot: true })).toBe(true) // name + Robot
    expect(listed({ name: true })).toBe(false)
    expect(listed({ name: true, visitor: true })).toBe(false)
    expect(listed({ joinedAt: fresh, visitor: true })).toBe(false)
    expect(listed({ text: 'buy at hexed dot cc' })).toBe(true) // an approved word alone
    expect(listed({ text: 'buy at hexed dot cc' }, [])).toBe(false) // not approved: nothing
})

test('account age is taken from when the server first saw the player, not today', () => {
    const f = facts({ name: true, joinedAt: NOW - 2 * DAY })
    expect(judge(f, NOW, DEFAULT_RULES, []).listed).toBe(true)
    expect(judge(f, NOW, DEFAULT_RULES, []).grounds.age).toBe(2)
})

test('a report is worth a lookup on the same rules, or any word at all', () => {
    expect(worthReporting({ name: true, robot: true }, DEFAULT_RULES)).toBe(true)
    expect(worthReporting({ name: true, age: 3 }, DEFAULT_RULES)).toBe(true)
    expect(worthReporting({ name: true, visitor: true }, DEFAULT_RULES)).toBe(false)
    expect(worthReporting({ bio: 'some new site.com' }, DEFAULT_RULES)).toBe(true)
})

test('authenticator codes follow RFC 6238', () => {
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109_000)).toBe('081804')
})
