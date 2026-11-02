import { statfs } from 'fs/promises'
import { cpus, freemem, totalmem } from 'os'
import { dirname } from 'path'

import { pyFloatRepr } from '../../shared/utils/pyjson'
import { pyFormatThousands, pyRound } from '../../shared/utils/pyformat'
import {
  pyPlatformMachine,
  pyPlatformRelease,
  pyPlatformSystem,
  pyPlatformVersion
} from '../services/agent-system.service'
import { diskUsageNotFound } from '../utils/py-oserror'
import type { ToolSpec } from './tool-contract'

const MB = 1024 ** 2
const GB = 1024 ** 3

const MOD_CHECKS: readonly [string, string, string | null][] = [
  ['google.genai', 'google-genai', '@google/genai'],
  ['PIL', 'pillow', 'sharp'],
  ['docx', 'python-docx', 'docx'],
  ['openpyxl', 'openpyxl', 'exceljs'],
  ['pandas', 'pandas', 'exceljs'],
  ['pypdf', 'pypdf', 'pdfjs-dist'],
  ['fitz', 'pymupdf', 'pdfjs-dist'],
  ['reportlab', 'reportlab', 'pdf-lib'],
  ['pptx', 'python-pptx', 'pptxgenjs'],
  ['cv2', 'opencv-python', null],
  ['librosa', 'librosa', null],
  ['soundfile', 'soundfile', null],
  ['edge_tts', 'edge-tts', 'edge-tts-universal'],
  ['gtts', 'gTTS', null],
  ['pyttsx3', 'pyttsx3', null],
  ['qrcode', 'qrcode', 'qrcode']
]

function memoryUsage(): { used: number; total: number; percent: number } {
  const total = totalmem()
  const used = total - freemem()
  return { used, total, percent: pyRound((used / total) * 100, 1) }
}

async function diskUsage(path: string): Promise<{ free: number; total: number }> {
  let info
  try {
    info = await statfs(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw diskUsageNotFound(path)
    throw error
  }
  const block = Number(info.frsize)
  return { total: Number(info.blocks) * block, free: Number(info.bavail) * block }
}

function groupedFloor(bytes: number, size: number): string {
  return pyFormatThousands(Math.floor(bytes / size))
}

const systemDiagnostics: ToolSpec = {
  python: 'tool_system_diagnostics',
  params: [],
  run: async (ctx) => {
    const lines = [
      'System Diagnostics - Gemibot.py',
      `- OS: ${pyPlatformSystem()} ${pyPlatformRelease()} (${pyPlatformVersion()})`,
      `- Architecture: ${pyPlatformMachine()}`,
      `- Python Executable: ${process.execPath}`,
      `- Python Version: ${process.versions.node}`,
      `- Virtual Env (.venv) Active: False (${dirname(process.execPath)})`,
      `- Project Root: ${ctx.paths.root}`,
      '- Memory Store: conversation database'
    ]

    const vm = memoryUsage()
    const du = await diskUsage(ctx.paths.root)
    lines.push(`- CPU Cores: ${cpus().length} logical`)
    lines.push(
      `- RAM: ${groupedFloor(vm.used, MB)} MB / ${groupedFloor(vm.total, MB)} MB (${pyFloatRepr(vm.percent)}%)`
    )
    lines.push(`- Disk Free: ${groupedFloor(du.free, GB)} GB / ${groupedFloor(du.total, GB)} GB`)

    lines.push('\nInstalled Multimodal & Office Libraries:')
    for (const [, pipName, counterpart] of MOD_CHECKS)
      lines.push(counterpart ? `  [OK]      ${pipName}` : `  [MISSING] ${pipName}`)

    return lines.join('\n')
  }
}

export const SYSTEM_TOOLS: Record<string, ToolSpec> = {
  system_diagnostics: systemDiagnostics
}
