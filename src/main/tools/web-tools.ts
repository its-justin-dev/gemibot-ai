import * as cheerio from 'cheerio'
import { decode as htmlUnescape } from 'he'

import { PythonError, ToolError, errorMessage } from '../../shared/utils/exceptions'
import { pyQuote } from '../../shared/utils/pyurllib'
import { pyOr, pyTruthy } from '../../shared/utils/pytruth'
import { pyStr, pyStrip } from '../../shared/utils/pystr'
import type { ToolSpec } from './tool-contract'

const PY_S =
  '[\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

export async function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number | null = null
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
    } catch (e) {
      throw new Error(`<urlopen error ${errorMessage(e)}>`, { cause: e })
    }
    if (!response.ok) throw new Error(`HTTP Error ${response.status}: ${response.statusText}`)

    const chunks: Uint8Array[] = []
    let total = 0
    const reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        total += value.byteLength
        if (maxBytes !== null && total >= maxBytes) {
          await reader.cancel()
          break
        }
      }
    }
    const limit = maxBytes === null ? total : Math.min(total, maxBytes)
    const bytes = new Uint8Array(limit)
    let offset = 0
    for (const chunk of chunks) {
      const take = Math.min(chunk.byteLength, limit - offset)
      if (take > 0) bytes.set(chunk.subarray(0, take), offset)
      offset += take
      if (offset >= limit) break
    }
    return { bytes, contentType: response.headers.get('content-type') }
  } finally {
    clearTimeout(timer)
  }
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = contentCharset(contentType) ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    throw new PythonError('LookupError', `unknown encoding: ${charset}`)
  }
}

function contentCharset(contentType: string | null): string | null {
  if (!contentType) return null
  for (const part of contentType.split(';').slice(1)) {
    const [name, ...rest] = part.trim().split('=')
    if (name.toLowerCase() === 'charset') {
      const value = rest.join('=').trim().replaceAll(/^"|"$/gu, '')
      return value || null
    }
  }
  return null
}

interface DomNode {
  type?: string
  data?: string
  children?: DomNode[]
}

function getTextStrip(root: DomNode | undefined): string {
  if (!root) return ''
  const parts: string[] = []
  const visit = (node: DomNode): void => {
    if (node.type === 'text') {
      parts.push(node.data ?? '')
      return
    }
    if (node.type === 'comment' || node.type === 'directive') return
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return parts
    .map(pyStrip)
    .filter((part) => part !== '')
    .join('')
}

const searchGrounding: ToolSpec = {
  python: 'tool_search_grounding',
  params: [{ name: 'query', required: true }],
  run: async (_ctx, args) => {
    const cleanQ = pyStrip(pyStr(pyOr(args.query, '')))
    if (!cleanQ) throw new ToolError('Search query cannot be empty.')
    const url = `https://html.duckduckgo.com/html/?q=${pyQuote(cleanQ)}`
    try {
      const { bytes } = await httpGet(
        url,
        { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gemibot/2.0' },
        15000
      )
      const rawHtml = new TextDecoder('utf-8').decode(bytes)
      const $ = cheerio.load(rawHtml)
      const results: string[] = []
      $('.result')
        .slice(0, 5)
        .each((_, element) => {
          const row = $(element)
          const title = row.find('.result__title')
          const snippet = row.find('.result__snippet')
          const link = row.find('.result__url')
          if (title.length > 0 && snippet.length > 0) {
            results.push(
              `• **${getTextStrip(title.get(0) as DomNode | undefined)}**\n  ${getTextStrip(
                snippet.get(0) as DomNode | undefined
              )}\n  Source: ${link.length > 0 ? getTextStrip(link.get(0) as DomNode | undefined) : ''}`
            )
          }
        })
      if (results.length > 0) {
        return `Google Search Grounding Results for '${cleanQ}':\n\n${results.join('\n\n')}`
      }
    } catch (e) {
      return `Search Grounding query for '${cleanQ}' completed (${errorMessage(e)}).`
    }
    return `Google Search Grounding executed for: ${cleanQ}`
  }
}

function dictGet(obj: Record<string, unknown>, key: string, fallback: string): string {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return pyStr(obj[key])
  return fallback
}

const mapGrounding: ToolSpec = {
  python: 'tool_map_grounding',
  params: [
    { name: 'location', required: true },
    { name: 'query', default: null }
  ],
  run: async (_ctx, args) => {
    const loc = pyStrip(pyStr(pyOr(args.location, '')))
    if (!loc) throw new ToolError('Location cannot be empty.')
    const query = args.query
    const q = pyTruthy(query) ? pyStrip(`${loc} ${pyStr(query)}`) : loc
    const url =
      `https://nominatim.openstreetmap.org/search?q=${pyQuote(q)}` +
      '&format=json&addressdetails=1&limit=5'
    try {
      const { bytes } = await httpGet(url, { 'User-Agent': 'Gemibot-Map-Grounding/2.0' }, 15000)
      const data = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Record<string, unknown>[]
      if (pyTruthy(data)) {
        const items: string[] = []
        for (const place of data.slice(0, 3)) {
          const name = dictGet(place, 'display_name', '')
          const lat = dictGet(place, 'lat', '')
          const lon = dictGet(place, 'lon', '')
          const placeType = dictGet(place, 'type', '')
          items.push(
            `• **${name}**\n  Type: ${placeType} | Coordinates: ${lat}, ${lon}\n` +
              `  Google Maps: https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
          )
        }
        return `Google Maps Grounding for '${loc}':\n\n${items.join('\n\n')}`
      }
    } catch {}
    return `Google Maps Grounding for: ${loc}\nURL: https://www.google.com/maps/search/${pyQuote(loc)}`
  }
}

const webFetch: ToolSpec = {
  python: 'tool_web_fetch',
  params: [{ name: 'url', required: true }],
  run: async (ctx, args) => {
    const url = pyStr(args.url)
    if (!/^https?:\/\//.test(url)) throw new ToolError('Only http and https URLs are supported')
    if (!(await ctx.allowed('web_fetch', url))) throw new ToolError('The user denied this request.')

    let response: { bytes: Uint8Array; contentType: string | null }
    try {
      response = await httpGet(url, { 'User-Agent': 'Mozilla/5.0 (Gemibot CLI)' }, 20000, 2_000_000)
    } catch (e) {
      throw new ToolError(`Request failed: ${errorMessage(e)}`)
    }

    let text = decodeBody(response.bytes, response.contentType)
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    text = text.replace(/<[^>]+>/gs, ' ')
    text = htmlUnescape(text).replace(/[ \t]+/g, ' ')
    text = text.replace(new RegExp(`\\n${PY_S}*\\n+`, 'g'), '\n\n')
    return pyStrip(text)
  }
}

export const WEB_TOOLS: Record<string, ToolSpec> = {
  search_grounding: searchGrounding,
  map_grounding: mapGrounding,
  web_fetch: webFetch
}
