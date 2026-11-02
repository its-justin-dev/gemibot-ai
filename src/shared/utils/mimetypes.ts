import { MIME_TABLE } from '../constants/mime-table'

function splitDrive(path: string): string {
  const match = /^[A-Za-z]:/u.exec(path)
  return match ? path.slice(match[0].length) : path
}

function splitExt(p: string): [string, string] {
  const sepIndex = p.lastIndexOf('\\')
  const dotIndex = p.lastIndexOf('.')
  if (dotIndex > sepIndex) {
    let index = sepIndex + 1
    while (index < dotIndex) {
      if (p[index] !== '.') return [p.slice(0, dotIndex), p.slice(dotIndex)]
      index += 1
    }
  }
  return [p, '']
}

function hasKey(table: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key)
}

export function guessType(path: string): [mime: string | null, encoding: string | null] {
  let [base, ext] = splitExt(splitDrive(path))
  for (;;) {
    const mapped = MIME_TABLE.suffix_map[ext.toLowerCase()]
    if (mapped === undefined) break
    ;[base, ext] = splitExt(base + mapped)
  }
  let encoding: string | null = null
  if (hasKey(MIME_TABLE.encodings_map, ext)) {
    encoding = MIME_TABLE.encodings_map[ext]
  }
  const lower = ext.toLowerCase()
  if (hasKey(MIME_TABLE.types_map_strict, lower))
    return [MIME_TABLE.types_map_strict[lower], encoding]
  if (hasKey(MIME_TABLE.types_map_nonstrict, lower))
    return [MIME_TABLE.types_map_nonstrict[lower], encoding]
  return [null, encoding]
}

export function pathExt(path: string): string {
  return splitExt(path)[1]
}
