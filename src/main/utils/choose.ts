import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { pyFormatIntWidth } from '../../shared/utils/pyformat'
import { pyStrip } from '../../shared/utils/pystr'
import type { ChooseItem, ChooseOptions } from '../services/agent-session.service'
import { out } from './console-out'

export type ReadLine = (prompt: string) => Promise<string | null>

const DIGITS_ONLY = /^\d+$/u

export async function choose(
  title: string,
  items: ChooseItem[],
  options: ChooseOptions = {},
  readLine: ReadLine
): Promise<string | null> {
  if (items.length === 0) return null
  const rule = '-'.repeat(Math.min(70, AppConstants.WIDTH))

  out(`\n${C.BOLD}${title}${C.RESET}`)
  out(`${C.GRAY}${rule}${C.RESET}`)
  items.forEach(([value, note], index) => {
    const tag = value === options.current ? ` ${C.GREEN}(active)${C.RESET}` : ''
    const noteStr = note ? ` ${C.DIM}- ${note}${C.RESET}` : ''
    out(
      `  ${C.CYAN}${pyFormatIntWidth(index + 1, 2)}.${C.RESET} ${C.BOLD}${value}${C.RESET}` +
        `${tag}${noteStr}`
    )
  })
  out(`${C.GRAY}${rule}${C.RESET}`)

  for (;;) {
    const answer = await readLine(`Enter number (1-${items.length}) or press Enter to cancel > `)
    if (answer === null) {
      out()
      return null
    }
    const choice = pyStrip(answer)
    if (!choice) return null
    if (DIGITS_ONLY.test(choice)) {
      const idx = Number.parseInt(choice, 10) - 1
      if (idx >= 0 && idx < items.length) return items[idx][0]
      out(`  ${C.RED}Invalid number. Please enter between 1 and ${items.length}.${C.RESET}`)
    } else {
      const matched = items.find(([value]) => choice.toLowerCase() === value.toLowerCase())
      if (matched) return matched[0]
      out(`  ${C.RED}Invalid input. Enter a number (1-${items.length}) or name.${C.RESET}`)
    }
  }
}
