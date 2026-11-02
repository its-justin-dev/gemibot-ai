import { ndiff } from './difflib'
import { pySplitlines } from './pystr'

export const FENCE = '`'.repeat(3)

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; items: Array<[string, string]> }
  | { type: 'paragraph'; text: string }

export function escapeMarkup(text: string | null | undefined): string {
  return (text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function computeDiffStats(oldText: string, newText: string): [number, number] {
  const oldLines = pySplitlines(oldText ?? '')
  const newLines = pySplitlines(newText ?? '')
  const diff = ndiff(oldLines, newLines)
  const added = diff.filter((d) => d.startsWith('+ ')).length
  const removed = diff.filter((d) => d.startsWith('- ')).length
  return [added, removed]
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/u
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/u
const LIST_START_RE = /^(\s*)([-*+]|\d+\.)\s+/u
const HEADING_START_RE = /^(#{1,6})\s+/u

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = (text ?? '').split('\n')
  let i = 0
  const n = lines.length

  while (i < n) {
    const line = lines[i]

    if (line.trim().startsWith(FENCE)) {
      const lang = line.trim().slice(3).trim().toLowerCase()
      const codeLines: string[] = []
      i += 1
      while (i < n && !lines[i].trim().startsWith(FENCE)) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < n) i += 1
      blocks.push({ type: 'code', lang: lang || 'text', code: codeLines.join('\n') })
      continue
    }

    const hm = HEADING_RE.exec(line)
    if (hm) {
      blocks.push({ type: 'heading', level: hm[1].length, text: hm[2].trim() })
      i += 1
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      const listItems: Array<[string, string]> = []
      while (i < n) {
        const curLine = lines[i]
        const curLm = LIST_ITEM_RE.exec(curLine)
        if (curLm) {
          listItems.push([curLm[2], curLm[3].trim()])
          i += 1
        } else if (curLine.trim() === '') {
          if (i + 1 < n && LIST_START_RE.test(lines[i + 1])) i += 1
          else break
        } else if (curLine.startsWith('   ') || curLine.startsWith('\t')) {
          if (listItems.length) {
            const [prevM, prevT] = listItems[listItems.length - 1]
            listItems[listItems.length - 1] = [prevM, `${prevT} ${curLine.trim()}`]
          }
          i += 1
        } else break
      }
      blocks.push({ type: 'list', items: listItems })
      continue
    }

    if (!line.trim()) {
      i += 1
      continue
    }

    const paraLines = [line]
    i += 1
    while (i < n) {
      const nextLine = lines[i]
      if (
        nextLine.trim().startsWith(FENCE) ||
        HEADING_START_RE.test(nextLine) ||
        LIST_START_RE.test(nextLine) ||
        !nextLine.trim()
      )
        break
      paraLines.push(nextLine)
      i += 1
    }
    blocks.push({
      type: 'paragraph',
      text: paraLines
        .filter((l) => l.trim())
        .map((l) => l.trim())
        .join(' ')
    })
  }

  return blocks
}
