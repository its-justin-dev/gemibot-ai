import { DiffHunk, DiffLine, DiffLineType } from '../models/file-diff'
import { pyInt, pySplitWords } from './pystr'

export function parseUnifiedDiff(diffLines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let oldLineNum = 1
  let newLineNum = 1

  for (const line of diffLines) {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk)

      const parts = pySplitWords(line)
      if (parts.length < 3) continue

      try {
        const oldPart = parts[1]
        const newPart = parts[2]

        const oldStart = pyInt(oldPart.split(',')[0].slice(1))
        const oldCount = oldPart.includes(',') ? pyInt(oldPart.split(',')[1]) : 1
        const newStart = pyInt(newPart.split(',')[0].slice(1))
        const newCount = newPart.includes(',') ? pyInt(newPart.split(',')[1]) : 1

        currentHunk = new DiffHunk({
          header: line,
          old_start: oldStart,
          old_count: oldCount,
          new_start: newStart,
          new_count: newCount
        })
        oldLineNum = oldStart
        newLineNum = newStart
      } catch {
        continue
      }
    } else if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.lines.push(new DiffLine(line.slice(1), null, DiffLineType.REMOVED, oldLineNum))
        oldLineNum += 1
      } else if (line.startsWith('+')) {
        currentHunk.lines.push(new DiffLine(line.slice(1), newLineNum, DiffLineType.ADDED))
        newLineNum += 1
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push(
          new DiffLine(line.slice(1), newLineNum, DiffLineType.CONTEXT, oldLineNum)
        )
        oldLineNum += 1
        newLineNum += 1
      }
    }
  }

  if (currentHunk) hunks.push(currentHunk)
  return hunks
}
