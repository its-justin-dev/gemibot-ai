import { resolve } from 'path'
import { ChangeType, FileChange, type FileChangeDict } from '../../shared/models/file-change'
import { pyNormalizeRelPath } from '../../shared/utils/py-path'
import { pyCompare } from '../../shared/utils/pystr'
import { pyListRepr } from '../../shared/utils/pyrepr'
import { nowStrftime } from '../../shared/utils/strftime'
import type { ChangesSummary } from '../../shared/types/changes'
import { out } from '../utils/console-out'
import { SnapshotStore } from './snapshot-store.service'

export class ChangeTracker {
  root: string
  readonly store: SnapshotStore
  pendingChanges: Map<string, FileChange> = new Map()
  filesRead: Record<string, string> = {}
  onChangesUpdated: ((summary: ChangesSummary) => void) | null = null

  private constructor(root: string) {
    this.root = resolve(root)
    this.store = new SnapshotStore(this.root)
  }

  static async create(root: string): Promise<ChangeTracker> {
    const tracker = new ChangeTracker(root)
    await tracker.loadState()
    return tracker
  }

  normalizePath(path: string): string {
    return pyNormalizeRelPath(path)
  }

  /** Pending changes belong to a project, so switching targets swaps in the other project's set. */
  async setRoot(root: string): Promise<void> {
    const before = this.getSummary()
    this.root = resolve(root)
    this.store.setRoot(this.root)
    this.pendingChanges.clear()
    this.filesRead = {}
    await this.loadState()
    const after = this.getSummary()
    if (JSON.stringify(before) !== JSON.stringify(after)) this.onChangesUpdated?.(after)
  }

  async loadState(): Promise<void> {
    const manifest = await this.store.loadManifest()
    const rawChanges = (manifest.changes ?? {}) as Record<string, unknown>
    const rawReads = (manifest.reads ?? {}) as Record<string, string>

    this.pendingChanges.clear()
    for (const [path, data] of Object.entries(rawChanges)) {
      try {
        this.pendingChanges.set(
          this.normalizePath(path),
          FileChange.fromDict(data as FileChangeDict)
        )
      } catch {}
    }

    this.filesRead = Object.fromEntries(
      Object.entries(rawReads).map(([path, time]) => [this.normalizePath(path), time])
    )
  }

  private async saveState(): Promise<void> {
    await this.store.saveManifest({
      changes: Object.fromEntries(
        [...this.pendingChanges.entries()].map(([path, change]) => [path, change.toDict()])
      ),
      reads: this.filesRead
    })
    if (this.onChangesUpdated) {
      try {
        this.onChangesUpdated(this.getSummary())
      } catch {}
    }
  }

  async recordRead(relPath: string): Promise<void> {
    this.filesRead[this.normalizePath(relPath)] = nowStrftime('%H:%M:%S')
    await this.saveState()
  }

  async recordChange(
    relPath: string,
    fullPath: string,
    changeType: ChangeType,
    detail = '',
    isBinary = false,
    what = '',
    why = ''
  ): Promise<FileChange | null> {
    const norm = this.normalizePath(relPath)
    const full = resolve(fullPath)

    const existing = this.pendingChanges.get(norm)
    if (existing) {
      if (!existing.original_exists && changeType === ChangeType.DELETED) {
        if (existing.snapshot_id) await this.store.deleteSnapshot(existing.snapshot_id)
        this.pendingChanges.delete(norm)
        await this.saveState()
        return null
      }

      if (changeType === ChangeType.DELETED) {
        existing.change_type = ChangeType.DELETED
      } else if (existing.original_exists && existing.change_type === ChangeType.DELETED) {
        existing.change_type = ChangeType.MODIFIED
      } else if (!existing.original_exists) {
        existing.change_type =
          changeType === ChangeType.GENERATED || changeType === ChangeType.DOCX_EDITED
            ? changeType
            : ChangeType.ADDED
      } else {
        existing.change_type = changeType
      }

      existing.detail = detail || existing.detail
      existing.timestamp = nowStrftime('%Y-%m-%d %H:%M:%S')

      if (what) existing.what.push(what)
      if (why) existing.why.push(why)

      await this.saveState()
      return existing
    }

    const [snapId, origExists, detectedBin] = await this.store.saveSnapshot(norm, full)

    if (origExists && !snapId) {
      out(
        `Warning: Failed to create snapshot for existing file ${norm}, change tracking may be incomplete`
      )
    }

    const change = new FileChange({
      path: norm,
      full_path: full,
      change_type: changeType,
      snapshot_id: snapId,
      original_exists: origExists,
      timestamp: nowStrftime('%Y-%m-%d %H:%M:%S'),
      detail,
      is_binary: isBinary || detectedBin,
      what: what ? [what] : [],
      why: why ? [why] : []
    })
    this.pendingChanges.set(norm, change)
    await this.saveState()
    return change
  }

  async acceptAll(): Promise<string[]> {
    const accepted = [...this.pendingChanges.keys()]
    this.pendingChanges.clear()
    this.filesRead = {}
    await this.store.clearAll()
    await this.saveState()
    return accepted
  }

  async rejectAll(): Promise<string[]> {
    const rejected: string[] = []
    const failed: string[] = []
    for (const [normPath, change] of [...this.pendingChanges.entries()]) {
      const restored = await this.store.restoreSnapshot(
        change.snapshot_id,
        change.full_path,
        change.original_exists
      )
      if (restored) rejected.push(normPath)
      else failed.push(normPath)
    }

    if (!failed.length) {
      this.pendingChanges.clear()
      this.filesRead = {}
      await this.store.clearAll()
    } else {
      for (const normPath of rejected) {
        const change = this.pendingChanges.get(normPath)
        if (change) {
          this.pendingChanges.delete(normPath)
          if (change.snapshot_id) await this.store.deleteSnapshot(change.snapshot_id)
        }
      }
      out(`Warning: Failed to restore ${failed.length} files: ${pyListRepr(failed)}`)
    }

    await this.saveState()
    return rejected
  }

  async acceptFile(relPath: string): Promise<boolean> {
    const norm = this.normalizePath(relPath)
    const change = this.pendingChanges.get(norm)
    if (change) {
      this.pendingChanges.delete(norm)
      if (change.snapshot_id) await this.store.deleteSnapshot(change.snapshot_id)
      await this.saveState()
      return true
    }
    return false
  }

  async rejectFile(relPath: string): Promise<boolean> {
    const norm = this.normalizePath(relPath)
    const change = this.pendingChanges.get(norm)
    if (!change) return false

    this.pendingChanges.delete(norm)
    const restored = await this.store.restoreSnapshot(
      change.snapshot_id,
      change.full_path,
      change.original_exists
    )
    if (restored) {
      await this.store.deleteSnapshot(change.snapshot_id)
      await this.saveState()
      return true
    }

    this.pendingChanges.set(norm, change)
    await this.saveState()
    return false
  }

  getSummary(): ChangesSummary {
    const counts: Record<string, number> = {
      [ChangeType.ADDED]: 0,
      [ChangeType.MODIFIED]: 0,
      [ChangeType.DELETED]: 0,
      [ChangeType.GENERATED]: 0,
      [ChangeType.DOCX_EDITED]: 0
    }
    for (const change of this.pendingChanges.values()) {
      const val = change.change_type as string
      counts[val] = (counts[val] ?? 0) + 1
    }

    return {
      total_changes: this.pendingChanges.size,
      counts,
      changes: [...this.pendingChanges.values()]
        .sort((a, b) => pyCompare(a.path, b.path))
        .map((change) => change.toDict()),
      files_read: Object.entries(this.filesRead)
        .sort(([a], [b]) => pyCompare(a, b))
        .map(([path, time]) => ({ path, time }))
    }
  }
}
