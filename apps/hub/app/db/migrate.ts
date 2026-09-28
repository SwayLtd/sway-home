/**
 * Migration runner.
 *
 *   bun run app/db/migrate.ts            apply anything pending
 *   bun run app/db/migrate.ts --reset    delete the file and start again (local only)
 *   bun run app/db/migrate.ts --status   list applied and pending
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { database, nowIso, openDatabase } from './database.ts'
import { MIGRATIONS, MIGRATIONS_TABLE } from './migrations.ts'

export function databasePath(): string {
  const fromEnv = process.env.DB_PATH
  // ':memory:' is SQLite's own name for a database that never touches disk. Resolving it
  // against the filesystem turns it into a path containing a colon, which Windows refuses
  // outright - so it is passed through verbatim.
  if (fromEnv === ':memory:') return fromEnv
  if (fromEnv) return resolve(fromEnv)
  return resolve(process.cwd(), '../../data/house.sqlite')
}

/** True when the hub is running against a throwaway database, as it does under test. */
export function isMemoryDatabase(path: string): boolean {
  return path === ':memory:'
}

export async function runMigrations(options: { reset?: boolean; silent?: boolean } = {}): Promise<{ applied: string[]; pending: string[] }> {
  const path = databasePath()
  if (!isMemoryDatabase(path)) mkdirSync(dirname(path), { recursive: true })

  if (options.reset && !isMemoryDatabase(path)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${path}${suffix}`
      if (existsSync(file)) rmSync(file)
    }
  }

  await openDatabase(path)
  const db = database()
  db.exec(MIGRATIONS_TABLE)

  const done = new Set(db.all<{ id: string }>('SELECT id FROM _migrations').map((row) => row.id))
  const applied: string[] = []

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.up)
      db.run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', [migration.id, nowIso()])
      db.exec('COMMIT')
      applied.push(migration.id)
      if (!options.silent) console.log(`  applied ${migration.id}`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${migration.id} failed: ${(error as Error).message}`)
    }
  }

  const pending = MIGRATIONS.filter((m) => !done.has(m.id) && !applied.includes(m.id)).map((m) => m.id)
  return { applied, pending }
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))
  const path = databasePath()
  console.log(`database  ${path}`)
  const result = await runMigrations({ reset: args.has('--reset') })
  console.log(`driver    ${database().name}`)
  console.log(result.applied.length > 0 ? `applied   ${result.applied.length} migration(s)` : 'up to date')
  const tables = database().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  console.log(`tables    ${tables.map((t) => t.name).join(', ')}`)
}
