import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import sharp, { type Sharp } from 'sharp'

import { ToolError } from '../../shared/utils/exceptions'
import { pyFormatFixed, pyFormatThousands } from '../../shared/utils/pyformat'
import { pyIntValue, pyStr, pyStrip } from '../../shared/utils/pystr'
import { pyTruthy } from '../../shared/utils/pytruth'
import type { Content, Part } from '../models/content'
import { estimateRequestBreakdown } from '../services/token-usage.service'
import { pathIsFile } from '../utils/fs-stat'
import {
  CAP_PROP_FPS,
  CAP_PROP_FRAME_COUNT,
  CAP_PROP_FRAME_HEIGHT,
  CAP_PROP_FRAME_WIDTH,
  CAP_PROP_POS_FRAMES,
  type DecodedFrame,
  VideoCapture
} from '../utils/py-cv2'
import { label, pathArg, type ToolContext, type ToolSpec } from './tool-contract'

const DEFAULT_PROMPT =
  'Analyze the video timeline, scenes, actions, UI/text on screen, and key events.'

function prop(cap: VideoCapture, id: number, fallback: number): number {
  const value = cap.get(id)
  return pyTruthy(value) ? Math.trunc(value) : fallback
}

function countArg(value: unknown, fallback: number): number {
  return pyIntValue(pyTruthy(value) ? value : fallback)
}

/** Frame extraction stays out of the v1 timeline but still lands in the pending drawer and undo. */
async function noteFrame(ctx: ToolContext, full: string, summary: string): Promise<void> {
  const rel = ctx.paths.rel(full)
  const pending = ctx.changeTracker.pendingChanges.get(ctx.changeTracker.normalizePath(rel))
  if (!pending) return
  await ctx.changeTracker.recordChange(rel, full, pending.change_type, summary, true)
}

function pixels(frame: DecodedFrame): Sharp {
  return frame.kind === 'raw'
    ? sharp(frame.bytes, {
        raw: { width: frame.width, height: frame.height, channels: frame.channels }
      })
    : sharp(frame.bytes)
}

async function encodeJpeg(frame: DecodedFrame): Promise<Buffer> {
  return await pixels(frame).jpeg({ quality: 95 }).toBuffer()
}

async function encodePng(frame: DecodedFrame): Promise<Buffer> {
  return await pixels(frame).png().toBuffer()
}

const videoRead: ToolSpec = {
  python: 'tool_video_read',
  params: [{ name: 'path', required: true }],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`Video file not found: ${label(args.path)}`)

    const cap = new VideoCapture(await readFile(full))
    if (!cap.isOpened()) throw new ToolError(`Could not open video stream: ${label(args.path)}`)
    const fps = cap.get(CAP_PROP_FPS) || 0.0
    const frames = prop(cap, CAP_PROP_FRAME_COUNT, 0)
    const w = prop(cap, CAP_PROP_FRAME_WIDTH, 0)
    const h = prop(cap, CAP_PROP_FRAME_HEIGHT, 0)
    cap.release()

    const dur = fps > 0 ? frames / fps : 0.0
    const info = await stat(full)
    return (
      `Video File: ${ctx.paths.rel(full)} (${pyFormatThousands(info.size)} bytes)\n` +
      `- Resolution: ${w}x${h} px\n` +
      `- Frame Rate: ${pyFormatFixed(fps, 2)} FPS\n` +
      `- Total Frames: ${pyFormatThousands(frames)}\n` +
      `- Duration: ${pyFormatFixed(dur, 2)} seconds (${pyFormatFixed(dur / 60, 2)} minutes)`
    )
  }
}

const videoAnalyze: ToolSpec = {
  python: 'tool_video_analyze',
  params: [
    { name: 'path', required: true },
    { name: 'prompt', default: DEFAULT_PROMPT },
    { name: 'sample_frames', default: 6 }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`Video file not found: ${label(args.path)}`)

    const cap = new VideoCapture(await readFile(full))
    if (!cap.isOpened()) throw new ToolError(`Could not open video file: ${label(args.path)}`)

    const totalFrames = Math.max(1, prop(cap, CAP_PROP_FRAME_COUNT, 1))
    const fps = cap.get(CAP_PROP_FPS) || 30.0
    const nSamples = Math.max(2, Math.min(countArg(args.sample_frames, 6), 12))
    const indices: number[] = []
    for (let i = 0; i < nSamples; i++)
      indices.push(Math.trunc((i * (totalFrames - 1)) / Math.max(1, nSamples - 1)))

    const payload: Part[] = []
    const timestamps: string[] = []
    for (const idx of indices) {
      cap.set(CAP_PROP_POS_FRAMES, idx)
      const frame = cap.read()
      if (!frame) continue
      const jpeg = await encodeJpeg(frame)
      timestamps.push(`${pyFormatFixed(fps > 0 ? idx / fps : 0.0, 1)}s`)
      payload.push({ inline_data: { data: jpeg.toString('base64'), mime_type: 'image/jpeg' } })
    }
    cap.release()

    if (payload.length === 0) throw new ToolError('Could not decode frames from video.')

    const metaInfo = (await videoRead.run(ctx, { path: args.path })) as string
    payload.push({
      text:
        `These are ${timestamps.length} keyframes sampled at ${timestamps.join(', ')} ` +
        `from ${ctx.paths.rel(full)}.\n${pyStr(args.prompt)}`
    })
    const contents: Content[] = [{ parts: payload }]
    const resp = await ctx.client.generateContent(ctx.state.model, contents, undefined, {
      conversationId: ctx.state.conversationId,
      sender: ctx.state.usageSender,
      kind: 'tool',
      label: 'video analysis',
      requestedModel: ctx.state.model,
      breakdown: estimateRequestBreakdown({ contents })
    })
    ctx.generate.countUsage(resp)
    return `${metaInfo}\n\nGemini Video Timeline Analysis:\n${pyStrip(resp.text || '')}`
  }
}

const videoExtractFrames: ToolSpec = {
  python: 'tool_video_extract_frames',
  params: [
    { name: 'path', required: true },
    { name: 'output_dir', required: true },
    { name: 'count', default: 8 }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const outDir = await ctx.paths.resolve(pathArg(args.output_dir))
    if (!(await pathIsFile(full))) throw new ToolError(`Video file not found: ${label(args.path)}`)
    const detail = `${ctx.paths.rel(full)} -> ${ctx.paths.rel(outDir)}`
    if (!(await ctx.allowed('video_extract_frames', detail)))
      throw new ToolError('The user denied frame extraction.')

    const cap = new VideoCapture(await readFile(full))
    const total = Math.max(1, prop(cap, CAP_PROP_FRAME_COUNT, 1))
    const n = Math.max(1, Math.min(countArg(args.count, 8), 30))
    await mkdir(outDir, { recursive: true })
    const saved: string[] = []
    for (let i = 0; i < n; i++) {
      const fIdx = Math.trunc((i * (total - 1)) / Math.max(1, n - 1))
      cap.set(CAP_PROP_POS_FRAMES, fIdx)
      const frame = cap.read()
      if (!frame) continue
      const png = await encodePng(frame)
      const fp = join(outDir, `frame_${String(i + 1).padStart(2, '0')}_f${fIdx}.png`)
      await ctx.beginBinaryArtifact(fp)
      await writeFile(fp, png)
      await noteFrame(ctx, fp, `Extracted video frame ${fIdx} from ${ctx.paths.rel(full)}`)
      saved.push(ctx.paths.rel(fp))
    }
    cap.release()
    return `Extracted ${saved.length} frame(s) into ${ctx.paths.rel(outDir)}:\n${saved.join('\n')}`
  }
}

export const VIDEO_TOOLS: Record<string, ToolSpec> = {
  video_read: videoRead,
  video_analyze: videoAnalyze,
  video_extract_frames: videoExtractFrames
}
