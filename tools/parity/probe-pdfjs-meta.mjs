// Scratch probe: pdfjs document-level metadata + page text for every pdf fixture,
// so the port's analyze/read mappings are written against observed values, not guesses.
// Plain JS has no way to write the return type this rule asks for.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fx = join(here, 'tests', 'fixtures')
const fonts =
  join(here, 'node_modules', 'pdfjs-dist', 'standard_fonts').replace(
    /\\/gu,
    '/'
  ) + '/'

const NAMES = new Map(Object.entries(OPS).map(([k, v]) => [v, k]))
const BREAK = new Set(['beginText', 'endText', 'nextLine', 'moveText', 'moveTextSetLeading'])

function pageText(list) {
  const lines = []
  let cur = ''
  const flush = () => {
    if (cur !== '') {
      lines.push(cur)
      cur = ''
    }
  }
  for (let i = 0; i < list.fnArray.length; i += 1) {
    const n = NAMES.get(list.fnArray[i])
    if (!n) continue
    if (BREAK.has(n)) flush()
    else if (n === 'showText' || n === 'showTextWithSpacing') {
      for (const chunk of list.argsArray[i]) {
        if (Array.isArray(chunk)) cur += chunk.map((g) => g.unicode).join('')
      }
    }
  }
  flush()
  return lines.join('\n')
}

for (const name of [
  'oracle-report.pdf',
  'oracle-meta.pdf',
  'oracle-empty.pdf',
  'oracle-titled.pdf',
  'oracle-openenc.pdf',
  'oracle-pages.pdf',
  'oracle-secret.pdf',
  'oracle-junk.pdf',
  'oracle-unicode.pdf'
]) {
  console.log(`##### ${name}`)
  let doc
  try {
    doc = await getDocument({
      data: new Uint8Array(readFileSync(join(fx, name))),
      isEvalSupported: false,
      disableFontFace: true,
      standardFontDataUrl: fonts
    }).promise
  } catch (e) {
    console.log('  LOAD ERROR', e?.name ?? typeof e, JSON.stringify(e?.message ?? e))
    continue
  }
  const meta = await doc.getMetadata()
  console.log('  numPages', doc.numPages, 'fingerprint', typeof doc.fingerprints)
  const info = {}
  for (const [k, v] of Object.entries(meta.info ?? {})) {
    info[k] = typeof v === 'object' ? JSON.stringify(v) : v
  }
  console.log('  info', JSON.stringify(info))
  for (let p = 1; p <= Math.min(doc.numPages, 2); p += 1) {
    const page = await doc.getPage(p)
    const text = pageText(await page.getOperatorList())
    console.log(`  page ${p} text: ${JSON.stringify(text)}`)
    const vp = page.getViewport({ scale: 1 })
    console.log(`  page ${p} size: ${vp.width} x ${vp.height}`)
  }
}
