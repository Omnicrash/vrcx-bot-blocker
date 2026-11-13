// The checks a report's grounds are held to. They mirror the plugin's rules (bot-blocker.js), so
// both judge a player the same way; test/rules.test.ts pins the shared cases.

// What a report says the player was caught on. Almost Nuisance and account age are reported but
// aren't enough for the shared list on their own, since neither is part of the default rule set.
export interface Grounds {
    name?: boolean
    robot?: boolean
    visitor?: boolean
    bio?: string
    nuisance?: boolean
    probable?: boolean
    age?: number
    // A block for being in one of the reporter's groups. Never listed automatically: these wait
    // for a person to approve them on the management page.
    group?: string
    groupId?: string
    reviewed?: boolean
}

// What the server needs before it lists a player, set on the management page. Like the plugin's
// rules: every rule that's on without "always" has to hold, or any rule that's on with "always".
export const RULE_NAMES = ['name', 'robot', 'visitor', 'bio', 'nuisance', 'probable', 'age'] as const
export type RuleName = (typeof RULE_NAMES)[number]
export interface ServerRules {
    rules: Record<RuleName, { on: boolean; always: boolean }>
    ageDays: number
    bioWords: string[]
}

// The defaults match the plugin's default rule set.
export const DEFAULT_RULES: ServerRules = {
    rules: {
        name: { on: true, always: false },
        robot: { on: true, always: false },
        visitor: { on: true, always: false },
        bio: { on: true, always: true },
        nuisance: { on: true, always: true },
        probable: { on: false, always: true },
        age: { on: false, always: true }
    },
    ageDays: 7,
    bioWords: ['hexed.cc']
}

export function meetsRules(g: Grounds, r: ServerRules): boolean {
    const holds = (k: RuleName) => (k === 'age' ? g.age !== undefined && g.age < r.ageDays : !!g[k])
    const on = RULE_NAMES.filter((k) => r.rules[k].on)
    const alone = on.filter((k) => r.rules[k].always)
    const together = on.filter((k) => !r.rules[k].always)
    return alone.some(holds) || (together.length > 0 && together.every(holds))
}

// VRChat's default display name: a word, a space, then the last 4 hex digits of the user id.
export function hasDefaultName(displayName: string, userId: string): boolean {
    const m = /^\S+ ([0-9a-f]{4})$/.exec(displayName || '')
    return !!m && !!userId && userId.toLowerCase().endsWith(m[1]!)
}

// A website also matches the spellings used to get past filters: site(.)cc, site[.]cc,
// site (dot) cc, site dot cc, and spaces around the dot.
const DOT = String.raw`\s*(?:\.|\(\.\)|\[\.\]|\(dot\)|\[dot\]|\bdot\b)\s*`
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function wordPattern(word: string): RegExp {
    const isSite = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(word)
    return new RegExp(isSite ? word.split('.').map(escapeRe).join(DOT) : escapeRe(word), 'i')
}

// The part of a VRChat user the checks look at.
export interface Profile {
    id: string
    displayName: string
    bio?: string
    bioLinks?: string[]
    pronouns?: string
    statusDescription?: string
    iconUrl?: string
    tags?: string[]
    date_joined?: string
}

// The first word from the list the profile's free text mentions, or null. The bots advertise in
// their pronouns as much as in the bio, so every field a player writes is read.
export function bioMention(user: Pick<Profile, 'bio' | 'bioLinks' | 'pronouns' | 'statusDescription'>, words: string[]): string | null {
    const text = [user.bio ?? '', ...(user.bioLinks ?? []), user.pronouns ?? '', user.statusDescription ?? ''].join(' ')
    return words.find((w) => wordPattern(w).test(text)) ?? null
}

// The default Robot avatar's picture. Without a VRChat+ icon of their own, a player's profile
// icon is their current avatar's thumbnail, so this shows who is wearing the Robot right now.
export const ROBOT_ICON = 'file_0e8c4e32-7444-44ea-ade4-313c010d4bae'
export const wearsRobot = (user: Pick<Profile, 'iconUrl'>) => (user.iconUrl ?? '').includes(ROBOT_ICON)

// Re-checks every ground and keeps the ones that hold. Reports sync at once, so the player is
// looked at while still wearing what they were caught in.
export function verifiedGrounds(claimed: Grounds, user: Profile, bioWords: string[]): Grounds {
    const tags = user.tags ?? []
    const out: Grounds = {}
    if (claimed.name && hasDefaultName(user.displayName, user.id)) out.name = true
    if (claimed.robot && wearsRobot(user)) out.robot = true
    if (claimed.visitor && !tags.includes('system_trust_basic')) out.visitor = true
    if (claimed.bio) {
        const word = bioMention(user, bioWords)
        if (word) out.bio = word
    }
    if (claimed.nuisance && tags.includes('system_troll')) out.nuisance = true
    if (claimed.probable && tags.includes('system_probable_troll')) out.probable = true
    if (claimed.age !== undefined && user.date_joined) {
        out.age = Math.max(0, Math.floor((Date.now() - Date.parse(user.date_joined)) / 86_400_000))
    }
    return out
}
