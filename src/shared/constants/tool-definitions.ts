export type SchemaTypeName = 'STRING' | 'INTEGER' | 'BOOLEAN' | 'NUMBER' | 'ARRAY' | 'OBJECT'

export const STR: SchemaTypeName = 'STRING'
export const INT: SchemaTypeName = 'INTEGER'
export const BOOL: SchemaTypeName = 'BOOLEAN'
export const NUM: SchemaTypeName = 'NUMBER'

export interface SchemaSpec {
  type: SchemaTypeName
  description?: string
  items?: SchemaSpec
  properties?: Record<string, SchemaSpec>
  required?: string[]
}

export interface ToolDecl {
  name: string
  description: string
  parameters: SchemaSpec
}

export function S(
  kind: SchemaTypeName,
  desc?: string,
  kw?: Pick<SchemaSpec, 'items' | 'properties' | 'required'>
): SchemaSpec {
  return { type: kind, description: desc, ...kw }
}

export function decl(
  name: string,
  description: string,
  props: Record<string, SchemaSpec>,
  required: string[] = []
): ToolDecl {
  return {
    name,
    description,
    parameters: { type: 'OBJECT', properties: props, required: [...required] }
  }
}

export const READ_TOOLS: ToolDecl[] = [
  decl(
    'list_files',
    'List files and folders in a directory of the project.',
    {
      path: S(STR, "Directory relative to the project root. Default '.'"),
      depth: S(INT, 'How many levels to show (1-4). Default 2')
    },
    []
  ),
  decl(
    'read_file',
    "Read a text file. Output lines are prefixed with 'N| ' line numbers.",
    {
      path: S(STR, 'File path relative to the project root'),
      offset: S(INT, 'First line to read, starting at 1'),
      limit: S(INT, 'Maximum number of lines. Default 2000')
    },
    ['path']
  ),
  decl(
    'glob_files',
    "Find files by glob pattern such as '**/*.py' or 'src/**/*.ts'.",
    { pattern: S(STR, 'Glob pattern relative to the project root') },
    ['pattern']
  ),
  decl(
    'grep_files',
    'Search file contents with a regular expression.',
    {
      pattern: S(STR, 'Regular expression to search for'),
      path: S(STR, "Directory or file to search. Default '.'"),
      include: S(STR, "Only search file names matching this glob, e.g. '*.py'"),
      ignore_case: S(BOOL, 'Case-insensitive search')
    },
    ['pattern']
  ),
  decl(
    'todo_write',
    'Create or update the task checklist for the current job.',
    {
      todos: S('ARRAY', 'Full list of todos', {
        items: {
          type: 'OBJECT',
          properties: {
            content: S(STR, 'Task description'),
            status: S(STR, 'pending, in_progress or completed')
          },
          required: ['content', 'status']
        }
      })
    },
    ['todos']
  )
]

export const WRITE_TOOLS: ToolDecl[] = [
  decl(
    'edit_file',
    'Replace exact text in a file. old_string must match the file exactly and be unique unless replace_all is true. Use an empty old_string only to create a new file.',
    {
      path: S(STR, 'File path relative to the project root'),
      old_string: S(STR, 'Exact text to replace'),
      new_string: S(STR, 'Replacement text'),
      replace_all: S(BOOL, 'Replace every occurrence'),
      what: S(STR, 'Brief description of what was changed (1-2 lines, optional)'),
      why: S(STR, 'Reason for the change (optional)')
    },
    ['path', 'old_string', 'new_string']
  ),
  decl(
    'write_file',
    'Create a file or completely overwrite an existing one.',
    {
      path: S(STR, 'File path relative to the project root'),
      content: S(STR, 'Full file content'),
      what: S(STR, 'Brief description of what the file contains or does (1-2 lines, optional)'),
      why: S(STR, 'Reason for creating/modifying this file (optional)')
    },
    ['path', 'content']
  ),
  decl(
    'delete_file',
    'Delete a file from the project.',
    {
      path: S(STR, 'File path relative to the project root'),
      what: S(STR, 'Brief description of what was deleted (1-2 lines, optional)'),
      why: S(STR, 'Reason for deletion (optional)')
    },
    ['path']
  ),
  decl(
    'run_command',
    'Run a shell command in the project root (build, test, git, install, etc.).',
    {
      command: S(STR, 'The command to run'),
      timeout: S(INT, 'Timeout in seconds. Default 120, maximum 600')
    },
    ['command']
  ),
  decl(
    'web_fetch',
    'Fetch a web page and return its text content.',
    { url: S(STR, 'The http or https URL') },
    ['url']
  )
]

export const IMAGE_READ_TOOLS: ToolDecl[] = [
  decl(
    'image_read',
    'Read and analyze an image file using Pillow metadata and Gemini Vision.',
    {
      path: S(STR, 'Image path relative to project root'),
      prompt: S(STR, 'Question or analysis instruction for the image')
    },
    ['path']
  ),
  decl(
    'image_ocr',
    'Extract all text, tables, and labels from an image using Gemini Vision OCR.',
    {
      path: S(STR, 'Image path relative to project root'),
      language: S(STR, "Expected language hint, default 'auto'")
    },
    ['path']
  )
]

export const IMAGE_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'image_generate_uhd',
    'Generate an Ultra HD 4K (3840x2160) image from a prompt and save it to disk.',
    {
      prompt: S(STR, 'Detailed visual description of the image to generate'),
      output_path: S(STR, "Destination file path, e.g. 'assets/hero_uhd.png'"),
      resolution: S(
        STR,
        "Target resolution: '4k' (3840x2160), '2k' (2560x1440), 'square_uhd' (2048x2048). Default '4k'"
      ),
      enhance: S(BOOL, 'Apply Ultra HD Lanczos sharpening and contrast mastering. Default true'),
      what: S(STR, 'Brief description of the generated image (1-2 lines, optional)'),
      why: S(STR, 'Reason for generating this image (optional)')
    },
    ['prompt', 'output_path']
  ),
  decl(
    'image_transform',
    'Resize, crop, rotate, convert format, or enhance an existing image.',
    {
      path: S(STR, 'Source image path'),
      output_path: S(STR, 'Output image path (optional, defaults to overwriting path)'),
      operation: S(
        STR,
        "Operation: 'resize', 'upscale_4k', 'grayscale', 'rotate', 'sharpen', 'contrast', 'thumbnail'"
      ),
      width: S(INT, 'Target width for resize/thumbnail'),
      height: S(INT, 'Target height for resize/thumbnail'),
      angle: S(INT, 'Rotation angle in degrees'),
      what: S(STR, 'Brief description of the transformation (1-2 lines, optional)'),
      why: S(STR, 'Reason for this transformation (optional)')
    },
    ['path', 'operation']
  )
]

export const DOCX_READ_TOOLS: ToolDecl[] = [
  decl(
    'docx_read',
    'Read a Microsoft Word (.docx) file including headings, paragraphs, and tables.',
    {
      path: S(STR, 'Path to the .docx file'),
      include_tables: S(BOOL, 'Include extracted table rows. Default true')
    },
    ['path']
  ),
  decl(
    'docx_analyze',
    'Analyze a Word (.docx) file for structure, statistics, styles, headings, and readability.',
    { path: S(STR, 'Path to the .docx file') },
    ['path']
  )
]

export const DOCX_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'docx_write',
    'Create or overwrite a Microsoft Word (.docx) document from Markdown-formatted content.',
    {
      path: S(STR, 'Output .docx file path'),
      title: S(STR, 'Document title heading'),
      content: S(
        STR,
        'Body content supporting # headings, * bullets, 1. numbered lists, and | tables |'
      ),
      author: S(STR, 'Document author metadata'),
      what: S(STR, 'Brief description of the document content (1-2 lines, optional)'),
      why: S(STR, 'Reason for creating/modifying this document (optional)')
    },
    ['path', 'content']
  ),
  decl(
    'docx_edit',
    'Edit an existing .docx file by replacing text across paragraphs/tables or appending content.',
    {
      path: S(STR, 'Path to existing .docx file'),
      find_text: S(STR, 'Exact text to find and replace (optional)'),
      replace_text: S(STR, 'Replacement text (optional)'),
      append_markdown: S(
        STR,
        'Additional Markdown paragraphs/headings to append at the end (optional)'
      ),
      what: S(STR, 'Brief description of the edit (1-2 lines, optional)'),
      why: S(STR, 'Reason for this edit (optional)')
    },
    ['path']
  )
]

export const EXCEL_READ_TOOLS: ToolDecl[] = [
  decl(
    'excel_read',
    'Read sheets, rows, and cell values from an Excel (.xlsx) or CSV file.',
    {
      path: S(STR, 'Path to .xlsx or .csv file'),
      sheet: S(STR, 'Sheet name (optional, defaults to active sheet)'),
      max_rows: S(INT, 'Maximum rows to display. Default 100')
    },
    ['path']
  ),
  decl(
    'excel_analyze',
    'Analyze an Excel (.xlsx) workbook for sheet schemas, summary statistics, missing values, and formulas.',
    { path: S(STR, 'Path to .xlsx file') },
    ['path']
  )
]

export const EXCEL_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'excel_write',
    'Create or update an Excel (.xlsx) workbook with headers, rows, formulas, and auto-sized columns.',
    {
      path: S(STR, 'Output .xlsx file path'),
      sheet_name: S(STR, "Target worksheet name. Default 'Sheet1'"),
      headers: S('ARRAY', 'Column header names', { items: S(STR) }),
      rows: S('ARRAY', "2D array of row values (strings, numbers, or '=SUM(...)' formulas)", {
        items: S('ARRAY', undefined, { items: S(STR) })
      })
    },
    ['path', 'headers', 'rows']
  )
]

export const PDF_PPTX_READ_TOOLS: ToolDecl[] = [
  decl(
    'pdf_read',
    'Read text content from a PDF file across specified pages.',
    {
      path: S(STR, 'Path to .pdf file'),
      start_page: S(INT, 'First page number (1-indexed). Default 1'),
      end_page: S(INT, 'Last page number. Default 20')
    },
    ['path']
  ),
  decl(
    'pdf_analyze',
    'Analyze a PDF document for metadata, page count, word density, TOC, and structure.',
    { path: S(STR, 'Path to .pdf file') },
    ['path']
  ),
  decl(
    'pptx_read',
    'Read slide titles, bullet text, tables, and speaker notes from a PowerPoint (.pptx) file.',
    { path: S(STR, 'Path to .pptx file') },
    ['path']
  )
]

export const PDF_PPTX_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'pdf_write',
    'Generate a formatted PDF document from title and Markdown/plain text content.',
    {
      path: S(STR, 'Output .pdf file path'),
      title: S(STR, 'PDF document title'),
      content: S(STR, 'Full text/Markdown content to render into PDF pages')
    },
    ['path', 'content']
  ),
  decl(
    'pptx_write',
    'Create a PowerPoint (.pptx) presentation deck from a list of slide definitions.',
    {
      path: S(STR, 'Output .pptx file path'),
      title: S(STR, 'Presentation main title'),
      subtitle: S(STR, 'Presentation subtitle'),
      slides: S('ARRAY', 'Slides to add', {
        items: {
          type: 'OBJECT',
          properties: {
            heading: S(STR, 'Slide heading'),
            bullets: S('ARRAY', 'Bullet points', { items: S(STR) }),
            notes: S(STR, 'Speaker notes')
          },
          required: ['heading', 'bullets']
        }
      })
    },
    ['path', 'title', 'slides']
  )
]

export const VOICE_READ_TOOLS: ToolDecl[] = [
  decl(
    'voice_analyze',
    'Analyze an audio/voice file (.wav, .mp3, .m4a, .ogg, .flac) for acoustic metrics and Gemini AI voice comprehension.',
    {
      path: S(STR, 'Audio file path'),
      prompt: S(STR, 'Specific question or analysis focus for the audio')
    },
    ['path']
  ),
  decl(
    'voice_transcribe',
    'Transcribe spoken audio into accurate text and speaker segments.',
    {
      path: S(STR, 'Audio file path'),
      language: S(STR, "Language code hint, e.g. 'en-US' or 'tl-PH'. Default 'auto'")
    },
    ['path']
  )
]

export const VOICE_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'voice_generate',
    'Generate natural spoken audio (.mp3 or .wav) from text using Neural TTS / offline TTS.',
    {
      text: S(STR, 'Text to synthesize into speech'),
      output_path: S(STR, "Output audio file path, e.g. 'output/voice.mp3'"),
      voice: S(
        STR,
        "Voice name or gender hint, e.g. 'en-US-GuyNeural', 'en-US-JennyNeural', 'en-PH-JamesNeural'"
      ),
      rate: S(INT, 'Speech rate words per minute (default 175)')
    },
    ['text', 'output_path']
  )
]

export const VIDEO_READ_TOOLS: ToolDecl[] = [
  decl(
    'video_read',
    'Inspect a video file (.mp4, .mkv, .mov, .avi, .webm) for resolution, FPS, frame count, duration, and timeline info.',
    { path: S(STR, 'Path to video file') },
    ['path']
  ),
  decl(
    'video_analyze',
    'Extract keyframes from a video file and analyze visual scenes, actions, and text with Gemini Vision.',
    {
      path: S(STR, 'Path to video file'),
      prompt: S(STR, 'What to analyze or look for in the video'),
      sample_frames: S(INT, 'Number of evenly spaced frames to sample (2-12). Default 6')
    },
    ['path']
  )
]

export const VIDEO_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'video_extract_frames',
    'Extract keyframe images from a video file into an output folder.',
    {
      path: S(STR, 'Path to video file'),
      output_dir: S(STR, 'Directory to save extracted frame PNGs'),
      count: S(INT, 'Number of evenly spaced frames to extract (1-30). Default 8')
    },
    ['path', 'output_dir']
  )
]

export const DATA_UTIL_READ_TOOLS: ToolDecl[] = [
  decl(
    'sqlite_query',
    'Run a SQL query on a local SQLite database file and return rows.',
    {
      db_path: S(STR, 'Path to .sqlite / .db file'),
      sql: S(STR, 'SQL query to execute (SELECT, PRAGMA, etc.)')
    },
    ['db_path', 'sql']
  ),
  decl(
    'csv_analyze',
    'Perform statistical and schema profiling on a CSV/TSV dataset.',
    { path: S(STR, 'Path to .csv file') },
    ['path']
  ),
  decl(
    'system_diagnostics',
    'Inspect OS, CPU, RAM, Disk, Python .venv packages, and Gemibot readiness.',
    {},
    []
  )
]

export const DATA_UTIL_WRITE_TOOLS: ToolDecl[] = [
  decl(
    'archive_manage',
    'Create or extract a .zip or .tar.gz archive inside the project.',
    {
      action: S(STR, "'zip', 'unzip', 'tar', or 'untar'"),
      source: S(STR, 'Source file/folder or archive path'),
      destination: S(STR, 'Destination archive path or extraction folder')
    },
    ['action', 'source', 'destination']
  ),
  decl(
    'qr_generate',
    'Generate a high-resolution QR code image PNG from text or URL.',
    {
      data: S(STR, 'URL or text payload for the QR code'),
      output_path: S(STR, "Output PNG path, e.g. 'assets/qrcode.png'")
    },
    ['data', 'output_path']
  )
]

export const GROUNDING_TOOLS: ToolDecl[] = [
  decl(
    'search_grounding',
    'Real-time Google Search grounding: query Google for live facts, breaking news, docs, and citations.',
    { query: S(STR, 'Search query to find real-time information from Google Search') },
    ['query']
  ),
  decl(
    'map_grounding',
    'Google Maps grounding: look up places, addresses, navigation directions, geo coordinates, and local business data.',
    {
      location: S(STR, 'Place name, address, or geographic query on Google Maps'),
      query: S(STR, 'Specific question or information required about this location (optional)')
    },
    ['location']
  )
]

export const ALL_READ_DECLARATIONS: ToolDecl[] = [
  ...READ_TOOLS,
  ...IMAGE_READ_TOOLS,
  ...DOCX_READ_TOOLS,
  ...EXCEL_READ_TOOLS,
  ...PDF_PPTX_READ_TOOLS,
  ...VOICE_READ_TOOLS,
  ...VIDEO_READ_TOOLS,
  ...DATA_UTIL_READ_TOOLS,
  ...GROUNDING_TOOLS
]

export const ALL_WRITE_DECLARATIONS: ToolDecl[] = [
  ...WRITE_TOOLS,
  ...IMAGE_WRITE_TOOLS,
  ...DOCX_WRITE_TOOLS,
  ...EXCEL_WRITE_TOOLS,
  ...PDF_PPTX_WRITE_TOOLS,
  ...VOICE_WRITE_TOOLS,
  ...VIDEO_WRITE_TOOLS,
  ...DATA_UTIL_WRITE_TOOLS
]

export const ALL_DECLARATIONS: ToolDecl[] = [...ALL_READ_DECLARATIONS, ...ALL_WRITE_DECLARATIONS]

export const WRITE_NAMES: Set<string> = new Set(ALL_WRITE_DECLARATIONS.map((d) => d.name))

export const FUNCTION_CATALOG: [string, string][] = [
  ['all', 'All Functions Unlocked - Coding + Image UHD + DOCX + Excel + PDF/PPTX + Voice + Video'],
  ['build', 'Build Mode - Code reading, editing, writing, shell execution & full multimodal tools'],
  ['plan', 'Plan Mode - Read-only architecture investigation & step-by-step planning'],
  ['read', 'Read Mode - Strict read-only inspection across code, docs, images, audio & video'],
  ['image_reader', 'Image Reader & OCR - Vision analysis, UI inspection, EXIF & text extraction'],
  [
    'image_generator_uhd',
    'Image Generator Ultra HD - 4K (3840x2160) AI image generation & upscaling'
  ],
  ['docx_management', 'DOCX Management - Word .docx reader, structural analyzer, writer & editor'],
  [
    'excel_management',
    'Excel Management - Spreadsheet .xlsx/.csv reader, stats analyzer & formula writer'
  ],
  ['pdf_management', 'PDF Management - PDF reader, page/metadata analyzer & PDF report generator'],
  ['pptx_management', 'PPTX Management - PowerPoint slide reader, analyzer & presentation builder'],
  [
    'voice_analyzer',
    'Voice Analyzer & Transcriber - Audio metrics, waveform stats & speech-to-text'
  ],
  [
    'voice_generator',
    'Voice Generator (TTS) - Neural & offline text-to-speech audio file synthesis'
  ],
  [
    'video_reader',
    'Video Reader & Analyzer - Video metadata, frame extraction & Gemini scene analysis'
  ],
  ['data_sql', 'Data Science & SQL - SQLite query runner, CSV statistical profiler & QR generator'],
  [
    'search_grounding',
    'Search Grounding - Live web search with real-time Google Search grounding (1.5K queries)'
  ],
  [
    'map_grounding',
    'Map Grounding - Google Maps places, local business, directions & geographic grounding'
  ],
  [
    'pip_installer',
    'Environment & .venv Pip Installer - Check or auto-install all required pip packages'
  ]
]

export const FUNCTION_TOOL_MAP: Record<string, ToolDecl[]> = {
  all: ALL_DECLARATIONS,
  build: ALL_DECLARATIONS,
  plan: ALL_READ_DECLARATIONS,
  read: ALL_READ_DECLARATIONS,
  image_reader: [...READ_TOOLS, ...IMAGE_READ_TOOLS],
  image_generator_uhd: [...READ_TOOLS, ...IMAGE_READ_TOOLS, ...IMAGE_WRITE_TOOLS],
  docx_management: [...READ_TOOLS, ...DOCX_READ_TOOLS, ...DOCX_WRITE_TOOLS],
  excel_management: [...READ_TOOLS, ...EXCEL_READ_TOOLS, ...EXCEL_WRITE_TOOLS],
  pdf_management: [...READ_TOOLS, ...PDF_PPTX_READ_TOOLS, ...PDF_PPTX_WRITE_TOOLS],
  pptx_management: [...READ_TOOLS, ...PDF_PPTX_READ_TOOLS, ...PDF_PPTX_WRITE_TOOLS],
  voice_analyzer: [...READ_TOOLS, ...VOICE_READ_TOOLS],
  voice_generator: [...READ_TOOLS, ...VOICE_READ_TOOLS, ...VOICE_WRITE_TOOLS],
  video_reader: [...READ_TOOLS, ...VIDEO_READ_TOOLS, ...VIDEO_WRITE_TOOLS],
  data_sql: [...READ_TOOLS, ...DATA_UTIL_READ_TOOLS, ...DATA_UTIL_WRITE_TOOLS],
  search_grounding: [...READ_TOOLS, ...GROUNDING_TOOLS],
  map_grounding: [...READ_TOOLS, ...GROUNDING_TOOLS]
}

export const TOOL_ICONS: Record<string, string> = {
  list_files: '-',
  read_file: '-',
  glob_files: '-',
  grep_files: '-',
  todo_write: '-',
  edit_file: '-',
  write_file: '-',
  delete_file: '-',
  run_command: '$',
  web_fetch: '-',
  image_read: '-',
  image_ocr: '-',
  image_generate_uhd: '-',
  image_transform: '-',
  docx_read: '-',
  docx_analyze: '-',
  docx_write: '-',
  docx_edit: '-',
  excel_read: '-',
  excel_analyze: '-',
  excel_write: '-',
  pdf_read: '-',
  pdf_analyze: '-',
  pdf_write: '-',
  pptx_read: '-',
  pptx_write: '-',
  voice_analyze: '-',
  voice_transcribe: '-',
  voice_generate: '-',
  video_read: '-',
  video_analyze: '-',
  video_extract_frames: '-',
  sqlite_query: '-',
  csv_analyze: '-',
  archive_manage: '-',
  qr_generate: '-',
  system_diagnostics: '-',
  search_grounding: '🔍',
  map_grounding: '🗺️'
}
