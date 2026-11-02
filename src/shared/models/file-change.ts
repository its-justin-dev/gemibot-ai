import { nowStrftime } from '../utils/strftime'

export enum ChangeType {
  ADDED = 'Added',
  MODIFIED = 'Modified',
  DELETED = 'Deleted',
  GENERATED = 'Generated',
  DOCX_EDITED = 'Document edited',
  READ = 'Read'
}

export interface FileChangeDict {
  path: string
  full_path: string
  change_type: string
  snapshot_id: string | null
  original_exists: boolean
  timestamp: string
  detail: string
  is_binary: boolean
  what: string[]
  why: string[]
}

export class FileChange {
  path: string
  full_path: string
  change_type: ChangeType
  snapshot_id: string | null
  original_exists: boolean
  timestamp: string
  detail: string
  is_binary: boolean
  what: string[]
  why: string[]

  constructor(init: {
    path: string
    full_path: string
    change_type: ChangeType
    snapshot_id?: string | null
    original_exists?: boolean
    timestamp?: string
    detail?: string
    is_binary?: boolean
    what?: string[]
    why?: string[]
  }) {
    this.path = init.path
    this.full_path = init.full_path
    this.change_type = init.change_type
    this.snapshot_id = init.snapshot_id ?? null
    this.original_exists = init.original_exists ?? false
    this.timestamp = init.timestamp ?? nowStrftime('%Y-%m-%d %H:%M:%S')
    this.detail = init.detail ?? ''
    this.is_binary = init.is_binary ?? false
    this.what = init.what ?? []
    this.why = init.why ?? []
  }

  toDict(): FileChangeDict {
    return {
      path: this.path,
      full_path: this.full_path,
      change_type: this.change_type,
      snapshot_id: this.snapshot_id,
      original_exists: this.original_exists,
      timestamp: this.timestamp,
      detail: this.detail,
      is_binary: this.is_binary,
      what: this.what,
      why: this.why
    }
  }

  static fromDict(data: Partial<FileChangeDict>): FileChange {
    const rawCt = data.change_type ?? 'Modified'
    const ct = (Object.values(ChangeType) as string[]).includes(rawCt)
      ? (rawCt as ChangeType)
      : ChangeType.MODIFIED
    return new FileChange({
      path: data.path ?? '',
      full_path: data.full_path ?? '',
      change_type: ct,
      snapshot_id: data.snapshot_id ?? null,
      original_exists: data.original_exists ?? false,
      timestamp: data.timestamp ?? nowStrftime('%Y-%m-%d %H:%M:%S'),
      detail: data.detail ?? '',
      is_binary: data.is_binary ?? false,
      what: data.what ?? [],
      why: data.why ?? []
    })
  }
}
