import { expect, test } from 'bun:test'
import { bioMention, hasDefaultName, meetsMinimum, ROBOT_ICON, verifiedGrounds } from '../src/rules'
import { totp } from '../src/vrchat'

test('default display name ends in the last 4 hex digits of the user id', () => {
    expect(hasDefaultName('Ulvor6ex f478', 'usr_c768200e-f3db-4b7f-90e0-51323b70f478')).toBe(true)
    expect(hasDefaultName('Ulvor6ex f479', 'usr_c768200e-f3db-4b7f-90e0-51323b70f478')).toBe(false)
    expect(hasDefaultName('Some Name f478', 'usr_c768200e-f3db-4b7f-90e0-51323b70f478')).toBe(false)
})

test('bio words: websites match their disguised spellings, keywords match as written', () => {
    const words = ['hexed.cc', 'free robux']
    for (const t of ['hexed.cc', 'HEXED . CC', 'hexed(.)cc', 'hexed[.]cc', 'hexed (dot) cc', 'hexed dot cc']) {
        expect(bioMention({ bio: t }, words)).toBe('hexed.cc')
    }
    for (const t of ['hexedcc', 'hexed.com', 'i got hexed, cc me', 'freerobux']) {
        expect(bioMention({ bio: t }, words)).toBeNull()
    }
    expect(bioMention({ bioLinks: ['https://hexed.cc/x'] }, words)).toBe('hexed.cc')
    expect(bioMention({ pronouns: 'hexed.cc BUY' }, words)).toBe('hexed.cc')
    expect(bioMention({ statusDescription: 'hexed dot cc' }, words)).toBe('hexed.cc')
})

test('the minimum is the default rule set', () => {
    expect(meetsMinimum({ name: true, robot: true, visitor: true })).toBe(true)
    expect(meetsMinimum({ name: true, visitor: true })).toBe(false)
    expect(meetsMinimum({ bio: 'hexed.cc' })).toBe(true)
    expect(meetsMinimum({ nuisance: true })).toBe(true)
    expect(meetsMinimum({ probable: true, age: 1 })).toBe(false)
})

test('only grounds that still hold survive the re-check', () => {
    const all = { name: true, robot: true, visitor: true, bio: 'hexed.cc', nuisance: true }
    const person = { id: 'usr_00000000-0000-0000-0000-00000000f478', displayName: 'Renamed Person', tags: ['system_trust_basic'], bio: 'hi', iconUrl: 'https://api.vrchat.cloud/api/1/image/file_a8a717f8-47bf-4caa-b818-ebc902741dea/1/256' }
    expect(verifiedGrounds(all, person, ['hexed.cc'])).toEqual({})
    const bot = { id: 'usr_00000000-0000-0000-0000-00000000f478', displayName: 'Ulvor6ex f478', tags: [], pronouns: 'hexed.cc BUY', iconUrl: `https://api.vrchat.cloud/api/1/image/${ROBOT_ICON}/1/256` }
    expect(verifiedGrounds(all, bot, ['hexed.cc'])).toEqual({ name: true, robot: true, visitor: true, bio: 'hexed.cc' })
})

test('authenticator codes follow RFC 6238', () => {
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109_000)).toBe('081804')
})
