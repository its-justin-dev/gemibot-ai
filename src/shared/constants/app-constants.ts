export type ModelCategory = string

export const AppConstants = {
  API_KEY: '',

  MODEL_CATALOG: {
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite [FASTEST - 6-7s]',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite [Fast - 20-25s]',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.7-flash': 'Gemini 3.7 Flash',
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-3.5-flash': 'Gemini 3.5 Flash',
    'gemini-2-flash': 'Gemini 2 Flash',
    'gemini-2-flash-lite': 'Gemini 2 Flash Lite',
    'gemini-2.0-flash': 'Gemini 2 Flash',
    'gemini-2.0-flash-lite': 'Gemini 2 Flash Lite',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-3-flash-preview': 'Gemini 3 Flash',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
    'gemini-4-argon': 'Gemini 4 Argon',
    'gemini-flash-latest': 'Gemini Flash Latest',
    'gemini-pro-latest': 'Gemini Pro Latest',
    'gemini-flash-lite-latest': 'Gemini Flash-Lite Latest',
    'gemma-4-31b-it': 'Gemma 4 31B',
    'gemma-4-26b-a4b-it': 'Gemma 4 26B',
    'antigravity-preview-latest': 'Antigravity (Latest Preview)',
    antigravity: 'Antigravity (Default)',
    'antigravity-preview-09-2026': 'Antigravity (09-2026 Preview)',
    'antigravity-preview-05-2026': 'Antigravity (05-2026 Preview)',
    'antigravity-latest': 'Antigravity Latest',
    'deep-research-pro-preview-12-2025': 'Deep Research Pro Preview',
    'deep-research-preview-04-2026': 'Deep Research Preview',
    'deep-research-max-preview-04-2026': 'Deep Research Max Preview',
    'nano-banana-pro-preview': 'Nano Banana Pro (Gemini 3 Pro Image)',
    'gemini-3.1-flash-image': 'Nano Banana 2 (Gemini 3.1 Flash Image)',
    'gemini-3.1-flash-lite-image': 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)',
    'gemini-2.5-flash-image': 'Nano Banana (Gemini 2.5 Flash Preview Image)',
    'gemini-nano-banana-2.1': 'Gemini Nano Banana 2.1',
    'gemini-omni-1.1-flash': 'Gemini Omni 1.1 Flash',
    'gemini-omni-flash-preview': 'Gemini Omni Flash',
    'veo-3.1-generate-preview': 'Veo 3 Generate',
    'veo-3.1-fast-generate-preview': 'Veo 3 Fast Generate',
    'veo-3.1-lite-generate-preview': 'Veo 3 Lite Generate',
    'gemini-3.8-flash-tts': 'Gemini 3.8 Flash TTS',
    'gemini-3.8-flash-lite-tts': 'Gemini 3.8 Flash Lite TTS',
    'gemini-3.1-flash-tts-preview': 'Gemini 3.1 Flash TTS',
    'gemini-2.5-flash-preview-tts': 'Gemini 2.5 Flash TTS',
    'gemini-2.5-pro-preview-tts': 'Gemini 2.5 Pro TTS',
    'gemini-3.5-transcribe': 'Gemini 3.5 Transcribe',
    'lyria-3-clip-preview': 'Lyria 3 Clip',
    'lyria-3-pro-preview': 'Lyria 3 Pro',
    'lyria-3.5': 'Lyria 3.5',
    'gemini-3.8-live': 'Gemini 3.8 Live',
    'gemini-3.8-live-extended-thinking': 'Gemini 3.8 Live Extended Thinking',
    'gemini-3.5-live-translate-preview': 'Gemini 3.5 Live Translate',
    'gemini-3.5-transcribe-live': 'Gemini 3.5 Transcribe Live',
    'gemini-3.1-flash-live-preview': 'Gemini 3 Flash Live',
    'gemini-2.5-flash-native-audio-latest': 'Gemini 2.5 Flash Native Audio Dialog',
    'gemini-2.5-computer-use-preview-10-2025': 'Computer Use Preview',
    'gemini-robotics-er-2-preview': 'Gemini Robotics ER 2 Preview',
    'gemini-embedding-2': 'Gemini Embedding 2',
    'gemini-embedding-001': 'Gemini Embedding 1',
    'gemini-2': 'Gemini 2 (Search Grounding)',
    'gemini-2.5': 'Gemini 2.5 (Search Grounding)',
    'gemini-3': 'Gemini 3 and newer (Search Grounding)',
    default: 'Default (Search Grounding)'
  } as Record<string, string>,

  ANTIGRAVITY_MODELS: [
    'antigravity-preview-latest',
    'antigravity',
    'antigravity-preview-09-2026',
    'antigravity-preview-05-2026',
    'antigravity-latest'
  ],

  MODEL_ALIASES: {
    'gemini-2-flash': 'gemini-3.1-flash-lite',
    'gemini-2.0-flash': 'gemini-3.1-flash-lite',
    'gemini-2-flash-lite': 'gemini-3.1-flash-lite',
    'gemini-2.0-flash-lite': 'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite',
    'gemini-2.5-flash': 'gemini-3.8-flash',
    'gemini-2.5-pro': 'gemini-3.1-pro-preview',
    'gemini-2': 'gemini-3.1-flash-lite',
    'gemini-2.5': 'gemini-3.1-flash-lite',
    'gemini-3': 'gemini-3.1-flash-lite',
    default: 'gemini-3.1-flash-lite',
    antigravity: 'antigravity-preview-latest',
    'antigravity-latest': 'antigravity-preview-latest'
  } as Record<string, string>,

  FALLBACK_MODELS: [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'antigravity-preview-latest',
    'gemini-3.5-flash'
  ],

  GROUNDING_MODELS: new Set(['gemini-2', 'gemini-2.5', 'gemini-3', 'default']),

  resolveModelId(modelId: string): string {
    if (!modelId) return 'gemini-3.1-flash-lite'
    const cleaned = String(modelId).trim()
    return AppConstants.MODEL_ALIASES[cleaned] ?? cleaned
  },

  isAntigravity(modelId: string): boolean {
    return String(modelId).toLowerCase().startsWith('antigravity')
  },

  isGemma(modelId: string): boolean {
    return String(modelId).toLowerCase().startsWith('gemma')
  },

  isEmbedding(modelId: string): boolean {
    return String(modelId).toLowerCase().includes('embedding')
  },

  isGrounding(modelId: string): boolean {
    return AppConstants.GROUNDING_MODELS.has(String(modelId).trim())
  },

  isNetworkError(err: unknown): boolean {
    const errStr = String(err).toLowerCase()
    const indicators = [
      'getaddrinfo failed',
      'nameresolutionerror',
      'maxretryerror',
      'connectionerror',
      'connecterror',
      'failed to establish a new connection',
      'connection refused',
      'network is unreachable',
      'unreachable network',
      'unreachable host',
      'connection reset',
      'winerror 10051',
      'winerror 10060',
      'winerror 10065',
      'winerror 10054',
      'no internet',
      'temporary failure in name resolution',
      'failed to resolve',
      'socket.gaierror'
    ]
    return indicators.some((ind) => errStr.includes(ind))
  },

  getModelCategory(modelId: string): ModelCategory {
    const m = String(modelId).toLowerCase()
    if (m.startsWith('antigravity')) return 'Antigravity'
    if (m.startsWith('deep-research')) return 'Deep Research'
    if (m.startsWith('gemma')) return 'Gemma'
    if (m.includes('embedding')) return 'Embeddings'
    if (
      m === 'gemini-2' ||
      m === 'gemini-2.5' ||
      m === 'gemini-3' ||
      m === 'default' ||
      m.includes('grounding')
    )
      return 'Search Grounding'
    if (m.includes('tts') || m.includes('transcribe') || m.includes('lyria') || m.includes('audio'))
      return 'Audio & Voice'
    if (m.includes('image') || m.includes('banana') || m.includes('veo') || m.includes('omni'))
      return 'Image & Video'
    if (m.includes('pro') || m.includes('argon')) return 'Pro & Frontier'
    if (m.includes('flash') || m.includes('lite')) return 'Flash'
    if (m.includes('computer-use') || m.includes('robotics')) return 'Robotics & Tools'
    return 'Flash'
  },

  getModelBadge(modelId: string): string {
    const m = String(modelId).toLowerCase()
    if (m === 'gemini-3.1-flash-lite')
      return '\u26a1 FASTEST \u2022 6-7s response \u2022 500 RPD \u2022 Multimodal'
    if (m === 'gemini-3.5-flash-lite')
      return '\u26a1 Fast \u2022 20-25s response \u2022 500 RPD \u2022 Multimodal'
    if (m.startsWith('antigravity'))
      return '\ud83e\udd16 Autonomous Coding Agent \u2022 Interactions API'
    if (m.startsWith('deep-research')) return '\ud83d\udd0d Autonomous Deep Web Research Agent'
    if (m === 'gemini-3.8-flash') return '\u26a1 Ultra Fast \u2022 Latest Generation'
    if (m === 'gemini-3.6-flash') return '\u26a1 High Speed \u2022 High Context'
    if (m === 'gemini-3.5-flash') return '\u26a1 High Capacity \u2022 Flagship Flash'
    if (m.startsWith('gemma')) return '\ud83d\udc8e Open Model \u2022 Direct Reasoning'
    if (m.includes('embedding')) return '\ud83d\udcd0 Vector Embeddings \u2022 Semantic Search'
    if (m === 'gemini-2' || m === 'gemini-2.5' || m === 'gemini-3' || m === 'default')
      return '\ud83c\udf10 Live Google Web Search Grounded'
    if (m.includes('tts') || m.includes('voice'))
      return '\ud83d\udd0a Speech & Voice Audio Synthesis'
    if (m.includes('transcribe')) return '\ud83c\udf99\ufe0f Audio Transcription & Speech Analysis'
    if (m.includes('image') || m.includes('banana'))
      return '\ud83c\udfa8 Multimodal Image Generation & Vision'
    if (m.includes('veo')) return '\ud83c\udfac High-Definition Video Generation'
    if (m.includes('pro')) return '\ud83e\udde0 Complex Reasoning & Code Architecture'
    if (m.includes('argon')) return '\ud83e\udde0 Flagship Reasoning Frontier Model'
    if (m.includes('computer-use')) return '\ud83d\udda5\ufe0f UI Automation & Computer Control'
    if (m.includes('robotics')) return '\ud83e\uddbe Spatial & Physical Intelligence'
    return '\u26a1 General AI Generation'
  },

  MODELS: [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-4-argon',
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemini-flash-lite-latest',
    'antigravity-preview-latest',
    'antigravity',
    'antigravity-preview-09-2026',
    'antigravity-preview-05-2026',
    'antigravity-latest',
    'deep-research-pro-preview-12-2025',
    'deep-research-preview-04-2026',
    'deep-research-max-preview-04-2026',
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it'
  ],

  IMAGE_MODELS: [
    'nano-banana-pro-preview',
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
    'imagen-3.0-generate-002'
  ],

  MAX_STEPS: 40,
  MAX_OUTPUT: 30000,

  /**
   * How much of the stored memory document rides along in every request. v1.0 sent the last 60k
   * characters, which is roughly 15k tokens re-uploaded on every step of every turn; this budget
   * is the v2 window — about 5k tokens, enough for a few hundred recent memory lines.
   */
  MEMORY_PROMPT_CHARS: 20000,

  /** Saving effort feeds the model a fifth of this window and a shorter conversation. */
  SAVING_MEMORY_PROMPT_CHARS: 4000,

  /** How many trailing history entries keep their tool output in full. */
  HISTORY_KEEP_ENTRIES: 12,
  SAVING_HISTORY_KEEP_ENTRIES: 6,

  SESSION_DIR: '.gemibot',

  IGNORED: new Set([
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    'dist',
    'build',
    '.idea',
    '.vscode',
    '.next',
    'target',
    '.pytest_cache',
    '.gemibot'
  ]),

  WIDTH: Math.max(60, Math.min(100 - 4, 110)),

  SPINNER_FRAMES: ['|', '/', '-', '\\'],

  REQUIRED_PIP_PACKAGES: [
    'google-genai',
    'pillow',
    'python-docx',
    'openpyxl',
    'pandas',
    'pypdf',
    'pymupdf',
    'reportlab',
    'python-pptx',
    'opencv-python',
    'moviepy',
    'pydub',
    'SpeechRecognition',
    'gTTS',
    'pyttsx3',
    'edge-tts',
    'librosa',
    'soundfile',
    'numpy',
    'qrcode',
    'psutil',
    'beautifulsoup4',
    'lxml',
    'requests'
  ],

  MEMORY_HEADER:
    '# System Development Progress & Interaction Memory\n\n' +
    '> This document in the conversation database stores the complete, unabbreviated ' +
    'chronological record of all user prompts, AI responses, tool/command executions, and ' +
    'exact file diffs/contents across sessions.\n\n',

  SETTINGS_HEADER:
    '# Gemibot User Settings & Preferences\n\n' +
    '> These preferences are stored in the conversation database for Gemibot (CLI and Window ' +
    'GUI). When you reopen Gemibot, they are restored automatically.\n\n',

  PERSONA: `
You are "GemiBot AI" running inside Gemibot CLI, a command-line coding and multimodal agent
and the user's close friend, like a chill older brother who is also a very strong senior engineer.

Personality:
- Warm, loyal, casual and short. Never robotic or formal.
- Call the user "bro". Never write the full word "brother".
- If the user says "bro" or "brother", answer back with "bro".
- Reply in the same language the user uses (English, Tagalog or Taglish).
- Never use emojis.
- The persona applies to your chat messages only. Never put persona words into
  code, comments, commit messages or file contents unless the user asks.

Memory & Continuity Protocol:
- The conversation database holds the complete system development progress; the engine
  includes its memory digest in every prompt automatically.
- The CLI engine automatically writes the full, unabbreviated interaction log (including
  exact prompts, your complete response, all tool/command outputs, exact diffs, and full
  modified file contents) as the final step of every turn. Do not copy it manually.

Capabilities & Specialized Suites:
- Coding & Workspace: list_files, read_file, glob_files, grep_files, edit_file, write_file, delete_file, run_command, web_fetch, todo_write
- Image Vision & Ultra HD Generation: image_read, image_ocr, image_generate_uhd
- Word DOCX Management: docx_read, docx_analyze, docx_write, docx_edit
- Excel & Spreadsheet Management: excel_read, excel_analyze, excel_write, excel_formula_audit
- PDF & PowerPoint Management: pdf_read, pdf_analyze, pdf_write, pptx_read, pptx_write
- Voice & Audio Intelligence: voice_analyze, voice_transcribe, voice_generate
- Video Intelligence: video_read, video_analyze, video_extract_frames
- Data Science, SQLite, Archives & Diagnostics: sqlite_query, csv_analyze, archive_manage, qr_generate, system_diagnostics

How you work:
- STRICT TARGET DIRECTORY RESTRICTION: You work exclusively inside the user's
  designated target directory and its subfolders. You may list, read, search,
  create, edit, delete, and generate files (including images and media) ONLY
  inside that directory. Nothing outside the target directory can be touched,
  and you cannot escape or navigate up to parent folders (e.g. "..", absolute
  paths, other drives, symlinks/junctions).
- All generated files (images, docx, excel, pdf, audio, video frames, etc.)
  must be saved inside the target directory.
- Always read a file before you edit it. Never guess file contents.
- Prefer edit_file for changes. Use write_file only for new files or full rewrites.
- read_file output has line number prefixes like "12| ". Never include them in
  old_string, new_string or file content.
- Make the smallest correct change. Match the existing code style and conventions.
- For multi-step work, keep a short plan with todo_write and update it as you go.
- After changing code, run the project's tests, build or linter with run_command
  when that is possible, and fix what you broke.
- Use grep_files and glob_files to explore before making assumptions.
- Be accurate. If you are not sure, say so. Do not invent files, functions or output.
- Keep chat replies short. Do not repeat file contents you already wrote.
`,

  PLAN_NOTE: `
You are in PLAN mode. You can only read, analyze and search. You cannot edit files or run
commands. Investigate, then give the user a clear step-by-step plan. Do not claim
you changed anything.
`,

  READ_NOTE: `
You are in READ mode. You can only read and inspect files, documents, images, audio,
spreadsheets, and videos. You cannot modify or delete files or execute shell commands.
`
}

export type AppConstantsType = typeof AppConstants

export function setConsoleWidth(columns: number): void {
  AppConstants.WIDTH = Math.max(60, Math.min(columns - 4, 110))
}
