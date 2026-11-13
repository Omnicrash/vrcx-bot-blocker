// Takes reports in, checks them against VRChat one at a time, and keeps the shared list.
import { createHash } from 'node:crypto'
import { and, asc, count, eq, gt, max } from 'drizzle-orm'
import { BIO_WORDS } from './config'
import { db, schema } from './db'
import { type Grounds, meetsMinimum, verifiedGrounds } from './rules'
import { getUser } from './vrchat'

const { reports, entries } = schema

// Install ids and addresses are kept only as hashes.
export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

export type Received = 'queued' | 'known' | 'below minimum'

export function receive(r: { userId: string; displayName: string; grounds: Grounds; install: string; ip: string }): Received {
    if (!meetsMinimum(r.grounds)) {
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
            outcome: listed ? 'known' : 'pending'
        })
        .run()
    if (!listed) {
        wake()
    }
    return listed ? 'known' : 'queued'
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
    const kept = verifiedGrounds(report.grounds as Grounds, found.user, BIO_WORDS)
    if (!meetsMinimum(kept)) {
        done('rejected', `held up: ${Object.keys(kept).join(', ') || 'nothing'}`)
        return true
    }
    db.insert(entries)
        .values({
            userId: report.userId,
            displayName: found.user.displayName,
            grounds: kept,
            seq: nextSeq(),
            addedAt: Date.now(),
            removed: false
        })
        .onConflictDoUpdate({
            target: entries.userId,
            set: { displayName: found.user.displayName, grounds: kept, seq: nextSeq(), removed: false }
        })
        .run()
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
    const listed = db.select({ n: count() }).from(entries).where(eq(entries.removed, false)).get()?.n ?? 0
    const pending = db.select({ n: count() }).from(reports).where(eq(reports.outcome, 'pending')).get()?.n ?? 0
    return { listed, pending }
}
