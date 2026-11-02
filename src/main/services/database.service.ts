import { app } from 'electron'
import { existsSync, renameSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

export interface DbConnection {
  db: Database
}

let dbInstance: Database | null = null
let bootstrapped = false

export const DB_SCHEMA_VERSION = 11

export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseUnavailableError'
  }
}

export function getDbPath(): string {
  const userData = typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd()
  return join(userData, 'gemibot.db')
}

function migrations(): Array<(db: Database) => void> {
  return [
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT 'New Conversation',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          summary TEXT,
          summary_up_to_message_id INTEGER,
          parent_conversation_id TEXT,
          FOREIGN KEY (parent_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL,
          tool_calls TEXT,
          tool_result TEXT,
          model TEXT,
          effort_level TEXT,
          status TEXT,
          duration_ms INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS queued_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          content TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
        CREATE INDEX IF NOT EXISTS idx_queued_conversation_position ON queued_messages(conversation_id, position);
      `)
    },
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
        DELETE FROM schema_version;
        INSERT INTO schema_version (version) VALUES (2);
      `)
    },
    (db) => {
      if (!columnExists(db, 'messages', 'meta_json')) {
        db.exec('ALTER TABLE messages ADD COLUMN meta_json TEXT')
      }
    },
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_contents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          content_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
          UNIQUE (conversation_id, position)
        );
        CREATE INDEX IF NOT EXISTS idx_contents_conversation_position
          ON conversation_contents(conversation_id, position);
      `)
    },
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS imported_files (
          path TEXT NOT NULL,
          source_key TEXT NOT NULL,
          hash TEXT,
          conversation_id TEXT,
          imported_at INTEGER NOT NULL,
          PRIMARY KEY (path, source_key)
        );
      `)
    },
    (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
          ON messages(conversation_id, id);
      `)
    },
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, key)
        );

        CREATE TABLE IF NOT EXISTS memory_docs (
          path TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Inert since the legacy session.json mirror was removed; kept so upgrades keep the data.
        CREATE TABLE IF NOT EXISTS session_state (
          root TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pending_manifests (
          root TEXT PRIMARY KEY,
          manifest_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pending_snapshots (
          root TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          data BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (root, snapshot_id)
        );
      `)
    },
    (db) => {
      // v7 keyed long-term rows by the memory/settings file path.  The app no longer touches
      // those files, so move each row to the logical key of the project it belongs to.
      const memoryRows = db
        .prepare('SELECT path, content, updated_at FROM memory_docs ORDER BY updated_at DESC')
        .all() as Array<{ path: string; content: string; updated_at: number }>
      const putMemory = db.prepare(
        'INSERT OR IGNORE INTO memory_docs (path, content, updated_at) VALUES (?, ?, ?)'
      )
      const dropMemory = db.prepare('DELETE FROM memory_docs WHERE path = ?')
      for (const row of memoryRows) {
        const match = /^(.*)[/\\]memory[/\\]memory\.md$/i.exec(row.path)
        if (match === null) continue
        putMemory.run(`memory:${match[1]}`, row.content, row.updated_at)
        dropMemory.run(row.path)
      }

      const settingRows = db
        .prepare('SELECT scope, key, value, updated_at FROM settings ORDER BY updated_at DESC')
        .all() as Array<{ scope: string; key: string; value: string; updated_at: number }>
      const putSetting = db.prepare(
        'INSERT OR IGNORE INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)'
      )
      const oldScopes = new Set<string>()
      for (const row of settingRows) {
        const match = /^(.*)[/\\]memory[/\\]settings\.md$/i.exec(row.scope)
        if (match === null) continue
        putSetting.run(`settings:${match[1]}`, row.key, row.value, row.updated_at)
        oldScopes.add(row.scope)
      }
      const dropScope = db.prepare('DELETE FROM settings WHERE scope = ?')
      for (const scope of oldScopes) dropScope.run(scope)
    },
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS compactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          summary TEXT NOT NULL,
          covers_up_to_message_id INTEGER NOT NULL DEFAULT 0,
          first_kept_message_id INTEGER NOT NULL DEFAULT 0,
          split_content_index INTEGER NOT NULL DEFAULT 0,
          messages_summarized_count INTEGER NOT NULL DEFAULT 0,
          messages_kept_count INTEGER NOT NULL DEFAULT 0,
          tokens_before INTEGER NOT NULL DEFAULT 0,
          tokens_after INTEGER NOT NULL DEFAULT 0,
          model_used TEXT NOT NULL DEFAULT '',
          trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
          status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
          duration_ms INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_compactions_conversation_created
          ON compactions(conversation_id, created_at);
      `)
    },
    (db) => {
      // Counts and labels only: no prompt text, tool output, message body or API key is stored.
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT,
          sender TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL,
          requested_model TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          thought_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          estimated INTEGER NOT NULL DEFAULT 0,
          breakdown_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
          ON token_usage(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at);
        CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
      `)
    },
    (db) => {
      // Durable Build mode state: the compact VIEW plus the spec/plan contracts needed to resume.
      // No prompts, API keys or model reasoning are stored here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS build_runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          root TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          state_json TEXT NOT NULL,
          tokens_used INTEGER NOT NULL DEFAULT 0,
          steps_used INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_build_runs_conversation
          ON build_runs(conversation_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_build_runs_root ON build_runs(root, updated_at);
      `)
    }
  ]
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

function legacyVersion(db: Database): number {
  if (!tableExists(db, 'schema_version')) return 0
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    { version: number } | undefined
  return row?.version ?? 0
}

function configure(db: Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
}

function migrate(db: Database): void {
  configure(db)
  const steps = migrations()
  let current = db.pragma('user_version', { simple: true }) as number
  const legacy = legacyVersion(db)
  if (current === 0 && legacy > 0) {
    if (legacy > DB_SCHEMA_VERSION) {
      throw new DatabaseUnavailableError(
        `Database schema v${legacy} is newer than this app supports (v${DB_SCHEMA_VERSION}).`
      )
    }
    current = legacy
    db.pragma(`user_version = ${current}`)
  }
  if (current > DB_SCHEMA_VERSION) {
    throw new DatabaseUnavailableError(
      `Database schema v${current} is newer than this app supports (v${DB_SCHEMA_VERSION}).`
    )
  }
  for (let version = current; version < steps.length; version++) {
    const run = db.transaction(() => {
      steps[version](db)
      db.pragma(`user_version = ${version + 1}`)
    })
    run()
  }
  if (tableExists(db, 'schema_version')) {
    db.prepare('UPDATE schema_version SET version = ?').run(DB_SCHEMA_VERSION)
  }
}

function isCorrupt(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed/i.test(
    text
  )
}

function backupCorruptFile(path: string): void {
  try {
    if (!existsSync(path)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(path, `${path}.corrupt-${stamp}`)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`))
        renameSync(`${path}${suffix}`, `${path}.corrupt-${stamp}${suffix}`)
    }
  } catch {
    /* the original stays in place if it cannot be moved */
  }
}

export function openDatabase(): Database {
  if (dbInstance) return dbInstance

  const path = getDbPath()
  let db: Database | null = null
  try {
    db = new Database(path)
    migrate(db)
    dbInstance = db
    bootstrapped = true
    return db
  } catch (error) {
    // Windows cannot rename a file that is still open, so release the handle before backing up.
    if (db !== null) {
      try {
        db.close()
      } catch {}
      db = null
    }
    if (!isCorrupt(error)) throw error
    backupCorruptFile(path)
    const fresh = new Database(path)
    migrate(fresh)
    dbInstance = fresh
    bootstrapped = true
    return fresh
  }
}

/**
 * Long-term stores pick SQLite only after the app itself opened the database.  The lazy
 * in-memory fallback used by unit tests must not flip them to database mode mid-suite.
 */
export function isDatabaseOpen(): boolean {
  return dbInstance !== null && bootstrapped
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* closing must not throw on quit */
    }
    try {
      dbInstance.close()
    } catch {
      /* ignore a double close */
    }
    dbInstance = null
    bootstrapped = false
  }
}

/**
 * Tests import the main process without Electron's app module; those runs get an isolated
 * in-memory database instead of touching a user profile.  In the real app a missing open() is
 * a bug and must be visible rather than silently discarding every write.
 */
function canUseElectronApp(): boolean {
  return Boolean(process.versions.electron) && typeof app?.getPath === 'function'
}

export function getDatabase(): Database {
  if (dbInstance) return dbInstance
  if (canUseElectronApp()) {
    throw new DatabaseUnavailableError('The conversation database has not been opened.')
  }
  const db = new Database(':memory:')
  migrate(db)
  dbInstance = db
  return db
}
