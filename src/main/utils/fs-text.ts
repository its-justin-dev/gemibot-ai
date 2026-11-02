import { readFile, writeFile } from 'fs/promises'
import { isBinary } from '../../shared/utils/text'
import { ToolError } from '../../shared/utils/exceptions'
import { pyPathName } from '../../shared/utils/py-path'

export interface TextFile {
  text: string
  crlf: boolean
}

export async function readText(path: string): Promise<TextFile> {
  const raw = await readFile(path)
  if (isBinary(raw)) throw new ToolError(`${pyPathName(path)} looks like a binary file`)
  const decoded = raw.toString('utf-8')
  const crlf = decoded.includes('\r\n')
  return { text: decoded.replaceAll('\r\n', '\n'), crlf }
}

export async function writeText(path: string, text: string, crlf: boolean): Promise<void> {
  await writeFile(path, Buffer.from(crlf ? text.replaceAll('\n', '\r\n') : text, 'utf-8'))
}

export async function readPathText(path: string): Promise<string> {
  const raw = await readFile(path)
  return raw.toString('utf-8').replace(/\r\n?/g, '\n')
}

export async function writePathText(path: string, text: string): Promise<void> {
  const native = process.platform === 'win32' ? text.replaceAll('\n', '\r\n') : text
  await writeFile(path, Buffer.from(native, 'utf-8'))
}
