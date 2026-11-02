import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { afterAll, describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { ChangeType } from '../../src/shared/models/file-change'
import type { MemoryTurn } from '../../src/shared/utils/memory-entry'
import { ToolError } from '../../src/shared/utils/exceptions'
import { nowStrftime } from '../../src/shared/utils/strftime'
import { ChangeTracker } from '../../src/main/services/change-tracker.service'
import { DiffService } from '../../src/main/services/diff.service'
import { FileOperations } from '../../src/main/services/file-operations.service'
import { AgentMemory } from '../../src/main/services/agent-memory.service'
import { AgentSettings } from '../../src/main/services/agent-settings.service'
import { storageKey } from '../../src/main/services/long-term-repository.service'
import { SnapshotStore } from '../../src/main/services/snapshot-store.service'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { fixture } from './load-fixture'
import { scrub } from './scrub'

/**
 * Filesystem half of the storage layer, replayed against the same
 * `.gemibot/pending/`, `memory/settings.md` and `memory/memory.md` bytes v1.0
 * produced. Reference data: `tests/fixtures/v1-storage.json`.
 */
const storage = fixture('v1-storage.json')
const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const workspaces: string[] = []

async function workspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `gemibot-parity-${prefix}-`))
  workspaces.push(dir)
  return dir
}

async function put(ws: string, rel: string, data: Buffer): Promise<string> {
  const target = join(ws, rel)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
  return target
}

async function readBuffer(rel: string): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, rel))
}

async function listFiles(ws: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.gemibot') continue
      const child = join(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) found.push(child.slice(ws.length + 1).replaceAll('\\', '/'))
    }
  }
  await visit(ws)
  return found.sort()
}

async function toolErrorText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as ToolError).message
  }
  throw new Error('expected a ToolError')
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SnapshotStore', () => {
  const cases = storage.snapshots.cases as Array<{
    rel: string
    content_hex: string
    id: string
    exists: boolean
    is_binary: boolean
    expected: string
  }>

  it('ids, existence and binary flags match save_snapshot()', async () => {
    const ws = await workspace('store-')
    const store = new SnapshotStore(ws)
    for (const rec of cases) {
      const target = await put(ws, `src/${rec.rel}`, Buffer.from(rec.content_hex, 'hex'))
      const [id, exists, isBinary] = await store.saveSnapshot(rec.rel, target)
      expect(id, `id ${rec.rel}`).toBe(rec.id)
      expect(id, `expected ${rec.rel}`).toBe(rec.expected)
      expect(exists, `exists ${rec.rel}`).toBe(rec.exists)
      expect(isBinary, `is_binary ${rec.rel}`).toBe(rec.is_binary)
    }
    expect(await store.listSnapshotIds()).toEqual(storage.snapshots.listing)
  })

  it('reports a missing file as [null, false, false]', async () => {
    const ws = await workspace('store-')
    const store = new SnapshotStore(ws)
    const result = await store.saveSnapshot('gone.py', join(ws, 'gone.py'))
    expect(result).toEqual(storage.snapshots.missing)
  })

  it('starts from the same empty manifest', async () => {
    const ws = await workspace('store-')
    expect(await new SnapshotStore(ws).loadManifest()).toEqual(storage.snapshots.load_default)
  })

  it('writes manifest.json byte for byte and leaves no manifest.tmp', async () => {
    const ws = await workspace('store-')
    const store = new SnapshotStore(ws)
    await store.saveManifest({
      changes: { 'x.py': { path: 'x.py' } },
      reads: { 'x.py': nowStrftime('%H:%M:%S') }
    })
    const written = scrub(await readFile(store.manifestFile, 'utf-8'), ws)
    expect(written).toBe(storage.snapshots.manifest_roundtrip)
    await expect(
      readFile(join(ws, '.gemibot', 'pending', 'manifest.tmp'), 'utf-8')
    ).rejects.toThrow()
  })

  it('keeps the .gemibot/pending paths v1.0 used', async () => {
    const ws = await workspace('store-')
    const store = new SnapshotStore(ws)
    const relative = (path: string): string => path.slice(ws.length + 1).replaceAll('\\', '/')
    expect(relative(store.manifestFile)).toBe(storage.snapshots.manifest_paths[0])
    expect(relative(store.manifestFile.replace(/\.json$/, '.tmp'))).toBe(
      storage.snapshots.manifest_paths[1]
    )
  })
})

describe('ChangeTracker and FileOperations over a scripted turn', () => {
  it('produces the same manifest, snapshots, summary and tree as v1.0', async () => {
    const ws = await workspace('ws-')
    const tracker = await ChangeTracker.create(ws)
    tracker.onChangesUpdated = null
    const files = new FileOperations(ws, tracker)

    await files.writeTextFile('src/app.py', 'def f():\n    return 1\n')
    await files.editTextFile('src/app.py', 'return 1', 'return 2')
    await files.writeTextFile('README.md', '# Hi\n', false, null, 'Created the readme')
    await files.deleteFile('README.md')
    await files.writeBytesFile(
      'img/logo.png',
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    )
    await files.writeTextFile('docs/note.txt', 'üñî\r\n', true)
    await files.readTextFile('docs/note.txt')
    await files.createFolder('empty-dir')

    const manifest = await readFile(join(ws, '.gemibot', 'pending', 'manifest.json'), 'utf-8')
    expect(scrub(manifest, ws)).toBe(storage.tracker.manifest)
    expect(await tracker.store.listSnapshotIds()).toEqual(storage.tracker.snapshots)

    const summary = tracker.getSummary()
    expect(summary.changes.map((c) => c.path)).toEqual(storage.tracker.summary_changes)
    expect(summary.counts).toEqual(storage.tracker.summary_counts)
    expect(scrub(JSON.stringify(summary.files_read), ws)).toBe(
      JSON.stringify(storage.tracker.summary_reads)
    )
    expect(await listFiles(ws)).toEqual(storage.tracker.tree)
  })

  it('nets an added-then-deleted file out and restores a deleted original as Modified', async () => {
    const ws = await workspace('net-')
    const tracker = await ChangeTracker.create(ws)
    const files = new FileOperations(ws, tracker)

    await files.writeTextFile('temp.txt', 'created\n')
    expect(tracker.pendingChanges.size).toBe(1)
    await files.deleteFile('temp.txt')
    expect(tracker.pendingChanges.size).toBe(0)

    await files.writeTextFile('keep.txt', 'before\n')
    await tracker.acceptAll()
    const second = await ChangeTracker.create(ws)
    const secondFiles = new FileOperations(ws, second)
    await secondFiles.writeTextFile('keep.txt', 'after\n')
    expect(second.pendingChanges.get('keep.txt')?.change_type).toBe(ChangeType.MODIFIED)
    await secondFiles.deleteFile('keep.txt')
    expect(second.pendingChanges.get('keep.txt')?.change_type).toBe(ChangeType.DELETED)
    expect(await second.rejectFile('keep.txt')).toBe(true)
    expect(await readFile(join(ws, 'keep.txt'), 'utf-8')).toBe('before\n')
  })
})

describe('DiffService', () => {
  const script = storage.compute_diff.script as Array<
    Record<string, string | number | boolean | null>
  >
  const cases = storage.compute_diff.cases as Array<{ name: string; diff: unknown }>

  it('replays the v1.0 op script into identical FileDiff dictionaries', async () => {
    const ws = await workspace('diff-')
    const store = new SnapshotStore(ws)
    const service = new DiffService(ws, store)

    for (const op of script) {
      const rel = op.rel as string
      if (op.op === 'write') {
        const data = op.source
          ? await readBuffer(op.source as string)
          : op.fill !== undefined
            ? Buffer.alloc(op.size as number, op.fill as number)
            : Buffer.from(op.hex_text as string, 'hex')
        await put(ws, rel, data)
      } else if (op.op === 'snapshot') {
        const [id] = await store.saveSnapshot(rel, join(ws, rel))
        expect(id, `snapshot ${rel}`).toBe(op.id)
      } else if (op.op === 'remove') {
        await rm(join(ws, rel), { force: true })
      } else if (op.op === 'diff') {
        const name = op.name as string
        const diff = await service.computeDiff(
          rel,
          op.change_type as ChangeType,
          op.snapshot_id as string | null,
          op.original_exists as boolean,
          op.is_binary as boolean,
          join(ws, rel)
        )
        expect(scrub(JSON.stringify(diff.toDict()), ws), name).toBe(
          JSON.stringify(cases.find((c) => c.name === name)?.diff)
        )
      }
    }
    expect(script.filter((op) => op.op === 'diff')).toHaveLength(cases.length)
  })

  it('caches one FileDiff per path, snapshot and change type', async () => {
    const ws = await workspace('cache-')
    const store = new SnapshotStore(ws)
    const service = new DiffService(ws, store)
    await writeFile(join(ws, 'a.py'), 'x = 1\n')
    const first = await service.computeDiff(
      'a.py',
      ChangeType.ADDED,
      null,
      false,
      false,
      join(ws, 'a.py')
    )
    const second = await service.computeDiff(
      'a.py',
      ChangeType.ADDED,
      null,
      false,
      false,
      join(ws, 'a.py')
    )
    expect(second).toBe(first)
    service.clearCache()
    expect(
      await service.computeDiff('a.py', ChangeType.ADDED, null, false, false, join(ws, 'a.py'))
    ).not.toBe(first)
  })

  it('reads the same image metadata PIL reported', async () => {
    const ws = await workspace('meta-')
    const store = new SnapshotStore(ws)
    const service = new DiffService(ws, store)
    for (const rec of storage.images as Array<{
      name: string
      metadata: Record<string, unknown>
      error?: string
    }>) {
      if (rec.error) continue
      const data = await readBuffer(join('images', rec.name))
      await writeFile(join(ws, rec.name), data)
      const diff = await service.computeDiff(
        rec.name,
        ChangeType.GENERATED,
        null,
        false,
        true,
        join(ws, rec.name)
      )
      expect(diff.toDict().binary_metadata, rec.name).toEqual(rec.metadata)
    }
  })
})

describe('FileOperations messages', () => {
  it('raises the same ToolError texts v1.0 raised', async () => {
    const ws = await workspace('messages-')
    const tracker = await ChangeTracker.create(ws)
    const files = new FileOperations(ws, tracker)
    await writeFile(join(ws, 'text.txt'), 'one\ntwo\n')
    await writeFile(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
    await mkdir(join(ws, 'sub'), { recursive: true })

    expect(await toolErrorText(() => files.readTextFile('missing.txt'))).toBe(
      'File not found: missing.txt'
    )
    expect(await toolErrorText(() => files.readBytesFile('missing.txt'))).toBe(
      'File not found: missing.txt'
    )
    expect(await toolErrorText(() => files.readTextFile('bin.dat'))).toBe(
      'bin.dat looks like a binary file'
    )
    expect(await toolErrorText(() => files.readTextFile('sub'))).toBe('File not found: sub')
    expect(await toolErrorText(() => files.editTextFile('missing.txt', 'a', 'b'))).toBe(
      'File not found: missing.txt'
    )
    expect(await toolErrorText(() => files.editTextFile('sub', 'a', 'b'))).toBe(
      'sub is a directory'
    )
    expect(await toolErrorText(() => files.editTextFile('text.txt', 'nope', 'b'))).toBe(
      'Target string not found in text.txt'
    )
    expect(await toolErrorText(() => files.deleteFile('sub'))).toBe(
      'sub is a directory; use delete_folder instead'
    )
    expect(await toolErrorText(() => files.deleteFolder('missing-dir'))).toBe(
      'Directory not found: missing-dir'
    )
    expect(await toolErrorText(() => files.deleteFolder('text.txt'))).toBe(
      'text.txt is not a directory'
    )
  })

  it('keeps CRLF files CRLF and edits only the first match by default', async () => {
    const ws = await workspace('crlf-')
    const tracker = await ChangeTracker.create(ws)
    const files = new FileOperations(ws, tracker)
    await files.writeTextFile('note.txt', 'a\nb\n', true)
    expect(await readFile(join(ws, 'note.txt'), 'utf-8')).toBe('a\r\nb\r\n')

    const [text, crlf] = await files.readTextFile('note.txt')
    expect(text).toBe('a\nb\n')
    expect(crlf).toBe(true)

    await files.writeTextFile('dup.txt', 'x x x\n')
    await files.editTextFile('dup.txt', 'x', 'y')
    expect(await readFile(join(ws, 'dup.txt'), 'utf-8')).toBe('y x x\n')
    await files.editTextFile('dup.txt', 'x', 'y', true)
    expect(await readFile(join(ws, 'dup.txt'), 'utf-8')).toBe('y y y\n')
  })

  it('records the folder delete detail on every file inside', async () => {
    const ws = await workspace('folder-')
    const tracker = await ChangeTracker.create(ws)
    const files = new FileOperations(ws, tracker)
    await files.writeTextFile('tree/a.txt', 'a\n')
    await files.writeTextFile('tree/deep/b.txt', 'b\n')
    await tracker.acceptAll()

    const reloaded = await ChangeTracker.create(ws)
    const reloadedFiles = new FileOperations(ws, reloaded)
    expect(await reloadedFiles.deleteFolder('tree')).toBe('tree')
    const rows = reloaded.getSummary().changes
    expect(rows.map((row) => row.path)).toEqual(['tree/a.txt', 'tree/deep/b.txt'])
    expect(rows.every((row) => row.detail === 'Deleted folder tree')).toBe(true)
    expect(rows.every((row) => row.change_type === ChangeType.DELETED)).toBe(true)
    await expect(reloadedFiles.deleteFolder('tree', false)).rejects.toBeInstanceOf(ToolError)
  })

  it('stamps the generated-image and document details v1.0 wrote', async () => {
    const ws = await workspace('detail-')
    const tracker = await ChangeTracker.create(ws)
    const files = new FileOperations(ws, tracker)
    await files.saveImage('out.png', Buffer.from('89504e470d0a1a0a', 'hex'))
    expect(tracker.pendingChanges.get('out.png')?.detail).toBe('Generated image saved to out.png')
    expect(tracker.pendingChanges.get('out.png')?.change_type).toBe(ChangeType.GENERATED)

    await files.saveDocx(
      'docs/report.docx',
      await readBuffer(join('documents', 'report-original.docx'))
    )
    expect(tracker.pendingChanges.get('docs/report.docx')?.detail).toBe(
      'Document edited: docs/report.docx'
    )
    expect(tracker.pendingChanges.get('docs/report.docx')?.change_type).toBe(ChangeType.DOCX_EDITED)

    await files.writeTextFile('notes.txt', 'hi\n', false, null, '', 'a title', 'because')
    const change = tracker.pendingChanges.get('notes.txt')
    expect(change?.what).toEqual(['a title'])
    expect(change?.why).toEqual(['because'])
    await files.editTextFile('notes.txt', 'hi', 'bye', false, 'again', 'second', 'second why')
    expect(tracker.pendingChanges.get('notes.txt')?.what).toEqual(['a title', 'second'])
    expect(tracker.pendingChanges.get('notes.txt')?.why).toEqual(['because', 'second why'])
  })

  it('warns in v1.0 wording when a rollback cannot restore a file', async () => {
    const ws = await workspace('reject-')
    const tracker = await ChangeTracker.create(ws)
    const files = new FileOperations(ws, tracker)
    await files.writeTextFile('lost.txt', 'one\n')
    await tracker.acceptAll()
    const again = await ChangeTracker.create(ws)
    const againFiles = new FileOperations(ws, again)
    await againFiles.writeTextFile('lost.txt', 'two\n')
    await rm(
      join(
        ws,
        '.gemibot',
        'pending',
        'snapshots',
        String(again.pendingChanges.get('lost.txt')?.snapshot_id)
      )
    )
    const lines: string[] = []
    const unsubscribe = onConsoleOutput((line) => lines.push(line))
    const rejected = await again.rejectAll()
    unsubscribe()
    expect(rejected).toEqual([])
    expect(lines.join('')).toContain("Warning: Failed to restore 1 files: ['lost.txt']")
  })
})

describe('AgentSettings', () => {
  const prefs = {
    model: storage.settings.default_dict.model as string,
    activeFunction: storage.settings.default_dict.function_suite as string,
    mode: storage.settings.default_dict.mode as string
  }

  it('seeds the same default settings rows and writes no files', async () => {
    const ws = await workspace('settings-')
    const store = new AgentSettings(ws)
    await store.ensureSettings(prefs)
    const dict = await store.readSettingsDict()
    expect(dict).toEqual(storage.settings.default_dict)
    expect(await readdir(ws)).toEqual([])
  })

  it('merges updates into the stored rows without touching the defaults', async () => {
    const ws = await workspace('settings-')
    const store = new AgentSettings(ws)
    await store.ensureSettings(prefs)
    await store.saveSettings({ theme: 'not_so_dark', zz_extra: '42' })
    const dict = await store.readSettingsDict()
    expect(dict).toEqual(storage.settings.after_save_dict)
    expect(dict.model).toBe(prefs.model)
    expect(dict.function_suite).toBe(prefs.activeFunction)
  })

  it('keeps the rows one level up when installed in a wrapper folder', async () => {
    const ws = await workspace('settings-')
    const parent = new AgentSettings(ws)
    await parent.ensureSettings(prefs)
    await parent.saveSettings({ theme: 'parent_theme' })

    const wrapper = new AgentSettings(join(ws, 'gemibot'))
    expect(wrapper.storageInfo().scope).toBe(`settings:${storageKey(ws)}`)
    expect((await wrapper.readSettingsDict()).theme).toBe('parent_theme')

    const own = new AgentSettings(join(ws, 'other'))
    expect(own.storageInfo().scope).toBe(`settings:${storageKey(join(ws, 'other'))}`)
  })
})

describe('AgentMemory', () => {
  const inputs = storage.memory.inputs as {
    state: { model: string; active_function: string; mode: string }
    tool_logs: MemoryTurn['turnToolLogs']
    file_changes: MemoryTurn['turnFileChanges']
    turns: Array<{ prompt: string; responses: string[] }>
  }

  function turn(index: number): Omit<MemoryTurn, 'timestamp'> {
    const hasLogs = index === 0
    return {
      mode: inputs.state.mode,
      activeFunction: inputs.state.active_function,
      model: inputs.state.model,
      userPrompt: inputs.turns[index].prompt,
      aiResponses: inputs.turns[index].responses,
      turnToolLogs: hasLogs ? inputs.tool_logs : [],
      turnFileChanges: hasLogs ? inputs.file_changes : []
    }
  }

  it('writes, appends and clears the memory document v1.0 keeps', async () => {
    const ws = await workspace('memory-')
    const store = new AgentMemory(ws)
    await store.ensureMemory()
    expect(await store.readMemoryContent()).toBe(AppConstants.MEMORY_HEADER)

    const v1Header: string = storage.memory.header
    const withV2Header = (text: string): string =>
      AppConstants.MEMORY_HEADER + text.slice(v1Header.length)

    await store.logInteraction(turn(0))
    expect(scrub(await store.readMemoryContent(), ws)).toBe(
      scrub(withV2Header(storage.memory.entry), ws)
    )

    await store.logInteraction(turn(1))
    expect(scrub(await store.readMemoryContent(), ws)).toBe(
      scrub(withV2Header(storage.memory.empty_entry), ws)
    )

    expect(await store.clearMemory()).toBe(true)
    expect(await store.readMemoryContent()).toBe(AppConstants.MEMORY_HEADER)
    expect(await readdir(ws)).toEqual([])
  })

  it('persists entries in the conversation database across instances', async () => {
    const ws = await workspace('memory-')
    const store = new AgentMemory(ws)
    await store.ensureMemory()
    await store.logInteraction(turn(2))

    const reopened = new AgentMemory(ws)
    expect(await reopened.readMemoryContent()).toBe(await store.readMemoryContent())
    expect((await reopened.storageInfo()).key).toBe(`memory:${storageKey(ws)}`)
  })

  it('keeps memory one level up in a wrapper install', async () => {
    const ws = await workspace('memory-')
    await new AgentMemory(ws).ensureMemory()
    const wrapper = new AgentMemory(join(ws, 'chatbot'))
    expect((await wrapper.storageInfo()).key).toBe(`memory:${storageKey(ws)}`)
    expect(await wrapper.readMemoryContent()).toBe(AppConstants.MEMORY_HEADER)
    expect((await new AgentMemory(join(ws, 'other')).storageInfo()).key).toBe(
      `memory:${storageKey(join(ws, 'other'))}`
    )
  })
})
