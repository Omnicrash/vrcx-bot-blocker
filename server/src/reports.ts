// Takes reports in, checks them against VRChat one at a time, and keeps the shared list.
import { createHash } from 'node:crypto'
import { and, asc, count, desc, eq, gt, max } from 'drizzle-orm'
import { BIO_WORDS } from './config'
import { db, schema } from './db'
import { DEFAULT_RULES, type Grounds, meetsRules, RULE_NAMES, type ServerRules, verifiedGrounds } from './rules'
import { getUser } from './vrchat'

const { reports, entries, settings } = schema

// The acceptance rules: what the management page saved, on top of the defaults. The bio words
// start from VAPI_BIO_WORDS until the page sets its own.
export function serverRules(): ServerRules {
    const saved = (db.select().from(settings).where(eq(settings.key, 'rules')).get()?.value ?? {}) as Partial<ServerRules>
    const rules = { ...DEFAULT_RULES.rules }
    for (const k of RULE_NAMES) {
        rules[k] = { ...DEFAULT_RULES.rules[k], ...(saved.rules?.[k] ?? {}) }
    }
    return { rules, ageDays: saved.ageDays ?? DEFAULT_RULES.ageDays, bioWords: saved.bioWords ?? BIO_WORDS }
}

export function saveRules(r: ServerRules) {
    db.insert(settings).values({ key: 'rules', value: r }).onConflictDoUpdate({ target: settings.key, set: { value: r } }).run()
}

// Install ids and addresses are kept only as hashes.
export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

export type Received = 'queued' | 'review' | 'known' | 'below minimum'

export function receive(r: { userId: string; displayName: string; grounds: Grounds; install: string; ip: string }): Received {
    const forReview = !!r.grounds.group
    if (!forReview && !meetsRules(r.grounds, serverRules())) {
        return 'below minimum'
    }
    const listed = db.select().from(entries).where(and(eq(entries.userId, r.userId), eq(entries.removed, false))).get()
    db.insert(reports)
        .values({
            userId: r.userId,
            displayName: r.displayName,
            grounds: r.grounds,
            install: hash(r.install),
            ip: hash(r.ip),
            receivedAt: Date.now(),
            outcome: listed ? 'known' : forReview ? 'review' : 'pending'
        })
        .run()
    if (listed) {
        return 'known'
    }
    if (forReview) {
        return 'review'
    }
    wake()
    return 'queued'
}

function list(userId: string, displayName: string, grounds: Grounds) {
    db.insert(entries)
        .values({ userId, displayName, grounds, seq: nextSeq(), addedAt: Date.now(), removed: false })
        .onConflictDoUpdate({ target: entries.userId, set: { displayName, grounds, seq: nextSeq(), removed: false } })
        .run()
}

function nextSeq(): number {
    const row = db.select({ m: max(entries.seq) }).from(entries).get()
    return (row?.m ?? 0) + 1
}

// One pending report: the player is looked up, the grounds re-checked, and the player listed
// when what holds still meets the minimum.
async function checkOne(): Promise<boolean> {
    const report = db.select().from(reports).where(eq(reports.outcome, 'pending')).orderBy(asc(reports.id)).limit(1).get()
    if (!report) {
        return false
    }
    const done = (outcome: string, note?: string) =>
        db.update(reports).set({ outcome, note }).where(eq(reports.id, report.id)).run()

    // Several reports for one player: the first decides, the rest follow it.
    const listed = db.select().from(entries).where(and(eq(entries.userId, report.userId), eq(entries.removed, false))).get()
    if (listed) {
        done('known')
        return true
    }
    const found = await getUser(report.userId)
    if (!found.ok) {
        // VRChat unreachable or the login gone: leave it pending and try again later.
        if (found.reason === 'unavailable') {
            return false
        }
        done('rejected', 'no such user')
        return true
    }
    const rules = serverRules()
    const kept = verifiedGrounds(report.grounds as Grounds, found.user, rules.bioWords)
    if (!meetsRules(kept, rules)) {
        done('rejected', `held up: ${Object.keys(kept).join(', ') || 'nothing'}`)
        return true
    }
    list(report.userId, found.user.displayName, kept)
    done('accepted')
    return true
}

// The checker works through the queue on its own; a new report wakes it, a failure puts it to
// sleep for a minute before it tries again.
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
setInterval(wake, 60_000).unref()

// Everything changed after `since`, oldest first, at most `limit` entries.
export function changesSince(since: number, limit: number) {
    const rows = db.select().from(entries).where(gt(entries.seq, since)).orderBy(asc(entries.seq)).limit(limit + 1).all()
    const page = rows.slice(0, limit)
    return {
        seq: page.at(-1)?.seq ?? since,
        more: rows.length > limit,
        added: page.filter((e) => !e.removed).map((e) => ({ userId: e.userId, displayName: e.displayName, grounds: e.grounds })),
        removed: page.filter((e) => e.removed).map((e) => e.userId)
    }
}

// Takes a player off the shared list, for every plugin at its next sync.
export function unlist(userId: string) {
    db.update(entries).set({ removed: true, seq: nextSeq() }).where(eq(entries.userId, userId)).run()
}

export function counts() {
    const n = (q: { n: number } | undefined) => q?.n ?? 0
    const listed = n(db.select({ n: count() }).from(entries).where(eq(entries.removed, false)).get())
    const pending = n(db.select({ n: count() }).from(reports).where(eq(reports.outcome, 'pending')).get())
    const review = n(db.select({ n: count() }).from(reports).where(eq(reports.outcome, 'review')).get())
    return { listed, pending, review }
}

// The group reports waiting for a person, one row per player.
export function reviewQueue() {
    const rows = db.select().from(reports).where(eq(reports.outcome, 'review')).orderBy(asc(reports.id)).all()
    const byUser = new Map<string, { userId: string; displayName: string; groups: Set<string>; groupIds: Set<string>; reporters: Set<string>; grounds: Grounds; firstAt: number }>()
    for (const r of rows) {
        const g = r.grounds as Grounds
        const item = byUser.get(r.userId) ?? { userId: r.userId, displayName: r.displayName, groups: new Set(), groupIds: new Set(), reporters: new Set(), grounds: {}, firstAt: r.receivedAt }
        if (g.group) item.groups.add(g.group)
        if (g.groupId) item.groupIds.add(g.groupId)
        item.reporters.add(r.install)
        item.grounds = { ...item.grounds, ...g }
        byUser.set(r.userId, item)
    }
    return [...byUser.values()].map((i) => ({ ...i, groups: [...i.groups], groupIds: [...i.groupIds], reporters: i.reporters.size }))
}

// A person's verdict on a player's group reports. Approved: listed, with the group as grounds.
export function decide(userId: string, approve: boolean) {
    const item = reviewQueue().find((i) => i.userId === userId)
    if (!item) {
        return false
    }
    if (approve) {
        list(userId, item.displayName, { group: item.groups.join(', '), reviewed: true } as Grounds)
    }
    db.update(reports)
        .set({ outcome: approve ? 'accepted' : 'rejected', note: approve ? 'approved by review' : 'rejected by review' })
        .where(and(eq(reports.userId, userId), eq(reports.outcome, 'review')))
        .run()
    return true
}

// The current list, newest first, for the management page.
export function listed(limit = 200) {
    return db.select().from(entries).where(eq(entries.removed, false)).orderBy(desc(entries.seq)).limit(limit).all()
}
