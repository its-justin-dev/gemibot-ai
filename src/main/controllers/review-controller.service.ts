import { errorMessage } from '../../shared/utils/exceptions'
import { FileChange, type FileChangeDict } from '../../shared/models/file-change'
import type { FileDiff } from '../../shared/models/file-diff'
import { out } from '../utils/console-out'
import { DiffService } from '../services/diff.service'
import type { ChangeTracker } from '../services/change-tracker.service'

export class ReviewController {
  private readonly tracker: ChangeTracker
  private readonly diffService: DiffService
  private readonly onClose: (() => void) | null
  private panelOpen = false
  private panelClosed = false

  constructor(deps: { tracker: ChangeTracker; diffService: DiffService; onClose?: () => void }) {
    this.tracker = deps.tracker
    this.diffService = deps.diffService
    this.onClose = deps.onClose ?? null
  }

  getPendingChanges(): FileChangeDict[] {
    return this.tracker.getSummary().changes.map((c) => FileChange.fromDict(c).toDict())
  }

  async getFileDiff(relPath: string): Promise<FileDiff | null> {
    const change = this.tracker.pendingChanges.get(this.tracker.normalizePath(relPath))
    if (!change) return null
    return await this.diffService.computeDiff(
      change.path,
      change.change_type,
      change.snapshot_id,
      change.original_exists,
      change.is_binary,
      change.full_path
    )
  }

  async acceptFile(relPath: string): Promise<boolean> {
    return await this.tracker.acceptFile(relPath)
  }

  async rejectFile(relPath: string): Promise<boolean> {
    return await this.tracker.rejectFile(relPath)
  }

  async acceptAll(): Promise<string[]> {
    return await this.tracker.acceptAll()
  }

  async rejectAll(): Promise<string[]> {
    return await this.tracker.rejectAll()
  }

  openReviewPanel(): FileChangeDict[] | null {
    const fileChanges = this.getPendingChanges()
    if (fileChanges.length === 0) return null
    this.panelClosed = false
    this.panelOpen = true
    return fileChanges
  }

  onPanelDestroy(): void {
    if (this.panelClosed) return
    this.panelClosed = true
    this.panelOpen = false
    if (this.onClose) {
      try {
        this.onClose()
      } catch {}
    }
  }

  async safeAcceptFile(path: string): Promise<boolean> {
    try {
      return await this.tracker.acceptFile(path)
    } catch (e) {
      out(`Error accepting file: ${errorMessage(e)}`)
      return false
    }
  }

  async safeRejectFile(path: string): Promise<boolean> {
    try {
      return await this.tracker.rejectFile(path)
    } catch (e) {
      out(`Error rejecting file: ${errorMessage(e)}`)
      return false
    }
  }

  async safeAcceptAll(): Promise<string[]> {
    try {
      return await this.tracker.acceptAll()
    } catch (e) {
      out(`Error accepting all: ${errorMessage(e)}`)
      return []
    }
  }

  async safeRejectAll(): Promise<string[]> {
    try {
      return await this.tracker.rejectAll()
    } catch (e) {
      out(`Error rejecting all: ${errorMessage(e)}`)
      return []
    }
  }

  closeReviewPanel(): void {
    if (!this.panelOpen) return
    this.panelOpen = false
  }
}
