import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { DATA_DIR, MIGRATIONS_DIR } from '../env'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

let current: Db | undefined

/** file 传 ':memory:' 可得到一个临时库（测试用） */
export function openDb(file?: string): Db {
  if (!file) {
    mkdirSync(DATA_DIR, { recursive: true })
    file = path.join(DATA_DIR, 'automedia.db')
  }
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  const d = drizzle(sqlite, { schema })
  migrate(d, { migrationsFolder: MIGRATIONS_DIR })
  current = d
  return d
}

export function db(): Db {
  if (!current) throw new Error('database not opened')
  return current
}

export { schema }
