import JSZip from 'jszip'
import { readFile } from 'fs/promises'
import { decode } from 'he'

const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g

interface Token {
  name: string
  attrs: string
  selfClosing: boolean
  isClose: boolean
  contentStart: number
  start: number
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = []
  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(xml))) {
    const raw = match[0]
    tokens.push({
      name: match[2],
      attrs: match[3] ?? '',
      selfClosing: match[4] === '/',
      isClose: match[1] === '/',
      contentStart: match.index + raw.length,
      start: match.index
    })
  }
  return tokens
}

interface Element {
  name: string
  attrs: string
  content: string
}

function findCloseIndex(tokens: Token[], open: number, to: number): number {
  const name = tokens[open].name
  let depth = 1
  for (let j = open + 1; j < to; j++) {
    const scan = tokens[j]
    if (scan.name !== name) continue
    if (scan.isClose) {
      depth -= 1
      if (depth === 0) return j
    } else if (!scan.selfClosing) {
      depth += 1
    }
  }
  return to
}

function directChildren(xml: string, tokens: Token[], from: number, to: number): Element[] {
  const children: Element[] = []
  let i = from
  while (i < to) {
    const token = tokens[i]
    if (token.isClose) {
      i += 1
      continue
    }
    if (token.selfClosing) {
      children.push({ name: token.name, attrs: token.attrs, content: '' })
      i += 1
      continue
    }
    const end = findCloseIndex(tokens, i, to)
    children.push({
      name: token.name,
      attrs: token.attrs,
      content: xml.slice(token.contentStart, end < to ? tokens[end].start : xml.length)
    })
    i = end + 1
  }
  return children
}

function runText(run: Element): string {
  let text = ''
  for (const child of splitTokens(run)) {
    switch (child.name) {
      case 'w:t':
        text += decode(child.content)
        break
      case 'w:tab':
      case 'w:ptab':
        text += '\t'
        break
      case 'w:cr':
        text += '\n'
        break
      case 'w:noBreakHyphen':
        text += '-'
        break
      case 'w:br':
        text += /w:type="[^"]*"/.test(child.attrs) ? '' : '\n'
        break
      default:
        break
    }
  }
  return text
}

function splitTokens(element: Element): Element[] {
  const inner = element.content
  const tokens = tokenize(inner)
  return directChildren(inner, tokens, 0, tokens.length)
}

function paragraphText(paragraph: Element): string {
  let text = ''
  for (const child of splitTokens(paragraph)) {
    if (child.name === 'w:r') {
      text += runText(child)
    } else if (child.name === 'w:hyperlink') {
      for (const run of splitTokens(child)) {
        if (run.name === 'w:r') text += runText(run)
      }
    }
  }
  return text
}

export function paragraphTextsFromDocumentXml(xml: string): string[] {
  const tokens = tokenize(xml)
  const stack: string[] = []
  let bodyChildDepth = -1
  const paragraphs: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    if (token.isClose) {
      stack.pop()
      continue
    }

    if (bodyChildDepth >= 0 && stack.length === bodyChildDepth && token.name === 'w:p') {
      if (token.selfClosing) {
        paragraphs.push('')
        continue
      }
      const end = findCloseIndex(tokens, i, tokens.length)
      paragraphs.push(
        paragraphText({
          name: 'w:p',
          attrs: token.attrs,
          content: xml.slice(
            token.contentStart,
            end < tokens.length ? tokens[end].start : xml.length
          )
        })
      )
      i = end
      continue
    }

    if (token.name === 'w:body' && !token.selfClosing) bodyChildDepth = stack.length + 1
    if (!token.selfClosing) stack.push(token.name)
  }

  return paragraphs
}

export async function docxParagraphTexts(data: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(data)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('word/document.xml not found in document')
  return paragraphTextsFromDocumentXml(await entry.async('string'))
}

export async function docxParagraphTextsFromFile(path: string): Promise<string[]> {
  return docxParagraphTexts(await readFile(path))
}
