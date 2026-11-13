// The server's own checks. Reports only tell it whom to look at; whether a player goes on the
// shared list is decided from what the server itself saw (a Check) and the acceptance rules set on
// the management page. The plugin mirrors worthReporting() so it only sends what can be listed.

// What a report says the reporter saw. Unknown keys (an older plugin's `nuisance`) are dropped.
export interface Grounds {
    name?: boolean
    robot?: boolean
    visitor?: boolean
    bio?: string
    age?: number
    // A block for being in one of the reporter's groups: never listed automatically, a person
    // approves or rejects it on the management page.
    group?: string
    groupId?: string
    reviewed?: boolean
}

// What the server saw when it looked a player up. Kept forever, so changed rules can be applied
// to everyone again without asking VRChat a second time.
export interface Facts {
    displayName: string
    name: boolean
    robot: boolean
    visitor: boolean
    joinedAt: number | null
    text: string // bio, bio links, pronouns and status: where the words are looked for
}

// The acceptance rules: at least `needed` of the counted signs, or an approved word anywhere in
// the profile text. Account age counts as it was when the server first saw the player, so an
// entry doesn't fall off the list just because the bot account grew older.
export const SIGNS = ['name', 'robot', 'visitor', 'age'] as const
export type Sign = (typeof SIGNS)[number]
export interface ServerRules {
    counted: Record<Sign, boolean>
    needed: number
    ageDays: number
}

export const DEFAULT_RULES: ServerRules = {
    counted: { name: true, robot: true, visitor: false, age: true },
    needed: 2,
    ageDays: 7
}
export const DEFAULT_WORDS = ['hexed.cc']

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

// The first word from the list a text mentions, or null.
export function mention(text: string, words: string[]): string | null {
    return words.find((w) => wordPattern(w).test(text)) ?? null
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

// The default Robot avatar's picture (its own avatar record uses this file). Without a VRChat+
// icon of their own, a player's profile icon is their current avatar's thumbnail.
export const ROBOT_ICON = 'file_0e8c4e32-7444-44ea-ade4-313c010d4bae'

export function factsOf(user: Profile): Facts {
    const joined = user.date_joined ? Date.parse(user.date_joined) : NaN
    return {
        displayName: user.displayName,
        name: hasDefaultName(user.displayName, user.id),
        robot: (user.iconUrl ?? '').includes(ROBOT_ICON),
        visitor: !(user.tags ?? []).includes('system_trust_basic'),
        joinedAt: Number.isFinite(joined) ? joined : null,
        text: [user.bio ?? '', ...(user.bioLinks ?? []), user.pronouns ?? '', user.statusDescription ?? ''].join(' ')
    }
}

// Account age in whole days when the server first saw the player.
export const ageWhenSeen = (f: Facts, firstSeenAt: number) =>
    f.joinedAt === null ? null : Math.max(0, Math.floor((firstSeenAt - f.joinedAt) / 86_400_000))

// Whether what the server saw lists the player, and the grounds that go out with the entry:
// every sign that held, so each plugin can still apply its own rules to it.
export function judge(f: Facts, firstSeenAt: number, r: ServerRules, words: string[]): { listed: boolean; grounds: Grounds } {
    const age = ageWhenSeen(f, firstSeenAt)
    const holds: Record<Sign, boolean> = { name: f.name, robot: f.robot, visitor: f.visitor, age: age !== null && age < r.ageDays }
    const grounds: Grounds = {}
    if (f.name) grounds.name = true
    if (f.robot) grounds.robot = true
    if (f.visitor) grounds.visitor = true
    if (age !== null) grounds.age = age
    const word = mention(f.text, words)
    if (word) grounds.bio = word
    const count = SIGNS.filter((s) => r.counted[s] && holds[s]).length
    return { listed: count >= r.needed || !!word, grounds }
}

// Whether a report is worth a lookup: the same rules on what the reporter saw. Any word counts,
// since a word the server doesn't know yet goes to review.
export function worthReporting(g: Grounds, r: ServerRules): boolean {
    const claimed: Record<Sign, boolean> = {
        name: !!g.name,
        robot: !!g.robot,
        visitor: !!g.visitor,
        age: g.age !== undefined && g.age < r.ageDays
    }
    return SIGNS.filter((s) => r.counted[s] && claimed[s]).length >= r.needed || !!g.bio
}
