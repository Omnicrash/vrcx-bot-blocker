import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Every report as it came in. The install id and address are stored as hashes: they only count
// reporters apart and enforce limits, nothing traces them back to a person.
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
        // pending -> accepted | rejected | known (already on the list) | unavailable (no such user)
        outcome: text('outcome').notNull().default('pending'),
        note: text('note')
    },
    (t) => [index('reports_pending').on(t.outcome), index('reports_user').on(t.userId)]
)

// The shared list. `seq` grows with every change (added, removed again), so a plugin asks only
// for what changed since its last sync.
export const entries = sqliteTable(
    'entries',
    {
        userId: text('user_id').primaryKey(),
        displayName: text('display_name').notNull(),
        grounds: text('grounds', { mode: 'json' }).notNull(),
        seq: integer('seq').notNull(),
        addedAt: integer('added_at').notNull(),
        removed: integer('removed', { mode: 'boolean' }).notNull().default(false)
    },
    (t) => [index('entries_seq').on(t.seq)]
)
