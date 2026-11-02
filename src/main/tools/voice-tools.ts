import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, extname } from 'path'

import { Communicate } from 'edge-tts-universal'

import { errorMessage, ToolError } from '../../shared/utils/exceptions'
import { pyFormatFixed, pyFormatThousands } from '../../shared/utils/pyformat'
import { pyStr, pyStrip } from '../../shared/utils/pystr'
import { pyTruthy } from '../../shared/utils/pytruth'
import { guessType } from '../../shared/utils/mimetypes'
import type { Content, Part } from '../models/content'
import { estimateRequestBreakdown } from '../services/token-usage.service'
import { pathIsFile } from '../utils/fs-stat'
import { acousticProfile } from '../utils/py-librosa'
import { readWaveHeader } from '../utils/py-wave'
import { label, pathArg, type ToolContext, type ToolSpec } from './tool-contract'

const DEFAULT_PROMPT =
  'Analyze this audio: provide a full transcript, speaker tone/emotion, background noise ' +
  'assessment, and key takeaways.'

function audioMime(full: string): string {
  const [mime] = guessType(full)
  return mime ?? 'audio/wav'
}

async function askAboutAudio(
  ctx: ToolContext,
  raw: Buffer,
  mime: string,
  prompt: string
): Promise<string> {
  try {
    const part: Part = { inline_data: { data: raw.toString('base64'), mime_type: mime } }
    const contents: Content[] = [{ parts: [part, { text: prompt }] }]
    const resp = await ctx.client.generateContent(ctx.state.model, contents, undefined, {
      conversationId: ctx.state.conversationId,
      sender: ctx.state.usageSender,
      kind: 'tool',
      label: 'audio analysis',
      requestedModel: ctx.state.model,
      breakdown: estimateRequestBreakdown({ contents })
    })
    ctx.generate.countUsage(resp)
    return resp.text || ''
  } catch (e) {
    return `Gemini Audio analysis error: ${errorMessage(e)}`
  }
}

const voiceAnalyze: ToolSpec = {
  python: 'tool_voice_analyze',
  params: [
    { name: 'path', required: true },
    { name: 'prompt', default: DEFAULT_PROMPT }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`Audio file not found: ${label(args.path)}`)
    const raw = await readFile(full)
    const mime = audioMime(full)
    const metrics = [
      `Audio File: ${ctx.paths.rel(full)} (${pyFormatThousands(raw.length)} bytes, ${mime})`
    ]

    if (extname(full).toLowerCase() === '.wav') {
      try {
        const wf = readWaveHeader(raw)
        const dur = wf.rate ? wf.nframes / wf.rate : 0
        metrics.push(
          `WAV Metrics: Duration=${pyFormatFixed(dur, 2)}s | SampleRate=${wf.rate}Hz | ` +
            `Channels=${wf.channels} | SampleWidth=${wf.sampwidth * 8}-bit`
        )
      } catch {}
    }

    try {
      metrics.push(acousticProfile(raw))
    } catch {}

    const aiAnalysis = await askAboutAudio(ctx, raw, mime, pyStr(args.prompt))
    return metrics.join('\n') + '\n\nAI Voice Analysis:\n' + pyStrip(aiAnalysis)
  }
}

const voiceTranscribe: ToolSpec = {
  python: 'tool_voice_transcribe',
  params: [
    { name: 'path', required: true },
    { name: 'language', default: 'auto' }
  ],
  run: async (ctx, args) => {
    const prompt =
      `Transcribe every spoken word in this audio accurately (language hint: ${pyStr(args.language)}). ` +
      'Include timestamps if multiple sections or speakers exist.'
    return await voiceAnalyze.run(ctx, { path: args.path, prompt })
  }
}

async function synthesizeWithEdge(text: string, voice: string, full: string): Promise<void> {
  const communicate = new Communicate(text, { voice })
  const chunks: Buffer[] = []
  for await (const chunk of communicate.stream()) {
    if (chunk.type === 'audio' && chunk.data) chunks.push(Buffer.from(chunk.data))
  }
  await writeFile(full, Buffer.concat(chunks))
}

const voiceGenerate: ToolSpec = {
  python: 'tool_voice_generate',
  params: [
    { name: 'text', required: true },
    { name: 'output_path', required: true },
    { name: 'voice', default: 'en-US-GuyNeural' },
    { name: 'rate', default: 175 }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.output_path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('voice_generate', rel))) {
      throw new ToolError('The user denied voice generation.')
    }
    await mkdir(dirname(full), { recursive: true })

    const text = pyStr(args.text)
    const voice = pyStr(args.voice)
    try {
      await ctx.beginBinaryArtifact(full)
      await synthesizeWithEdge(text, pyTruthy(args.voice) ? voice : 'en-US-GuyNeural', full)
    } catch (e) {
      throw new ToolError(
        `No TTS engine succeeded (${errorMessage(e)}). ` +
          'Install edge-tts, gTTS, or pyttsx3 via /pip.'
      )
    }

    const info = await stat(full)
    const summary = `Generated speech audio: ${rel} (${pyFormatThousands(info.size)} bytes) via edge-tts (${voice})`
    await ctx.recordBinaryArtifact(full, 'created', `${summary}\nSpoken text: ${text}`)
    return summary
  }
}

export const VOICE_TOOLS: Record<string, ToolSpec> = {
  voice_analyze: voiceAnalyze,
  voice_transcribe: voiceTranscribe,
  voice_generate: voiceGenerate
}
