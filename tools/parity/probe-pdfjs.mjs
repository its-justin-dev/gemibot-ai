// Scratch probe: what does pdfjs-dist hand back for the oracle PDF fixtures?
// Usage: node tools/parity/probe-pdfjs.mjs [file.pdf ...]
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fx = join(here, 'tests', 'fixtures')
const fonts = pathToFileURL(join(here, 'node_modules', 'pdfjs-dist', 'standard_fonts')).href
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['oracle-report.pdf', 'oracle-meta.pdf']

for (const name of files) {
  const data = new Uint8Array(readFileSync(join(fx, name)))
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    standardFontDataUrl: `${fonts}/`
  }).promise
  console.log(`##### ${name} pages=${doc.numPages}`)
  console.log('info:', JSON.stringify((await doc.getMetadata()).info))
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p)
    for (const combine of [true, false]) {
      const tc = await page.getTextContent({ disableCombineTextItems: combine })
      console.log(`--- page ${p} disableCombineTextItems=${combine} items=${tc.items.length}`)
      for (const it of tc.items) {
        console.log(
          JSON.stringify({
            s: it.str,
            eol: it.hasEOL,
            x: Math.round(it.transform[4] * 100) / 100,
            y: it.transform[5],
            w: Math.round(it.width * 100) / 100
          })
        )
      }
    }
  }
}
