export enum DiffLineType {
  ADDED = 'added',
  REMOVED = 'removed',
  CONTEXT = 'context'
}

export interface DiffLineDict {
  content: string
  line_number: number | null
  line_type: string
  old_line_number: number | null
}

export class DiffLine {
  content: string
  line_number: number | null
  line_type: DiffLineType
  old_line_number: number | null

  constructor(
    content: string,
    line_number: number | null,
    line_type: DiffLineType,
    old_line_number: number | null = null
  ) {
    this.content = content
    this.line_number = line_number
    this.line_type = line_type
    this.old_line_number = old_line_number
  }

  toDict(): DiffLineDict {
    return {
      content: this.content,
      line_number: this.line_number,
      line_type: this.line_type,
      old_line_number: this.old_line_number
    }
  }

  static fromDict(data: Partial<DiffLineDict>): DiffLine {
    return new DiffLine(
      data.content ?? '',
      data.line_number ?? null,
      (data.line_type ?? 'context') as DiffLineType,
      data.old_line_number ?? null
    )
  }
}

export interface DiffHunkDict {
  header: string
  lines: DiffLineDict[]
  old_start: number
  old_count: number
  new_start: number
  new_count: number
  collapsed_unchanged: number
}

export class DiffHunk {
  header: string
  lines: DiffLine[]
  old_start: number
  old_count: number
  new_start: number
  new_count: number
  collapsed_unchanged: number

  constructor(init: {
    header: string
    lines?: DiffLine[]
    old_start?: number
    old_count?: number
    new_start?: number
    new_count?: number
    collapsed_unchanged?: number
  }) {
    this.header = init.header
    this.lines = init.lines ?? []
    this.old_start = init.old_start ?? 0
    this.old_count = init.old_count ?? 0
    this.new_start = init.new_start ?? 0
    this.new_count = init.new_count ?? 0
    this.collapsed_unchanged = init.collapsed_unchanged ?? 0
  }

  get addedCount(): number {
    return this.lines.filter((line) => line.line_type === DiffLineType.ADDED).length
  }

  get removedCount(): number {
    return this.lines.filter((line) => line.line_type === DiffLineType.REMOVED).length
  }

  toDict(): DiffHunkDict {
    return {
      header: this.header,
      lines: this.lines.map((line) => line.toDict()),
      old_start: this.old_start,
      old_count: this.old_count,
      new_start: this.new_start,
      new_count: this.new_count,
      collapsed_unchanged: this.collapsed_unchanged
    }
  }

  static fromDict(data: Partial<DiffHunkDict>): DiffHunk {
    return new DiffHunk({
      header: data.header ?? '',
      lines: (data.lines ?? []).map((line) => DiffLine.fromDict(line)),
      old_start: data.old_start ?? 0,
      old_count: data.old_count ?? 0,
      new_start: data.new_start ?? 0,
      new_count: data.new_count ?? 0,
      collapsed_unchanged: data.collapsed_unchanged ?? 0
    })
  }
}

export interface BinaryMetadataDict {
  size_bytes: number
  is_image: boolean
  width: number | null
  height: number | null
  format: string | null
  mime_type: string | null
}

export class BinaryMetadata {
  size_bytes: number
  is_image: boolean
  width: number | null
  height: number | null
  format: string | null
  mime_type: string | null

  constructor(init: {
    size_bytes: number
    is_image?: boolean
    width?: number | null
    height?: number | null
    format?: string | null
    mime_type?: string | null
  }) {
    this.size_bytes = init.size_bytes
    this.is_image = init.is_image ?? false
    this.width = init.width ?? null
    this.height = init.height ?? null
    this.format = init.format ?? null
    this.mime_type = init.mime_type ?? null
  }

  toDict(): BinaryMetadataDict {
    return {
      size_bytes: this.size_bytes,
      is_image: this.is_image,
      width: this.width,
      height: this.height,
      format: this.format,
      mime_type: this.mime_type
    }
  }

  static fromDict(data: Partial<BinaryMetadataDict>): BinaryMetadata {
    return new BinaryMetadata({
      size_bytes: data.size_bytes ?? 0,
      is_image: data.is_image ?? false,
      width: data.width ?? null,
      height: data.height ?? null,
      format: data.format ?? null,
      mime_type: data.mime_type ?? null
    })
  }
}

export interface DocxTextDiffDict {
  original_text: string
  current_text: string
  hunks: DiffHunkDict[]
}

export class DocxTextDiff {
  original_text: string
  current_text: string
  hunks: DiffHunk[]

  constructor(original_text: string, current_text: string, hunks: DiffHunk[] = []) {
    this.original_text = original_text
    this.current_text = current_text
    this.hunks = hunks
  }

  toDict(): DocxTextDiffDict {
    return {
      original_text: this.original_text,
      current_text: this.current_text,
      hunks: this.hunks.map((hunk) => hunk.toDict())
    }
  }

  static fromDict(data: Partial<DocxTextDiffDict>): DocxTextDiff {
    return new DocxTextDiff(
      data.original_text ?? '',
      data.current_text ?? '',
      (data.hunks ?? []).map((hunk) => DiffHunk.fromDict(hunk))
    )
  }
}

export interface FileDiffDict {
  path: string
  change_type: string
  hunks: DiffHunkDict[]
  is_binary: boolean
  binary_metadata: BinaryMetadataDict | null
  docx_diff: DocxTextDiffDict | null
  has_error: boolean
  error_message: string
}

export class FileDiff {
  path: string
  change_type: string
  hunks: DiffHunk[]
  is_binary: boolean
  binary_metadata: BinaryMetadata | null
  docx_diff: DocxTextDiff | null
  has_error: boolean
  error_message: string

  constructor(init: {
    path: string
    change_type: string
    hunks?: DiffHunk[]
    is_binary?: boolean
    binary_metadata?: BinaryMetadata | null
    docx_diff?: DocxTextDiff | null
    has_error?: boolean
    error_message?: string
  }) {
    this.path = init.path
    this.change_type = init.change_type
    this.hunks = init.hunks ?? []
    this.is_binary = init.is_binary ?? false
    this.binary_metadata = init.binary_metadata ?? null
    this.docx_diff = init.docx_diff ?? null
    this.has_error = init.has_error ?? false
    this.error_message = init.error_message ?? ''
  }

  get totalAdded(): number {
    return this.hunks.reduce((sum, hunk) => sum + hunk.addedCount, 0)
  }

  get totalRemoved(): number {
    return this.hunks.reduce((sum, hunk) => sum + hunk.removedCount, 0)
  }

  get lineSummary(): string {
    const added = this.totalAdded
    const removed = this.totalRemoved
    if (added > 0 && removed > 0) return `+${added} -${removed}`
    if (added > 0) return `+${added}`
    if (removed > 0) return `-${removed}`
    return ''
  }

  toDict(): FileDiffDict {
    return {
      path: this.path,
      change_type: this.change_type,
      hunks: this.hunks.map((hunk) => hunk.toDict()),
      is_binary: this.is_binary,
      binary_metadata: this.binary_metadata ? this.binary_metadata.toDict() : null,
      docx_diff: this.docx_diff ? this.docx_diff.toDict() : null,
      has_error: this.has_error,
      error_message: this.error_message
    }
  }

  static fromDict(data: Partial<FileDiffDict>): FileDiff {
    return new FileDiff({
      path: data.path ?? '',
      change_type: data.change_type ?? 'Modified',
      hunks: (data.hunks ?? []).map((hunk) => DiffHunk.fromDict(hunk)),
      is_binary: data.is_binary ?? false,
      binary_metadata: data.binary_metadata ? BinaryMetadata.fromDict(data.binary_metadata) : null,
      docx_diff: data.docx_diff ? DocxTextDiff.fromDict(data.docx_diff) : null,
      has_error: data.has_error ?? false,
      error_message: data.error_message ?? ''
    })
  }
}
