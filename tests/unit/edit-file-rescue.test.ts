import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onConsoleOutput } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'

/**
 * v2 extensions to `edit_file`, beyond the v1.0 behaviour pinned in parity-tools.test.ts.
 * The model reads with `read_file`, whose answer is decorated with "    N| " prefixes and a
 * trailing "[lines a-b of c]", and then pastes that decoration into `old_string`.
 */

let root = ''
let detach: (() => void) | null = null

async function makeAgent(): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-rescue-'))
  return await Agent.create({
    root,
    model: 'gemini-3.5-flash-lite',
    autoYes: true,
    apiKey: 'parity-test-placeholder',
    choose: async () => null
  })
}

async function run(agent: Agent, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await agent.tools.execute('edit_file', args)
}

function output(result: Record<string, unknown>): string {
  return String(result.output ?? result.error)
}

/** The v1.0 refusal, which stays byte-identical as the first line of the message. */
const NOT_FOUND =
  'old_string was not found. Read the file again and copy the exact text including spaces ' +
  'and indentation, without line number prefixes'

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

describe('edit_file pasted read_file output', () => {
  it('matches through the line number prefixes', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: '    1| alpha\n    2| beta',
          new_string: 'ALPHA\nBETA'
        })
      )
    ).toBe('Updated notes.txt')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('ALPHA\nBETA\n')
  })

  it('matches through the prefixes and the truncation footer together', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: '    1| alpha\n    2| beta\n    3| gamma\n[lines 1-3 of 3]',
          new_string: '    1| alpha\n    2| BETA\n    3| gamma\n[lines 1-3 of 3]'
        })
      )
    ).toBe('Updated notes.txt')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('leaves a real match alone when the file itself holds prefixed lines', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'log.md'), '    1| alpha\n    2| beta\n')
    expect(
      output(
        await run(agent, {
          path: 'log.md',
          old_string: '    1| alpha\n    2| beta',
          new_string: '    1| alpha\n    2| BETA'
        })
      )
    ).toBe('Updated log.md')
    expect(await readFile(join(root, 'log.md'), 'utf-8')).toBe('    1| alpha\n    2| BETA\n')
  })

  it('keeps refusing a string that is only decoration', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: '\n[lines 1-45 of 45]',
          new_string: 'x'
        })
      )
    ).toBe(NOT_FOUND)
  })

  it('still counts occurrences of an undecorated match', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'x\ny\nx\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: '    1| x\n',
          new_string: '    2| q\n'
        })
      )
    ).toBe(
      'old_string appears 2 times. Add more surrounding lines to make it unique, or set replace_all to true'
    )
  })

  it('does not strip prefixes from a partial paste', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\n')
    const message = output(
      await run(agent, {
        path: 'notes.txt',
        old_string: '    1| alpha\nbeta',
        new_string: 'done'
      })
    )
    expect(message.startsWith(NOT_FOUND)).toBe(true)
    expect(message).toContain('The closest text in notes.txt is at line 1')
  })

  it('does not treat an unpadded "1| " list row as decoration', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\n')
    const message = output(
      await run(agent, {
        path: 'notes.txt',
        old_string: '1| alpha\n1| beta',
        new_string: 'done'
      })
    )
    expect(message.startsWith(NOT_FOUND)).toBe(true)
    expect(message).toContain('The closest text in notes.txt is at line 1')
  })

  it('matches a CRLF old_string against the LF text the tool reads', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: 'two\r\n',
          new_string: 'TWO\n'
        })
      )
    ).toBe('Updated notes.txt')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('one\nTWO\n')
  })
})

/**
 * The other way a paste goes wrong: the model retypes the block, so the trailing spaces vanish and
 * the whole thing lands a level or two off the file's indentation. `gemini-2.5-flash-lite` does
 * this repeatedly, and each refusal costs a step.
 */
describe('edit_file retyped block', () => {
  it('matches a block whose trailing spaces were dropped', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha   \nbeta\n')
    expect(
      output(await run(agent, { path: 'notes.txt', old_string: 'alpha\nbeta', new_string: 'A\nB' }))
    ).toBe('Updated notes.txt')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('A\nB\n')
  })

  it('keeps the file indentation when the model pastes a block flush left', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'block.js'), '  if (ok) {\n    doThing()\n  }\n')
    expect(
      output(
        await run(agent, {
          path: 'block.js',
          old_string: 'if (ok) {\n  doThing()\n}',
          new_string: 'if (ok) {\n  doOther()\n}'
        })
      )
    ).toBe('Updated block.js')
    expect(await readFile(join(root, 'block.js'), 'utf-8')).toBe(
      '  if (ok) {\n    doOther()\n  }\n'
    )
  })

  it('shifts a block the model over-indented back down to the file', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'block.js'), '  save()\n')
    expect(
      output(
        await run(agent, { path: 'block.js', old_string: '    save()', new_string: '    load()' })
      )
    ).toBe('Updated block.js')
    expect(await readFile(join(root, 'block.js'), 'utf-8')).toBe('  load()\n')
  })

  it('does not guess indentation across a tab', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'tabs.js'), '\tif (ok) {\n\t\tdoThing()\n\t}\n')
    expect(
      output(
        await run(agent, {
          path: 'tabs.js',
          old_string: 'if (ok) {\n  doThing()\n}',
          new_string: 'if (ok) {\n  doOther()\n}'
        })
      )
    ).toBe('Updated tabs.js')
    expect(await readFile(join(root, 'tabs.js'), 'utf-8')).toBe('if (ok) {\n  doOther()\n}\n')
  })

  it('refuses a block that matches twice instead of editing the first one', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'twice.js'), '  one  \n  two  \n\n  one  \n  two  \n')
    expect(
      output(await run(agent, { path: 'twice.js', old_string: 'one\ntwo', new_string: 'x\ny' }))
    ).toBe(
      'old_string appears 2 times. Add more surrounding lines to make it unique, or set replace_all to true'
    )
    expect(await readFile(join(root, 'twice.js'), 'utf-8')).toBe(
      '  one  \n  two  \n\n  one  \n  two  \n'
    )
    expect(
      output(
        await run(agent, {
          path: 'twice.js',
          old_string: 'one\ntwo',
          new_string: 'x\ny',
          replace_all: true
        })
      )
    ).toBe('Updated twice.js')
    // Both runs land at the depth the file already used.
    expect(await readFile(join(root, 'twice.js'), 'utf-8')).toBe('  x\n  y\n\n  x\n  y\n')
  })

  it('still says the v1.0 line when the text is genuinely not in the file', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: 'alpha\n    but different inside\nbeta',
          new_string: 'x'
        })
      )
    ).toBe(NOT_FOUND)
  })

  it('refuses an edit that only differed by read_file decoration', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: '    1| alpha',
          new_string: 'alpha'
        })
      )
    ).toBe('old_string and new_string are identical')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('alpha\n')
  })
})

/**
 * The failure a real session looped on fifteen times: the model writes the block it *wants* into
 * `old_string`, so nothing matches and "read the file again" teaches it nothing. The refusal now
 * carries the nearest real text, which is what the next call needs.
 */
describe('edit_file refusal shows what is actually in the file', () => {
  const SIDEBAR = [
    'const items = [',
    '  {',
    '    path: "/seller/order",',
    '    label: "Orders",',
    '  },',
    '  {',
    '    path: "/seller/feedback",',
    '    label: "Customer Feedback",',
    '    icon: Star,',
    '    count: 0,',
    '  },',
    ']',
    ''
  ].join('\n')

  async function refuseInventedBlock(): Promise<string> {
    const agent = await makeAgent()
    await writeFile(join(root, 'Sidebar.jsx'), SIDEBAR)
    return output(
      await run(agent, {
        path: 'Sidebar.jsx',
        old_string: '    { path: "/seller/couriers", label: "Courier Performance", icon: Truck }',
        new_string: '    { path: "/seller/couriers", label: "Courier Performance", icon: Truck },'
      })
    )
  }

  it('keeps the v1.0 sentence as the first line', async () => {
    expect((await refuseInventedBlock()).startsWith(NOT_FOUND)).toBe(true)
  })

  it('points at the closest line and quotes the real content', async () => {
    const message = await refuseInventedBlock()
    expect(message).toContain('The closest text in Sidebar.jsx is at line ')
    expect(message).toContain('path: "/seller/feedback"')
    expect(message).toContain('label: "Customer Feedback"')
    expect(message).not.toContain('/seller/couriers')
  })

  it('quotes a bounded window rather than the whole file', async () => {
    const message = await refuseInventedBlock()
    expect(message.split('\n').length).toBeLessThanOrEqual(15)
  })

  it('stays silent when the file holds nothing like the anchor', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\n')
    expect(
      output(
        await run(agent, {
          path: 'notes.txt',
          old_string: 'quarterly_reconciliation_summary',
          new_string: 'x'
        })
      )
    ).toBe(NOT_FOUND)
  })

  it('keeps the excerpt short when the file holds one enormous minified line', async () => {
    const agent = await makeAgent()
    await writeFile(
      join(root, 'bundle.js'),
      'var label = "/seller/feedback";\n'.concat('x'.repeat(200000))
    )
    const started = Date.now()
    const message = output(
      await run(agent, {
        path: 'bundle.js',
        old_string: 'var label = "/seller/couriers";',
        new_string: 'x'
      })
    )
    expect(message.startsWith(NOT_FOUND)).toBe(true)
    expect(message).toContain('The closest text in bundle.js is at line 1')
    expect(message.length).toBeLessThan(1200)
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
