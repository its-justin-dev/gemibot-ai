import { mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'

import sharp, { type Metadata, type Sharp } from 'sharp'
import { encode as htmlEncode } from 'he'

import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { errorMessage, ToolError } from '../../shared/utils/exceptions'
import { pyFormatThousands } from '../../shared/utils/pyformat'
import { pyQuote } from '../../shared/utils/pyurllib'
import { pyIntValue, pySlice, pyStr, pyStrip } from '../../shared/utils/pystr'
import { pyOr, pyTruthy } from '../../shared/utils/pytruth'
import { guessType, pathExt } from '../../shared/utils/mimetypes'
import { exifTagName, jpegExifPayload, parseExifIfd0 } from '../../shared/utils/exif'
import type { Content, Part } from '../models/content'
import { attr } from '../services/ai-client.service'
import { estimateRequestBreakdown } from '../services/token-usage.service'
import { out } from '../utils/console-out'
import { pathIsFile } from '../utils/fs-stat'
import { httpGet } from './web-tools'
import { label, pathArg, type ToolSpec } from './tool-contract'

async function imageMime(full: string): Promise<string> {
  const [mime] = guessType(full)
  return mime ?? 'image/png'
}

function pilFormat(meta: Metadata): string {
  const map: Record<string, string> = {
    jpeg: 'JPEG',
    png: 'PNG',
    webp: 'WEBP',
    gif: 'GIF',
    tiff: 'TIFF',
    avif: 'AVIF',
    heif: 'HEIF',
    bmp: 'BMP',
    jxl: 'JXL',
    jp2: 'JPEG2000',
    svg: 'SVG'
  }
  return meta.format ? (map[meta.format] ?? meta.format.toUpperCase()) : ''
}

function pilMode(meta: Metadata): string {
  const space = String(meta.space)
  if (space === 'cmyk') return 'CMYK'
  const channels = meta.channels ?? 3
  if (space === 'b-w' || space === 'grey' || space === 'grey16')
    return channels >= 2 || meta.hasAlpha ? 'LA' : 'L'
  return channels >= 4 || meta.hasAlpha ? 'RGBA' : 'RGB'
}

function exifSummary(meta: Metadata, raw: Buffer): string | null {
  const exifBuffer = jpegExifPayload(raw) ?? (meta.exif ? Buffer.from(meta.exif) : null)
  if (!exifBuffer) return null
  const entries = parseExifIfd0(exifBuffer)
  const parts: string[] = []
  for (const entry of entries.slice(0, 12)) {
    parts.push(`${exifTagName(entry.id)}=${pySlice(entry.value, 0, 60)}`)
  }
  return parts.length > 0 ? parts.join(', ') : null
}

async function pilSave(
  pipe: Sharp,
  full: string,
  quality: number | null
): Promise<{ width: number; height: number }> {
  const ext = pathExt(full).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') {
    return await pipe.jpeg({ quality: quality ?? 75 }).toFile(full)
  }
  if (ext === '.png') {
    return await pipe.png({ compressionLevel: 9 }).toFile(full)
  }
  if (ext === '.webp') return await pipe.webp({ quality: quality ?? 75 }).toFile(full)
  if (ext === '.avif') return await pipe.avif({ quality: quality ?? 50 }).toFile(full)
  if (ext === '.tiff' || ext === '.tif') return await pipe.tiff().toFile(full)
  if (ext === '.gif') return await pipe.gif().toFile(full)
  return await pipe.toFile(full)
}

const LANCZOS = { kernel: 'lanczos3' } as const

function unsharpMask(pipe: Sharp, radius: number, percent: number): Sharp {
  return pipe.sharpen({ sigma: radius / 2, m1: 0, m2: percent / 100 })
}

function contrast(pipe: Sharp, factor: number): Sharp {
  return pipe.linear(factor, 128 * (1 - factor))
}

const imageRead: ToolSpec = {
  python: 'tool_image_read',
  params: [
    { name: 'path', required: true },
    {
      name: 'prompt',
      default: 'Describe this image in detail, including objects, text, layout, and colors.'
    }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`Image not found: ${label(args.path)}`)
    const raw = await readFile(full)
    const mime = await imageMime(full)
    const metaLines = [
      `File: ${ctx.paths.rel(full)} (${pyFormatThousands(raw.length)} bytes, ${mime})`
    ]
    try {
      const meta = await sharp(raw).metadata()
      metaLines.push(
        `Dimensions: ${meta.width}x${meta.height} px | Format: ${pilFormat(meta)} | Mode: ${pilMode(meta)}`
      )
      const exif = exifSummary(meta, raw)
      if (exif) metaLines.push(`EXIF: ${exif}`)
    } catch (e) {
      metaLines.push(`Pillow metadata note: ${errorMessage(e)}`)
    }

    let visionReply: string
    try {
      const part: Part = { inline_data: { data: raw.toString('base64'), mime_type: mime } }
      const contents: Content[] = [{ parts: [part, { text: pyStr(args.prompt) }] }]
      const resp = await ctx.client.generateContent(ctx.state.model, contents, undefined, {
        conversationId: ctx.state.conversationId,
        sender: ctx.state.usageSender,
        kind: 'tool',
        label: 'image analysis',
        requestedModel: ctx.state.model,
        breakdown: estimateRequestBreakdown({ contents })
      })
      ctx.generate.countUsage(resp)
      visionReply = resp.text || ''
    } catch (e) {
      visionReply = `Gemini Vision call failed: ${errorMessage(e)}`
    }

    return metaLines.join('\n') + '\n\nVision Analysis:\n' + pyStrip(visionReply)
  }
}

const imageOcr: ToolSpec = {
  python: 'tool_image_ocr',
  params: [
    { name: 'path', required: true },
    { name: 'language', default: 'auto' }
  ],
  run: async (ctx, args) => {
    const ocrPrompt =
      `Perform exact, character-for-character OCR on this image (language hint: ${pyStr(args.language)}). ` +
      'Preserve all headings, line breaks, tables (as Markdown tables), and code blocks. ' +
      'Output the extracted text clearly.'
    return await imageRead.run(ctx, { path: args.path, prompt: ocrPrompt })
  }
}

async function proceduralCanvas(prompt: string, targetW: number, targetH: number): Promise<Sharp> {
  const raw = Buffer.alloc(targetW * targetH * 3)
  for (let y = 0; y < targetH; y += 1) {
    const t = y / targetH
    const r = Math.trunc(18 + t * 40)
    const g = Math.trunc(28 + t * 80)
    const b = Math.trunc(55 + t * 140)
    const hex = `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
      .toString(16)
      .padStart(2, '0')}`
    raw.write(hex.repeat(targetW), y * targetW * 3, 'hex')
  }
  const lines = ['GEMIBOT ULTRA HD 4K RENDER', '', `Prompt: ${pySlice(prompt, 0, 160)}`]
  const tspans = lines
    .map((line, i) => `<tspan x="200" dy="${i === 0 ? 0 : 20}">${htmlEncode(line)}</tspan>`)
    .join('')
  const frame =
    `<svg width="${targetW}" height="${targetH}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="120" y="120" width="${targetW - 240}" height="${targetH - 240}" fill="none" ` +
    'stroke="rgb(0,210,255)" stroke-width="6"/>' +
    `<text x="200" y="220" fill="rgb(240,248,255)" font-family="monospace" font-size="16">${tspans}</text>` +
    '</svg>'
  return sharp(raw, { raw: { width: targetW, height: targetH, channels: 3 } }).composite([
    { input: Buffer.from(frame), top: 0, left: 0 }
  ])
}

const imageGenerateUhd: ToolSpec = {
  python: 'tool_image_generate_uhd',
  params: [
    { name: 'prompt', required: true },
    { name: 'output_path', required: true },
    { name: 'resolution', default: '4k' },
    { name: 'enhance', default: true },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.output_path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('image_generate_uhd', `${rel} (${pyStr(args.resolution)})`))) {
      throw new ToolError('The user denied image generation.')
    }
    await mkdir(dirname(full), { recursive: true })

    const resMap: Record<string, [number, number]> = {
      '4k': [3840, 2160],
      '2k': [2560, 1440],
      square_uhd: [2048, 2048],
      '1080p': [1920, 1080]
    }
    const [targetW, targetH] = resMap[pyStr(pyOr(args.resolution, '4k')).toLowerCase()] ?? [
      3840, 2160
    ]
    const uhdPrompt =
      `${pyStr(args.prompt)}, ultra HD 4K resolution, 8k photorealistic masterpiece, razor-sharp focus, ` +
      'high dynamic range, intricate micro-details, cinematic lighting'

    let rawImageBytes: Buffer | null = null
    let usedSource = ''

    for (const imgModel of AppConstants.IMAGE_MODELS) {
      try {
        const res = await ctx.client.generateImages(
          imgModel,
          uhdPrompt,
          { number_of_images: 1 },
          {
            conversationId: ctx.state.conversationId,
            sender: ctx.state.usageSender,
            kind: 'image',
            label: 'image generation',
            requestedModel: ctx.state.model
          }
        )
        const images = attr<Record<string, unknown>[]>(res, 'generated_images')
        if (pyTruthy(images)) {
          const imageObj = attr<Record<string, unknown>>(images?.[0], 'image')
          const bytes = attr<unknown>(imageObj, 'image_bytes')
          rawImageBytes =
            typeof bytes === 'string'
              ? Buffer.from(bytes, 'base64')
              : Buffer.from(bytes as Uint8Array)
          usedSource = `Gemini Imagen (${imgModel})`
          break
        }
      } catch {
        continue
      }
    }

    if (rawImageBytes === null) {
      try {
        const genUrl =
          `https://image.pollinations.ai/prompt/${pyQuote(uhdPrompt)}` +
          `?width=${Math.min(targetW, 1920)}&height=${Math.min(targetH, 1080)}&nologo=true&enhance=true`
        const { bytes } = await httpGet(
          genUrl,
          { 'User-Agent': 'Mozilla/5.0 (Gemibot UHD)' },
          45000
        )
        rawImageBytes = Buffer.from(bytes)
        usedSource = 'Flux Ultra-HD Synthesis Engine'
      } catch {
        rawImageBytes = null
      }
    }

    let pipe: Sharp
    if (rawImageBytes) {
      pipe = sharp(rawImageBytes).removeAlpha().toColourspace('srgb')
    } else {
      pipe = await proceduralCanvas(pyStr(args.prompt), targetW, targetH)
      usedSource = 'Pillow Procedural 4K Canvas'
    }

    pipe = pipe.resize(targetW, targetH, LANCZOS)
    if (pyTruthy(args.enhance)) {
      pipe = contrast(unsharpMask(pipe, 1.8, 135), 1.06).modulate({ saturation: 1.05 })
    }

    const summary = `Generated Ultra HD Image: ${rel} | Resolution: ${targetW}x${targetH} | Engine: ${usedSource}`
    await ctx.beginBinaryArtifact(full)
    await pilSave(pipe, full, 98)
    await ctx.recordBinaryArtifact(full, 'created', summary, pyStr(args.what), pyStr(args.why))
    out(`  ${C.GRAY}- ${C.GREEN}- ${summary}${C.RESET}`)
    return summary
  }
}

const imageTransform: ToolSpec = {
  python: 'tool_image_transform',
  params: [
    { name: 'path', required: true },
    { name: 'operation', required: true },
    { name: 'output_path', default: null },
    { name: 'width', default: null },
    { name: 'height', default: null },
    { name: 'angle', default: null },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const src = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(src))) throw new ToolError(`Source image not found: ${label(args.path)}`)
    const dst = pyTruthy(args.output_path)
      ? await ctx.paths.resolve(pathArg(args.output_path))
      : src
    const relDst = ctx.paths.rel(dst)
    if (!(await ctx.allowed('image_transform', `${pyStr(args.operation)} -> ${relDst}`))) {
      throw new ToolError('The user denied image transformation.')
    }

    const meta = await sharp(src).metadata()
    const op = pyStr(args.operation).toLowerCase().trim()
    let pipe: Sharp
    if (op === 'resize') {
      const w = Math.max(1, pyIntValue(pyOr(args.width, meta.width ?? 1)))
      const h = Math.max(1, pyIntValue(pyOr(args.height, meta.height ?? 1)))
      pipe = sharp(src).resize(w, h, LANCZOS)
    } else if (op === 'upscale_4k') {
      pipe = unsharpMask(sharp(src).removeAlpha().resize(3840, 2160, LANCZOS), 1.8, 130)
    } else if (op === 'grayscale') {
      pipe = sharp(src).grayscale()
    } else if (op === 'rotate') {
      const angle = Number(pyOr(args.angle, 90))
      pipe = sharp(src).rotate(-angle)
    } else if (op === 'sharpen') {
      pipe = sharp(src).sharpen({ sigma: 1 })
    } else if (op === 'contrast') {
      pipe = contrast(sharp(src).removeAlpha().toColourspace('srgb'), 1.25)
    } else if (op === 'thumbnail') {
      const w = Math.max(1, pyIntValue(pyOr(args.width, 512)))
      const h = Math.max(1, pyIntValue(pyOr(args.height, 512)))
      pipe = sharp(src).resize(w, h, { ...LANCZOS, fit: 'inside', withoutEnlargement: true })
    } else {
      throw new ToolError(`Unsupported operation: ${pyStr(args.operation)}`)
    }

    await mkdir(dirname(dst), { recursive: true })
    await ctx.beginBinaryArtifact(dst)
    const info = await pilSave(pipe, dst, null)
    const summary = `Transformed ${ctx.paths.rel(src)} -> ${relDst} (${op}, ${info.width}x${info.height})`
    await ctx.recordBinaryArtifact(dst, 'modified', summary, pyStr(args.what), pyStr(args.why))
    return summary
  }
}

export const IMAGE_TOOLS: Record<string, ToolSpec> = {
  image_read: imageRead,
  image_ocr: imageOcr,
  image_generate_uhd: imageGenerateUhd,
  image_transform: imageTransform
}
