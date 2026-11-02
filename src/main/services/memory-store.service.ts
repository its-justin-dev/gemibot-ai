import { AppConstants } from '../../shared/constants/app-constants'
import { memoryRepository } from './long-term-repository.service'

/** The byte-oriented view the conversation journal needs, backed by the conversation database. */
export interface MemoryIO {
  ensure(): Promise<void>
  read(): Promise<string>
  write(text: string): Promise<void>
  append(text: string): Promise<void>
  clear(): Promise<boolean>
  size(): Promise<number>
  tail(offset: number): Promise<string>
  replaceTail(offset: number, text: string): Promise<void>
}

/**
 * Offsets stay byte offsets so the journal's live-tail rewrite works unchanged.  If SQLite is
 * unavailable (startup failure) the document lives in RAM for the session instead of erroring
 * inside every turn.
 */
export class DatabaseMemoryIO implements MemoryIO {
  private resolvedKey: string | null = null
  private fallback: string | null = null

  constructor(private readonly keys: readonly string[]) {}

  private key(): string {
    if (this.resolvedKey === null) {
      try {
        this.resolvedKey = memoryRepository.newestExistingKey(this.keys) ?? this.keys[0]
      } catch {
        this.resolvedKey = this.keys[0]
      }
    }
    return this.resolvedKey
  }

  private stored(): string | null {
    try {
      return memoryRepository.get(this.key())
    } catch {
      return null
    }
  }

  private tryWrite(text: string): void {
    try {
      memoryRepository.write(this.key(), text)
      this.fallback = null
    } catch {
      this.fallback = text
    }
  }

  async ensure(): Promise<void> {
    if (this.stored() !== null) return
    this.tryWrite(this.fallback ?? AppConstants.MEMORY_HEADER)
  }

  async read(): Promise<string> {
    if (this.fallback !== null) return this.fallback
    const stored = this.stored()
    if (stored !== null) return stored
    await this.ensure()
    return this.stored() ?? this.fallback ?? ''
  }

  async write(text: string): Promise<void> {
    this.tryWrite(text)
  }

  async append(text: string): Promise<void> {
    const pending = this.fallback
    try {
      if (pending !== null) memoryRepository.write(this.key(), pending + text)
      else memoryRepository.append(this.key(), text)
      this.fallback = null
    } catch {
      this.fallback = (pending ?? this.stored() ?? '') + text
    }
  }

  /** Replaces the document with the header and reports whether SQLite really kept it. */
  async clear(): Promise<boolean> {
    const header = AppConstants.MEMORY_HEADER
    try {
      memoryRepository.write(this.key(), header)
      this.fallback = null
      return memoryRepository.get(this.key()) === header
    } catch {
      // Keep this session consistent, but let the caller warn that a restart restores it.
      this.fallback = header
      return false
    }
  }

  async size(): Promise<number> {
    return Buffer.byteLength(await this.read(), 'utf-8')
  }

  async tail(offset: number): Promise<string> {
    const buffer = Buffer.from(await this.read(), 'utf-8')
    return buffer.subarray(Math.max(0, Math.min(offset, buffer.length))).toString('utf-8')
  }

  async replaceTail(offset: number, text: string): Promise<void> {
    const buffer = Buffer.from(await this.read(), 'utf-8')
    let cut = Math.max(0, Math.min(offset, buffer.length))
    // Keep the cut on a UTF-8 boundary even if the stored text was edited elsewhere.
    while (cut > 0 && cut < buffer.length && (buffer[cut] & 0xc0) === 0x80) cut -= 1
    const next = Buffer.concat([buffer.subarray(0, cut), Buffer.from(text, 'utf-8')])
    await this.write(next.toString('utf-8'))
  }
}
