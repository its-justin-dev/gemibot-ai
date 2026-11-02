// Scratch probe: what does the main-thread FontFaceObject expose for a loaded font?
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fx = join(here, 'tests', 'fixtures')
const fonts =
  join(here, 'node_modules', 'pdfjs-dist', 'standard_fonts').replace(
    /\\/gu,
    '/'
  ) + '/'

const doc = await getDocument({
  data: new Uint8Array(readFileSync(join(fx, process.argv[2] || 'oracle-unicode.pdf'))),
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: fonts
}).promise
const page = await doc.getPage(1)
await page.getOperatorList()
for (const id of ['g_d0_f1', 'g_d0_f2', 'g_d0_f3']) {
  const obj = page.commonObjs.get(id)
  const out = {}
  for (const k of [
    'fallbackName',
    'vertical',
    'isType3Font',
    'black',
    'bold',
    'italic',
    'mimetype',
    'cssFontInfo',
    'systemFontInfo',
    'fontMatrix',
    'bbox',
    'loadedName',
    'isInvalidPDFjsFont',
    'fontExtraProperties',
    'disableFontFace',
    'missingFile'
  ]) {
    try {
      out[k] = obj[k]
    } catch (e) {
      out[k] = `THROW ${e.message}`
    }
  }
  const d = obj.data
  console.log(id, JSON.stringify(out), 'dataBytes=' + (d?.byteLength ?? 'none'))
}
