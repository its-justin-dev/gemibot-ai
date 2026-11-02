const ENV_LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*)=/u

/**
 * Rewrite `KEY=value` rows in dotenv text. Comments, blank lines, quoting style of other rows
 * and the original ordering are preserved; keys that are absent get appended at the end.
 */
export function applyEnvValues(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values))
  const replaced = text.split('\n').map((line) => {
    const match = ENV_LINE.exec(line)
    if (!match) return line
    const name = match[3]
    if (!pending.has(name)) return line
    const value = pending.get(name) as string
    pending.delete(name)
    return `${match[1]}${match[2] ?? ''}${name}${match[4]}=${value}`
  })
  if (pending.size === 0) return replaced.join('\n')

  while (replaced.length > 0 && replaced[replaced.length - 1].trim() === '') replaced.pop()
  for (const [name, value] of pending) replaced.push(`${name}=${value}`)
  return `${replaced.join('\n')}\n`
}
