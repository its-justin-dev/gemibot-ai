import { copyFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onConsoleOutput } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'

/**
 * What `pdf_read`/`pdf_analyze` answer when the file is not a PDF at all. The model reaches for
 * `pdf_read` by name, and a Word file used to come back as `PdfStreamError: Stream has ended
 * unexpectedly`, which points at nothing. A genuinely broken PDF still gets that v1 error.
 */

const FX = (name: string): string => join(__dirname, '../fixtures', name)

let root = ''
let detach: (() => void) | null = null

async function makeAgent(): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-pdf-'))
  return await Agent.create({
    root,
    model: 'gemini-3.5-flash-lite',
    autoYes: true,
    apiKey: 'parity-test-placeholder',
    choose: async () => null
  })
}

async function run(agent: Agent, tool: string, path: string): Promise<string> {
  const res = await agent.tools.execute(tool, { path })
  return String(res.error ?? res.output)
}

async function stageFixture(name: string, as: string): Promise<string> {
  await copyFile(FX(name), join(root, as))
  return as
}

beforeEach(() => {
  detach = onConsoleOutput(() => undefined)
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
})

afterEach(async () => {
  detach?.()
  detach = null
  vi.restoreAllMocks()
  const pending = root
  root = ''
  await rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined
  )
})

describe('the pdf readers on a file that is not a pdf', () => {
  it('names the reader for a Word document', async () => {
    const agent = await makeAgent()
    const path = await stageFixture('oracle-sample.docx', 'sms-documentation.docx')
    expect(await run(agent, 'pdf_read', path)).toBe(
      'Not a PDF: sms-documentation.docx is an Office document. Use docx_read instead.'
    )
    expect(await run(agent, 'pdf_analyze', path)).toBe(
      'Not a PDF: sms-documentation.docx is an Office document. Use docx_read instead.'
    )
  })

  it('names the reader for a spreadsheet and a deck', async () => {
    const agent = await makeAgent()
    expect(
      await run(agent, 'pdf_read', await stageFixture('oracle-sample.xlsx', 'sheet.xlsx'))
    ).toBe('Not a PDF: sheet.xlsx is an Office document. Use excel_read instead.')
    expect(await run(agent, 'pdf_read', await stageFixture('oracle-rich.pptx', 'deck.pptx'))).toBe(
      'Not a PDF: deck.pptx is an Office document. Use pptx_read instead.'
    )
  })

  it('follows the bytes, not the extension', async () => {
    const agent = await makeAgent()
    const path = await stageFixture('oracle-sample.docx', 'invoice.pdf')
    expect(await run(agent, 'pdf_read', path)).toContain('Use docx_read instead.')
  })

  it('keeps the v1 stream error for a file that is only junk', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'junk.pdf'), 'not a pdf at all\n')
    expect(await run(agent, 'pdf_read', 'junk.pdf')).toBe(
      'PdfStreamError: Stream has ended unexpectedly'
    )
  })

  it('reads a real pdf untouched', async () => {
    const agent = await makeAgent()
    const path = await stageFixture('oracle-report.pdf', 'report.pdf')
    const out = await run(agent, 'pdf_read', path)
    expect(out).toContain(`PDF File: ${path} (Total pages:`)
    const bytes = await readFile(FX('oracle-report.pdf'))
    expect(await readFile(join(root, path))).toEqual(bytes)
  })
})
