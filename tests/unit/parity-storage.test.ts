import { describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { PIL_MIME } from '../../src/shared/constants/pil-mime'
import { FileChange } from '../../src/shared/models/file-change'
import { FileDiff } from '../../src/shared/models/file-diff'
import {
  pyNormalizeRelPath,
  pyPathName,
  pyPathStem,
  pyPathSuffix
} from '../../src/shared/utils/py-path'
import type { MemoryTurn } from '../../src/shared/utils/memory-entry'
import { buildMemoryEntry } from '../../src/shared/utils/memory-entry'
import { defaultSettingsBlock, parseSettingsMarkdown } from '../../src/shared/utils/settings-doc'
import { parseUnifiedDiff } from '../../src/shared/utils/unified-diff'
import { fixture } from './load-fixture'
import { scrub } from './scrub'

/**
 * Pure half of the storage layer: the path, model, settings-document and
 * memory-entry semantics v1.0's Pending Changes review and `memory/` files depend on.
 * Reference bytes come from `tools/parity/dump-v1-fixtures.py`.
 */
const storage = fixture('v1-storage.json')

describe('PIL.Image.MIME registry', () => {
  it('is the same table v1.0 reads, in the same order', () => {
    expect(Object.keys(PIL_MIME)).toEqual(Object.keys(storage.pil_mime))
    expect(PIL_MIME).toEqual(storage.pil_mime)
  })
})

describe('pathlib semantics', () => {
  it('normalizes like ChangeTracker._normalize / DiffService._normalize', () => {
    for (const [raw, trackerNorm, diffNorm] of storage.paths) {
      expect(pyNormalizeRelPath(raw), `normalize ${raw}`).toBe(trackerNorm)
      expect(pyNormalizeRelPath(raw), `normalize ${raw}`).toBe(diffNorm)
    }
  })

  it('splits name, suffix and stem like Path(p)', () => {
    for (const [raw, , , name, suffix, stem] of storage.paths) {
      expect(pyPathName(raw), `name ${raw}`).toBe(name)
      expect(pyPathSuffix(raw), `suffix ${raw}`).toBe(suffix)
      expect(pyPathStem(raw), `stem ${raw}`).toBe(stem)
    }
  })
})

describe('FileChange round-trip', () => {
  it('from_dict(to_dict(from_dict(x))) keeps v1.0 key order and defaults', () => {
    for (const rec of storage.file_change) {
      expect(
        scrub(JSON.stringify(FileChange.fromDict(rec.in).toDict())),
        `change ${rec.in.path}`
      ).toBe(scrub(JSON.stringify(rec.out)))
    }
  })
})

describe('unified diff parsing', () => {
  it('builds the same hunks DiffService._parse_unified_diff produced', () => {
    for (const rec of storage.parse_unified_diff) {
      expect(JSON.stringify(parseUnifiedDiff(rec.unified).map((h) => h.toDict()))).toBe(
        JSON.stringify(rec.hunks)
      )
    }
  })

  it('reports the same +n -n summary the review drawer shows', () => {
    for (const rec of storage.parse_unified_diff) {
      const diff = new FileDiff({
        path: 'rel.py',
        change_type: 'Modified',
        hunks: parseUnifiedDiff(rec.unified)
      })
      expect(diff.totalAdded).toBe(rec.total_added)
      expect(diff.totalRemoved).toBe(rec.total_removed)
      expect(diff.lineSummary).toBe(rec.line_summary)
    }
  })
})

describe('memory/settings.md document', () => {
  const defaults = storage.settings.default_dict

  it('writes the default block with the database header and v1.0 keys', () => {
    const v1Header = storage.settings.default_file.slice(
      0,
      storage.settings.default_file.indexOf('- **')
    )
    expect(
      defaultSettingsBlock(defaults.model, defaults.function_suite, defaults.mode)
    ).toBe(AppConstants.SETTINGS_HEADER + storage.settings.default_file.slice(v1Header.length))
    expect(AppConstants.SETTINGS_HEADER.split('\n')[0]).toBe(
      '# Gemibot User Settings & Preferences'
    )
  })

  it('parses both supported key syntaxes and skips what v1.0 skips', () => {
    expect(parseSettingsMarkdown(storage.settings.default_file)).toEqual(defaults)
    expect(Object.keys(parseSettingsMarkdown(storage.settings.default_file))).toEqual(
      Object.keys(defaults)
    )
  })

  it('reads the odd file the way read_settings_dict did', () => {
    const parsed = parseSettingsMarkdown(storage.settings.odd_source)
    expect(parsed).toEqual(storage.settings.odd_dict)
    expect(Object.keys(parsed)).toEqual(Object.keys(storage.settings.odd_dict))
  })
})

describe('memory document interaction entry', () => {
  const inputs = storage.memory.inputs
  const state = inputs.state
  const v1Header: string = storage.memory.header

  it('keeps the v1.0 entry body and swaps in the database header', () => {
    expect(storage.memory.cleared).toBe(v1Header)
    expect(AppConstants.MEMORY_HEADER).toContain('conversation database')
    expect(AppConstants.MEMORY_HEADER).not.toContain('/memory/memory.md')
  })

  function turn(index: number): MemoryTurn {
    const hasLogs = index === 0
    return {
      timestamp: '2026-10-21 15:56:04 (Wednesday, October 21, 2026 03:56:04 PM)',
      mode: state.mode,
      activeFunction: state.active_function,
      model: state.model,
      userPrompt: inputs.turns[index].prompt,
      aiResponses: inputs.turns[index].responses,
      turnToolLogs: hasLogs ? inputs.tool_logs : [],
      turnFileChanges: hasLogs ? inputs.file_changes : []
    }
  }

  it('appends the same markdown v1.0 wrote, fences and all', () => {
    const expected = String(storage.memory.entry).replace(v1Header, AppConstants.MEMORY_HEADER)
    expect(scrub(AppConstants.MEMORY_HEADER + buildMemoryEntry(turn(0)))).toBe(expected)
  })

  it('falls back to the italic placeholders for a tool-free turn', () => {
    const expected = String(storage.memory.empty_entry).replace(
      v1Header,
      AppConstants.MEMORY_HEADER
    )
    expect(
      scrub(AppConstants.MEMORY_HEADER + buildMemoryEntry(turn(0)) + buildMemoryEntry(turn(1)))
    ).toBe(expected)
  })
})
