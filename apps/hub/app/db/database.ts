/**
 * SQLite, without a native dependency.
 *
 * `better-sqlite3` is the usual answer and it is the wrong one here: it is a C++ addon that
 * segfaults Bun on Windows, and this hub is meant to run under Bun on whatever the user
 * already has. Both runtimes now ship a SQLite driver in core - `bun:sqlite` and
 * `node:sqlite` - so the dependency is not needed at all. This file picks the right one at
 * boot and hides the two behind one interface.
 *
 * The same choice pays off twice: no compile step on install, no prebuilt binary to match
 * to a platform, and the hub stays a `git clone` away from running on a Pi later.
 */

export interface SqlDriver {
  name: 'bun:sqlite' | 'node:sqlite'
  exec(sql: string): void
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  close(): void
}

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

async function openBun(path: string): Promise<SqlDriver> {
  const { Database } = await import('bun:sqlite')
  const database = new Database(path, { create: true })
  return {
    name: 'bun:sqlite',
    exec: (sql) => database.exec(sql),
    run: (sql, params = []) => {
      const result = database.run(sql, params as never)
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
    },
    get: <T,>(sql: string, params: unknown[] = []) => database.query(sql).get(...(params as never[])) as T | undefined,
    all: <T,>(sql: string, params: unknown[] = []) => database.query(sql).all(...(params as never[])) as T[],
    close: () => database.close(),
  }
}

async function openNode(path: string): Promise<SqlDriver> {
  const { DatabaseSync } = (await import('node:sqlite')) as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void
      prepare(sql: string): {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
        get(...params: unknown[]): unknown
        all(...params: unknown[]): unknown[]
      }
      close(): void
    }
  }
  const database = new DatabaseSync(path)
  return {
    name: 'node:sqlite',
    exec: (sql) => database.exec(sql),
    run: (sql, params = []) => database.prepare(sql).run(...params),
    get: <T,>(sql: string, params: unknown[] = []) => database.prepare(sql).get(...params) as T | undefined,
    all: <T,>(sql: string, params: unknown[] = []) => database.prepare(sql).all(...params) as T[],
    close: () => database.close(),
  }
}

let driver: SqlDriver | null = null

export async function openDatabase(path: string): Promise<SqlDriver> {
  if (driver) return driver
  driver = isBun() ? await openBun(path) : await openNode(path)

  // WAL is the difference between "a routine fires while the UI is reading" working and
  // throwing SQLITE_BUSY. The rest are the pragmas any embedded SQLite wants.
  driver.exec('PRAGMA journal_mode = WAL')
  driver.exec('PRAGMA synchronous = NORMAL')
  driver.exec('PRAGMA foreign_keys = ON')
  driver.exec('PRAGMA busy_timeout = 5000')
  driver.exec('PRAGMA temp_store = MEMORY')
  driver.exec('PRAGMA cache_size = -16000')
  return driver
}

export function database(): SqlDriver {
  if (!driver) throw new Error('Database not open. Call openDatabase() during boot.')
  return driver
}

export function closeDatabase(): void {
  driver?.close()
  driver = null
}

// ---------------------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------------------

/** Columns stored as JSON text. Read and written through here so the shape is one place. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    const parsed = JSON.parse(value) as T
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

export function boolToInt(value: boolean | undefined | null): number {
  return value ? 1 : 0
}

export function intToBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Run a function inside a transaction. Nested calls join the outer transaction rather than
 * opening a second one, because SQLite has no nested transactions and the alternative is a
 * confusing "cannot start a transaction within a transaction" at 2am.
 */
let transactionDepth = 0
export function transaction<T>(callback: () => T): T {
  const db = database()
  if (transactionDepth > 0) return callback()

  transactionDepth += 1
  db.exec('BEGIN')
  try {
    const result = callback()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    transactionDepth -= 1
  }
}

/** `insertInto('devices', { id, name })` - saves writing the placeholder list by hand. */
export function insertInto(table: string, row: Record<string, unknown>, orReplace = false): void {
  const keys = Object.keys(row)
  const placeholders = keys.map(() => '?').join(', ')
  const verb = orReplace ? 'INSERT OR REPLACE' : 'INSERT'
  database().run(`${verb} INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(row))
}

export function updateWhere(table: string, row: Record<string, unknown>, where: string, whereParams: unknown[]): void {
  const keys = Object.keys(row)
  if (keys.length === 0) return
  const assignments = keys.map((key) => `${key} = ?`).join(', ')
  database().run(`UPDATE ${table} SET ${assignments} WHERE ${where}`, [...Object.values(row), ...whereParams])
}
