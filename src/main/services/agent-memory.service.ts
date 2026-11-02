import { resolve } from 'path'
import { buildMemoryEntry, type MemoryTurn } from '../../shared/utils/memory-entry'
import { pyLen, pySlice } from '../../shared/utils/pystr'
import { nowStrftime } from '../../shared/utils/strftime'
import { memoryKeyCandidates, resolveMemoryKey } from './app-storage-keys.service'
import { DatabaseMemoryIO, type MemoryIO } from './memory-store.service'

export function memoryTimestamp(date = new Date()): string {
  return nowStrftime('%Y-%m-%d %H:%M:%S (%A, %B %d, %Y %I:%M:%S %p)', date)
}

export interface MemoryStorageInfo {
  key: string
}

export class AgentMemory {
  private readonly appRoot: string
  private readonly store: MemoryIO

  constructor(appRoot: string) {
    this.appRoot = resolve(appRoot)
    this.store = new DatabaseMemoryIO(memoryKeyCandidates(this.appRoot))
  }

  io(): MemoryIO {
    return this.store
  }

  async storageInfo(): Promise<MemoryStorageInfo> {
    return { key: resolveMemoryKey(this.appRoot) }
  }

  async ensureMemory(): Promise<void> {
    await this.store.ensure()
  }

  async clearMemory(): Promise<boolean> {
    return await this.store.clear()
  }

  async readMemoryContent(): Promise<string> {
    await this.store.ensure()
    return await this.store.read()
  }

  /** Rollback needs a character count, which is the same unit checkpoints recorded. */
  async truncateMemory(targetLength: number): Promise<boolean> {
    const text = await this.readMemoryContent()
    if (pyLen(text) <= targetLength) return false
    await this.store.write(pySlice(text, 0, targetLength))
    return true
  }

  async logInteraction(turn: Omit<MemoryTurn, 'timestamp'>): Promise<void> {
    await this.store.ensure()
    const entry = buildMemoryEntry({ ...turn, timestamp: memoryTimestamp() })
    await this.store.append(entry)
  }
}
