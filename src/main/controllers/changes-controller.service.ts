import { C } from '../../shared/constants/colors'
import { ChangeType } from '../../shared/models/file-change'
import { pyLjust, pyStrip } from '../../shared/utils/pystr'
import type { ChangesSummary } from '../../shared/types/changes'
import { out } from '../utils/console-out'
import { ChangeTracker } from '../services/change-tracker.service'

export interface ChangesDrawerWidget {
  updateData(summary: ChangesSummary): void
}

export class ChangesController {
  private drawer: ChangesDrawerWidget | null = null

  constructor(private readonly tracker: ChangeTracker) {
    this.tracker.onChangesUpdated = (summary) => this.onTrackerUpdated(summary)
    if (this.drawer) this.drawer.updateData(this.tracker.getSummary())
  }

  setDrawerWidget(drawer: ChangesDrawerWidget | null): void {
    this.drawer = drawer
    if (this.drawer) {
      try {
        this.drawer.updateData(this.tracker.getSummary())
      } catch {}
    }
  }

  private onTrackerUpdated(summary: ChangesSummary): void {
    if (!this.drawer) return
    try {
      this.drawer.updateData(summary)
    } catch {}
  }

  async acceptAll(): Promise<string[]> {
    return await this.tracker.acceptAll()
  }

  async rejectAll(): Promise<string[]> {
    return await this.tracker.rejectAll()
  }

  async acceptFile(relPath: string): Promise<boolean> {
    return await this.tracker.acceptFile(relPath)
  }

  async rejectFile(relPath: string): Promise<boolean> {
    return await this.tracker.rejectFile(relPath)
  }

  getSummary(): ChangesSummary {
    return this.tracker.getSummary()
  }

  printCliDetails(): void {
    const summary = this.tracker.getSummary()
    const changes = summary.changes
    const reads = summary.files_read

    out(`\n${C.BOLD}Pending Changes Review (${changes.length} files)${C.RESET}`)
    out(`${C.GRAY}${'-'.repeat(65)}${C.RESET}`)
    if (changes.length === 0) {
      out(`  ${C.DIM}No pending changes.${C.RESET}`)
    } else {
      for (const c of changes) {
        const ctype = c.change_type ?? 'Modified'
        const path = c.path ?? ''
        const timestamp = c.timestamp ?? ''
        const t = timestamp.includes(' ') ? (timestamp.split(' ').at(-1) ?? '') : timestamp
        const col =
          ctype === ChangeType.ADDED
            ? C.GREEN
            : ctype === ChangeType.MODIFIED
              ? C.BLUE
              : ctype === ChangeType.DELETED
                ? C.RED
                : C.MAGENTA
        out(
          `  ${col}[${pyLjust(ctype, 15)}]${C.RESET} ${C.BOLD}${pyLjust(path, 35)}${C.RESET} ` +
            `${C.DIM}${t}${C.RESET}`
        )
      }
    }

    if (reads.length > 0) {
      const listed = reads
        .slice(0, 10)
        .map((r) => r.path)
        .join(', ')
      out(
        `\n${C.DIM}Files read (${reads.length}): ${listed}${reads.length > 10 ? ' ...' : ''}${C.RESET}`
      )
    }
    out(`${C.GRAY}${'-'.repeat(65)}${C.RESET}\n`)
  }

  async handleCliCommand(cmd: string): Promise<'accepted' | 'rejected' | 'viewed' | null> {
    const c = pyStrip(cmd).toLowerCase()
    if (c === '/accept' || c === '/accept_all' || c === 'accept') {
      const accepted = await this.acceptAll()
      out(
        `\n  ${C.GREEN}✓ Accepted all pending changes (${accepted.length} files kept).${C.RESET}\n`
      )
      return 'accepted'
    }
    if (c === '/reject' || c === '/reject_all' || c === 'reject') {
      const rejected = await this.rejectAll()
      out(
        `\n  ${C.RED}✕ Rejected all pending changes (${rejected.length} files restored to ` +
          `original state).${C.RESET}\n`
      )
      return 'rejected'
    }
    if (c === '/changes' || c === '/pending' || c === 'changes') {
      this.printCliDetails()
      return 'viewed'
    }
    return null
  }
}
