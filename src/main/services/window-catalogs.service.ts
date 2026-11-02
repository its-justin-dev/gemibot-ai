import { AppConstants } from '../../shared/constants/app-constants'
import { FUNCTION_CATALOG } from '../../shared/constants/tool-definitions'
import { pyStrip, pyTitle } from '../../shared/utils/pystr'
import { EffortLevel } from '../../shared/models/effort-level'
import type { CatalogItem } from './model-catalog.service'

export const FONT_SIZE_MAP = new Map<string, [number, number]>([
  ['UI Scale: 11px (Compact)', [11, 0.88]],
  ['UI Scale: 12px (Small)', [12, 0.94]],
  ['UI Scale: 13px (Normal)', [13, 1.0]],
  ['UI Scale: 14px (Medium)', [14, 1.06]],
  ['UI Scale: 15px (Large)', [15, 1.14]],
  ['UI Scale: 16px (Extra Large)', [16, 1.22]],
  ['UI Scale: 18px (Huge)', [18, 1.35]]
])

export const DEFAULT_SCALE_LABEL = 'UI Scale: 13px (Normal)'

export const DEFAULT_FONT_CFG: [number, number] = [13, 1.0]

export const MODE_OPTIONS = ['BUILD', 'PLAN', 'READ']

const FUNC_DISPLAY_TO_CODE: [string, string][] = [
  ['🚀 All Functions (Full Access)', 'all'],
  ['🛠️ Build Mode (Full Agent)', 'build'],
  ['📐 Plan Mode (Analysis & Plan)', 'plan'],
  ['📖 Read Mode (Strict Inspect)', 'read'],
  ['👁️ Vision OCR & Image Reader', 'image_reader'],
  ['🎨 Image Generator Ultra HD 4K', 'image_generator_uhd'],
  ['📄 Word DOCX Management', 'docx_management'],
  ['📊 Excel & CSV Spreadsheet', 'excel_management'],
  ['📑 PDF Reader & Generator', 'pdf_management'],
  ['📽️ PowerPoint PPTX Builder', 'pptx_management'],
  ['🎙️ Voice Transcriber & Audio', 'voice_analyzer'],
  ['🔊 Voice Generator (TTS)', 'voice_generator'],
  ['🎬 Video Analyzer & Frames', 'video_reader'],
  ['💾 Data Science & SQLite SQL', 'data_sql'],
  ['🔍 Search Grounding (Live Web)', 'search_grounding'],
  ['🗺️ Map Grounding (Google Maps)', 'map_grounding'],
  ['📦 Project Dependencies Installer', 'pip_installer']
]

export class WindowCatalogs {
  readonly modelDisplayToId = new Map<string, string>()
  readonly modelIdToDisplay = new Map<string, string>()
  readonly funcDisplayToCode = new Map<string, string>()
  readonly funcCodeToDisplay = new Map<string, string>()

  constructor(available: CatalogItem[], currentModel: string) {
    const catalog = AppConstants.MODEL_CATALOG as Record<string, string>
    for (const [modelId, modelDisplay] of available) {
      const stripped = modelDisplay ? pyStrip(modelDisplay) : ''
      const cleanName = stripped || catalog[modelId] || ''
      const display = cleanName || `Gemini ${deriveModelName(modelId)}`
      this.modelDisplayToId.set(display, modelId)
      this.modelIdToDisplay.set(modelId, display)
    }

    if (!this.modelIdToDisplay.has(currentModel)) {
      const catalogName = catalog[currentModel] || ''
      const display = catalogName || `Gemini ${deriveModelName(currentModel, true)}`
      this.modelDisplayToId.set(display, currentModel)
      this.modelIdToDisplay.set(currentModel, display)
    }

    for (const [display, code] of FUNC_DISPLAY_TO_CODE) {
      this.funcDisplayToCode.set(display, code)
      this.funcCodeToDisplay.set(code, display)
    }
    for (const [code] of FUNCTION_CATALOG) {
      if (this.funcCodeToDisplay.has(code)) continue
      const label = `⚙️ ${pyTitle(code.replaceAll('_', ' '))}`
      this.funcDisplayToCode.set(label, code)
      this.funcCodeToDisplay.set(code, label)
    }
  }

  funcOptions(): string[] {
    return [...this.funcDisplayToCode.keys()]
  }

  modelOptions(): Array<{ id: string; display: string }> {
    return [...this.modelIdToDisplay.entries()].map(([id, display]) => ({ id, display }))
  }

  modelButtonText(
    modelDisplay: string,
    supportsThinking: boolean,
    effort: EffortLevel | null
  ): string {
    if (!modelDisplay || modelDisplay === 'Select Model') return 'Select Model'
    if (supportsThinking && effort) {
      return `${modelDisplay} • ${effort.icon} ${effort.displayName}`
    }
    return modelDisplay
  }
}

function deriveModelName(modelId: string, plain = false): string {
  if (plain) return pyTitle(modelId.replaceAll('gemini-', '').replaceAll('-', ' '))
  return pyTitle(
    modelId
      .replaceAll('gemini-', '')
      .replaceAll('models/', '')
      .replaceAll('-preview', ' Preview')
      .replaceAll('-', ' ')
  )
}
