import { pyKeepOriginalWs, pyRstrip, pySplitlines } from './pystr'

export type OpcodeTag = 'replace' | 'delete' | 'insert' | 'equal'
export type Opcode = [OpcodeTag, number, number, number, number]
export type MatchBlock = [number, number, number]
export type Junk = ((elt: string) => boolean) | null

function calculateRatio(matches: number, length: number): number {
  if (length) return (2.0 * matches) / length
  return 1.0
}

export class SequenceMatcher {
  a: string[]
  b: string[]
  private b2j = new Map<string, number[]>()
  private bjunk = new Set<string>()
  private isjunk: Junk
  private autojunk: boolean
  private matchingBlocks: MatchBlock[] | null = null
  private opcodes: Opcode[] | null = null
  private fullbcount: Map<string, number> | null = null

  constructor(isjunk: Junk = null, a: string[] = [], b: string[] = [], autojunk = true) {
    this.isjunk = isjunk
    this.autojunk = autojunk
    this.a = []
    this.b = []
    this.setSeqs(a, b)
  }

  setSeqs(a: string[], b: string[]): void {
    this.setSeq1(a)
    this.setSeq2(b)
  }

  setSeq1(a: string[]): void {
    if (a === this.a) return
    this.a = a
    this.matchingBlocks = null
    this.opcodes = null
  }

  setSeq2(b: string[]): void {
    if (b === this.b) return
    this.b = b
    this.matchingBlocks = null
    this.opcodes = null
    this.fullbcount = null
    this.chainB()
  }

  private chainB(): void {
    const b = this.b
    const b2j = new Map<string, number[]>()
    for (let i = 0; i < b.length; i++) {
      const indices = b2j.get(b[i])
      if (indices) indices.push(i)
      else b2j.set(b[i], [i])
    }
    this.b2j = b2j

    const junk = new Set<string>()
    if (this.isjunk) {
      for (const elt of b2j.keys()) if (this.isjunk(elt)) junk.add(elt)
      for (const elt of junk) b2j.delete(elt)
    }
    this.bjunk = junk

    const n = b.length
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1
      const popular: string[] = []
      for (const [elt, idxs] of b2j) if (idxs.length > ntest) popular.push(elt)
      for (const elt of popular) b2j.delete(elt)
    }
  }

  findLongestMatch(
    alo = 0,
    ahi: number | null = null,
    blo = 0,
    bhi: number | null = null
  ): MatchBlock {
    const { a, b, b2j } = this
    const isbjunk = (elt: string): boolean => this.bjunk.has(elt)
    if (ahi === null) ahi = a.length
    if (bhi === null) bhi = b.length
    let besti = alo
    let bestj = blo
    let bestsize = 0

    let j2len = new Map<number, number>()
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>()
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue
        if (j >= bhi!) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        newj2len.set(j, k)
        if (k > bestsize) {
          besti = i - k + 1
          bestj = j - k + 1
          bestsize = k
        }
      }
      j2len = newj2len
    }

    while (besti > alo && bestj > blo && !isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1
      bestj -= 1
      bestsize += 1
    }
    while (
      besti + bestsize < ahi! &&
      bestj + bestsize < bhi! &&
      !isbjunk(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1
    }
    while (besti > alo && bestj > blo && isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1
      bestj -= 1
      bestsize += 1
    }
    while (
      besti + bestsize < ahi! &&
      bestj + bestsize < bhi! &&
      isbjunk(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1
    }

    return [besti, bestj, bestsize]
  }

  getMatchingBlocks(): MatchBlock[] {
    if (this.matchingBlocks !== null) return this.matchingBlocks
    const la = this.a.length
    const lb = this.b.length

    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]]
    const matchingBlocks: MatchBlock[] = []
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi)
      if (k) {
        matchingBlocks.push([i, j, k])
        if (alo < i && blo < j) queue.push([alo, i, blo, j])
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
      }
    }
    matchingBlocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])

    let i1 = 0
    let j1 = 0
    let k1 = 0
    const nonAdjacent: MatchBlock[] = []
    for (const [i2, j2, k2] of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2
      } else {
        if (k1) nonAdjacent.push([i1, j1, k1])
        i1 = i2
        j1 = j2
        k1 = k2
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1])
    nonAdjacent.push([la, lb, 0])
    this.matchingBlocks = nonAdjacent
    return this.matchingBlocks
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes !== null) return this.opcodes
    let i = 0
    let j = 0
    const answer: Opcode[] = []
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: OpcodeTag | '' = ''
      if (i < ai && j < bj) tag = 'replace'
      else if (i < ai) tag = 'delete'
      else if (j < bj) tag = 'insert'
      if (tag) answer.push([tag, i, ai, j, bj])
      i = ai + size
      j = bj + size
      if (size) answer.push(['equal', ai, i, bj, j])
    }
    this.opcodes = answer
    return answer
  }

  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes()
    if (!codes.length) codes = [['equal', 0, 1, 0, 1]]
    codes = codes.slice()
    if (codes[0][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[0]
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]
    }
    if (codes[codes.length - 1][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[codes.length - 1]
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]
    }

    const nn = n + n
    const groups: Opcode[][] = []
    let group: Opcode[] = []
    for (const opcode of codes) {
      const [tag, i1, i2, j1, j2] = opcode
      let next: Opcode = [tag, i1, i2, j1, j2]
      if (tag === 'equal' && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)])
        groups.push(group)
        group = []
        next = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]
      }
      group.push(next)
    }
    if (group.length && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group)
    return groups
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, triple) => sum + triple[2], 0)
    return calculateRatio(matches, this.a.length + this.b.length)
  }

  quickRatio(): number {
    if (this.fullbcount === null) {
      const fullbcount = new Map<string, number>()
      for (const elt of this.b) fullbcount.set(elt, (fullbcount.get(elt) ?? 0) + 1)
      this.fullbcount = fullbcount
    }
    const fullbcount = this.fullbcount
    const avail = new Map<string, number>()
    let matches = 0
    for (const elt of this.a) {
      const numb = avail.has(elt) ? avail.get(elt)! : (fullbcount.get(elt) ?? 0)
      avail.set(elt, numb - 1)
      if (numb > 0) matches += 1
    }
    return calculateRatio(matches, this.a.length + this.b.length)
  }

  realQuickRatio(): number {
    const la = this.a.length
    const lb = this.b.length
    return calculateRatio(Math.min(la, lb), la + lb)
  }
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1
  const length = stop - start
  if (length === 1) return `${beginning}`
  if (!length) beginning -= 1
  return `${beginning},${length}`
}

export function makeUnifiedDiff(
  rel: string,
  oldText: string | null,
  newText: string | null
): string[] {
  return unifiedDiff(
    pySplitLinesForDiff(oldText),
    pySplitLinesForDiff(newText),
    `a/${rel}`,
    `b/${rel}`,
    '',
    '',
    3,
    ''
  )
}

function pySplitLinesForDiff(text: string | null): string[] {
  return pySplitlines(text ?? '')
}

export function unifiedDiff(
  a: string[],
  b: string[],
  fromfile = '',
  tofile = '',
  fromfiledate = '',
  tofiledate = '',
  n = 3,
  lineterm = '\n'
): string[] {
  const out: string[] = []
  let started = false
  for (const group of new SequenceMatcher(null, a, b).getGroupedOpcodes(n)) {
    if (!started) {
      started = true
      const fromdate = fromfiledate ? `\t${fromfiledate}` : ''
      const todate = tofiledate ? `\t${tofiledate}` : ''
      out.push(`--- ${fromfile}${fromdate}${lineterm}`)
      out.push(`+++ ${tofile}${todate}${lineterm}`)
    }
    const first = group[0]
    const last = group[group.length - 1]
    const file1Range = formatRangeUnified(first[1], last[2])
    const file2Range = formatRangeUnified(first[3], last[4])
    out.push(`@@ -${file1Range} +${file2Range} @@${lineterm}`)

    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === 'equal') {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`)
        continue
      }
      if (tag === 'replace' || tag === 'delete') {
        for (const line of a.slice(i1, i2)) out.push(`-${line}`)
      }
      if (tag === 'replace' || tag === 'insert') {
        for (const line of b.slice(j1, j2)) out.push(`+${line}`)
      }
    }
  }
  return out
}

export function isCharacterJunk(ch: string): boolean {
  return ch === ' ' || ch === '\t'
}

class Differ {
  constructor(
    private linejunk: Junk = null,
    private charjunk: Junk = isCharacterJunk
  ) {}

  compare(a: string[], b: string[]): string[] {
    const out: string[] = []
    const cruncher = new SequenceMatcher(this.linejunk, a, b)
    for (const [tag, alo, ahi, blo, bhi] of cruncher.getOpcodes()) {
      if (tag === 'replace') out.push(...this.fancyReplace(a, alo, ahi, b, blo, bhi))
      else if (tag === 'delete') out.push(...this.dump('-', a, alo, ahi))
      else if (tag === 'insert') out.push(...this.dump('+', b, blo, bhi))
      else if (tag === 'equal') out.push(...this.dump(' ', a, alo, ahi))
      else throw new Error(`unknown tag ${tag}`)
    }
    return out
  }

  private dump(tag: string, x: string[], lo: number, hi: number): string[] {
    const out: string[] = []
    for (let i = lo; i < hi; i++) out.push(`${tag} ${x[i]}`)
    return out
  }

  private plainReplace(
    a: string[],
    alo: number,
    ahi: number,
    b: string[],
    blo: number,
    bhi: number
  ): string[] {
    let groups: string[][]
    if (bhi - blo < ahi - alo) groups = [this.dump('+', b, blo, bhi), this.dump('-', a, alo, ahi)]
    else groups = [this.dump('-', a, alo, ahi), this.dump('+', b, blo, bhi)]
    return groups.flat()
  }

  private fancyReplace(
    a: string[],
    alo: number,
    ahi: number,
    b: string[],
    blo: number,
    bhi: number
  ): string[] {
    let bestRatio = 0
    let bestI = 0
    let bestJ = 0
    const cutoff = 0.75
    const cruncher = new SequenceMatcher(this.charjunk)
    let eqI: number | null = null
    let eqJ: number | null = null

    for (let j = blo; j < bhi; j++) {
      const bj = b[j]
      cruncher.setSeq2(charsOf(bj))
      for (let i = alo; i < ahi; i++) {
        const ai = a[i]
        if (ai === bj) {
          if (eqI === null) {
            eqI = i
            eqJ = j
          }
          continue
        }
        cruncher.setSeq1(charsOf(ai))
        if (
          cruncher.realQuickRatio() > bestRatio &&
          cruncher.quickRatio() > bestRatio &&
          cruncher.ratio() > bestRatio
        ) {
          bestRatio = cruncher.ratio()
          bestI = i
          bestJ = j
        }
      }
    }

    if (bestRatio < cutoff) {
      if (eqI === null) return this.plainReplace(a, alo, ahi, b, blo, bhi)
      bestI = eqI
      bestJ = eqJ!
    } else {
      eqI = null
    }

    const out = this.fancyHelper(a, alo, bestI, b, blo, bestJ)

    const aelt = a[bestI]
    const belt = b[bestJ]
    if (eqI === null) {
      let atags = ''
      let btags = ''
      cruncher.setSeqs(charsOf(aelt), charsOf(belt))
      for (const [tag, ai1, ai2, bj1, bj2] of cruncher.getOpcodes()) {
        const la = ai2 - ai1
        const lb = bj2 - bj1
        if (tag === 'replace') {
          atags += '^'.repeat(la)
          btags += '^'.repeat(lb)
        } else if (tag === 'delete') atags += '-'.repeat(la)
        else if (tag === 'insert') btags += '+'.repeat(lb)
        else if (tag === 'equal') {
          atags += ' '.repeat(la)
          btags += ' '.repeat(lb)
        } else throw new Error(`unknown tag ${tag}`)
      }
      out.push(...this.qformat(aelt, belt, atags, btags))
    } else {
      out.push(`  ${aelt}`)
    }

    out.push(...this.fancyHelper(a, bestI + 1, ahi, b, bestJ + 1, bhi))
    return out
  }

  private fancyHelper(
    a: string[],
    alo: number,
    ahi: number,
    b: string[],
    blo: number,
    bhi: number
  ): string[] {
    if (alo < ahi) {
      if (blo < bhi) return this.fancyReplace(a, alo, ahi, b, blo, bhi)
      return this.dump('-', a, alo, ahi)
    }
    if (blo < bhi) return this.dump('+', b, blo, bhi)
    return []
  }

  private qformat(aline: string, bline: string, atags: string, btags: string): string[] {
    const a = pyRstrip(pyKeepOriginalWs(aline, atags))
    const b = pyRstrip(pyKeepOriginalWs(bline, btags))
    const out: string[] = [`- ${aline}`]
    if (a) out.push(`? ${a}\n`)
    out.push(`+ ${bline}`)
    if (b) out.push(`? ${b}\n`)
    return out
  }
}

export function ndiff(
  a: string[],
  b: string[],
  linejunk: Junk = null,
  charjunk: Junk = isCharacterJunk
): string[] {
  return new Differ(linejunk, charjunk).compare(a, b)
}

export function charsOf(text: string): string[] {
  return Array.from(text)
}
