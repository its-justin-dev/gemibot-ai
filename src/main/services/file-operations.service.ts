import { readdir, mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'fs/promises'
import type { Dirent } from 'fs'
import { dirname } from 'path'
import { ChangeType } from '../../shared/models/file-change'
import { ToolError } from '../../shared/utils/exceptions'
import { isBinary } from '../../shared/utils/text'
import { pyExpandUser, pyIsAbsolute, pyRelativePath, pyResolve } from '../utils/fs-path'
import { readText } from '../utils/fs-text'
import type { ChangeTracker } from './change-tracker.service'

export class FileOperations {
  private root: string
  private readonly tracker: ChangeTracker

  constructor(root: string, tracker: ChangeTracker) {
    this.root = pyResolve(root)
    this.tracker = tracker
  }

  setRoot(root: string): void {
    this.root = pyResolve(root)
  }

  resolve(path: string): string {
    const candidate = pyExpandUser(path)
    return pyIsAbsolute(candidate) ? pyResolve(candidate) : pyResolve(candidate, this.root)
  }

  rel(fullPath: string): string {
    return pyRelativePath(pyResolve(fullPath), this.root)
  }

  isBinary(data: Buffer): boolean {
    return isBinary(data)
  }

  async readTextFile(path: string): Promise<[string, boolean]> {
    const full = this.resolve(path)
    if (!(await isFile(full))) throw new ToolError(`File not found: ${path}`)
    const { text, crlf } = await readText(full)
    await this.tracker.recordRead(this.rel(full))
    return [text, crlf]
  }

  async readBytesFile(path: string): Promise<Buffer> {
    const full = this.resolve(path)
    if (!(await isFile(full))) throw new ToolError(`File not found: ${path}`)
    await this.tracker.recordRead(this.rel(full))
    return readFile(full)
  }

  async writeTextFile(
    path: string,
    content: string,
    crlf = false,
    changeType: ChangeType | null = null,
    detail = '',
    what = '',
    why = ''
  ): Promise<string> {
    const full = this.resolve(path)
    const relPath = this.rel(full)
    const existed = await exists(full)

    const type = changeType ?? (existed ? ChangeType.MODIFIED : ChangeType.ADDED)

    await this.tracker.recordChange(relPath, full, type, detail, false, what, why)

    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, Buffer.from(crlf ? content.replaceAll('\n', '\r\n') : content, 'utf-8'))
    return relPath
  }

  async writeBytesFile(
    path: string,
    data: Buffer,
    changeType: ChangeType | null = null,
    detail = '',
    what = '',
    why = ''
  ): Promise<string> {
    const full = this.resolve(path)
    const relPath = this.rel(full)
    const existed = await exists(full)

    const type = changeType ?? (existed ? ChangeType.MODIFIED : ChangeType.ADDED)

    await this.tracker.recordChange(relPath, full, type, detail, true, what, why)

    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, data)
    return relPath
  }

  async editTextFile(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
    detail = '',
    what = '',
    why = ''
  ): Promise<string> {
    const full = this.resolve(path)
    const relPath = this.rel(full)
    if (!(await exists(full))) throw new ToolError(`File not found: ${path}`)
    if (await isDirectory(full)) throw new ToolError(`${path} is a directory`)

    const [oldText, crlf] = await this.readTextFile(path)
    if (!oldText.includes(oldString)) throw new ToolError(`Target string not found in ${relPath}`)

    const newText = replaceAll
      ? oldText.replaceAll(oldString, () => newString)
      : oldText.replace(oldString, () => newString)
    await this.writeTextFile(
      path,
      newText,
      crlf,
      ChangeType.MODIFIED,
      detail || `Replaced text in ${relPath}`,
      what,
      why
    )
    return relPath
  }

  async deleteFile(path: string, what = '', why = ''): Promise<string> {
    const full = this.resolve(path)
    const relPath = this.rel(full)
    if (!(await exists(full))) throw new ToolError(`File not found: ${path}`)
    if (await isDirectory(full)) {
      throw new ToolError(`${path} is a directory; use delete_folder instead`)
    }

    await this.tracker.recordChange(
      relPath,
      full,
      ChangeType.DELETED,
      `Deleted ${relPath}`,
      false,
      what,
      why
    )
    await unlink(full)
    return relPath
  }

  async createFolder(path: string): Promise<string> {
    const full = this.resolve(path)
    const relPath = this.rel(full)
    await mkdir(full, { recursive: true })
    return relPath
  }

  async deleteFolder(path: string, recursive = true): Promise<string> {
    const full = this.resolve(path)
    const relPath = this.rel(full)
    if (!(await exists(full))) throw new ToolError(`Directory not found: ${path}`)
    if (!(await isDirectory(full))) throw new ToolError(`${path} is not a directory`)

    if (recursive) {
      for (const child of await walkFiles(full)) {
        await this.tracker.recordChange(
          this.rel(child),
          child,
          ChangeType.DELETED,
          `Deleted folder ${relPath}`,
          false,
          '',
          ''
        )
      }
      await rm(full, { recursive: true, force: true })
    } else {
      await rmdir(full)
    }
    return relPath
  }

  saveImage(
    outputPath: string,
    imgData: Buffer,
    detail = '',
    what = '',
    why = ''
  ): Promise<string> {
    return this.writeBytesFile(
      outputPath,
      imgData,
      ChangeType.GENERATED,
      detail || `Generated image saved to ${outputPath}`,
      what,
      why
    )
  }

  async saveDocx(
    outputPath: string,
    data: Buffer,
    detail = '',
    what = '',
    why = ''
  ): Promise<string> {
    const full = this.resolve(outputPath)
    const relPath = this.rel(full)

    await this.tracker.recordChange(
      relPath,
      full,
      ChangeType.DOCX_EDITED,
      detail || `Document edited: ${relPath}`,
      true,
      what,
      why
    )

    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, data)
    return relPath
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (current: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = `${current}/${entry.name}`
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  await visit(dir)
  return found
}
