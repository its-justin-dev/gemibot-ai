import { AppConstants } from '../../shared/constants/app-constants'
import { EffortMapper } from './effort-mapper.service'

export interface ModelDetail {
  id: string
  display: string
  category: string
  badge: string
  supports_thinking: boolean
  searchable_blob: string
}

export type CatalogItem = [string, string]

export interface RemoteModel {
  name?: string | null
  display_name?: string | null
  displayName?: string | null
}

export interface CatalogClient {
  models?: {
    list(): AsyncIterable<RemoteModel> | RemoteModel[] | Promise<AsyncIterable<RemoteModel>>
  }
}

export class ModelCatalog {
  private static instance: ModelCatalog | null = null

  client: CatalogClient | null
  private cachedItems: CatalogItem[] = []
  private cachedDetails = new Map<string, ModelDetail>()
  private isRefreshing = false
  private onCatalogUpdated: (() => void) | null = null

  constructor(client: CatalogClient | null = null) {
    this.client = client
    this.initializeFromConstants()
  }

  static getInstance(client: CatalogClient | null = null): ModelCatalog {
    if (ModelCatalog.instance === null) {
      ModelCatalog.instance = new ModelCatalog(client)
    } else if (client && ModelCatalog.instance.client === null) {
      ModelCatalog.instance.client = client
    }
    return ModelCatalog.instance
  }

  static resetInstance(): void {
    ModelCatalog.instance = null
  }

  private initializeFromConstants(): void {
    const catalog = AppConstants.MODEL_CATALOG as Record<string, string>
    const items: CatalogItem[] = []
    for (const m of AppConstants.MODELS) {
      items.push([m, catalog[m] ?? m])
    }
    this.cachedItems = items
    this.rebuildDetailsCache()
  }

  private rebuildDetailsCache(): void {
    const details = new Map<string, ModelDetail>()
    for (const [modelId, display] of this.cachedItems) {
      const category = AppConstants.getModelCategory(modelId)
      const badge = AppConstants.getModelBadge(modelId)
      details.set(modelId, {
        id: modelId,
        display,
        category,
        badge,
        supports_thinking: EffortMapper.supportsThinking(modelId),
        searchable_blob: `${display} ${modelId} ${category} ${badge}`.toLowerCase()
      })
    }
    this.cachedDetails = details
  }

  getModels(): CatalogItem[] {
    return [...this.cachedItems]
  }

  getAllDetails(): ModelDetail[] {
    return [...this.cachedDetails.values()]
  }

  getModelInfo(modelId: string): ModelDetail {
    const cached = this.cachedDetails.get(modelId)
    if (cached) return { ...cached }

    const category = AppConstants.getModelCategory(modelId)
    const badge = AppConstants.getModelBadge(modelId)
    const display = (AppConstants.MODEL_CATALOG as Record<string, string>)[modelId] ?? modelId
    return {
      id: modelId,
      display,
      category,
      badge,
      supports_thinking: EffortMapper.supportsThinking(modelId),
      searchable_blob: `${display} ${modelId} ${category} ${badge}`.toLowerCase()
    }
  }

  setUpdateListener(callback: () => void): void {
    this.onCatalogUpdated = callback
  }

  refreshAsync(client?: CatalogClient | null): Promise<void> {
    if (client) this.client = client
    if (!this.client) return Promise.resolve()
    if (this.isRefreshing) return Promise.resolve()

    return this.runRefresh()
  }

  private async runRefresh(): Promise<void> {
    this.isRefreshing = true
    try {
      const catalog = AppConstants.MODEL_CATALOG as Record<string, string>
      const remoteItems: CatalogItem[] = []
      for (const entry of await collectModels(this.client)) {
        const name = (entry?.name || '').replaceAll('models/', '')
        const remoteDisplay = entry?.display_name ?? entry?.displayName ?? ''
        const display = remoteDisplay || (catalog[name] ?? '')
        if (name) remoteItems.push([name, display])
      }

      if (remoteItems.length > 0) {
        const seen = new Set<string>()
        const merged: CatalogItem[] = []
        const orderMap = new Map<string, number>()
        AppConstants.MODELS.forEach((m, idx) => orderMap.set(m, idx))
        for (const [name, display] of remoteItems) {
          seen.add(name)
          merged.push([name, display])
        }
        for (const name of AppConstants.MODELS) {
          if (!seen.has(name)) merged.push([name, catalog[name] ?? ''])
        }
        merged.sort((a, b) => {
          const keyA: [number, string] = [orderMap.get(a[0]) ?? 999, a[0]]
          const keyB: [number, string] = [orderMap.get(b[0]) ?? 999, b[0]]
          if (keyA[0] !== keyB[0]) return keyA[0] < keyB[0] ? -1 : 1
          if (keyA[1] !== keyB[1]) return keyA[1] < keyB[1] ? -1 : 1
          return 0
        })

        this.cachedItems = merged
        this.rebuildDetailsCache()

        if (this.onCatalogUpdated) this.onCatalogUpdated()
      }
    } catch {
    } finally {
      this.isRefreshing = false
    }
  }
}

async function collectModels(client: CatalogClient | null): Promise<RemoteModel[]> {
  const page = await client?.models?.list()
  if (!page) return []
  if (Array.isArray(page)) return page
  const items: RemoteModel[] = []
  for await (const item of page as AsyncIterable<RemoteModel>) items.push(item)
  return items
}
