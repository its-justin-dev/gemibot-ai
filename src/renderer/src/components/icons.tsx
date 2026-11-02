import { Fragment } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clapperboard,
  ClipboardList,
  Coins,
  Cpu,
  Database,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Feather,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Gauge,
  Gem,
  Globe,
  History,
  Image,
  Info,
  KeyRound,
  Languages,
  Map,
  Mic,
  Monitor,
  Package,
  Palette,
  Pencil,
  PencilLine,
  PenLine,
  Presentation,
  Rocket,
  RotateCcw,
  Ruler,
  Scale,
  ScanSearch,
  Search,
  Settings,
  Shield,
  Smartphone,
  Square,
  Stethoscope,
  Trash2,
  Undo2,
  Volume2,
  Wrench,
  X,
  XCircle,
  Zap,
  type LucideIcon
} from 'lucide-react'

const GLYPHS: Record<string, LucideIcon> = {
  '📋': ClipboardList,
  '⚙️': Settings,
  '⚙': Settings,
  '↩️': Undo2,
  '↩': Undo2,
  '⏪': History,
  '🧠': Brain,
  '📦': Package,
  '📊': BarChart3,
  '🧹': Eraser,
  '🪙': Coins,
  '📂': FolderOpen,
  '📁': Folder,
  '📄': FileText,
  '📝': PencilLine,
  '✏️': Pencil,
  '⚡': Zap,
  '⚖️': Scale,
  '🚀': Rocket,
  '🏎️': Gauge,
  '🪶': Feather,
  '🔍': Search,
  '🔎': ScanSearch,
  '🎨': Palette,
  '💎': Gem,
  '🤖': Bot,
  '🔊': Volume2,
  '🌐': Globe,
  '📐': Ruler,
  '⚠️': AlertTriangle,
  '⚠': AlertTriangle,
  ℹ️: Info,
  ℹ: Info,
  '⏹️': Square,
  '⏹': Square,
  '🖥️': Monitor,
  '🖥': Monitor,
  '🦾': Cpu,
  '❌': XCircle,
  '🛡️': Shield,
  '🗑️': Trash2,
  '✍️': PenLine,
  '👁️': Eye,
  '🙈': EyeOff,
  '🔤': Languages,
  '🖼️': Image,
  '📑': FileText,
  '📽️': Presentation,
  '🎙️': Mic,
  '🎬': Clapperboard,
  '🎞️': Film,
  '💾': Database,
  '📱': Smartphone,
  '🩺': Stethoscope,
  '📥': Download,
  '📖': BookOpen,
  '🔑': KeyRound,
  '🗺️': Map,
  '🛠️': Wrench,
  '✅': CheckCircle2,
  '→': ArrowRight,
  '↺': RotateCcw,
  '✗': X,
  '✓': Check,
  '✕': X,
  '✖': X,
  '▴': ChevronUp,
  '▾': ChevronDown,
  '▼': ChevronDown,
  '▶': ChevronRight,
  '↓': ArrowDown
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const GLYPH_PATTERN = new RegExp(
  `(${Object.keys(GLYPHS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})`,
  'gu'
)

const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu

// eslint-disable-next-line react-refresh/only-export-components
export function stripGlyphs(text: string): string {
  return text
    .replace(GLYPH_PATTERN, '')
    .replace(EMOJI_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Whether `Glyph` can draw this character. Anything outside the table is stripped to nothing, so
 * a label that leans on an unmapped emoji silently loses its icon.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function hasGlyph(glyph: string): boolean {
  return GLYPHS[glyph] !== undefined
}

export function Glyph({
  glyph,
  className
}: {
  glyph: string
  className?: string
}): React.JSX.Element {
  const Icon = GLYPHS[glyph]
  if (Icon === undefined) {
    const text = glyph.replace(EMOJI_PATTERN, '')
    if (text === '') return <></>
    return <span className={className}>{text}</span>
  }
  return <Icon aria-hidden className={className ? `glyph ${className}` : 'glyph'} strokeWidth={2} />
}

export function GlyphText({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(GLYPH_PATTERN)
  return (
    <>
      {parts.map((part, index) =>
        GLYPHS[part] !== undefined ? (
          <Glyph glyph={part} key={index} />
        ) : (
          <Fragment key={index}>{part.replace(EMOJI_PATTERN, '')}</Fragment>
        )
      )}
    </>
  )
}
