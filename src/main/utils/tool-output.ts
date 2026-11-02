import { AppConstants } from '../../shared/constants/app-constants'

/**
 * Shortens the copy of a tool result that travels to the model. `read_file` keeps whole numbered
 * lines and names the offset that continues the read; other output keeps a head and a tail so
 * terminal summaries and stack traces survive. The full text stays in the timeline, the tool log
 * and the conversation database.
 */
export function fitToolOutput(name: string, rawOut: string, cap: number): string {
  const limit = cap > 0 ? Math.min(cap, AppConstants.MAX_OUTPUT) : AppConstants.MAX_OUTPUT
  if (rawOut.length <= limit) return rawOut

  if (name === 'read_file') {
    const footer = /\n\[lines (\d+)-(\d+) of (\d+)\]\s*$/u.exec(rawOut)
    const body = footer === null ? rawOut : rawOut.slice(0, footer.index)
    const lines = body.split('\n')
    const reserve = 180
    let used = 0
    let end = 0
    while (end < lines.length && used + lines[end].length + 1 <= limit - reserve) {
      used += lines[end].length + 1
      end += 1
    }
    if (end === 0) {
      return (
        body.slice(0, Math.max(1, limit - reserve)) +
        `\n[truncated: ${rawOut.length} characters total; call read_file with a smaller limit]`
      )
    }
    const first = footer === null ? 1 : Number(footer[1])
    const total = footer === null ? end : Number(footer[3])
    return (
      lines.slice(0, end).join('\n') +
      `\n[truncated: showing lines ${first}-${first + end - 1} of ${total}; ` +
      `call read_file with offset=${first + end} for more]`
    )
  }

  const keep = Math.max(64, limit - 160)
  const head = Math.round(keep * 0.65)
  const tail = keep - head
  const note =
    `\n... [truncated ${rawOut.length - head - tail} of ${rawOut.length} characters; ` +
    'full output is in the timeline. Re-run with a narrower filter to see more] ...\n'
  return rawOut.slice(0, head) + note + (tail > 0 ? rawOut.slice(-tail) : '')
}
