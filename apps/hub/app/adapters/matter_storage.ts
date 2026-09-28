/**
 * Where matter.js keeps the fabric: its keys, the certificates it issued, the nodes it
 * commissioned and what it cached about them.
 *
 * matter.js ships two stores and neither holds up on the hub's machine: the file store
 * replaces each value by renaming a temporary file over it, which Windows refuses while the
 * old file is still open (EPERM), and the SQLite store opens one transaction per write batch
 * on a single connection, so two batches in flight collide ("Transaction is in progress").
 * This one keeps everything in memory, as matter.js's own memory store does, and writes each
 * change through to a SQLite file of its own at once, in a single synchronous statement:
 * nothing is ever half-written and nothing waits on anything else.
 */

import { Database } from 'bun:sqlite'
import { fromJson, MemoryStorageDriver, toJson, type StorageDriver, type SupportedStorageTypes } from '@matter/main'

/** matter.js's own rule for a context path (its helper is private): segments joined by dots. */
function contextKey(contexts: string[]): string {
  return contexts.join('.')
}

export class HubMatterStorage extends MemoryStorageDriver {
  readonly #database: Database
  readonly #namespace: string

  constructor(database: Database, namespace: string) {
    super()
    this.#database = database
    this.#namespace = namespace
  }

  override initialize(): void {
    const rows = this.#database
      .query<{ context: string; key: string; value: string }, [string]>('SELECT context, key, value FROM matter_kv WHERE namespace = ?')
      .all(this.#namespace)
    for (const row of rows) {
      const context = (this.store[row.context] ??= {}) as Record<string, SupportedStorageTypes>
      context[row.key] = fromJson(row.value)
    }
    super.initialize()
  }

  override set(contexts: string[], values: Record<string, SupportedStorageTypes>): void
  override set(contexts: string[], key: string, value: SupportedStorageTypes): void
  override set(contexts: string[], keyOrValues: string | Record<string, SupportedStorageTypes>, value?: SupportedStorageTypes): void {
    const entries = typeof keyOrValues === 'string' ? [[keyOrValues, value] as const] : Object.entries(keyOrValues)
    if (typeof keyOrValues === 'string') super.set(contexts, keyOrValues, value as SupportedStorageTypes)
    else super.set(contexts, keyOrValues)
    const context = contextKey(contexts)
    const write = this.#database.prepare('INSERT OR REPLACE INTO matter_kv (namespace, context, key, value) VALUES (?, ?, ?, ?)')
    this.#database.transaction(() => {
      for (const [key, entry] of entries) write.run(this.#namespace, context, key, toJson(entry as SupportedStorageTypes))
    })()
  }

  override delete(contexts: string[], key: string): void {
    super.delete(contexts, key)
    this.#database.run('DELETE FROM matter_kv WHERE namespace = ? AND context = ? AND key = ?', [this.#namespace, contextKey(contexts), key])
  }

  override clearAll(contexts: string[]): void {
    super.clearAll(contexts)
    const context = contextKey(contexts)
    if (!context) {
      this.#database.run('DELETE FROM matter_kv WHERE namespace = ?', [this.#namespace])
      return
    }
    this.#database.run('DELETE FROM matter_kv WHERE namespace = ? AND (context = ? OR substr(context, 1, ?) = ?)', [
      this.#namespace,
      context,
      context.length + 1,
      `${context}.`,
    ])
  }

  override clear(): void {
    for (const key of Object.keys(this.store)) delete this.store[key]
    this.#database.run('DELETE FROM matter_kv WHERE namespace = ?', [this.#namespace])
  }
}

/** The driver matter.js is told to use, over one SQLite file shared by every namespace. */
export function hubStorageDriver(path: string, id = 'sway-hub'): { implementation: StorageDriver.Implementation; close(): void } {
  const database = new Database(path, { create: true })
  database.run('PRAGMA journal_mode = WAL')
  database.run(
    'CREATE TABLE IF NOT EXISTS matter_kv (namespace TEXT NOT NULL, context TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, context, key))'
  )
  return {
    implementation: {
      id,
      create(namespace) {
        const storage = new HubMatterStorage(database, namespace.namespace)
        storage.initialize()
        return storage
      },
    },
    close: () => database.close(),
  }
}
