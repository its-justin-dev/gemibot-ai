import type { ThinkingConfig } from '@google/genai'
import { resolve } from 'path'
import { EffortLevel } from '../../shared/models/effort-level'
import { EffortMapper } from '../services/effort-mapper.service'
import { CatalogClient, ModelCatalog } from '../services/model-catalog.service'
import { SettingsStore } from '../storage/settings-store.service'

export type ModelListener = (model: string, effort: EffortLevel) => void

export class ModelController {
  readonly root: string
  readonly catalog: ModelCatalog
  readonly store: SettingsStore
  private readonly mapper: typeof EffortMapper = EffortMapper

  currentModel!: string
  currentEffort!: EffortLevel

  /** A one-turn effort bump chosen by deep routing; it never rewrites the saved preference. */
  private effortOverride: EffortLevel | null = null

  private listeners: ModelListener[] = []

  private constructor(root: string, client: CatalogClient | null) {
    this.root = resolve(root)
    this.catalog = ModelCatalog.getInstance(client)
    this.store = new SettingsStore(this.root)
  }

  static async create(root: string, client: CatalogClient | null = null): Promise<ModelController> {
    const controller = new ModelController(root, client)
    controller.currentModel = await controller.store.getModel()
    controller.currentEffort = await controller.store.getEffortLevel()
    return controller
  }

  addListener(callback: ModelListener): void {
    if (!this.listeners.includes(callback)) this.listeners.push(callback)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.currentModel, this.currentEffort)
      } catch {}
    }
  }

  async selectModel(modelId: string | null | undefined): Promise<void> {
    if (!modelId) return
    this.currentModel = String(modelId).trim()
    await this.store.setModel(this.currentModel)
    this.notify()
  }

  async selectEffortLevel(level: unknown): Promise<void> {
    this.currentEffort = EffortLevel.fromString(level)
    await this.store.setEffortLevel(this.currentEffort)
    this.notify()
  }

  getThinkingConfig(): ThinkingConfig | null {
    return this.mapper.getThinkingConfig(this.currentModel, this.effectiveEffort())
  }

  /** The effort to use for the request in flight, including a deep-route override. */
  effectiveEffort(): EffortLevel {
    return this.effortOverride ?? this.currentEffort
  }

  setEffortOverride(level: EffortLevel | null): void {
    this.effortOverride = level
  }

  /** The config for a candidate model; an explicit effort overrides the picker (sub-agents). */
  getThinkingConfigFor(modelId: string, effort?: EffortLevel | null): ThinkingConfig | null {
    return this.mapper.getThinkingConfig(modelId, effort ?? this.effectiveEffort())
  }

  supportsThinking(modelId?: string | null): boolean {
    const target = modelId || this.currentModel
    return this.mapper.supportsThinking(target)
  }

  getStatusBadge(): string {
    if (this.supportsThinking()) {
      return `${this.currentModel} • ${this.currentEffort.icon} ${this.currentEffort.displayName} Effort`
    }
    return `${this.currentModel} • Standard`
  }
}
