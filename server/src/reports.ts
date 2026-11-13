// Takes reports in, looks each player up once, and keeps the shared list in line with the
// acceptance rules. A lookup is reused for good; only listed entries are re-checked, slowly.
import { createHash } from 'node:crypto'
import { and, asc, count, desc, eq, gt, inArray, lt, max, ne, sql } from 'drizzle-orm'
import { BIO_WORDS, RECHECK_AFTER_DAYS, RECHECK_PER_HOUR } from './config'
import { db, schema, sqlite } from './db'
import { DEFAULT_RULES, DEFAULT_WORDS, type Facts, type Grounds, factsOf, judge, type ServerRules, worthReporting } from './rules'
import { getUser } from './vrchat'

const { reports, entries, settings, checks, words, whitelist, recommendations } = schema

// Install ids and addresses are kept only as hashes.
export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

// ---- rules and words ---------------------------------------------------------------------------

export function serverRules(): ServerRules {
    const saved = (db.select().from(settings).where(eq(settings.key, 'rules')).get()?.value ?? {}) as Partial<ServerRules>
    return {
        counted: { ...DEFAULT_RULES.counted, ...(saved.counted ?? {}) },
        needed: saved.needed ?? DEFAULT_RULES.needed,
        ageDays: saved.ageDays ?? DEFAULT_RULES.ageDays
    }
}

export function saveRules(r: ServerRules) {
    db.insert(settings).values({ key: 'rules', value: r }).onConflictDoUpdate({ target: settings.key, set: { value: r } }).run()
}

// The approved words, seeded once from VAPI_BIO_WORDS (or the default) while the table is empty.
export function approvedWords(): string[] {
    if (!db.select({ n: count() }).from(words).get()?.n) {
        for (const word of BIO_WORDS.length ? BIO_WORDS : DEFAULT_WORDS) {
            db.insert(words).values({ word, status: 'approved', firstAt: Date.now() }).onConflictDoNothing().run()
        }
    }
    return db.select().from(words).where(eq(words.status, 'approved')).all().map((w) => w.word)
}

export function wordsByStatus() {
    approvedWords()
    const all = db.select().from(words).orderBy(asc(words.firstAt)).all()
    const reportsFor = (w: string) =>
        db.select({ n: count() }).from(reports).where(sql`json_extract(${reports.grounds}, '$.bio') = ${w}`).get()?.n ?? 0
    return {
        approved: all.filter((w) => w.status === 'approved').map((w) => w.word),
        pending: all.filter((w) => w.status === 'pending').map((w) => ({ word: w.word, reports: reportsFor(w.word) })),
        rejected: all.filter((w) => w.status === 'rejected').map((w) => w.word)
    }
}

export function setWord(word: string, status: 'approved' | 'rejected' | 'removed') {
    const w = word.trim()
    if (!w) {
        return
    }
    if (status === 'removed') {
        db.delete(words).where(eq(words.word, w)).run()
        return
    }
    db.insert(words).values({ word: w, status, firstAt: Date.now() }).onConflictDoUpdate({ target: words.word, set: { status } }).run()
}

// A word a plugin found that the server has never seen: it waits for a person.
function noteWord(word: string | undefined) {
    if (word && word.length <= 100) {
        approvedWords() // seeds the defaults first, so they aren't mistaken for new words
        db.insert(words).values({ word, status: 'pending', firstAt: Date.now() }).onConflictDoNothing().run()
    }
}

// ---- change signal -----------------------------------------------------------------------------

// The plugins' open streams, told the moment the list changes.
const listeners = new Set<(seq: number) => void>()
export function onChange(fn: (seq: number) => void) {
    listeners.add(fn)
    return () => {
        listeners.delete(fn)
    }
}
function changed() {
    const seq = currentSeq()
    for (const fn of listeners) {
        try {
            fn(seq)
        } catch {}
    }
}
export const streams = () => listeners.size

// ---- the list ----------------------------------------------------------------------------------

export function currentSeq(): number {
    const e = db.select({ m: max(entries.seq) }).from(entries).get()?.m ?? 0
    const w = db.select({ m: max(whitelist.seq) }).from(whitelist).get()?.m ?? 0
    return Math.max(e, w)
}

const isWhitelisted = (userId: string) => !!db.select().from(whitelist).where(eq(whitelist.hash, hash(userId))).get()

// Clears a player as a real person: off the list for every plugin, and everything stored about
// them deleted. Only the hash stays, so later reports about them are dropped on arrival.
export function whitelistPlayer(userId: string) {
    sqlite.transaction(() => {
        // Numbered before the entry goes: if it held the highest number, plugins that already
        // synced past it would otherwise never hear about the whitelisting.
        const seq = currentSeq() + 1
        db.delete(entries).where(eq(entries.userId, userId)).run()
        db.delete(reports).where(eq(reports.userId, userId)).run()
        db.delete(checks).where(eq(checks.userId, userId)).run()
        db.delete(recommendations).where(eq(recommendations.key, `group:${userId}`)).run()
        db.insert(whitelist).values({ hash: hash(userId), seq, at: Date.now() }).onConflictDoUpdate({ target: whitelist.hash, set: { seq } }).run()
    })()
    changed()
}

export const whitelistCount = () => db.select({ n: count() }).from(whitelist).get()?.n ?? 0

export function recommend(key: string, verdict: 'approve' | 'reject', reasoning: string) {
    db.insert(recommendations)
        .values({ key, verdict, reasoning: reasoning.slice(0, 2000), at: Date.now() })
        .onConflictDoUpdate({ target: recommendations.key, set: { verdict, reasoning: reasoning.slice(0, 2000), at: Date.now() } })
        .run()
}
export const recommendationFor = (key: string) => db.select().from(recommendations).where(eq(recommendations.key, key)).get()
export const dropRecommendation = (key: string) => db.delete(recommendations).where(eq(recommendations.key, key)).run()

function putOnList(userId: string, displayName: string, grounds: Grounds) {
    const seq = currentSeq() + 1
    db.insert(entries)
        .values({ userId, displayName, grounds, seq, addedAt: Date.now(), removed: false, removedBy: null })
        .onConflictDoUpdate({ target: entries.userId, set: { displayName, grounds, seq, removed: false, removedBy: null } })
        .run()
}

function takeOff(userId: string, by: 'rules' | 'admin') {
    db.update(entries).set({ removed: true, removedBy: by, seq: currentSeq() + 1 }).where(eq(entries.userId, userId)).run()
}

const entryOf = (userId: string) => db.select().from(entries).where(eq(entries.userId, userId)).get()
const checkOf = (userId: string) => db.select().from(checks).where(eq(checks.userId, userId)).get()

// Players the rules decide about: those with a non-group report and a check.
function ruledPlayers(): string[] {
    return db
        .selectDistinct({ id: reports.userId })
        .from(reports)
        .innerJoin(checks, eq(checks.userId, reports.userId))
        .where(ne(reports.outcome, 'review'))
        .all()
        .map((r) => r.id)
}

// What the rules make of one player: 'add', 'remove' or nothing. Hand removals and approved group
// blocks are a person's decisions, which the rules never undo.
function verdict(userId: string, rules: ServerRules, approved: string[]) {
    const check = checkOf(userId)
    const entry = entryOf(userId)
    const none = { change: null, displayName: entry?.displayName ?? '', grounds: {} as Grounds }
    if (!check || entry?.removedBy === 'admin' || (entry && !entry.removed && (entry.grounds as Grounds).reviewed)) {
        return none
    }
    const facts = check.facts as Facts
    const { listed, grounds } = judge(facts, check.firstCheckedAt, rules, approved)
    const onList = !!entry && !entry.removed
    const change: 'add' | 'remove' | null = listed && !onList ? 'add' : !listed && onList ? 'remove' : null
    return { change, displayName: facts.displayName, grounds }
}

function decide(userId: string) {
    const v = verdict(userId, serverRules(), approvedWords())
    if (v.change === 'add') {
        putOnList(userId, v.displayName, v.grounds)
    } else if (v.change === 'remove') {
        takeOff(userId, 'rules')
    }
    if (v.change) {
        changed()
    }
}

// What a change of rules or words would do to the whole list, before it's applied.
export function preview(rules: ServerRules, approved: string[]) {
    const add: { userId: string; displayName: string }[] = []
    const remove: { userId: string; displayName: string }[] = []
    for (const id of ruledPlayers()) {
        const v = verdict(id, rules, approved)
        if (v.change === 'add') add.push({ userId: id, displayName: v.displayName })
        if (v.change === 'remove') remove.push({ userId: id, displayName: entryOf(id)?.displayName ?? v.displayName })
    }
    return { add, remove }
}

// Applies the current rules and words to everyone, in one transaction.
export function reevaluate() {
    const rules = serverRules()
    const approved = approvedWords()
    let added = 0
    let removed = 0
    sqlite.transaction(() => {
        for (const id of ruledPlayers()) {
            const v = verdict(id, rules, approved)
            if (v.change === 'add') {
                putOnList(id, v.displayName, v.grounds)
                added++
            } else if (v.change === 'remove') {
                takeOff(id, 'rules')
                removed++
            }
        }
    })()
    if (added || removed) {
        changed()
    }
    return { added, removed }
}

// ---- reports -----------------------------------------------------------------------------------

export type Received = 'queued' | 'review' | 'known' | 'below minimum' | 'whitelisted'

export function receive(r: { userId: string; displayName: string; grounds: Grounds; caughtBy?: unknown; install: string }): Received {
    if (isWhitelisted(r.userId)) {
        return 'whitelisted' // cleared as a real person: not stored at all
    }
    const forReview = !!r.grounds.group
    const worth = forReview || worthReporting(r.grounds, serverRules())
    const known = !forReview && !!checkOf(r.userId)
    if (!forReview) {
        noteWord(r.grounds.bio)
    }
    db.insert(reports)
        .values({
            userId: r.userId,
            displayName: r.displayName,
            grounds: r.grounds,
            caughtBy: r.caughtBy ?? null,
            install: hash(r.install),
            ip: '', // not kept: the rate limit counts addresses in memory only
            receivedAt: Date.now(),
            outcome: forReview ? 'review' : !worth ? 'below' : known ? 'checked' : 'pending'
        })
        .run()
    if (forReview) {
        return 'review'
    }
    if (!worth) {
        return 'below minimum'
    }
    if (known) {
        decide(r.userId) // seen before: no new lookup, the stored check decides
        return 'known'
    }
    wake()
    return 'queued'
}

// Looks one player up and stores what the server saw. 'later': VRChat can't be asked right now
// (daily budget, backoff, unreachable), so the caller stops for a while.
async function lookUp(userId: string): Promise<'ok' | 'missing' | 'later'> {
    const found = await getUser(userId)
    if (!found.ok) {
        return found.reason === 'missing' ? 'missing' : 'later'
    }
    const facts = factsOf(found.user)
    const now = Date.now()
    db.insert(checks)
        .values({ userId, facts, firstCheckedAt: now, checkedAt: now })
        .onConflictDoUpdate({ target: checks.userId, set: { facts, checkedAt: now } })
        .run()
    return 'ok'
}

// One player with pending reports: looked up (once), then decided.
async function checkOne(): Promise<boolean> {
    const report = db.select().from(reports).where(eq(reports.outcome, 'pending')).orderBy(asc(reports.id)).limit(1).get()
    if (!report) {
        return false
    }
    const pendingOfUser = and(eq(reports.userId, report.userId), eq(reports.outcome, 'pending'))
    if (!checkOf(report.userId)) {
        const got = await lookUp(report.userId)
        if (got === 'later') {
            return false
        }
        if (got === 'missing') {
            db.update(reports).set({ outcome: 'checked', note: 'no such user' }).where(pendingOfUser).run()
            return true
        }
    }
    db.update(reports).set({ outcome: 'checked' }).where(pendingOfUser).run()
    decide(report.userId)
    return true
}

let running = false
export function wake() {
    if (running) {
        return
    }
    running = true
    void (async () => {
        try {
            while (await checkOne()) {}
        } catch (err) {
            console.error('checker:', err)
        } finally {
            running = false
        }
    })()
}

// The slow re-check: a few listed entries an hour whose check is old, so renamed or ranked-up
// accounts drop off in time. Reports never cause a second lookup.
export async function recheckSome() {
    const cutoff = Date.now() - RECHECK_AFTER_DAYS * 86_400_000
    const due = db
        .select({ id: entries.userId })
        .from(entries)
        .innerJoin(checks, eq(checks.userId, entries.userId))
        .where(and(eq(entries.removed, false), lt(checks.checkedAt, cutoff)))
        .orderBy(asc(checks.checkedAt))
        .limit(RECHECK_PER_HOUR)
        .all()
    for (const { id } of due) {
        if ((await lookUp(id)) === 'later') {
            return
        }
        decide(id)
    }
}

export function startBackground() {
    wake()
    setInterval(wake, 10 * 60_000).unref()
    setInterval(() => void recheckSome().catch((e) => console.error('recheck:', e)), 3_600_000).unref()
}

// ---- for plugins and the management page ------------------------------------------------------

// Everything changed after `since`: added and removed players. The whitelist itself never goes
// out (it would be a list of real players): `whitelistSeq` only says when it last changed, and
// plugins then ask about their own blocks (`clearedAmong`).
export function changesSince(since: number, limit: number) {
    const rows = db.select().from(entries).where(gt(entries.seq, since)).orderBy(asc(entries.seq)).limit(limit + 1).all()
    const page = rows.slice(0, limit)
    const more = rows.length > limit
    const whitelistSeq = db.select({ m: max(whitelist.seq) }).from(whitelist).get()?.m ?? 0
    return {
        seq: more ? page.at(-1)!.seq : Math.max(since, currentSeq()),
        more,
        added: page.filter((e) => !e.removed).map((e) => ({ userId: e.userId, displayName: e.displayName, grounds: e.grounds })),
        removed: page.filter((e) => e.removed).map((e) => e.userId),
        whitelistSeq
    }
}

// Which of these hashes (a plugin's own blocks) are whitelisted. Nothing about the question is kept.
export function clearedAmong(hashes: string[]): string[] {
    if (!hashes.length) {
        return []
    }
    return db.select({ h: whitelist.hash }).from(whitelist).where(inArray(whitelist.hash, hashes)).all().map((r) => r.h)
}

// A person takes a player off the list; only a person puts them back.
export function removeByHand(userId: string) {
    takeOff(userId, 'admin')
    changed()
}

// Undoes a hand removal: the rules decide about the player again.
export function restore(userId: string) {
    db.update(entries).set({ removedBy: 'rules' }).where(and(eq(entries.userId, userId), eq(entries.removedBy, 'admin'))).run()
    decide(userId)
}

export function counts() {
    const n = (q: { n: number } | undefined) => q?.n ?? 0
    return {
        listed: n(db.select({ n: count() }).from(entries).where(eq(entries.removed, false)).get()),
        pending: n(db.select({ n: count() }).from(reports).where(eq(reports.outcome, 'pending')).get()),
        review: n(db.select({ n: count() }).from(reports).where(eq(reports.outcome, 'review')).get()),
        words: n(db.select({ n: count() }).from(words).where(eq(words.status, 'pending')).get())
    }
}

// The group reports waiting for a person, one row per player.
export function reviewQueue() {
    const rows = db.select().from(reports).where(eq(reports.outcome, 'review')).orderBy(asc(reports.id)).all()
    const byUser = new Map<string, { userId: string; displayName: string; groups: Map<string, string>; reporters: Set<string>; firstAt: number }>()
    for (const r of rows) {
        const g = r.grounds as Grounds
        const item = byUser.get(r.userId) ?? { userId: r.userId, displayName: r.displayName, groups: new Map(), reporters: new Set(), firstAt: r.receivedAt }
        if (g.group) item.groups.set(g.group, g.groupId ?? '')
        item.reporters.add(r.install)
        byUser.set(r.userId, item)
    }
    return [...byUser.values()].map((i) => ({ ...i, groups: [...i.groups].map(([name, id]) => ({ name, id })), reporters: i.reporters.size }))
}

export function decideGroup(userId: string, approve: boolean) {
    const item = reviewQueue().find((i) => i.userId === userId)
    if (!item) {
        return
    }
    const entry = entryOf(userId)
    if (approve && !(entry && !entry.removed) && entry?.removedBy !== 'admin') {
        putOnList(userId, item.displayName, { group: item.groups.map((g) => g.name).join(', '), reviewed: true })
        changed()
    }
    db.update(reports)
        .set({ outcome: 'checked', note: approve ? 'group approved' : 'group rejected' })
        .where(and(eq(reports.userId, userId), eq(reports.outcome, 'review')))
        .run()
}

export const allEntries = (limit = 500) => db.select().from(entries).orderBy(desc(entries.seq)).limit(limit).all()

// ---- the daily review --------------------------------------------------------------------------

const lastReviewAt = () => (db.select().from(settings).where(eq(settings.key, 'lastReviewAt')).get()?.value as number | undefined) ?? 0

export function markReviewed() {
    const now = Date.now()
    db.insert(settings).values({ key: 'lastReviewAt', value: now }).onConflictDoUpdate({ target: settings.key, set: { value: now } }).run()
    return now
}

// What the daily review looks at: players listed since the last review with what the server saw of
// them, group reports waiting for a person, and words nobody decided yet with the profile texts
// they were found in.
export function reviewItems() {
    const since = lastReviewAt()
    const listed = db
        .select()
        .from(entries)
        .innerJoin(checks, eq(checks.userId, entries.userId))
        .where(and(eq(entries.removed, false), gt(entries.addedAt, since)))
        .all()
        .map(({ entries: e, checks: c }) => ({ userId: e.userId, displayName: e.displayName, grounds: e.grounds, addedAt: e.addedAt, seen: c.facts, firstSeenAt: c.firstCheckedAt }))
    const groups = reviewQueue().map((g) => ({ ...g, recommendation: recommendationFor(`group:${g.userId}`) ?? null }))
    const pending = wordsByStatus().pending.map((w) => {
        const ids = db
            .selectDistinct({ id: reports.userId })
            .from(reports)
            .where(sql`json_extract(${reports.grounds}, '$.bio') = ${w.word}`)
            .limit(5)
            .all()
            .map((r) => r.id)
        const texts = ids.map((id) => (checkOf(id)?.facts as Facts | undefined)?.text).filter((t): t is string => !!t)
        return { ...w, examples: texts.map((t) => t.slice(0, 500)), recommendation: recommendationFor(`word:${w.word}`) ?? null }
    })
    return { since, rules: serverRules(), approvedWords: approvedWords(), listed, groups, words: pending }
}
