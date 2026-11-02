import { resolve } from 'path'
import { getDatabase } from './database.service'

/** SQLite key columns are byte-exact, while Windows paths are case-insensitive. */
export function storageKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Internal marker so a legacy file is imported exactly once per scope. */
const SEEDED_KEY = '__meta_seeded__'

export class SettingsRepository {
  list(scope: string): Record<string, string> {
    const rows = getDatabase()
      .prepare(
        'SELECT key, value FROM settings WHERE scope = ? AND key != ? ORDER BY rowid'
      )
      .all(scope, SEEDED_KEY) as Array<{ key: string; value: string }>
    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  }

  has(scope: string, key: string): boolean {
    return Boolean(
      getDatabase().prepare('SELECT 1 FROM settings WHERE scope = ? AND key = ?').get(scope, key)
    )
  }

  isSeeded(scope: string): boolean {
    return this.has(scope, SEEDED_KEY)
  }

  get(scope: string, key: string): string | null {
    const row = getDatabase()
      .prepare('SELECT value FROM settings WHERE scope = ? AND key = ?')
      .get(scope, key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMany(scope: string, entries: Record<string, string>): void {
    const db = getDatabase()
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) insert.run(scope, key, value, now)
    })()
  }

  /** The most recently written scope among `scopes`, used to keep an existing project's rows. */
  newestExistingScope(scopes: readonly string[]): string | null {
    if (scopes.length === 0) return null
    const placeholders = scopes.map(() => '?').join(', ')
    const row = getDatabase()
      .prepare(
        `SELECT scope FROM settings WHERE scope IN (${placeholders})
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(...scopes) as { scope: string } | undefined
    return row?.scope ?? null
  }

  /**
   * Inserts the first-run defaults.  Existing keys always win, so a write that happened before
   * the seed is never overwritten.
   */
  seed(scope: string, entries: Record<string, string>): boolean {
    const db = getDatabase()
    const now = Date.now()
    return db.transaction(() => {
      const seeded = db
        .prepare('SELECT 1 FROM settings WHERE scope = ? AND key = ?')
        .get(scope, SEEDED_KEY)
      if (seeded) return false
      const insert = db.prepare(
        'INSERT OR IGNORE INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)'
      )
      for (const [key, value] of Object.entries(entries)) insert.run(scope, key, value, now)
      insert.run(scope, SEEDED_KEY, '1', now)
      return true
    })()
  }
}

export class MemoryRepository {
  /** The most recently written key among `keys`, used to keep an existing project's document. */
  newestExistingKey(keys: readonly string[]): string | null {
    if (keys.length === 0) return null
    const placeholders = keys.map(() => '?').join(', ')
    const row = getDatabase()
      .prepare(
        `SELECT path FROM memory_docs WHERE path IN (${placeholders})
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(...keys) as { path: string } | undefined
    return row?.path ?? null
  }

  get(key: string): string | null {
    const row = getDatabase().prepare('SELECT content FROM memory_docs WHERE path = ?').get(key) as
      { content: string } | undefined
    return row?.content ?? null
  }

  insertIfMissing(key: string, content: string): string {
    getDatabase()
      .prepare('INSERT OR IGNORE INTO memory_docs (path, content, updated_at) VALUES (?, ?, ?)')
      .run(key, content, Date.now())
    return this.get(key) ?? content
  }

  write(key: string, content: string): void {
    getDatabase()
      .prepare(
        `INSERT INTO memory_docs (path, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      )
      .run(key, content, Date.now())
  }

  /** One statement so concurrent sub-agent turns cannot overwrite each other's entry. */
  append(key: string, text: string): void {
    getDatabase()
      .prepare(
        `INSERT INTO memory_docs (path, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content = memory_docs.content || excluded.content,
           updated_at = excluded.updated_at`
      )
      .run(key, text, Date.now())
  }
}

export class PendingRepository {
  getManifest(root: string): string | null {
    const row = getDatabase()
      .prepare('SELECT manifest_json FROM pending_manifests WHERE root = ?')
      .get(root) as { manifest_json: string } | undefined
    return row?.manifest_json ?? null
  }

  saveManifest(root: string, manifestJson: string): void {
    getDatabase()
      .prepare(
        `INSERT INTO pending_manifests (root, manifest_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(root) DO UPDATE SET manifest_json = excluded.manifest_json,
           updated_at = excluded.updated_at`
      )
      .run(root, manifestJson, Date.now())
  }

  hasSnapshot(root: string, snapshotId: string): boolean {
    return Boolean(
      getDatabase()
        .prepare('SELECT 1 FROM pending_snapshots WHERE root = ? AND snapshot_id = ?')
        .get(root, snapshotId)
    )
  }

  putSnapshot(root: string, snapshotId: string, data: Buffer): void {
    getDatabase()
      .prepare(
        `INSERT OR IGNORE INTO pending_snapshots (root, snapshot_id, data, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(root, snapshotId, data, Date.now())
  }

  getSnapshot(root: string, snapshotId: string): Buffer | null {
    const row = getDatabase()
      .prepare('SELECT data FROM pending_snapshots WHERE root = ? AND snapshot_id = ?')
      .get(root, snapshotId) as { data: Buffer } | undefined
    return row?.data ? Buffer.from(row.data) : null
  }

  deleteSnapshot(root: string, snapshotId: string): void {
    getDatabase()
      .prepare('DELETE FROM pending_snapshots WHERE root = ? AND snapshot_id = ?')
      .run(root, snapshotId)
  }

  listSnapshotIds(root: string): string[] {
    return (
      getDatabase()
        .prepare('SELECT snapshot_id FROM pending_snapshots WHERE root = ? ORDER BY snapshot_id')
        .all(root) as Array<{ snapshot_id: string }>
    ).map((row) => row.snapshot_id)
  }

  clear(root: string): void {
    const db = getDatabase()
    db.transaction(() => {
      db.prepare('DELETE FROM pending_snapshots WHERE root = ?').run(root)
      db.prepare('DELETE FROM pending_manifests WHERE root = ?').run(root)
    })()
  }

  /** One transaction so an interrupted upgrade cannot leave a partial pending-change set. */
  importLegacy(
    root: string,
    manifestJson: string,
    snapshots: Array<[snapshotId: string, data: Buffer]>
  ): void {
    const db = getDatabase()
    const now = Date.now()
    const insertManifest = db.prepare(
      'INSERT OR IGNORE INTO pending_manifests (root, manifest_json, updated_at) VALUES (?, ?, ?)'
    )
    const insertSnapshot = db.prepare(
      'INSERT OR IGNORE INTO pending_snapshots (root, snapshot_id, data, updated_at) VALUES (?, ?, ?, ?)'
    )
    db.transaction(() => {
      insertManifest.run(root, manifestJson, now)
      for (const [id, data] of snapshots) insertSnapshot.run(root, id, data, now)
    })()
  }
}

export const settingsRepository = new SettingsRepository()
export const memoryRepository = new MemoryRepository()
export const pendingRepository = new PendingRepository()
