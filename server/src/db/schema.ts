import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Every report as it came in, kept for good. The install id and address are stored as hashes:
// they count reporters apart and enforce limits, nothing traces them back to a person.
// `caughtBy` is research data only (which of the reporter's own rules fired); no decision reads it.
export const reports = sqliteTable(
    'reports',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        userId: text('user_id').notNull(),
        displayName: text('display_name').notNull(),
        grounds: text('grounds', { mode: 'json' }).notNull(),
        install: text('install').notNull(),
        ip: text('ip').notNull(),
        receivedAt: integer('received_at').notNull(),
        // pending (waits for a lookup) -> checked | review (a group report) | below (not worth one)
        outcome: text('outcome').notNull().default('pending'),
        note: text('note'),
        caughtBy: text('caught_by', { mode: 'json' })
    },
    (t) => [index('reports_pending').on(t.outcome), index('reports_user').on(t.userId)]
)

// What the server saw of each player, one row per player, kept forever. Reports reuse it instead
// of looking the player up again; only the slow re-check of listed entries refreshes it.
export const checks = sqliteTable('checks', {
    userId: text('user_id').primaryKey(),
    facts: text('facts', { mode: 'json' }).notNull(),
    firstCheckedAt: integer('first_checked_at').notNull(),
    checkedAt: integer('checked_at').notNull()
})

// Words and sites. `approved` ones list a player on their own; new ones from plugins wait as
// `pending` until a person decides on the management page; `rejected` ones are never asked again.
export const words = sqliteTable('words', {
    word: text('word').primaryKey(),
    status: text('status').notNull(),
    firstAt: integer('first_at').notNull()
})

// Settings changed on the management page, one JSON value per key ('rules').
export const settings = sqliteTable('settings', {
    key: text('key').primaryKey(),
    value: text('value', { mode: 'json' }).notNull()
})

// The shared list. `seq` grows with every change (added, removed again), so a plugin asks only
// for what changed since its last sync. `removedBy`: 'rules' (no longer fits) or 'admin' (taken
// off by hand, which nothing puts back).
export const entries = sqliteTable(
    'entries',
    {
        userId: text('user_id').primaryKey(),
        displayName: text('display_name').notNull(),
        grounds: text('grounds', { mode: 'json' }).notNull(),
        seq: integer('seq').notNull(),
        addedAt: integer('added_at').notNull(),
        removed: integer('removed', { mode: 'boolean' }).notNull().default(false),
        removedBy: text('removed_by')
    },
    (t) => [index('entries_seq').on(t.seq)]
)
