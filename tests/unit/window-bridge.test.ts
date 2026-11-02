import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => '' },
  clipboard: { writeText: () => undefined },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openPath: async () => '' }
}))

import { WindowBridge, isWindowCommand } from '../../src/main/ipc/window.handlers'

/**
 * A reopened window replaces the renderer, but a dialog the runtime asked the old renderer for
 * can never be answered. `attachWindow` has to fail those asks so the waiting turn unwinds
 * instead of hanging forever.
 */

interface FakeWindow {
  received: unknown[]
  webContents: { send: (channel: string, event: unknown) => void }
  isDestroyed: () => boolean
}

function fakeWindow(): FakeWindow {
  const win: FakeWindow = {
    received: [],
    webContents: { send: (_channel, event) => win.received.push(event) },
    isDestroyed: () => false
  }
  return win
}

const runtime = { snapshot: () => ({}) } as never

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('WindowBridge.attachWindow', () => {
  it('fails a read-line the old renderer was showing', async () => {
    const bridge = new WindowBridge()
    bridge.bindRuntime(runtime)
    const oldWin = fakeWindow()
    bridge.attachWindow(oldWin as never)

    const line = bridge.readLine('Name?')
    await flush()
    expect(oldWin.received).toEqual([{ kind: 'read-line', prompt: 'Name?', id: 1 }])

    bridge.attachWindow(fakeWindow() as never)
    await expect(line).resolves.toBeNull()
  })

  it('fails a permission dialog the old renderer was showing', async () => {
    const bridge = new WindowBridge()
    bridge.bindRuntime(runtime)
    const oldWin = fakeWindow()
    bridge.attachWindow(oldWin as never)

    const permission = bridge.permission('write_file', 'a.txt')
    await flush()
    expect(oldWin.received).toHaveLength(1)

    bridge.attachWindow(fakeWindow() as never)
    await expect(permission).resolves.toBe(false)
  })
})

describe('isWindowCommand', () => {
  it('drops anything that is not an object with a known command name', () => {
    expect(isWindowCommand(null)).toBe(false)
    expect(isWindowCommand('send')).toBe(false)
    expect(isWindowCommand([])).toBe(false)
    expect(isWindowCommand({})).toBe(false)
    expect(isWindowCommand({ cmd: 42 })).toBe(false)
    expect(isWindowCommand({ cmd: 'rm-rf' })).toBe(false)
    expect(isWindowCommand({ cmd: '__proto__' })).toBe(false)
  })

  it('accepts the payload-free commands the renderer sends', () => {
    for (const cmd of [
      'compact',
      'stop',
      'accept-all',
      'reject-all',
      'review-open',
      'target-browse',
      'model-picker',
      'load-older',
      'conversation-new',
      'open-data-folder',
      'build-pause',
      'build-resume',
      'build-stop',
      'build-approve',
      'build-docs',
      'build-docs-close'
    ]) {
      expect(isWindowCommand({ cmd })).toBe(true)
    }
  })

  it('checks every payload field it will hand to the runtime', () => {
    expect(isWindowCommand({ cmd: 'send', text: 'hi' })).toBe(true)
    expect(isWindowCommand({ cmd: 'send', text: 5 })).toBe(false)
    expect(isWindowCommand({ cmd: 'queue-delete', index: 2 })).toBe(true)
    expect(isWindowCommand({ cmd: 'queue-delete', index: -1 })).toBe(false)
    expect(isWindowCommand({ cmd: 'queue-delete', index: '2' })).toBe(false)
    expect(isWindowCommand({ cmd: 'multi-agent-stop' })).toBe(true)
    expect(isWindowCommand({ cmd: 'multi-agent-stop', subAgentIdx: Number.NaN })).toBe(false)
    expect(isWindowCommand({ cmd: 'multi-agent-start' })).toBe(false)
    expect(
      isWindowCommand({ cmd: 'multi-agent-start', orchestratorModel: 'm', totalSubTasks: 2 })
    ).toBe(true)
    expect(isWindowCommand({ cmd: 'multi-agent-sub-agent-update', subAgentIdx: 0, status: 'x' })).toBe(
      true
    )
    expect(isWindowCommand({ cmd: 'multi-agent-sub-agent-update', status: 'x' })).toBe(false)
    expect(isWindowCommand({ cmd: 'conversation-export', id: 'c1', format: 'pdf' })).toBe(false)
    expect(isWindowCommand({ cmd: 'conversation-export', id: 'c1', format: 'json' })).toBe(true)
    expect(isWindowCommand({ cmd: 'build-mode', mode: 'sometimes' })).toBe(false)
    expect(isWindowCommand({ cmd: 'build-revise', text: '   ' })).toBe(false)
    expect(isWindowCommand({ cmd: 'export-timeline', path: '', content: '' })).toBe(false)
    expect(isWindowCommand({ cmd: 'edit-user', text: 't', cpIdx: null, rowId: 1 })).toBe(true)
    expect(isWindowCommand({ cmd: 'edit-user', text: 't', cpIdx: null, rowId: '1' })).toBe(false)
  })

  it('only admits the listed action names', () => {
    expect(isWindowCommand({ cmd: 'action', name: 'undo' })).toBe(true)
    expect(isWindowCommand({ cmd: 'action', name: 'revert' })).toBe(true)
    expect(isWindowCommand({ cmd: 'action', name: 'launch-missiles' })).toBe(false)
  })
})
