import { readFile, stat } from 'fs/promises'
import { resolve } from 'path'
import { PIL_MIME } from '../../shared/constants/pil-mime'
import { ChangeType } from '../../shared/models/file-change'
import {
  BinaryMetadata,
  DiffHunk,
  DiffLine,
  DiffLineType,
  DocxTextDiff,
  FileDiff
} from '../../shared/models/file-diff'
import { unifiedDiff } from '../../shared/utils/difflib'
import { pyNormalizeRelPath } from '../../shared/utils/py-path'
import { pySplitlines } from '../../shared/utils/pystr'
import { parseUnifiedDiff } from '../../shared/utils/unified-diff'
import { readImageHeader } from '../utils/py-image'
import { docxParagraphTexts, docxParagraphTextsFromFile } from './docx-text.service'
import type { SnapshotStore } from './snapshot-store.service'

async function readFileText(path: string): Promise<string> {
  return (await readFile(path)).toString('utf-8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DiffService {
  readonly root: string
  private readonly store: SnapshotStore
  private readonly cache = new Map<string, FileDiff>()
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024

  constructor(root: string, snapshotStore: SnapshotStore) {
    this.root = resolve(root)
    this.store = snapshotStore
  }

  private normalize(path: string): string {
    return pyNormalizeRelPath(path)
  }

  async computeDiff(
    relPath: string,
    changeType: ChangeType,
    snapshotId: string | null,
    _originalExists: boolean,
    isBinary: boolean,
    fullPath: string
  ): Promise<FileDiff> {
    const normPath = this.normalize(relPath)
    let stamp = 'deleted'
    if (changeType !== ChangeType.DELETED) {
      try {
        const info = await stat(resolve(fullPath))
        if (info.size > this.MAX_FILE_SIZE) {
          return new FileDiff({
            path: normPath,
            change_type: changeType,
            has_error: true,
            error_message: `File too large for diff (${info.size} bytes > ${this.MAX_FILE_SIZE} bytes)`
          })
        }
        stamp = `${info.mtimeMs}:${info.size}`
      } catch {
        stamp = 'missing'
      }
    }
    // The snapshot id stays the same while a file is edited again inside one pending change, so
    // the cache key also carries the on-disk version or the panel keeps the earlier diff.
    const cacheKey = `${normPath}:${snapshotId}:${changeType}:${stamp}`

    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    try {
      let diff: FileDiff
      if (changeType === ChangeType.DELETED) {
        diff = await this.computeDeletedDiff(normPath, snapshotId, isBinary)
      } else if (changeType === ChangeType.ADDED) {
        diff = await this.computeAddedDiff(normPath, fullPath, isBinary)
      } else if (changeType === ChangeType.GENERATED) {
        diff = await this.computeGeneratedDiff(normPath, fullPath, isBinary)
      } else if (changeType === ChangeType.DOCX_EDITED) {
        diff = await this.computeDocxDiff(normPath, snapshotId, fullPath)
      } else {
        diff = await this.computeModifiedDiff(normPath, snapshotId, fullPath, isBinary)
      }

      this.cache.set(cacheKey, diff)
      if (this.cache.size > 200) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      return diff
    } catch (error) {
      return new FileDiff({
        path: normPath,
        change_type: changeType,
        has_error: true,
        error_message: errorMessage(error)
      })
    }
  }

  private async computeDeletedDiff(
    relPath: string,
    snapshotId: string | null,
    isBinary: boolean
  ): Promise<FileDiff> {
    if (isBinary) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.DELETED,
        is_binary: true,
        binary_metadata: await this.getBinaryMetadataFromSnapshot(snapshotId)
      })
    }

    const originalBytes = await this.store.getSnapshotBytes(snapshotId)
    if (!originalBytes) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.DELETED,
        has_error: true,
        error_message: 'Snapshot not found'
      })
    }

    try {
      const originalLines = pySplitlines(originalBytes.toString('utf-8'))
      const hunk = new DiffHunk({
        header: `@@ -1,${originalLines.length} +0,0 @@`,
        old_start: 1,
        old_count: originalLines.length,
        new_start: 0,
        new_count: 0
      })
      originalLines.forEach((line, i) => {
        hunk.lines.push(new DiffLine(line, null, DiffLineType.REMOVED, i + 1))
      })

      return new FileDiff({ path: relPath, change_type: ChangeType.DELETED, hunks: [hunk] })
    } catch (error) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.DELETED,
        is_binary: true,
        has_error: true,
        error_message: `Failed to decode deleted file: ${errorMessage(error)}`
      })
    }
  }

  private async computeAddedDiff(
    relPath: string,
    fullPath: string,
    isBinary: boolean
  ): Promise<FileDiff> {
    const full = resolve(fullPath)

    if (isBinary) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.ADDED,
        is_binary: true,
        binary_metadata: await this.getBinaryMetadataFromFile(full)
      })
    }

    try {
      const currentLines = pySplitlines(await readFileText(full))
      const hunk = new DiffHunk({
        header: `@@ -0,0 +1,${currentLines.length} @@`,
        old_start: 0,
        old_count: 0,
        new_start: 1,
        new_count: currentLines.length
      })
      currentLines.forEach((line, i) => {
        hunk.lines.push(new DiffLine(line, i + 1, DiffLineType.ADDED))
      })

      return new FileDiff({ path: relPath, change_type: ChangeType.ADDED, hunks: [hunk] })
    } catch (error) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.ADDED,
        is_binary: true,
        has_error: true,
        error_message: `Failed to read added file: ${errorMessage(error)}`
      })
    }
  }

  private computeGeneratedDiff(
    relPath: string,
    fullPath: string,
    isBinary: boolean
  ): Promise<FileDiff> {
    return this.computeAddedDiff(relPath, fullPath, isBinary)
  }

  private async computeModifiedDiff(
    relPath: string,
    snapshotId: string | null,
    fullPath: string,
    isBinary: boolean
  ): Promise<FileDiff> {
    const full = resolve(fullPath)

    if (isBinary) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.MODIFIED,
        is_binary: true,
        binary_metadata: await this.getBinaryMetadataFromFile(full)
      })
    }

    const originalBytes = await this.store.getSnapshotBytes(snapshotId)
    if (!originalBytes) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.MODIFIED,
        has_error: true,
        error_message: 'Snapshot not found'
      })
    }

    try {
      const originalText = originalBytes.toString('utf-8')
      const currentText = await readFileText(full)

      if (originalText === currentText) {
        return new FileDiff({ path: relPath, change_type: ChangeType.MODIFIED, hunks: [] })
      }

      const hunks = parseUnifiedDiff(
        unifiedDiff(
          pySplitlines(originalText),
          pySplitlines(currentText),
          `a/${relPath}`,
          `b/${relPath}`,
          '',
          '',
          3,
          ''
        )
      )

      return new FileDiff({ path: relPath, change_type: ChangeType.MODIFIED, hunks })
    } catch (error) {
      return new FileDiff({
        path: relPath,
        change_type: ChangeType.MODIFIED,
        has_error: true,
        error_message: `Failed to compute diff: ${errorMessage(error)}`
      })
    }
  }

  private async computeDocxDiff(
    relPath: string,
    snapshotId: string | null,
    fullPath: string
  ): Promise<FileDiff> {
    const full = resolve(fullPath)

    let originalText = ''
    const originalBytes = await this.store.getSnapshotBytes(snapshotId)
    if (originalBytes) {
      try {
        originalText = (await docxParagraphTexts(originalBytes)).join('\n')
      } catch (error) {
        originalText = `[Could not extract original text: ${errorMessage(error)}]`
      }
    }

    let currentText: string
    try {
      currentText = (await docxParagraphTextsFromFile(full)).join('\n')
    } catch (error) {
      currentText = `[Could not extract current text: ${errorMessage(error)}]`
    }

    const hunks = parseUnifiedDiff(
      unifiedDiff(
        pySplitlines(originalText),
        pySplitlines(currentText),
        `a/${relPath} (text only)`,
        `b/${relPath} (text only)`,
        '',
        '',
        3,
        ''
      )
    )

    return new FileDiff({
      path: relPath,
      change_type: ChangeType.DOCX_EDITED,
      is_binary: true,
      docx_diff: new DocxTextDiff(originalText, currentText, hunks)
    })
  }

  private async getBinaryMetadataFromSnapshot(
    snapshotId: string | null
  ): Promise<BinaryMetadata | null> {
    if (!snapshotId) return null
    const bytes = await this.store.getSnapshotBytes(snapshotId)
    if (!bytes) return null
    return this.extractBinaryMetadata(bytes)
  }

  private async getBinaryMetadataFromFile(filePath: string): Promise<BinaryMetadata | null> {
    try {
      await stat(filePath)
      return this.extractBinaryMetadata(await readFile(filePath))
    } catch {
      return null
    }
  }

  private extractBinaryMetadata(bytes: Buffer): BinaryMetadata {
    const metadata = new BinaryMetadata({ size_bytes: bytes.length })

    const header = readImageHeader(bytes)
    if (header) {
      metadata.is_image = true
      metadata.width = header.width
      metadata.height = header.height
      metadata.format = header.format
      metadata.mime_type = PIL_MIME[header.format] ?? null
    }

    return metadata
  }

  clearCache(): void {
    this.cache.clear()
  }
}
