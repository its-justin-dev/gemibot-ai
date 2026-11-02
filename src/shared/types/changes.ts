import type { FileChangeDict } from '../models/file-change'

export interface ChangesSummary {
  total_changes: number
  counts: Record<string, number>
  changes: FileChangeDict[]
  files_read: Array<{ path: string; time: string }>
}
