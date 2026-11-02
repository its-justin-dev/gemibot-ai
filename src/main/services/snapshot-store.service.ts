import { createHash } from 'crypto'
import type { Stats } from 'fs'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { isBinary } from '../../shared/utils/text'
import { out } from '../utils/console-out'
import { isDatabaseOpen } from './database.service'
import { pendingRepository, storageKey } from './long-term-repository.service'

export interface PendingManifest {
  changes: Record<string, unknown>
  reads: Record<string, string>
}

const EMPTY_MANIFEST: PendingManifest = { changes: {}, reads: {} }

export class SnapshotStore {
  root: string
  pendingDir: string
  snapshotsDir: string
  manifestFile: string
  private readonly database: boolean
  private rootKey: string

  constructor(root: string) {
    this.root = resolve(root)
    this.pendingDir = join(this.root, '.gemibot', 'pending')
    this.snapshotsDir = join(this.pendingDir, 'snapshots')
    this.manifestFile = join(this.pendingDir, 'manifest.json')
    this.database = isDatabaseOpen()
    this.rootKey = storageKey(this.root)
    if (!this.database) void this.ensureDirs()
  }

  setRoot(root: string): void {
    this.root = resolve(root)
    this.pendingDir = join(this.root, '.gemibot', 'pending')
    this.snapshotsDir = join(this.pendingDir, 'snapshots')
    this.manifestFile = join(this.pendingDir, 'manifest.json')
    this.rootKey = storageKey(this.root)
    if (!this.database) void this.ensureDirs()
  }

  private async ensureDirs(): Promise<void> {
    try {
      await mkdir(this.snapshotsDir, { recursive: true })
    } catch {}
  }

  async saveSnapshot(
    relPath: string,
    fullPath: string
  ): Promise<[string | null, boolean, boolean]> {
    const target = resolve(fullPath)
    if (!(await this.exists(target))) return [null, false, false]

    try {
      const raw = await readFile(target)
      const isBin = isBinary(raw)
      const snapId = createHash('sha256')
        .update(Buffer.from(relPath, 'utf-8'))
        .update(raw)
        .digest('hex')
        .slice(0, 16)

      if (this.database) {
        if (!pendingRepository.hasSnapshot(this.rootKey, snapId)) {
          pendingRepository.putSnapshot(this.rootKey, snapId, raw)
        }
        return [snapId, true, isBin]
      }

      await this.ensureDirs()
      const snapPath = join(this.snapshotsDir, snapId)
      if (!(await this.exists(snapPath))) await writeFile(snapPath, raw)
      return [snapId, true, isBin]
    } catch (error) {
      out(`Warning: Failed to create snapshot for ${relPath}: ${errorMessage(error)}`)
      return [null, true, false]
    }
  }

  async restoreSnapshot(
    snapshotId: string | null,
    fullPath: string,
    originalExists: boolean
  ): Promise<boolean> {
    const target = resolve(fullPath)
    try {
      if (!originalExists) {
        const info = await this.statOrNull(target)
        if (info?.isFile()) await unlink(target)
        else if (info?.isDirectory()) await rm(target, { recursive: true, force: true })
        return true
      }

      if (snapshotId) {
        if (this.database) {
          const data = pendingRepository.getSnapshot(this.rootKey, snapshotId)
          if (data !== null) {
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, data)
            return true
          }
          return false
        }
        const snapPath = join(this.snapshotsDir, snapshotId)
        if (await this.exists(snapPath)) {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, await readFile(snapPath))
          return true
        }
      }
      return false
    } catch (error) {
      out(`Error restoring snapshot ${snapshotId} to ${target}: ${errorMessage(error)}`)
      return false
    }
  }

  async getSnapshotBytes(snapshotId: string | null): Promise<Buffer | null> {
    if (!snapshotId) return null
    if (this.database) return pendingRepository.getSnapshot(this.rootKey, snapshotId)
    const snapPath = join(this.snapshotsDir, snapshotId)
    try {
      if (await this.exists(snapPath)) return await readFile(snapPath)
      return null
    } catch {
      return null
    }
  }

  async deleteSnapshot(snapshotId: string | null): Promise<void> {
    if (!snapshotId) return
    if (this.database) {
      pendingRepository.deleteSnapshot(this.rootKey, snapshotId)
      return
    }
    const snapPath = join(this.snapshotsDir, snapshotId)
    try {
      if (await this.exists(snapPath)) await unlink(snapPath)
    } catch {}
  }

  async saveManifest(data: PendingManifest): Promise<void> {
    if (this.database) {
      pendingRepository.saveManifest(this.rootKey, JSON.stringify(data, null, 2))
      return
    }
    await this.ensureDirs()
    try {
      const tempFile = join(this.pendingDir, 'manifest.tmp')
      await writeFile(tempFile, JSON.stringify(data, null, 2), 'utf-8')
      await rename(tempFile, this.manifestFile)
    } catch (error) {
      out(`Warning: Failed to save pending changes manifest: ${errorMessage(error)}`)
    }
  }

  async loadManifest(): Promise<PendingManifest> {
    if (this.database) {
      const stored = pendingRepository.getManifest(this.rootKey)
      if (stored !== null) return parseManifest(stored)
      // First database run: carry over the v1.0 pending set once, then SQLite owns it.
      const legacy = await this.readLegacyManifest()
      const snapshots = await this.readLegacySnapshots()
      pendingRepository.importLegacy(this.rootKey, JSON.stringify(legacy), snapshots)
      return legacy
    }
    return await this.readLegacyManifest()
  }

  private async readLegacyManifest(): Promise<PendingManifest> {
    if (!(await this.exists(this.manifestFile))) return { changes: {}, reads: {} }
    try {
      return parseManifest(await readFile(this.manifestFile, 'utf-8'))
    } catch {
      return { changes: {}, reads: {} }
    }
  }

  private async readLegacySnapshots(): Promise<Array<[string, Buffer]>> {
    let ids: string[]
    try {
      ids = await readdir(this.snapshotsDir)
    } catch {
      return []
    }
    const snapshots: Array<[string, Buffer]> = []
    for (const id of ids) {
      try {
        snapshots.push([id, await readFile(join(this.snapshotsDir, id))])
      } catch {
        /* an unreadable backup snapshot stays on disk */
      }
    }
    return snapshots
  }

  async clearAll(): Promise<void> {
    if (this.database) {
      pendingRepository.clear(this.rootKey)
      // Keep an empty manifest so the legacy files are not imported a second time.
      pendingRepository.saveManifest(this.rootKey, JSON.stringify(EMPTY_MANIFEST))
      return
    }
    try {
      await rm(this.snapshotsDir, { recursive: true, force: true })
      await unlink(this.manifestFile).catch(() => undefined)
      await this.ensureDirs()
    } catch {}
  }

  async listSnapshotIds(): Promise<string[]> {
    if (this.database) return pendingRepository.listSnapshotIds(this.rootKey)
    try {
      return (await readdir(this.snapshotsDir)).sort()
    } catch {
      return []
    }
  }

  private async statOrNull(path: string): Promise<Stats | null> {
    try {
      return await stat(path)
    } catch {
      return null
    }
  }

  private async exists(path: string): Promise<boolean> {
    return (await this.statOrNull(path)) !== null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseManifest(text: string): PendingManifest {
  try {
    const parsed = JSON.parse(text) as Partial<PendingManifest> | null
    if (parsed === null || typeof parsed !== 'object') return { changes: {}, reads: {} }
    return {
      changes: typeof parsed.changes === 'object' && parsed.changes !== null ? parsed.changes : {},
      reads: typeof parsed.reads === 'object' && parsed.reads !== null ? parsed.reads : {}
    }
  } catch {
    return { changes: {}, reads: {} }
  }
}
