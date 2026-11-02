import { safeFence } from './text'
import { pyPathSuffix } from './py-path'
import { pyJsonDumps } from './pyjson'

export interface ToolLogEntry {
  tool: string
  args: Record<string, unknown>
  raw_output: string
  is_error?: boolean
  duration?: number
}

export interface TurnFileChange {
  action: string
  path: string
  diff: string
  new_content: string | null
  old_content: string | null
}

export interface MemoryTurn {
  timestamp: string
  mode: string
  activeFunction: string
  model: string
  userPrompt: string
  aiResponses: string[]
  turnToolLogs: ToolLogEntry[]
  turnFileChanges: TurnFileChange[]
}

function contentLang(rel: string): string {
  return pyPathSuffix(rel).replace(/^\.+/, '') || 'text'
}

export function buildMemoryEntry(turn: MemoryTurn): string {
  const completeResponse =
    turn.aiResponses
      .filter((r) => r.trim() !== '')
      .join('\n\n')
      .trim() || '(No text response)'

  const lines: string[] = [
    '\n---\n',
    `## Interaction Log - ${turn.timestamp}\n`,
    `- **Mode:** \`${turn.mode.toUpperCase()}\``,
    `- **Active Function Suite:** \`${turn.activeFunction}\``,
    `- **Model:** \`${turn.model}\`\n`,
    '### 1. Exact User Prompt'
  ]

  const pfence = safeFence(turn.userPrompt)
  lines.push(`${pfence}text\n${turn.userPrompt}\n${pfence}\n`)

  lines.push('### 2. Complete AI Response')
  const rfence = safeFence(completeResponse)
  lines.push(`${rfence}markdown\n${completeResponse}\n${rfence}\n`)

  lines.push('### 3. Executed Tools & Terminal Commands (Complete Unabbreviated Outputs)')
  if (!turn.turnToolLogs.length) {
    lines.push('_No tools or terminal commands were executed during this turn._\n')
  } else {
    turn.turnToolLogs.forEach((entry, idx) => {
      const targs = pyJsonDumps(entry.args, { ensureAscii: false, indent: 2 })
      const statusTag = entry.is_error ? 'ERROR' : 'OK'
      lines.push(`#### 3.${idx + 1} \`${entry.tool}\` [${statusTag}]`)
      const afence = safeFence(targs)
      lines.push(`**Arguments:**\n${afence}json\n${targs}\n${afence}`)
      const ofence = safeFence(entry.raw_output)
      lines.push(`**Complete Output:**\n${ofence}text\n${entry.raw_output}\n${ofence}\n`)
    })
  }

  lines.push('### 4. System Changes, Exact Code Diffs & Full File Contents')
  if (!turn.turnFileChanges.length) {
    lines.push('_No files were created, modified, or deleted during this turn._\n')
  } else {
    turn.turnFileChanges.forEach((chg, idx) => {
      lines.push(`#### 4.${idx + 1} ${chg.action.toUpperCase()}: \`${chg.path}\``)
      if (chg.diff) {
        const dfence = safeFence(chg.diff)
        lines.push(`**Exact Code Diff:**\n${dfence}diff\n${chg.diff}\n${dfence}`)
      }
      if (chg.new_content !== null) {
        const cfence = safeFence(chg.new_content)
        lines.push(
          `**Full Unabbreviated File Content (\`${chg.path}\`):**\n` +
            `${cfence}${contentLang(chg.path)}\n${chg.new_content}\n${cfence}\n`
        )
      } else if (chg.old_content !== null) {
        const cfence = safeFence(chg.old_content)
        lines.push(
          `**Deleted File Original Content (\`${chg.path}\`):**\n` +
            `${cfence}${contentLang(chg.path)}\n${chg.old_content}\n${cfence}\n`
        )
      }
    })
  }

  return lines.join('\n') + '\n'
}
