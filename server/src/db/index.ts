// One shared connection; WAL for readers alongside the single writer. VAPI_DB=":memory:" gives
// tests a throwaway database. Migrations apply on import.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

const dbPath = process.env.VAPI_DB ?? './data/vapi.db'
if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
}
const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA busy_timeout = 5000')

export const db = drizzle(sqlite, { schema })
migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })

export { schema, sqlite }
