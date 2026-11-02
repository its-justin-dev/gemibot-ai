import { AppConstants } from '@shared/constants/app-constants'
import { pyIsUpper, pyLen, pySlice, pyStrip } from './pystr'

export function clip(text: string, limit: number = AppConstants.MAX_OUTPUT): string {
  const length = pyLen(text)
  if (length <= limit) return text
  return pySlice(text, 0, limit) + `\n... [truncated ${length - limit} characters]`
}

export function isBinary(data: Uint8Array): boolean {
  const head = data.subarray(0, 8000)
  return head.includes(0)
}

export function safeFence(text: string | null | undefined): string {
  let ticks = '```'
  while ((text ?? '').includes(ticks)) ticks += '`'
  return ticks
}

export function shortenBrother(word: string): string {
  const first = Array.from(word)[0] ?? ''
  if (pyIsUpper(word)) return 'BRO'
  if (pyIsUpper(first)) return 'Bro'
  return 'bro'
}

export function ensureBro(userText: string, reply: string): string {
  const pieces = reply.split(/(```[\s\S]*?```|`[^`\n]*`)/)
  for (let i = 0; i < pieces.length; i += 2) {
    pieces[i] = (pieces[i] ?? '').replace(/\bbrother\b/gi, (m) => shortenBrother(m))
  }
  const out = pieces.join('')
  const saidBro = /\b(bro|brother|kuya)\b/i.test(userText)
  const repliedBro = /\bbro\b/i.test(out)
  if (pyStrip(out) && saidBro && !repliedBro) return `Bro! ${out}`
  return out
}

export function stripMarkdownMarkers(text: string): string {
  if (!text) return ''
  const tokens = text.split(/(```[\s\S]*?```|`[^`\n]+`)/)
  const cleaned: string[] = []
  for (const token of tokens) {
    if (token.startsWith('`')) {
      cleaned.push(token)
    } else {
      const t = token
        .replace(/\*{1,3}(.*?)\*{1,3}/g, '$1')
        .replace(/_{1,3}(.*?)_{1,3}/g, '$1')
        .replaceAll('**', '')
        .replaceAll('__', '')
      cleaned.push(t)
    }
  }
  return cleaned.join('')
}
