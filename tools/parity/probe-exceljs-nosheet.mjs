// Probe: how does exceljs answer for the damaged workbooks the v1.0 oracle pinned in
// `.recovered/oracle-corrupt.txt`?  Only `corrupt-nosheet.xlsx` (a declared sheet whose part was
// removed) is in question — openpyxl silently drops it, and the oracle shows read/analyze/write
// all succeeding with the remaining sheet.  Run: node tools/parity/probe-exceljs-nosheet.mjs
import { readFile } from 'fs/promises'
import { join } from 'path'

import ExcelJS from 'exceljs'

const fx = join(import.meta.dirname, '..', '..', 'tests', 'fixtures')

for (const name of ['corrupt-nosheet.xlsx', 'corrupt-norel.xlsx', 'oracle-sample.xlsx']) {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(await readFile(join(fx, name)))
    console.log(`${name}: sheets=${JSON.stringify(wb.worksheets.map((w) => w.name))}`)
    for (const ws of wb.worksheets) {
      console.log(
        `  ${ws.name}: rows=${ws.rowCount} actual=${ws.actualRowCount} cols=${ws.columnCount}`
      )
    }
  } catch (e) {
    console.log(`${name}: ${e.constructor.name}: ${e.message}`)
  }
}
