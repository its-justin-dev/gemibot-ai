// Scratch probe: the raw glyph objects pdfjs hands back for a showText run.
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

const names = new Map(Object.entries(OPS).map(([k, v]) => [v, k]))
for (const name of process.argv.slice(2)) {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(join(fx, name))),
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: fonts
  }).promise
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p)
    const list = await page.getOperatorList()
    console.log(`##### ${name} page ${p}`)
    for (let i = 0; i < list.fnArray.length; i += 1) {
      const n = names.get(list.fnArray[i])
      const arg = list.argsArray[i]
      if (n === 'showText' || n === 'showTextWithSpacing') {
        console.log(`${n}: ${JSON.stringify(Array.from(arg[0]).slice(-2))}`)
      } else if (n === 'setFont') {
        console.log(`${n}: ${JSON.stringify(arg)}`)
      } else if (n === 'beginText' || n === 'endText' || n === 'nextLine') {
        console.log(`${n}: ${JSON.stringify(arg ?? null)}`)
      } else if (n === 'setTextMatrix') {
        console.log(`${n}: ${JSON.stringify([arg[4], arg[5]])}`)
      }
    }
  }
}
