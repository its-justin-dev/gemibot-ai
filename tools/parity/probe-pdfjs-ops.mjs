// Scratch probe: the raw operator list pdfjs produces for a page.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fx = join(here, 'tests', 'fixtures')
const fonts = pathToFileURL(join(here, 'node_modules', 'pdfjs-dist', 'standard_fonts')).href
const name = process.argv[2] || 'oracle-report.pdf'
const doc = await getDocument({
  data: new Uint8Array(readFileSync(join(fx, name))),
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: true,
  standardFontDataUrl: `${fonts}/`
}).promise
const names = new Map(Object.entries(OPS).map(([k, v]) => [v, k]))
for (let p = 1; p <= doc.numPages; p += 1) {
  const page = await doc.getPage(p)
  const list = await page.getOperatorList()
  console.log(`##### ${name} page ${p}: ${list.fnArray.length} ops`)
  for (let i = 0; i < list.fnArray.length; i += 1) {
    const arg = list.argsArray[i]
    let out
    if (Array.isArray(arg) && arg.length > 0 && Array.isArray(arg[0])) {
      // showText / showTextWithSpacing: [glyphs][]
      out = arg
        .map((chunk) =>
          Array.isArray(chunk)
            ? JSON.stringify(chunk.map((g) => g.unicode ?? '?').join('')) +
              ` w=${chunk.reduce((s, g) => s + (g.width || 0), 0)}`
            : String(chunk)
        )
        .join(' | ')
    } else {
      out = JSON.stringify(arg)?.slice(0, 100)
    }
    console.log(`${names.get(list.fnArray[i]) ?? list.fnArray[i]}: ${out}`)
  }
}
