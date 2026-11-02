import { pyExpandtabs, pyIsAllSpace, pyLen, pyLstrip, pyRstrip, pySlice } from './pystr'

const WHITESPACE_CLASS = '[\\t\\n\\v\\f\\r ]'
const WORD_PUNCT = '[\\p{L}\\p{N}_!"\'&.,?]'
const LETTER = '[\\p{L}_]'
const NON_WHITESPACE = '[^\\t\\n\\v\\f\\r ]'
const WORD_CHAR = '[\\p{L}\\p{N}_]'

const wordsepRe = new RegExp(
  `(${WHITESPACE_CLASS}+` +
    `|(?<=${WORD_PUNCT})-{2,}(?=${WORD_CHAR})` +
    `|${NON_WHITESPACE}+?(?:` +
    `-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})` +
    `|(?=${WHITESPACE_CLASS}|$)` +
    `|(?<=${WORD_PUNCT})(?=-{2,}${WORD_CHAR})` +
    `))`,
  'gu'
)

const wordsepSimpleRe = new RegExp(`(${WHITESPACE_CLASS}+)`, 'gu')

export interface TextWrapOptions {
  width?: number
  initialIndent?: string
  subsequentIndent?: string
  expandTabs?: boolean
  replaceWhitespace?: boolean
  fixSentenceEndings?: boolean
  breakLongWords?: boolean
  dropWhitespace?: boolean
  breakOnHyphens?: boolean
  tabsize?: number
  maxLines?: number | null
  placeholder?: string
}

const WHITESPACE_TRANS = /[\t\n\v\f\r ]/gu

export class TextWrapper {
  width: number
  initialIndent: string
  subsequentIndent: string
  expandTabs: boolean
  replaceWhitespace: boolean
  fixSentenceEndings: boolean
  breakLongWords: boolean
  dropWhitespace: boolean
  breakOnHyphens: boolean
  tabsize: number
  maxLines: number | null
  placeholder: string

  constructor(options: TextWrapOptions = {}) {
    this.width = options.width ?? 70
    this.initialIndent = options.initialIndent ?? ''
    this.subsequentIndent = options.subsequentIndent ?? ''
    this.expandTabs = options.expandTabs ?? true
    this.replaceWhitespace = options.replaceWhitespace ?? true
    this.fixSentenceEndings = options.fixSentenceEndings ?? false
    this.breakLongWords = options.breakLongWords ?? true
    this.dropWhitespace = options.dropWhitespace ?? true
    this.breakOnHyphens = options.breakOnHyphens ?? true
    this.tabsize = options.tabsize ?? 8
    this.maxLines = options.maxLines ?? null
    this.placeholder = options.placeholder ?? ' [...]'
  }

  private mungeWhitespace(text: string): string {
    let out = text
    if (this.expandTabs) out = pyExpandtabs(out, this.tabsize)
    if (this.replaceWhitespace) out = out.replace(WHITESPACE_TRANS, ' ')
    return out
  }

  private split(text: string): string[] {
    const re = this.breakOnHyphens ? wordsepRe : wordsepSimpleRe
    const chunks = text.split(re).filter((c): c is string => c.length > 0)
    return chunks
  }

  private fixSentenceEndingsIn(chunks: string[]): void {
    const sentenceEndRe = /[a-z][.!]['"]?$/u
    let i = 0
    while (i < chunks.length - 1) {
      if (chunks[i + 1] === ' ' && sentenceEndRe.test(chunks[i])) {
        chunks[i + 1] = '  '
        i += 2
      } else i += 1
    }
  }

  private handleLongWord(
    reversedChunks: string[],
    curLine: string[],
    curLen: number,
    width: number
  ): void {
    const spaceLeft = width < 1 ? 1 : width - curLen
    if (this.breakLongWords && spaceLeft > 0) {
      let end = spaceLeft
      const chunk = reversedChunks[reversedChunks.length - 1]
      if (this.breakOnHyphens && pyLen(chunk) > spaceLeft) {
        const head = pySlice(chunk, 0, spaceLeft)
        const hyphen = head.lastIndexOf('-')
        if (hyphen > 0 && Array.from(head.slice(0, hyphen)).some((c) => c !== '-')) end = hyphen + 1
      }
      curLine.push(pySlice(chunk, 0, end))
      reversedChunks[reversedChunks.length - 1] = pySlice(chunk, end)
    } else if (!curLine.length) {
      curLine.push(reversedChunks.pop()!)
    }
  }

  private wrapChunks(inputChunks: string[]): string[] {
    const lines: string[] = []
    if (this.width <= 0) throw new Error(`invalid width ${this.width} (must be > 0)`)
    let indent: string
    if (this.maxLines !== null) {
      indent = this.maxLines > 1 ? this.subsequentIndent : this.initialIndent
      if (pyLen(indent) + pyLen(this.placeholder.replace(/^ +/, '')) > this.width)
        throw new Error('placeholder too large for max width')
    }

    const chunks = inputChunks.slice().reverse()

    while (chunks.length) {
      const curLine: string[] = []
      let curLen = 0
      indent = lines.length ? this.subsequentIndent : this.initialIndent
      const width = this.width - pyLen(indent)

      if (this.dropWhitespace && pyIsAllSpace(chunks[chunks.length - 1]) && lines.length)
        chunks.pop()

      while (chunks.length) {
        const l = pyLen(chunks[chunks.length - 1])
        if (curLen + l <= width) {
          curLine.push(chunks.pop()!)
          curLen += l
        } else break
      }

      if (chunks.length && pyLen(chunks[chunks.length - 1]) > width) {
        this.handleLongWord(chunks, curLine, curLen, width)
        curLen = curLine.reduce((sum, c) => sum + pyLen(c), 0)
      }

      if (this.dropWhitespace && curLine.length && pyIsAllSpace(curLine[curLine.length - 1])) {
        curLen -= pyLen(curLine[curLine.length - 1])
        curLine.pop()
      }

      if (curLine.length) {
        const lastChunkIsBlank =
          !chunks.length || (this.dropWhitespace && chunks.length === 1 && pyIsAllSpace(chunks[0]))
        if (
          this.maxLines === null ||
          lines.length + 1 < this.maxLines ||
          (lastChunkIsBlank && curLen <= width)
        ) {
          lines.push(indent + curLine.join(''))
        } else {
          let broke = false
          while (curLine.length) {
            if (
              !pyIsAllSpace(curLine[curLine.length - 1]) &&
              curLen + pyLen(this.placeholder) <= width
            ) {
              curLine.push(this.placeholder)
              lines.push(indent + curLine.join(''))
              broke = true
              break
            }
            curLen -= pyLen(curLine[curLine.length - 1])
            curLine.pop()
          }
          if (!broke) {
            if (lines.length) {
              const prevLine = pyRstrip(lines[lines.length - 1])
              if (pyLen(prevLine) + pyLen(this.placeholder) <= this.width) {
                lines[lines.length - 1] = prevLine + this.placeholder
                break
              }
            }
            lines.push(indent + pyLstrip(this.placeholder))
          }
          break
        }
      }
    }

    return lines
  }

  private splitChunks(text: string): string[] {
    return this.split(this.mungeWhitespace(text))
  }

  wrap(text: string): string[] {
    const chunks = this.splitChunks(text)
    if (this.fixSentenceEndings) this.fixSentenceEndingsIn(chunks)
    return this.wrapChunks(chunks)
  }

  fill(text: string): string {
    return this.wrap(text).join('\n')
  }
}

export function wrap(text: string, width: number, options: TextWrapOptions = {}): string[] {
  return new TextWrapper({ ...options, width }).wrap(text)
}

export function fill(text: string, width: number, options: TextWrapOptions = {}): string {
  return new TextWrapper({ ...options, width }).fill(text)
}

export function shorten(text: string, width: number, options: TextWrapOptions = {}): string {
  const w = new TextWrapper({ ...options, width, maxLines: 1 })
  return w.fill(text.trim().split(/\s+/u).filter(Boolean).join(' '))
}
