import { mkdtemp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { EffortLevel } from '../../src/shared/models/effort-level'
import {
  ModelCatalog,
  type CatalogClient,
  type RemoteModel
} from '../../src/main/services/model-catalog.service'
import { ModelController } from '../../src/main/controllers/model-controller.service'
import { SettingsStorage } from '../../src/main/storage/settings-storage.service'
import { SettingsStore } from '../../src/main/storage/settings-store.service'
import { storageKey } from '../../src/main/services/long-term-repository.service'
import { AgentState } from '../../src/main/models/agent-state'
import { fixture } from './load-fixture'

/**
 * The model layer: catalog, controller and the `storage/settings_*.py` pair.
 * Reference data: `tests/fixtures/v1-catalog.json`.
 */
const ref = fixture('v1-catalog.json')
const controllerRef = ref.controller
const settingsRef = ref.settings

const workspaces: string[] = []

async function workspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `gemibot-parity-${prefix}-`))
  workspaces.push(dir)
  return dir
}

/**
 * v2.0 calls the Antigravity agents through the Interactions API with no request config, so they
 * report `supports_thinking: false` where v1.0's probe said `true`. The five rows of each captured
 * detail table are compared at that one changed key; every other key still has to match as written.
 */
function antigravityReportsNoThinking(rows: Array<{ id: string }>): Array<{ id: string }> {
  return rows.map((row) =>
    row.id.startsWith('antigravity') ? { ...row, supports_thinking: false } : row
  )
}

/** The `client.models.list()` surface, with an optional failure to replay. */
function fakeClient(items: RemoteModel[], error?: unknown): CatalogClient {
  return {
    models: {
      list() {
        if (error !== undefined) throw error
        return items
      }
    }
  }
}

/** The same remote page v1.0 fed the worker: mixed spellings, blanks and a nameless entry. */
const remote: RemoteModel[] = [
  { name: 'models/gemini-3.5-flash', display_name: 'Gemini 3.5 Flash (remote)' },
  { name: 'gemini-3.5-flash-lite' },
  { name: 'brand-new-model', display_name: 'Brand New' },
  { name: 'unknown-no-display' },
  { name: 'empty-display', display_name: '' },
  {},
  { name: '', display_name: 'Blank' },
  { name: 'imagen-3.0-generate-002', display_name: 'Imagen remote' }
]

afterAll(async () => {
  ModelCatalog.resetInstance()
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true })
})

beforeEach(() => ModelCatalog.resetInstance())

describe('ModelCatalog', () => {
  it('stays one instance per process and only fills a missing client', () => {
    const cat = ModelCatalog.getInstance()
    expect([ModelCatalog.getInstance() === cat]).toEqual([ref.singleton_same])

    const base = fakeClient(remote)
    const other = fakeClient([])
    ModelCatalog.resetInstance()
    const first = ModelCatalog.getInstance(base)
    const second = ModelCatalog.getInstance(other)
    expect([second === first, second.client === base]).toEqual(ref.client_backfill)

    ModelCatalog.resetInstance()
    const bare = ModelCatalog.getInstance()
    expect(bare.client).toBeNull()
    expect(ModelCatalog.getInstance(other).client === other).toEqual(ref.client_attach)
  })

  it('serves the built-in constants instantly, with the same detail dicts', () => {
    const cat = ModelCatalog.getInstance()
    expect(cat.getModels()).toEqual(ref.constants.items)
    expect(cat.getAllDetails()).toEqual(antigravityReportsNoThinking(ref.constants.details))
    expect(cat.getModelInfo('gemini-3.5-flash')).toEqual(ref.info_known)
    expect(cat.getModelInfo('some-brand-new-model')).toEqual(ref.info_unknown)
    expect(cat.getModelInfo('')).toEqual(ref.info_empty)
  })

  it('merges a remote page: constants order first, then extras sorted by name', async () => {
    const cat = ModelCatalog.getInstance()
    const events: string[] = []
    cat.setUpdateListener(() => events.push('updated'))
    await cat.refreshAsync(fakeClient(remote))
    expect(cat.getModels()).toEqual(ref.after_refresh.items)
    expect(cat.getAllDetails()).toEqual(antigravityReportsNoThinking(ref.after_refresh.details))
    expect(events).toEqual(ref.refresh_events)
  })

  it('keeps the merged catalog when the update listener throws', async () => {
    const boom: number[] = []
    const cat = ModelCatalog.getInstance(fakeClient(remote))
    cat.setUpdateListener(() => {
      boom.push(1)
      throw new Error('ui is gone')
    })
    await cat.refreshAsync()
    expect(cat.getModels()).toEqual(ref.listener_error_kept_merge)
    expect(boom).toEqual(ref.listener_error_count)
  })

  it('leaves the built-in list untouched for an empty or failing remote', async () => {
    const empty = ModelCatalog.getInstance(fakeClient([]))
    const emptyEvents: number[] = []
    empty.setUpdateListener(() => emptyEvents.push(1))
    await empty.refreshAsync()
    expect(empty.getModels()).toEqual(ref.empty_remote)
    expect(emptyEvents).toEqual(ref.empty_remote_called)

    const failed = ModelCatalog.getInstance(fakeClient([], new Error('401 UNAUTHENTICATED')))
    const failedEvents: number[] = []
    failed.setUpdateListener(() => failedEvents.push(1))
    await failed.refreshAsync()
    expect(failed.getModels()).toEqual(ref.error_remote)
    expect(failedEvents).toEqual(ref.error_remote_called)
  })

  it('does nothing at all without a client', async () => {
    const cat = ModelCatalog.getInstance()
    await cat.refreshAsync()
    expect(cat.getModels()).toEqual(ref.no_client)
  })
})

describe('ModelController', () => {
  it('restores defaults, badges every level and persists exactly what v1.0 wrote', async () => {
    const root = await workspace('controller')
    const ctrl = await ModelController.create(root)
    expect(ctrl.currentModel).toBe(controllerRef.initial_model)
    expect(ctrl.currentEffort.value).toBe(controllerRef.initial_effort)
    expect(ctrl.getStatusBadge()).toBe(controllerRef.initial_badge)
    expect(ctrl.getThinkingConfig()).toEqual({
      thinkingBudget: controllerRef.initial_config[0],
      includeThoughts: controllerRef.initial_config[1]
    })

    for (const [modelId, expected] of controllerRef.supports) {
      expect(
        modelId === null ? ctrl.supportsThinking() : ctrl.supportsThinking(modelId),
        `supports_thinking(${JSON.stringify(modelId)})`
      ).toBe(expected)
    }

    const badges: [string, string][] = []
    const configs: [string, number | null][] = []
    for (const level of EffortLevel.allLevels()) {
      await ctrl.selectEffortLevel(level)
      badges.push([level.value, ctrl.getStatusBadge()])
      configs.push([level.value, ctrl.getThinkingConfig()?.thinkingBudget ?? null])
    }
    // v1.0 recorded five levels in this order. `saving` is ours and trails the list, so the five
    // rows v1.0 wrote keep their positions and are still compared verbatim.
    const withoutSaving = <T>(rows: [string, T][]): [string, T][] =>
      rows.filter(([value]) => value !== 'saving')

    expect(withoutSaving(badges)).toEqual(controllerRef.badges)
    expect(withoutSaving(configs)).toEqual(controllerRef.configs)
    expect(badges.at(-1)).toEqual(['saving', 'gemini-3.5-flash-lite • 🪶 Saving Effort'])
    expect(configs.at(-1)).toEqual(['saving', 128])
    expect(badges.map(([value]) => value)).toEqual([
      'turbo',
      'low',
      'medium',
      'high',
      'extra_high',
      'saving'
    ])

    await ctrl.selectModel('gemini-2.5-flash-image')
    const standard: [string, string][] = []
    for (const level of EffortLevel.allLevels()) {
      await ctrl.selectEffortLevel(level)
      standard.push([level.value, ctrl.getStatusBadge()])
    }
    expect(withoutSaving(standard)).toEqual(controllerRef.badges_std)
    expect(standard.at(-1)).toEqual(['saving', 'gemini-2.5-flash-image • Standard'])

    // The level loops above leave v2.0 on Saving where v1.0's five ended on Extra High, and the
    // notifications below record the effort in force at each call.
    await ctrl.selectEffortLevel(EffortLevel.EXTRA_HIGH)

    const seen: [string, string][] = []
    const first = (model: string, effort: EffortLevel): void => {
      seen.push([model, effort.value])
    }
    const second = (model: string, effort: EffortLevel): void => {
      seen.push([model, effort.value])
    }
    ctrl.addListener(first)
    ctrl.addListener(second)
    // Registering the same callback twice is v1.0's dedupe: the count stays at 2.
    ctrl.addListener(first)
    await ctrl.selectModel('  gemini-3.5-pro  ')
    await ctrl.selectModel('')
    await ctrl.selectModel(null)
    await ctrl.selectEffortLevel('extra-high')
    await ctrl.selectEffortLevel(null)
    await ctrl.selectEffortLevel(7)
    expect(seen).toEqual(controllerRef.notifications)

    expect(ctrl.currentModel).toBe(controllerRef.after.model)
    expect(ctrl.currentEffort.value).toBe(controllerRef.after.effort)
    expect(ctrl.getStatusBadge()).toBe(controllerRef.after.badge)
    expect(await ctrl.store.getModel()).toBe(controllerRef.after.store_model)
    expect((await ctrl.store.getEffortLevel()).value).toBe(controllerRef.after.store_effort)
    expect(await ctrl.store.getAll()).toEqual(controllerRef.after.store_all)
  })
})

describe('SettingsStorage', () => {
  it('writes the storage layer rows, not the Agent ones', async () => {
    const std = await workspace('settingsstorage')
    const storage = new SettingsStorage(std)
    expect(await storage.readSettingsDict()).toEqual(settingsRef.missing_dict)
    expect(storage.storageInfo().scope).toBe(`settings:${storageKey(std)}`)
    expect(existsSync(join(std, 'memory'))).toBe(settingsRef.missing_still_absent)

    await storage.saveSettings({ theme: 'not_so_dark', zz_extra: '42' })
    expect(await storage.readSettingsDict()).toEqual({ theme: 'not_so_dark', zz_extra: '42' })
    await storage.saveSettings({ model: 'gemini-2.5-pro', effort_level: 'turbo' })
    expect(await storage.readSettingsDict()).toEqual({
      theme: 'not_so_dark',
      zz_extra: '42',
      model: 'gemini-2.5-pro',
      effort_level: 'turbo'
    })

    await storage.saveSettings({ zz_extra: '42', model: 'gemini-3.5-flash', custom: 'value' })
    await storage.saveSettings({ mode: 'plan' })
    expect(await storage.readSettingsDict()).toEqual({
      theme: 'not_so_dark',
      zz_extra: '42',
      model: 'gemini-3.5-flash',
      effort_level: 'turbo',
      custom: 'value',
      mode: 'plan'
    })

    expect(new SettingsStorage(join(std, 'chatbot')).storageInfo().scope).toBe(
      `settings:${storageKey(std)}`
    )
    expect(
      new SettingsStorage(join(std, 'gemibot-cli', 'src')).storageInfo().scope
    ).toBe(`settings:${storageKey(join(std, 'gemibot-cli', 'src'))}`)
    expect(
      new SettingsStorage(join(std, 'no-memory-here', 'gemibot')).storageInfo().scope
    ).toBe(`settings:${storageKey(join(std, 'no-memory-here', 'gemibot'))}`)
  })
})

describe('SettingsStore', () => {
  it('defaults, saves and re-reads through the storage layer', async () => {
    const std = await workspace('settingsstore')
    const storage = new SettingsStorage(std)
    await storage.saveSettings({
      zz_extra: '42',
      model: 'gemini-3.5-flash',
      custom: 'value',
      mode: 'plan'
    })

    const store = new SettingsStore(std)
    expect(await store.getModel()).toBe(settingsRef.store_model)
    expect((await store.getEffortLevel()).value).toBe(settingsRef.store_effort)
    await store.setModel('')
    expect(await store.getAll()).toEqual({
      zz_extra: '42',
      model: 'gemini-3.5-flash',
      custom: 'value',
      mode: 'plan'
    })
    await store.setModel('  gemini-3.5-flash-lite  ')
    await store.setEffortLevel('low')
    await store.setEffortLevel(EffortLevel.EXTRA_HIGH)
    await store.setEffortLevel('nonsense')
    await store.update({ target_directory: '', ui_scale: '13px' })
    expect((await store.getEffortLevel()).value).toBe(settingsRef.store_effort_after)
    expect(await store.getAll()).toEqual(settingsRef.store_all_after)
  })

  it('reads defaults from an empty workspace without writing rows', async () => {
    const empty = await workspace('storeempty')
    const fresh = new SettingsStore(empty)
    expect(await fresh.getModel()).toBe(settingsRef.fresh_model)
    expect((await fresh.getEffortLevel()).value).toBe(settingsRef.fresh_effort)
    expect(await fresh.getAll()).toEqual(settingsRef.fresh_all)
    expect(existsSync(join(empty, 'memory'))).toBe(settingsRef.fresh_created)
    await fresh.setModel('gemini-3.5-flash')
    expect(await fresh.getAll()).toEqual({ model: 'gemini-3.5-flash' })
  })
})

describe('AgentState', () => {
  it('starts with the same fields as the Python dataclass', () => {
    const state = new AgentState('C:/workspace/demo', 'gemini-3.5-flash')
    expect(state).toMatchObject({
      appRoot: 'C:/workspace/demo',
      root: 'C:/workspace/demo',
      model: 'gemini-3.5-flash',
      pinned: false,
      autoYes: false,
      mode: 'build',
      activeFunction: 'all',
      contents: [],
      always: new Set<string>(),
      undoStack: [],
      checkpoints: [],
      todos: [],
      tokensIn: 0,
      tokensOut: 0,
      escMonitor: null,
      turnToolLogs: [],
      turnFileChanges: [],
      turnTimelineEvents: [],
      timelineHistory: [],
      onTimelineEvent: null,
      onError: null,
      onToolError: null,
      onPermission: null,
      cancelRequested: false
    })
  })
})
