// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export function stripAnsi(text: string): string {
  return (text ?? '').replace(ANSI_RE, '')
}

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g

export function ansiToHtml(text: string): string {
  let html = ''
  let classes: string[] = []
  let index = 0
  let match: RegExpExecArray | null

  const flush = (chunk: string): void => {
    if (!chunk) return
    const escaped = escapeMarkupText(chunk)
    html += classes.length ? `<span class="${classes.join(' ')}">${escaped}</span>` : escaped
  }

  SGR_RE.lastIndex = 0
  while ((match = SGR_RE.exec(text)) !== null) {
    flush(text.slice(index, match.index))
    index = match.index + match[0].length
    classes = applySgr(classes, match[1])
  }
  flush(text.slice(index))
  return html
}

function applySgr(classes: string[], params: string): string[] {
  if (params === '') return []
  const codes = params.split(';').map((p) => (p === '' ? 0 : Number(p)))
  let next = classes.slice()
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === 0) {
      next = []
    } else if (code === 1) {
      next = unique([...next, 'ansi-bold'])
    } else if (code === 2) {
      next = unique([...next, 'ansi-dim'])
    } else if (code === 3) {
      next = unique([...next, 'ansi-italic'])
    } else if (code === 4) {
      next = unique([...next, 'ansi-underline'])
    } else if (code === 53) {
      next = unique([...next, 'ansi-overline'])
    } else if (code === 39) {
      next = next.filter((c) => !c.startsWith('ansi-fg-'))
    } else if (code === 49) {
      next = next.filter((c) => !c.startsWith('ansi-bg-'))
    } else if (code >= 30 && code <= 37) {
      next = unique([...next.filter((c) => !c.startsWith('ansi-fg-')), `ansi-fg-${code}`])
    } else if (code >= 90 && code <= 97) {
      next = unique([...next.filter((c) => !c.startsWith('ansi-fg-')), `ansi-fg-${code}`])
    } else if (code >= 40 && code <= 47) {
      next = unique([...next.filter((c) => !c.startsWith('ansi-bg-')), `ansi-bg-${code}`])
    } else if (code >= 100 && code <= 107) {
      next = unique([...next.filter((c) => !c.startsWith('ansi-bg-')), `ansi-bg-${code}`])
    } else if (code === 48 || code === 38) {
      const kind = code === 48 ? 'bg' : 'fg'
      const mode = codes[i + 1]
      if (mode === 5 && codes[i + 2] !== undefined) {
        next = unique([
          ...next.filter((c) => !c.startsWith(`ansi-${kind}-`)),
          `ansi-${kind}-256-${codes[i + 2]}`
        ])
        i += 2
      } else if (mode === 2) {
        const rgb = codes.slice(i + 2, i + 5)
        next = unique([
          ...next.filter((c) => !c.startsWith(`ansi-${kind}-`)),
          `ansi-${kind}-rgb-${rgb.join('-')}`
        ])
        i += 5
      }
    }
  }
  return next
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

function escapeMarkupText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
