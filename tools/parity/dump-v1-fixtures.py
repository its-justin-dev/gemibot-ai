"""Capture v1.0 reference outputs as JSON fixtures for the v2.0 parity tests.

Read-only with respect to current.v1.0: this file imports the v1.0 modules and
writes fixtures into Gemibot AI Bro/tests/fixtures only.

Run with the v1.0 interpreter:
  current.v1.0/.venv/Scripts/python.exe "Gemibot AI Bro/tools/parity/dump-v1-fixtures.py"
"""

import json
import sys
from datetime import datetime
from pathlib import Path

V1_ROOT = Path(__file__).resolve().parents[3] / "current.v1.0"
SRC = V1_ROOT / "src"
sys.path.insert(0, str(SRC))

from configs.constants import AppConstants  # noqa: E402
from configs import tool_schemas  # noqa: E402
from services.effort_mapper import EffortMapper  # noqa: E402
from models.effort_level import EffortLevel  # noqa: E402
from utils import helpers, text_formatters, timeline_parser  # noqa: E402
from utils.colors import Colors  # noqa: E402
import difflib  # noqa: E402
import fnmatch  # noqa: E402
import textwrap  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def dump(name, payload):
    path = OUT_DIR / name
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", path)


# ---------------------------------------------------------------- constants
constants = {
    "MODEL_CATALOG": [[k, v] for k, v in AppConstants.MODEL_CATALOG.items()],
    "ANTIGRAVITY_MODELS": AppConstants.ANTIGRAVITY_MODELS,
    "MODEL_ALIASES": [[k, v] for k, v in AppConstants.MODEL_ALIASES.items()],
    "FALLBACK_MODELS": AppConstants.FALLBACK_MODELS,
    "GROUNDING_MODELS": sorted(AppConstants.GROUNDING_MODELS),
    "MODELS": AppConstants.MODELS,
    "IMAGE_MODELS": AppConstants.IMAGE_MODELS,
    "MAX_STEPS": AppConstants.MAX_STEPS,
    "MAX_OUTPUT": AppConstants.MAX_OUTPUT,
    "SESSION_DIR": AppConstants.SESSION_DIR,
    "MEMORY_REL_PATH": AppConstants.MEMORY_REL_PATH,
    "SETTINGS_REL_PATH": AppConstants.SETTINGS_REL_PATH,
    "IGNORED": sorted(AppConstants.IGNORED),
    "SPINNER_FRAMES": list(AppConstants.SPINNER_FRAMES),
    "REQUIRED_PIP_PACKAGES": AppConstants.REQUIRED_PIP_PACKAGES,
    "MEMORY_HEADER": AppConstants.MEMORY_HEADER,
    "SETTINGS_HEADER": AppConstants.SETTINGS_HEADER,
    "MEMORY_FIRST_NOTE": AppConstants.MEMORY_FIRST_NOTE,
    "MEMORY_LAST_NOTE": AppConstants.MEMORY_LAST_NOTE,
    "PERSONA": AppConstants.PERSONA,
    "PLAN_NOTE": AppConstants.PLAN_NOTE,
    "READ_NOTE": AppConstants.READ_NOTE,
    "COLORS": {
        k: getattr(Colors, k)
        for k in dir(Colors)
        if not k.startswith("_") and isinstance(getattr(Colors, k), str)
    },
}

model_logic = []
for mid in list(AppConstants.MODEL_CATALOG) + ["", "made-up-model", "models/gemini-3.5-flash"]:
    model_logic.append(
        {
            "id": mid,
            "resolved": AppConstants.resolve_model_id(mid),
            "antigravity": AppConstants.is_antigravity(mid),
            "gemma": AppConstants.is_gemma(mid),
            "embedding": AppConstants.is_embedding(mid),
            "grounding": AppConstants.is_grounding(mid),
            "category": AppConstants.get_model_category(mid),
            "badge": AppConstants.get_model_badge(mid),
            "supports_thinking": EffortMapper.supports_thinking(mid),
        }
    )

network_errors = [
    "Error sending request: Max retries exceeded with url",
    "[Errno 11001] getaddrinfo failed",
    "NameResolutionError",
    "Connection refused",
    "[WinError 10051] As unconnected",
    "temporarily unavailable: temporary failure in name resolution",
    "429 Too Many Requests",
    "Invalid JSON payload",
    "socket.gaierror",
    "No internet",
    "connection reset by peer",
]

constants["model_logic"] = model_logic
constants["network_errors"] = [[e, AppConstants.is_network_error(e)] for e in network_errors]
dump("v1-constants.json", constants)

# ---------------------------------------------------------------- effort
effort = []
for level in EffortLevel.all_levels():
    cfg = EffortMapper.get_thinking_config("gemini-3.5-flash", level, include_thoughts=False)
    effort.append(
        {
            "level": level.value,
            "display": level.display_name,
            "icon": level.icon,
            "description": level.description,
            "cost_hint": level.cost_hint,
            "budget": None if cfg is None else cfg.thinking_budget,
            "status": EffortMapper.get_status_description("gemini-3.5-flash", level),
            "status_nothink": EffortMapper.get_status_description("gemini-2.5-flash-image", level),
        }
    )
parse_cases = [
    None, "", "low", "LOW", "extra-high", "Extra High", "turbo", "medium",
    "EffortLevel.HIGH", "  high  ", "nonsense", "extra", "Medium",
]
supports_ids = list(AppConstants.MODELS) + [
    "",
    None,
    "gemma-3-27b-it",
    "GEMMA-3-27B",
    "text-embedding-004",
    "gemini-embedding-001",
    "embedding-x",
    "imagen-3.0-generate-002",
    "veo-3.1-generate-preview",
    "lyria-realtime-exp",
    "nano-banana-pro",
    "models/gemini-3.5-flash",
    "GEMINI-3.5-FLASH",
    " gemini-3.5-flash ",
    "antigravity-pro",
    "gemini-2.5-flash-image",
    "gemini-2.0-flash-thinking-exp-0121",
    "gemini-4.0-pro",
    "gemini-pro-vision",
    "gemini",
    "tts-1",
    "clip-model",
    "video-model",
    "transcribe-x",
    "audio-dialog-x",
    "custom-thinking-model",
    "unknown-1.0",
    "Models/gemini-3.5-flash",
    "gemini-3.5-flash/thinking",
]
supports = []
for mid in supports_ids:
    supports.append([mid, EffortMapper.supports_thinking(mid)])

config_cases = []
for mid in [
    "gemini-3.5-flash",
    "gemini-2.5-flash-image",
    "imagen-3.0-generate-002",
    "",
    "gemini-2.0-flash-thinking-exp-0121",
    "antigravity-pro",
]:
    for level in EffortLevel.all_levels():
        for include_thoughts in (False, True):
            for disable_thinking in (False, True):
                cfg = EffortMapper.get_thinking_config(
                    mid,
                    level,
                    include_thoughts=include_thoughts,
                    disable_thinking=disable_thinking,
                )
                config_cases.append(
                    {
                        "model": mid,
                        "level": level.value,
                        "include_thoughts": include_thoughts,
                        "disable_thinking": disable_thinking,
                        "budget": None if cfg is None else cfg.thinking_budget,
                        "thoughts": None if cfg is None else cfg.include_thoughts,
                    }
                )

# Same entry points fed raw strings/None instead of EffortLevel members.
loose_cases = []
for mid in ["gemini-3.5-flash", "veo-3.1-generate-preview"]:
    for raw in [None, "", "low", "EXTRA-HIGH", "Turbo", "effortlevel.high", "nonsense", 7]:
        cfg = EffortMapper.get_thinking_config(mid, raw)
        loose_cases.append(
            {
                "model": mid,
                "raw": str(raw),
                "budget": None if cfg is None else cfg.thinking_budget,
                "status": EffortMapper.get_status_description(mid, raw),
            }
        )

dump("v1-effort.json", {
    "levels": effort,
    "from_string": [[c, EffortLevel.from_string(c).value] for c in parse_cases],
    "supports": supports,
    "configs": config_cases,
    "loose": loose_cases,
})

# ---------------------------------------------------------------- tool schemas
def decl_shape(d):
    return {"name": d.name, "description": d.description, "parameters": d.parameters}


def plain(obj):
    from enum import Enum

    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, dict):
        return {k: plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [plain(v) for v in obj]
    if hasattr(obj, "__dict__"):
        return {
            k: plain(v)
            for k, v in vars(obj).items()
            if v is not None and not k.startswith("_") and k != "parent"
        }
    return obj


schemas = {
    "READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.READ_TOOLS],
    "WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.WRITE_TOOLS],
    "IMAGE_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.IMAGE_READ_TOOLS],
    "IMAGE_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.IMAGE_WRITE_TOOLS],
    "DOCX_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.DOCX_READ_TOOLS],
    "DOCX_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.DOCX_WRITE_TOOLS],
    "EXCEL_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.EXCEL_READ_TOOLS],
    "EXCEL_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.EXCEL_WRITE_TOOLS],
    "PDF_PPTX_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.PDF_PPTX_READ_TOOLS],
    "PDF_PPTX_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.PDF_PPTX_WRITE_TOOLS],
    "VOICE_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.VOICE_READ_TOOLS],
    "VOICE_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.VOICE_WRITE_TOOLS],
    "VIDEO_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.VIDEO_READ_TOOLS],
    "VIDEO_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.VIDEO_WRITE_TOOLS],
    "DATA_UTIL_READ_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.DATA_UTIL_READ_TOOLS],
    "DATA_UTIL_WRITE_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.DATA_UTIL_WRITE_TOOLS],
    "GROUNDING_TOOLS": [plain(decl_shape(d)) for d in tool_schemas.GROUNDING_TOOLS],
    "FUNCTION_CATALOG": [[k, v] for k, v in tool_schemas.FUNCTION_CATALOG],
    "WRITE_NAMES": sorted(tool_schemas.WRITE_NAMES),
    "TOOL_ICONS": [[k, v] for k, v in tool_schemas.TOOL_ICONS.items()],
    "GROUPS": {
        "ALL_READ_DECLARATIONS": [d.name for d in tool_schemas.ALL_READ_DECLARATIONS],
        "ALL_WRITE_DECLARATIONS": [d.name for d in tool_schemas.ALL_WRITE_DECLARATIONS],
        "ALL_DECLARATIONS": [d.name for d in tool_schemas.ALL_DECLARATIONS],
    },
    "FUNCTION_TOOL_MAP": {
        k: [d.name for d in v] for k, v in tool_schemas.FUNCTION_TOOL_MAP.items()
    },
}
dump("v1-tool-schemas.json", schemas)

# ---------------------------------------------------------------- helpers
samples = [
    "def add(a, b):\n    return a + b\n",
    "def add(a, b):\n    return a - b\n",
    "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n",
    "line1\nline2\nCHANGED\nline4\nline5\nline6\nline7\nline8\n",
    "alpha\nbeta\ngamma\n",
    "",
    "single line",
    "\n\n\n",
    "x" * 5,
    "a\tb\tc\n",
]

diffs = []
for i, a in enumerate(samples):
    for b in samples[:4]:
        old = a.splitlines()
        new = b.splitlines()
        diffs.append(
            {
                "old": a,
                "new": b,
                "from": "a/rel.py",
                "to": "b/rel.py",
                "unified": list(
                    difflib.unified_diff(old, new, "a/rel.py", "b/rel.py", lineterm="", n=3)
                ),
                "ndiff": list(difflib.ndiff(old, new)),
                "stats": list(timeline_parser.compute_diff_stats(a, b)),
            }
        )

# A big file triggers difflib's autojunk heuristic (>=200 lines).
big_a = "\n".join(["def f():", *(["    pass", "", "    return 1"] * 80), "end"])
big_b = "\n".join(["def f():", *(["    pass", "", "    return 2"] * 80), "end", "extra"])
diffs.append(
    {
        "old": big_a,
        "new": big_b,
        "from": "a/big.py",
        "to": "b/big.py",
        "unified": list(
            difflib.unified_diff(
                big_a.splitlines(), big_b.splitlines(), "a/big.py", "b/big.py", lineterm="", n=3
            )
        ),
        "ndiff": list(difflib.ndiff(big_a.splitlines(), big_b.splitlines())),
        "stats": list(timeline_parser.compute_diff_stats(big_a, big_b)),
    }
)
dump("v1-diff.json", diffs)

wrap_lines = [
    "Hello there -- you goof-ball, use the -b option!",
    "Short",
    "   leading and trailing   ",
    "a" * 130,
    "supercalifragilisticexpialidocious-and-then-some-more-text-here",
    "Tab\there and a  double space",
    "word " * 30,
    "Welsh: hydna-'r-bren holl-dwfnodd",
    "- item with a very long tail that must be wrapped at the configured width boundary exactly",
    "\u2014 em dash \u2014 between words here, and some Taglish: \u2018di ba kuya, grabe \u2019yong bug na \u2018to",
    "e" * 59,
    "",
    "\u00e1\u00e9\u00ed\u00f3\u00fa accented words must wrap the same as ascii words in this sentence here",
]

wrapping = []
for width in (58, 76, 92, 96):
    for line in wrap_lines:
        wrapping.append(
            {
                "line": line,
                "width": width,
                "wrap": textwrap.wrap(line, width - 2, subsequent_indent="") or [""],
                "wrap_default": textwrap.wrap(line, width - 2) or [""],
                "fill_indent": textwrap.fill(line, width, initial_indent="** ", subsequent_indent="   "),
            }
        )
dump("v1-wrap.json", wrapping)

strings = {
    "clip": [[helpers.clip(t, 10), helpers.clip("x" * 5, 10)] for t in ["x" * 40, "short"]]
    + [[helpers.clip("a" * 30001)]],
    "safe_fence": [
        helpers.safe_fence(t)
        for t in ["", None, "plain", "```", "````", "a ``` b ```` c ```", "```x```"]
    ],
    "ensure_bro": [
        [helpers.ensure_bro(u, r), u, r]
        for u, r in [
            ("bro fix this", "Sure thing brother, done."),
            ("bro fix this", "done bro"),
            ("brother", "BROTHER approve"),
            ("kuya", "no greeting here"),
            ("hello", "The Brother file"),
            ("bro", "code: `brother` and ```\nbrother\n``` tails"),
            ("bro", "   "),
            ("hi", "plain reply"),
        ]
    ],
    "strip_markdown": [
        text_formatters.strip_markdown_markers(t)
        for t in [
            "",
            "**bold** and *italic* and ***both***",
            "__under__ and _i_",
            "keep `code **here**` untouched",
            "```\n**not stripped**\n```",
            "***a***b**c**",
            "**unclosed",
        ]
    ],
    "binary": [
        helpers.is_binary(b""),
        helpers.is_binary(b"abc"),
        helpers.is_binary(b"ab\x00c"),
        helpers.is_binary(b"x" * 9000 + b"\x00"),
    ],
}
dump("v1-strings.json", strings)

blocks_src = """# Title

Some paragraph text
that continues on the next line.

- one
- two
  continued
1. first
2. second

```python
def f():
    return 1
```

## Sub heading

   \tindented paragraph
"""
strings["parse_markdown_blocks"] = [
    timeline_parser.parse_markdown_blocks(blocks_src),
    timeline_parser.parse_markdown_blocks(""),
    timeline_parser.parse_markdown_blocks("```\ncode\n"),
    timeline_parser.parse_markdown_blocks("- a\n\n\n- b"),
    timeline_parser.parse_markdown_blocks("plain only"),
]
strings["escape_markup"] = [
    timeline_parser.escape_markup(t) for t in ["", "<a href='x'>&</a>", None, "no markup"]
]
strings["strip_ansi"] = [
    timeline_parser.strip_ansi(t)
    for t in ["\x1b[96mtext\x1b[0m", "\x1b[25lspinner", "no codes", "\x1b[48;5;29m\x1b[97mbg"]
]
dump("v1-markdown.json", strings)

names = ["app.py", "APP.PY", "test_one.py", "readme.md", ".env", "main.tsx", "a.b.c"]
pats = ["*.py", "*.PY", "test_?.py", "*.md", ".env", "*[0-9]*", "nomatch"]
dump(
    "v1-fnmatch.json",
    {"names": names, "patterns": pats, "matrix": [[p, [fnmatch.fnmatch(n, p) for n in names]] for p in pats]},
)

stamp = datetime(2026, 10, 21, 3, 7, 9)
dump(
    "v1-strftime.json",
    {
        "cases": [
            stamp.strftime("%Y-%m-%d %H:%M:%S (%A, %B %d, %Y %I:%M:%S %p)"),
            stamp.strftime("%A, %B %d, %Y %I:%M %p"),
            stamp.strftime("%H:%M:%S"),
            stamp.strftime("%Y%m%d_%H%M%S"),
            stamp.strftime("%Y-%m-%d %H:%M:%S"),
            datetime(2026, 1, 5, 12, 0, 0).strftime("%I:%M:%S %p"),
            datetime(2026, 1, 5, 0, 0, 0).strftime("%I:%M:%S %p"),
            datetime(2026, 12, 31, 23, 59, 59).strftime("%a %b %d %H:%M:%S %Y"),
        ]
    },
)

# ------------------------------------------------- window_app module constants
# Importing views.window_app is side-effect free (main() is guarded).
from views import window_app  # noqa: E402
from views.timeline_constants import (  # noqa: E402
    ACTION_ICONS,
    STATUS_COLORS,
    TOOL_DISPLAY_NAMES,
)

ui = {
    "HELP": window_app.HELP,
    "WIDTH": window_app.WIDTH,
    "SPINNER_FRAMES": list(window_app.SPINNER_FRAMES),
    "TOOL_ICONS_LOCAL": [[k, v] for k, v in window_app.TOOL_ICONS.items()],
    "WRITE_NAMES_LOCAL": sorted(window_app.WRITE_NAMES),
    "READ_NAMES_LOCAL": [d.name for d in window_app.ALL_READ_DECLARATIONS],
    "ALL_NAMES_BOUND": [d.name for d in window_app.ALL_DECLARATIONS],
    "FUNCTION_CATALOG_BOUND": [[k, v] for k, v in window_app.FUNCTION_CATALOG],
    "FUNCTION_TOOL_MAP_BOUND": {
        k: [d.name for d in v] for k, v in window_app.FUNCTION_TOOL_MAP.items()
    },
    "TOOL_DISPLAY_NAMES": [[k, v] for k, v in TOOL_DISPLAY_NAMES.items()],
    "ACTION_ICONS": [[k, v] for k, v in ACTION_ICONS.items()],
    "STATUS_COLORS": [[k, list(v)] for k, v in STATUS_COLORS.items()],
}

# Descriptions/params of the declarations actually sent to the API at runtime.
def shape(d):
    return {"name": d.name, "description": d.description, "parameters": plain(d.parameters)}


ui["ALL_DECLARATIONS_BOUND"] = [shape(d) for d in window_app.ALL_DECLARATIONS]
ui["READ_DECLARATIONS_LOCAL"] = [shape(d) for d in window_app.ALL_READ_DECLARATIONS]
dump("v1-ui.json", ui)

# ---------------------------------------------------------------- storage
import hashlib  # noqa: E402
import io  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import struct  # noqa: E402
import tempfile  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from PIL import Image  # noqa: E402
from docx import Document  # noqa: E402
from models.file_change import ChangeType, FileChange  # noqa: E402
from models.file_diff import FileDiff  # noqa: E402
from services.change_tracker import ChangeTracker  # noqa: E402
from services.diff_service import DiffService  # noqa: E402
from services.file_operations import FileOperations  # noqa: E402
from services.snapshot_store import SnapshotStore  # noqa: E402

TS_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")
TIME_RE = re.compile(r"\d{2}:\d{2}:\d{2}")
# The human-readable half of a memory timestamp moves at midnight, so it is frozen as one token.
DAY_RE = re.compile(
    r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), "
    r"(?:January|February|March|April|May|June|July|August|September|October|November|December) "
    r"\d{1,2}, \d{4} \d{2}:\d{2}:\d{2} (?:AM|PM)\b"
)


def scrub(text, base=None):
    """Blank out the wall-clock and the temp root so both sides can be compared byte for byte."""
    clean = TIME_RE.sub("<TIME>", DAY_RE.sub("<DAYDATE>", TS_RE.sub("<TS>", text)))
    if base is not None:
        raw = str(base)
        variants = [raw, raw.replace("\\", "/"), raw.replace("\\", "\\\\") ]
        for variant in variants:
            clean = clean.replace(variant, "<WS>")
    return clean


def new_agent(base):
    """An Agent with just the attributes the storage methods read, no GUI and no API client."""
    agent = SimpleNamespace()
    agent.app_root = Path(base)
    agent.root = Path(base)
    agent.model = "gemini-3.5-flash"
    agent.active_function = "all"
    agent.mode = "build"
    agent.turn_tool_logs = []
    agent.turn_file_changes = []
    for name in (
        "settings_path",
        "ensure_settings_file",
        "read_settings_dict",
        "save_settings",
        "memory_path",
        "ensure_memory_file",
        "clear_memory",
        "read_memory_content",
        "log_interaction_to_memory",
    ):
        setattr(agent, name, getattr(window_app.Agent, name).__get__(agent))
    return agent


# Image.MIME is filled by plugin import; init() loads every plugin like a live v1.0 process would.
Image.init()
storage = {"pil_mime": dict(Image.MIME)}

# Path semantics used across the storage layer.
path_cases = [
    "app.py",
    "./a/b.py",
    "a\\b\\c.py",
    "/abs/x/",
    "./",
    "..",
    "  spaced/file.txt ",
    ".env",
    "archive.tar.gz",
    "a.b.c",
    "no_suffixed",
    "trailingdot.",
    "UPPER.PY",
    "dir/",
    "C:\\x\\y.txt",
    ".//",
    "a/.",
    "a/./",
    "/",
    "C:\\",
    "a//b.py",
    "",
    "a/..",
    "././b",
    "a/b/../c.txt",
    "\\\\srv\\share\\f.txt",
    "a b /c d.txt ",
]
storage["paths"] = [
    [
        p,
        ChangeTracker._normalize(None, p),
        DiffService._normalize(None, p),
        Path(p).name,
        Path(p).suffix,
        Path(p).stem,
    ]
    for p in path_cases
]

# FileChange round-trips, including the defaults from_dict falls back to.
changes_in = [
    {"path": "a.py", "full_path": "C:\\w\\a.py", "change_type": "Added"},
    {
        "path": "b.md",
        "full_path": "/w/b.md",
        "change_type": "Document edited",
        "snapshot_id": "deadbeefdeadbeef",
        "original_exists": True,
        "timestamp": "2026-10-21 03:07:09",
        "detail": "Document edited: b.md",
        "is_binary": True,
        "what": ["wrote"],
        "why": ["because"],
    },
    {"path": "c", "full_path": "c", "change_type": "Bogus"},
    {"path": "d", "full_path": "d", "change_type": None},
]
storage["file_change"] = [
    {
        "in": raw,
        "out": FileChange.from_dict(raw).to_dict(),
        "ct": str(FileChange.from_dict(raw).change_type.value),
    }
    for raw in changes_in
]

# Hunk parsing over the same unified diffs the v1.0 terminal would have printed.
parsed = []
for rec in diffs:
    hunks = DiffService._parse_unified_diff(None, rec["unified"])
    fd = FileDiff(path="rel.py", change_type="Modified", hunks=hunks)
    parsed.append(
        {
            "unified": rec["unified"],
            "hunks": [h.to_dict() for h in hunks],
            "line_summary": fd.line_summary,
            "total_added": fd.total_added,
            "total_removed": fd.total_removed,
        }
    )
storage["parse_unified_diff"] = parsed[:12]

# Snapshot ids are a sha256 of (rel path bytes + original file bytes) truncated to 16 hex chars.
store_dir = Path(tempfile.mkdtemp(prefix="gemibot-parity-store-"))
try:
    store = SnapshotStore(store_dir)
    snap_cases = []
    for rel, content in [
        ("a.py", b"print('hi')\n"),
        ("a.py", b"print('bye')\n"),
        ("\u00e9moji/\u00fc.py", "x = '\u00fc\u00f1\u00ee\u00e7\u00f6de'\n".encode()),
        ("bin.dat", b"\x00\x01\x02\xff"),
    ]:
        target = store_dir / "src" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        snap_id, exists, is_bin = store.save_snapshot(rel, target)
        snap_cases.append(
            {
                "rel": rel,
                "content_hex": content.hex(),
                "id": snap_id,
                "exists": exists,
                "is_binary": is_bin,
                "expected": hashlib.sha256(rel.encode("utf-8") + content).hexdigest()[:16],
            }
        )
    missing_id, missing_exists, missing_bin = store.save_snapshot("gone.py", store_dir / "gone.py")
    storage["snapshots"] = {
        "cases": snap_cases,
        "missing": [missing_id, missing_exists, missing_bin],
        "listing": sorted(p.name for p in (store_dir / ".gemibot" / "pending" / "snapshots").iterdir()),
    }
    _empty = Path(tempfile.mkdtemp(prefix="gemibot-parity-empty-"))
    storage["snapshots"]["load_default"] = SnapshotStore(_empty).load_manifest()
    shutil.rmtree(_empty, ignore_errors=True)
    store.save_manifest({"changes": {"x.py": {"path": "x.py"}}, "reads": {"x.py": "03:07:09"}})
    storage["snapshots"]["manifest_roundtrip"] = scrub(
        (store_dir / ".gemibot" / "pending" / "manifest.json").read_text(encoding="utf-8")
    )
    storage["snapshots"]["manifest_paths"] = [
        str(store.manifest_file.relative_to(store_dir)).replace("\\", "/"),
        str(store.manifest_file.with_suffix(".tmp").relative_to(store_dir)).replace("\\", "/"),
    ]
finally:
    shutil.rmtree(store_dir, ignore_errors=True)

# A whole scripted turn: writes, edits, a delete and a net-out, through the real gateway.
ws = Path(tempfile.mkdtemp(prefix="gemibot-parity-ws-"))
try:
    tracker = ChangeTracker(ws)
    files = FileOperations(ws, tracker)
    tracker.on_changes_updated = None

    files.write_text("src/app.py", "def f():\n    return 1\n")
    files.edit_text("src/app.py", "return 1", "return 2")
    files.write_text("README.md", "# Hi\n", detail="Created the readme")
    files.delete_file("README.md")
    files.write_bytes("img/logo.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
    files.write_text("docs/note.txt", "\u00fc\u00f1\u00ee\r\n", crlf=True)
    files.read_text("docs/note.txt")
    files.create_folder("empty-dir")

    storage["tracker"] = {
        "manifest": scrub(
            (ws / ".gemibot" / "pending" / "manifest.json").read_text(encoding="utf-8"),
            base=ws,
        ),
        "snapshots": sorted(p.name for p in (ws / ".gemibot" / "pending" / "snapshots").iterdir()),
        "summary_changes": [c["path"] for c in tracker.get_summary()["changes"]],
        "summary_counts": tracker.get_summary()["counts"],
        "summary_reads": [
            {**row, "time": TIME_RE.sub("<TIME>", row["time"])}
            for row in tracker.get_summary()["files_read"]
        ],
        "tree": sorted(
            str(p.relative_to(ws)).replace("\\", "/")
            for p in ws.rglob("*")
            if p.is_file() and ".gemibot" not in p.parts
        ),
    }
finally:
    shutil.rmtree(ws, ignore_errors=True)

# Image metadata as PIL reports it, plus the bytes for the v2.0 reader to check.
img_dir = OUT_DIR / "images"
img_dir.mkdir(exist_ok=True)
image_cases = []
for fmt, ext, dims in [
    ("PNG", "png", (7, 5)),
    ("JPEG", "jpg", (7, 5)),
    ("GIF", "gif", (7, 5)),
    ("BMP", "bmp", (7, 5)),
    ("WEBP", "webp", (7, 5)),
    ("TIFF", "tiff", (7, 5)),
    ("ICO", "ico", (16, 16)),
    ("PPM", "ppm", (7, 5)),
]:
    name = f"sample-{dims[0]}x{dims[1]}.{ext}"
    handle = Image.new("RGB", dims, (200, 30, 60))
    case = {"name": name}
    try:
        handle.save(img_dir / name, fmt)
    except Exception as exc:  # a format this Pillow build cannot write
        case["error"] = str(exc)
        image_cases.append(case)
        continue
    raw = (img_dir / name).read_bytes()
    case["size"] = len(raw)
    try:
        case["pil_format"] = Image.open(img_dir / name).format
    except Exception as exc:
        case["open_error"] = str(exc)
    case["metadata"] = DiffService._extract_binary_metadata(None, raw).to_dict()
    image_cases.append(case)

# Header variants: the same PIL plugins reached through other modes, chunk flavours and quirks.
for label, build in [
    ("variant-lossless.webp", lambda p: Image.new("RGBA", (9, 6), (200, 30, 60, 255)).save(p, "WEBP", lossless=True)),
    (
        "variant-animated.webp",
        lambda p: Image.new("RGBA", (9, 6), (200, 30, 60, 255)).save(
            p,
            "WEBP",
            save_all=True,
            append_images=[Image.new("RGBA", (9, 6), (10, 200, 90, 128))],
            duration=100,
            loop=0,
        ),
    ),
    ("variant-gray.pgm", lambda p: Image.new("L", (7, 5), 128).save(p, "PPM")),
    ("variant-bit.pbm", lambda p: Image.new("1", (7, 5), 1).save(p, "PPM")),
    ("variant-rgba.png", lambda p: Image.new("RGBA", (3, 2), (200, 30, 60, 128)).save(p, "PNG")),
    ("variant-palette.png", lambda p: Image.new("P", (4, 3), 1).save(p, "PNG")),
    ("variant-progressive.jpg", lambda p: Image.new("RGB", (7, 5), (200, 30, 60)).save(p, "JPEG", progressive=True)),
    ("variant-cmyk.jpg", lambda p: Image.new("CMYK", (7, 5), (0, 100, 100, 10)).save(p, "JPEG")),
    ("variant-32.bmp", lambda p: Image.new("RGBA", (7, 5), (200, 30, 60, 128)).save(p, "BMP")),
    ("variant-p8.bmp", lambda p: Image.new("P", (7, 5), 1).save(p, "BMP")),
    ("variant.dib", lambda p: Image.new("RGB", (7, 5), (200, 30, 60)).save(p, "DIB")),
    ("variant-rgba.tif", lambda p: Image.new("RGBA", (4, 3), (200, 30, 60, 128)).save(p, "TIFF")),
    ("variant-jpeg.tif", lambda p: Image.new("RGB", (7, 5), (200, 30, 60)).save(p, "TIFF", compression="jpeg")),
    ("variant-multi.ico", lambda p: Image.new("RGBA", (32, 32), (200, 30, 60, 255)).save(p, "ICO", sizes=[(16, 16), (32, 32)])),
    ("variant-alpha.gif", lambda p: Image.new("P", (7, 5), 1).save(p, "GIF", transparency=0)),
]:
    case = {"name": label}
    try:
        build(img_dir / label)
    except Exception as exc:  # a flavour this Pillow build cannot write
        case["error"] = str(exc)
        image_cases.append(case)
        continue
    raw = (img_dir / label).read_bytes()
    case["size"] = len(raw)
    try:
        case["pil_format"] = Image.open(img_dir / label).format
    except Exception as exc:
        case["open_error"] = str(exc)
    case["metadata"] = DiffService._extract_binary_metadata(None, raw).to_dict()
    image_cases.append(case)

# Hand-built headers Pillow still sniffs: a top-down BMP, a CUR wrapping a DIB, commented PBM tokens.
dib_stream = io.BytesIO()
Image.new("RGB", (8, 16), (200, 30, 60)).save(dib_stream, "DIB")
cur = struct.pack("<HHH", 0, 2, 1) + struct.pack(
    "<BBBBHHII", 8, 16, 0, 0, 0, 32, len(dib_stream.getvalue()), 22
)
(img_dir / "variant.cur").write_bytes(cur + dib_stream.getvalue())
image_cases.append(
    {
        "name": "variant.cur",
        "size": (img_dir / "variant.cur").stat().st_size,
        "metadata": DiffService._extract_binary_metadata(None, (img_dir / "variant.cur").read_bytes()).to_dict(),
    }
)

top_down = bytearray((img_dir / "sample-7x5.bmp").read_bytes())
top_down[22:26] = struct.pack("<i", -5)
(img_dir / "variant-topdown.bmp").write_bytes(bytes(top_down))
image_cases.append(
    {
        "name": "variant-topdown.bmp",
        "size": len(top_down),
        "metadata": DiffService._extract_binary_metadata(None, bytes(top_down)).to_dict(),
    }
)

for label, payload in [
    ("variant-comment.pbm", b"P1\n# a comment\n3 2\n010010\n"),
    ("variant-maxval.pgm", b"P5\n#c\n2 3 255 " + bytes(6)),
    ("variant-longtoken.ppm", b"P6 " + b"1" * 300 + b" 2 2 255 " + bytes(12)),
    ("variant-nomaxval.ppm", b"P6 2 2\n" + bytes(12)),
    ("variant-badbits.bmp", b"BM" + bytes(12) + struct.pack("<IHH", 40, 7, 5) + struct.pack("<HH", 7, 12) + bytes(20)),
]:
    (img_dir / label).write_bytes(payload)
    image_cases.append(
        {
            "name": label,
            "size": len(payload),
            "metadata": DiffService._extract_binary_metadata(None, payload).to_dict(),
        }
    )

not_image = img_dir / "notes.md.txt"
not_image.write_bytes(b"# not an image\nplain text\n")
image_cases.append(
    {
        "name": not_image.name,
        "metadata": DiffService._extract_binary_metadata(None, not_image.read_bytes()).to_dict(),
        "size": not_image.stat().st_size,
    }
)
truncated = img_dir / "truncated.png"
truncated.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x07\x00\x00\x00\x05\x08\x02")
image_cases.append(
    {
        "name": truncated.name,
        "metadata": DiffService._extract_binary_metadata(None, truncated.read_bytes()).to_dict(),
        "size": truncated.stat().st_size,
    }
)
storage["images"] = image_cases

# DiffService end to end, including the docx text path v2.0 must reproduce from raw OOXML.
# Every step is recorded as an op script so the v2.0 test replays the identical workspace.
dw = Path(tempfile.mkdtemp(prefix="gemibot-parity-diff-"))
doc_dir = OUT_DIR / "documents"
doc_dir.mkdir(exist_ok=True)
diff_cases = []
script = []
try:
    store = SnapshotStore(dw)
    svc = DiffService(dw, store)

    def png_bytes(color):
        buf = io.BytesIO()
        Image.new("RGB", (7, 5), color).save(buf, "PNG")
        return buf.getvalue()

    (img_dir / "diff-a.png").write_bytes(png_bytes((200, 30, 60)))
    (img_dir / "diff-b.png").write_bytes(png_bytes((10, 200, 90)))

    def put(rel, hex_text=None, source=None, fill=None, size=None):
        target = dw / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if source is not None:
            target.write_bytes((OUT_DIR / source).read_bytes())
        elif fill is not None:
            target.write_bytes(bytes([fill]) * size)
        else:
            target.write_bytes(bytes.fromhex(hex_text))
        return target

    def w(rel, **kwargs):
        script.append({"op": "write", "rel": rel, **kwargs})
        put(rel, **kwargs)

    def snap(rel):
        sid, ex, bi = store.save_snapshot(rel, dw / rel)
        script.append({"op": "snapshot", "rel": rel, "id": sid, "exists": ex, "binary": bi})
        return sid, ex, bi

    def drop(rel):
        script.append({"op": "remove", "rel": rel})
        (dw / rel).unlink()

    def case(name, rel, change_type, snap_id, orig_exists, is_bin):
        script.append(
            {
                "op": "diff",
                "name": name,
                "rel": rel,
                "change_type": change_type.value,
                "snapshot_id": snap_id,
                "original_exists": orig_exists,
                "is_binary": is_bin,
            }
        )
        fd = svc.compute_diff(rel, change_type, snap_id, orig_exists, is_bin, str(dw / rel))
        payload = scrub(json.dumps(fd.to_dict(), ensure_ascii=False), base=dw)
        diff_cases.append({"name": name, "diff": json.loads(payload)})

    ORIGINAL = "def f():\n    return 1\n\n\na = 1\nb = 2\nc = 3\nd = 4\ne = 5\nprint('hi')\nprint(2)\n"
    EDITED = "def f():\n    return 2\n\na = 1\nb = 2\nc = 3\nd = 4\ne = 5\nprint('bye')\nprint(3)\n"
    w("src/app.py", hex_text=ORIGINAL.encode().hex())
    sid, ex, bi = snap("src/app.py")
    w("src/app.py", hex_text=EDITED.encode().hex())
    case("modified", "src/app.py", ChangeType.MODIFIED, sid, ex, bi)

    w("gone.py", hex_text=b"one\ntwo\n".hex())
    sid, ex, bi = snap("gone.py")
    drop("gone.py")
    case("deleted", "gone.py", ChangeType.DELETED, sid, ex, bi)

    w("gone.png", source="images/diff-a.png")
    sid, ex, bi = snap("gone.png")
    drop("gone.png")
    case("deleted_binary", "gone.png", ChangeType.DELETED, sid, ex, True)

    case("deleted_no_snapshot", "never.py", ChangeType.DELETED, None, False, False)

    sid, ex, bi = snap("new.py")
    w("new.py", hex_text=b"print('new')\n".hex())
    case("added", "new.py", ChangeType.ADDED, sid, ex, bi)

    sid, ex, bi = snap("empty.py")
    w("empty.py", hex_text="")
    case("added_empty", "empty.py", ChangeType.ADDED, sid, ex, bi)

    w("logo.png", source="images/diff-b.png")
    case("generated_binary", "logo.png", ChangeType.GENERATED, None, False, True)

    w("swap.png", source="images/diff-a.png")
    sid, ex, bi = snap("swap.png")
    w("swap.png", source="images/diff-b.png")
    case("modified_binary", "swap.png", ChangeType.MODIFIED, sid, True, True)

    w("crlf.txt", hex_text=b"line one\r\nline two\r\n".hex())
    sid, ex, bi = snap("crlf.txt")
    w("crlf.txt", hex_text=b"line one\r\nline trois\r\n".hex())
    case("modified_crlf", "crlf.txt", ChangeType.MODIFIED, sid, True, False)

    case("snapshot_missing", "src/app.py", ChangeType.MODIFIED, "0" * 16, True, False)

    w("émoji/ü.py", hex_text="x = 'üñîçöde'\n".encode().hex())
    case("added_unicode", "émoji/ü.py", ChangeType.ADDED, None, False, False)

    w("big.txt", fill=97, size=10 * 1024 * 1024 + 1)
    case("too_large", "big.txt", ChangeType.MODIFIED, None, False, False)
    drop("big.txt")

    doc = Document()
    doc.add_paragraph("Quarterly Report")
    styled = doc.add_paragraph()
    styled.add_run("Bold ").bold = True
    styled.add_run("then plain")
    broken = doc.add_paragraph()
    broken.add_run("first half").add_break()
    broken.add_run("after the break")
    tabbed = doc.add_paragraph()
    tabbed.add_run("left").add_tab()
    tabbed.add_run("right")
    doc.add_paragraph("")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "not a body paragraph"
    table.cell(0, 1).text = "neither is this"
    doc.add_paragraph("trailing line")
    doc.save(doc_dir / "report-original.docx")

    edited = Document(str(doc_dir / "report-original.docx"))
    edited.paragraphs[0].text = "Quarterly Report (final)"
    edited.paragraphs[-1].text = "trailing line changed\nsecond line"
    edited.save(doc_dir / "report-current.docx")

    w("report.docx", source="documents/report-original.docx")
    sid, ex, bi = snap("report.docx")
    w("report.docx", source="documents/report-current.docx")
    case("docx_edited", "report.docx", ChangeType.DOCX_EDITED, sid, True, True)

    case("docx_missing_original", "report.docx", ChangeType.DOCX_EDITED, "0" * 16, True, True)

    storage["compute_diff"] = {"script": script, "cases": diff_cases}
finally:
    shutil.rmtree(dw, ignore_errors=True)

# settings.md: default block, both accepted key syntaxes, the rewrite ordering.
sd = Path(tempfile.mkdtemp(prefix="gemibot-parity-settings-"))
try:
    agent = new_agent(sd)
    storage["settings"] = {}
    storage["settings"]["default_file"] = scrub(
        agent.ensure_settings_file().read_text(encoding="utf-8")
    )
    storage["settings"]["default_dict"] = agent.read_settings_dict()

    agent.save_settings({"theme": "not_so_dark", "zz_extra": "42"})
    storage["settings"]["after_save"] = scrub(
        agent.settings_path().read_text(encoding="utf-8")
    )
    storage["settings"]["after_save_dict"] = agent.read_settings_dict()
    odd = sd / "odd.md"
    odd.write_text(
        "# Header\n\n"
        "- **model:** `gemini-3.5-flash`\n"
        "- **effort_level:** `HIGH`\n"
        "theme: pure_dark\n"
        "> quoted: ignored\n"
        "- plain dash: value\n"
        "   \n"
        "- **target_directory:** `C:\\Users\\me\\proj`\n"
        "no colon here\n",
        encoding="utf-8",
    )
    agent.read_settings_dict = getattr(window_app.Agent, "read_settings_dict").__get__(
        SimpleNamespace(ensure_settings_file=lambda: odd)
    )
    storage["settings"]["odd_dict"] = agent.read_settings_dict()
    storage["settings"]["odd_source"] = odd.read_text(encoding="utf-8")
finally:
    shutil.rmtree(sd, ignore_errors=True)

# memory.md: the default header and one full interaction entry.
md = Path(tempfile.mkdtemp(prefix="gemibot-parity-memory-"))
try:
    agent = new_agent(md)
    mpath = agent.ensure_memory_file()
    storage["memory"] = {"header": mpath.read_text(encoding="utf-8")}
    turn1_logs = [
        {
            "tool": "write_file",
            "args": {"path": "src/app.py", "content": "def f():\n    return 1\n", "why": "start"},
            "raw_output": "Wrote src/app.py",
            "is_error": False,
        },
        {
            "tool": "run_command",
            "args": {"command": "pytest -q"},
            "raw_output": "\u00fc\u00f1\u00ee code ``` block\n1 passed\n",
            "is_error": True,
        },
    ]
    turn1_changes = [
        {
            "action": "created",
            "path": "src/app.py",
            "diff": "--- a/src/app.py\n+++ b/src/app.py\n@@ -0,0 +1,2 @@\n+def f():\n+    return 1\n",
            "new_content": "def f():\n    return 1\n",
            "old_content": None,
        },
        {
            "action": "deleted",
            "path": "old\u00e9.txt",
            "diff": "",
            "new_content": None,
            "old_content": "gone\n",
        },
        {
            "action": "modified",
            "path": "notes.md",
            "diff": "",
            "new_content": "```\nfence inside\n```\n",
            "old_content": "before\n",
        },
    ]
    agent.turn_tool_logs = turn1_logs
    agent.turn_file_changes = turn1_changes
    agent.log_interaction_to_memory(
        "bro fix ```this``` please", ["Sure thing bro.\n\n```python\nx = 1\n```", "   ", "tail"]
    )
    storage["memory"]["entry"] = scrub(mpath.read_text(encoding="utf-8"))

    agent2 = new_agent(md)
    agent2.log_interaction_to_memory("empty turn", ["   "])
    storage["memory"]["empty_entry"] = scrub(mpath.read_text(encoding="utf-8"))
    agent2.clear_memory()
    storage["memory"]["cleared"] = mpath.read_text(encoding="utf-8")
    mpath.write_bytes(mpath.read_text(encoding="utf-8").replace("\n", "\r\n").encode("utf-8"))
    agent2.log_interaction_to_memory("crlf prompt", ["crlf reply"])
    storage["memory"]["crlf_entry"] = scrub(mpath.read_bytes().decode("utf-8"))
    storage["memory"]["inputs"] = {
        "state": {
            "model": agent.model,
            "active_function": agent.active_function,
            "mode": agent.mode,
        },
        "tool_logs": turn1_logs,
        "file_changes": turn1_changes,
        "turns": [
            {
                "prompt": "bro fix ```this``` please",
                "responses": ["Sure thing bro.\n\n```python\nx = 1\n```", "   ", "tail"],
            },
            {"prompt": "empty turn", "responses": ["   "]},
            {"prompt": "crlf prompt", "responses": ["crlf reply"]},
        ],
    }
finally:
    shutil.rmtree(md, ignore_errors=True)

dump("v1-storage.json", storage)

# ---------------------------------------------------------------- json bytes
# session.json is written with plain `json.dumps(data)` while every entry of its
# "contents" list is a pydantic `model_dump_json(exclude_none=True)` string. Both
# encoders have byte rules v2.0 has to reproduce, so capture them explicitly.
import math  # noqa: E402
from google.genai import types as gt  # noqa: E402

json_fx = {
    "floats": [],
    "ints": [],
    "format": [],
    "strings": [],
    "values": [],
    "indent": [],
    "model": [],
    "base64": [],
}

FLOAT_CASES = [
    "1.0",
    "0.125",
    "1e40",
    "-0.0",
    "0.0",
    "-1.0",
    "1e15",
    "1e16",
    "1e17",
    "1e21",
    "1e22",
    "100.0",
    "0.1",
    "0.0001",
    "0.00001",
    "1e-7",
    "3.141592653589793",
    "0.3333333333333333",
    "1.7976931348623157e308",
    "5e-324",
    "9007199254740993.0",
    "123456789012345678901234567890.0",
    "float('nan')",
    "float('inf')",
    "-float('inf')",
]
for py_lit in FLOAT_CASES:
    value = eval(py_lit)
    if math.isnan(value):
        js_lit = "NaN"
    elif math.isinf(value):
        js_lit = "Infinity" if value > 0 else "-Infinity"
    else:
        js_lit = repr(value)
    json_fx["floats"].append({"py": py_lit, "js": js_lit, "out": json.dumps(value)})

# f-string numeric formats: `{x:.Nf}` rounds the exact binary value with ties-to-even and
# `{n:,}` groups integers.  Both appear in printed engine lines (spinner elapsed, memory
# character counts), so the rounding rules have to match, not just the common cases.
FORMAT_FLOATS = [
    "0.0", "-0.0", "0.5", "1.5", "2.5", "3.5", "0.125", "0.375", "0.25", "0.75",
    "1.005", "2.675", "0.145", "0.05", "0.04999999999999999", "1e16", "1e21",
    "3.141592653589793", "0.1", "0.3", "2.4999999999999996", "123456.7891",
    "1.7976931348623157e308", "5e-324", "2.5e-9", "0.9999999999999999",
    "49.99999999999999", "0.025", "0.075", "float('nan')", "float('inf')", "-float('inf')",
]
for py_lit in FORMAT_FLOATS:
    value = eval(py_lit)
    json_fx["format"].append(
        {
            "kind": "float",
            "py": py_lit,
            "js": "NaN"
            if math.isnan(value)
            else ("Infinity" if value == float("inf") else "-Infinity" if value == float("-inf") else repr(value)),
            "f0": f"{value:.0f}",
            "f1": f"{value:.1f}",
            "f2": f"{value:.2f}",
            "f4": f"{value:.4f}",
            "comma": f"{value:,}",
        }
    )

FORMAT_INTS = ["0", "7", "999", "1000", "1234567", "-1234", "-1", "2**53", "10**20"]
for py_lit in FORMAT_INTS:
    value = eval(py_lit)
    json_fx["format"].append(
        {
            "kind": "int",
            "py": py_lit,
            "js": str(value),
            "bigint": abs(value) > 2**53,
            "comma": f"{value:,}",
            "w3d": f"{value:3d}",
            "d2": f"{value:02d}",
        }
    )

INT_CASES = [
    ("0", "0"),
    ("-0", "0"),
    ("1", "1"),
    ("-1", "-1"),
    ("2**31", "2147483648"),
    ("2**53", "9007199254740992"),
    ("2**63", "9223372036854775808"),
    ("-(2**63)", "-9223372036854775808"),
    ("123456789012345678901234567890", "123456789012345678901234567890"),
]
for py_lit, js_lit in INT_CASES:
    value = eval(py_lit)
    json_fx["ints"].append(
        {"py": py_lit, "js": js_lit, "bigint": abs(value) > 2**53, "out": json.dumps(value)}
    )

STRING_CASES = [
    "hello\nworld",
    "tab\there\r\ncr",
    'quotes " and \' single',
    "back\\slash",
    "\x00\x01\x1f\x7f control",
    "\b\f vertical",
    "üñî çöde",
    "😀 astral emoji",
    "   line separators",
    "soft­hyphen / solidus",
    "",
    "  nbsp",
    "日本語のテキスト",
    "\uFFFF max bmp",
]
for raw in STRING_CASES:
    json_fx["strings"].append(
        {"value": raw, "ascii": json.dumps(raw), "utf8": json.dumps(raw, ensure_ascii=False)}
    )

VALUE_CASES = [
    {"a": 1, "b": [1, 2], "c": {"d": None}},
    {},
    [],
    [None, True, False, 1, 1.0, "x"],
    {"nested": {"list": [{"k": "v"}, [1, 2]], "empty": {}, "empty_list": []}},
    {"ü": "😀", "key with space": "value\nnewline"},
    [1.0, 2, 3.5],
    {"mode": "build", "contents": ["raw json string"], "todos": [{"content": "ü", "status": "pending"}]},
    {"t": True, "i": 0},
]
for index, value in enumerate(VALUE_CASES):
    json_fx["values"].append(
        {"label": f"value-{index}", "value": value, "out": json.dumps(value)}
    )

# `log_interaction_to_memory()` writes tool arguments with
# `json.dumps(args, ensure_ascii=False, indent=2)`, so the indented form has to match too.
INDENT_ARGS = [
    ("indent2", 2),
    ("indent0", 0),
    ("indent4", 4),
    ("indent_none", None),
]
for path_case in VALUE_CASES:
    for label, indent in INDENT_ARGS:
        json_fx["indent"].append(
            {
                "label": label,
                "value": path_case,
                "out": json.dumps(path_case, ensure_ascii=False, indent=indent),
            }
        )
for scalar in [1, 1.0, "x", None, True, [1, [2]], {"a": {"b": []}}]:
    json_fx["indent"].append(
        {"label": "scalar", "value": scalar, "out": json.dumps(scalar, ensure_ascii=False, indent=2)}
    )
json_fx["indent"].append(
    {
        "label": "floats",
        "value": {"limit": 3.0, "n": 2, "fps": 24.5, "big": 1e40, "neg0": -0.0},
        "out": json.dumps(
            {"limit": 3.0, "n": 2, "fps": 24.5, "big": 1e40, "neg0": -0.0},
            ensure_ascii=False,
            indent=2,
        ),
    }
)
json_fx["indent"].append(
    {
        "label": "unicode",
        "value": {"prompt": "üñî 😀\nline", "path": "a\\b"},
        "out": json.dumps({"prompt": "üñî 😀\nline", "path": "a\\b"}, ensure_ascii=False, indent=2),
    }
)
json_fx["indent"].append(
    {
        "label": "ascii",
        "value": {"prompt": "üñî 😀", "n": 1.0},
        "out": json.dumps({"prompt": "üñî 😀", "n": 1.0}, indent=2),
    }
)

MODEL_CASES = [
    '{"parts":[{"text":"hello\\nworld"}],"role":"user"}',
    '{"parts":[{"text":"quotes \\" back\\\\slash üñî 😀"}],"role":"user"}',
    '{"parts":[{"text":"thinking ","thought":true},{"text":"answer"}],"role":"model"}',
    '{"parts":[{"function_call":{"id":"abc","args":{"path":"a.txt","n":3},"name":"read_file"}}],"role":"model"}',
    '{"parts":[{"function_call":{"args":{},"name":"list_files"}}],"role":"model"}',
    '{"parts":[{"function_response":{"id":"abc","name":"read_file","response":{"error":"boom","n":1.5,"flag":true,"nil":null}}}],"role":"user"}',
    '{"parts":[{"inline_data":{"data":"AAH_","display_name":"x.png","mime_type":"image/png"}}],"role":"user"}',
    '{"parts":[],"role":"model"}',
    '{"parts":[{"text":"no role"}]}',
    "{}",
    '{"parts":[]}',
    '{"role":"user"}',
    '{"parts":[{"text":"a"}],"role":"python"}',
    '{"parts":[{"text":"a"}],"role":null}',
    '{"parts":[{"function_call":{"name":"f","args":{"n":1.0,"big":1e40,"deep":{"x":[1,2.5,null]}}}}],"role":"model"}',
    '{"parts":[{"function_call":{"name":"f","args":null}}],"role":"model"}',
    '{"parts":[{"function_response":{"name":"f","response":{"a":null,"b":[1,2]}}}],"role":"user"}',
    '{"parts":[{"file_data":{"file_uri":"gs://x","mime_type":"text/plain"}}],"role":"user"}',
    '{"parts":[{"text":"a","thought":null}],"role":"model"}',
    '{"parts":[{"text":"a","thought":"yes"}],"role":"model"}',
    '{"parts":[{"text":"a","thought_signature":"sig"}],"role":"model"}',
    '{"parts":[{"functionCall":{"name":"camel"},"text":"x"}]}',
    '{"parts":[{"media_resolution":{"resolution":"MEDIA_RESOLUTION_HIGH"}}]}',
    '{"parts":[{"text":"a"},{"function_call":{"id":null,"args":{},"name":"b","partial_args":null,"will_continue":true}}]}',
    '{"parts":[{"function_response":{"will_continue":false,"scheduling":null,"parts":null,"id":"i","name":"n","response":{}}}]}',
    '{"parts":[{"inline_data":{"data":"-_8="}}]}',
    '{"parts":[{"text":"a","unknown":9}],"role":"user"}',
    '{"parts":[],"role":"user","extra_field":1}',
    '{"parts":[{"text":5}],"role":"user"}',
    '{"parts":[{"text":"a"}],"role":5}',
    '{"parts":[{"function_response":{"name":"f","response":"plain string"}}],"role":"user"}',
    '{"parts":[{"inline_data":{"data":"a!b@"}}],"role":"user"}',
    '{"parts":[{"inline_data":{"data":"AAH"}}],"role":"user"}',
    '{"parts":[{"text":"a"},"plain string"]}',
    '{"parts":"not a list"}',
    '[{"parts":[]}]',
    '{"parts":[{"executable_code":{"code":"print(1)","language":"PYTHON"}}]}',
    '{"parts":[{"code_execution_result":{"output":"1\\n"}}]}',
    '{"parts":[{"function_call":{"name":"snake"},"functionCall":{"name":"camel"}}]}',
    '{"parts":[{"video_metadata":{"fps":24}}]}',
    '{"parts":[{"video_metadata":{"fps":"24.5"}}]}',
    '{"parts":[{"video_metadata":{"fps":24.7}}]}',
    '{"parts":[{"media_resolution":{"num_tokens":3.0}}]}',
    '{"parts":[{"media_resolution":{"num_tokens":3.5}}]}',
    '{"parts":[{"media_resolution":{"level":"MEDIA_RESOLUTION_HIGH","num_tokens":1024}}]}',
    '{"parts":[{"thought":1}]}',
    '{"parts":[{"thought":"no"}]}',
    '{"parts":[{"thought":"maybe"}]}',
    '{"parts":[{"code_execution_result":{"outcome":"NOPE"}}]}',
    '{"parts":[{"part_metadata":{"a":1.0,"b":[1,2],"deep":{"c":"\\u00fc"}}}]}',
    '{"parts":[{"text":null}]}',
    '{"parts":[null]}',
    '{"parts":[{"audio_transcription":{"text":"t","words":[{"word":"w","start_offset":"0s"}]}}]}',
    '{"parts":[{"speech_metadata":{"speaker":"s","style":"calm"}}]}',
    '{"parts":[{"tool_call":{"id":"t","tool_type":"URL_CONTEXT","args":{"q":"x"}}}]}',
    '{"parts":[{"tool_response":{"id":"t","response":{"a":1}}}]}',
    '{"parts":[{"function_response":{"scheduling":"SILENT","parts":[{"inline_data":{"data":"AA==","mime_type":"image/png"}},{"file_data":{"file_uri":"gs://x"}}],"name":"f","response":{}}}]}',
    '{"parts":[{"function_call":{"partial_args":[{"json_path":"$.a","string_value":"v","will_continue":false}]}}]}',
    '{"parts":[{"media_processing":"STATIC"}]}',
    '{"parts":[{"text":"a","thought_signature":"+/8="}]}',
    '{"role":true}',
    '{"parts":[{"text":"tab\\there"}],"role":"user"}',
]
for raw in MODEL_CASES:
    case = {"in": raw}
    try:
        obj = gt.Content.model_validate_json(raw)
    except Exception as exc:
        case["error"] = type(exc).__name__
        case["error_head"] = str(exc).splitlines()[1].strip() if len(str(exc).splitlines()) > 1 else ""
        json_fx["model"].append(case)
        continue
    dumped = obj.model_dump_json(exclude_none=True)
    case["out"] = dumped
    case["stable"] = gt.Content.model_validate_json(dumped).model_dump_json(exclude_none=True) == dumped
    case["full"] = obj.model_dump_json()
    json_fx["model"].append(case)

B64_CASES = [
    "AAH_",
    "AA==",
    "",
    "sig",
    "AAH",
    "a!b@",
    "-_8=",
    "AAAA====",
    "A",
    "AB",
    "ABC",
    "ABCD",
    "+/8=",
    "AAH=",
    "AAB=",
    "_-8=",
    "A=",
    "AA=",
    "AAA=",
    "ab+/",
    "  ",
    "AA IH",
    "AAAA",
    "AAA",
    "AAAAA",
    "~~",
    "-_8",
    "+/8",
    "0-_8=",
]
for text in B64_CASES:
    case = {"in": text}
    try:
        blob = gt.Blob.model_validate_json(json.dumps({"data": text}))
        case["out"] = blob.model_dump_json(exclude_none=True)
        case["bytes"] = list(blob.data)
    except Exception as exc:
        case["error"] = type(exc).__name__
    json_fx["base64"].append(case)

# Field tables for the pydantic models v1.0 persists inside session.json. `model_dump_json`
# walks the declaration order, so v2.0 needs the same table and the same bytes-typed fields.
def field_table(model):
    rows = []
    for name, field in model.model_fields.items():
        rows.append(
            {
                "name": name,
                "alias": field.alias,
                "annotation": str(field.annotation),
                "default": None if field.default is None else str(field.default),
            }
        )
    return {"model": model.__name__, "fields": rows}


MODEL_TABLES = [
    gt.Content,
    gt.Part,
    gt.Blob,
    gt.FileData,
    gt.FunctionCall,
    gt.FunctionResponse,
    gt.PartMediaResolution,
    gt.CodeExecutionResult,
    gt.ExecutableCode,
    gt.VideoMetadata,
    gt.ToolCall,
    gt.ToolResponse,
    gt.Transcription,
    gt.SpeechMetadata,
    gt.PartialArg,
    gt.FunctionResponsePart,
    gt.FunctionResponseBlob,
    gt.FunctionResponseFileData,
    gt.WordInfo,
]
json_fx["schema"] = {}
for model in MODEL_TABLES:
    json_fx["schema"][model.__name__] = field_table(model)

dump("v1-json.json", json_fx)

# ---------------------------------------------------------------- model catalog
import threading  # noqa: E402
from services.model_catalog import ModelCatalog  # noqa: E402
from controllers.model_controller import ModelController  # noqa: E402
from storage.settings_storage import SettingsStorage  # noqa: E402
from storage.settings_store import SettingsStore  # noqa: E402


class FakeRemoteModel:
    def __init__(self, name, display_name=None):
        self.name = name
        if display_name is not None:
            self.display_name = display_name


class FakeModels:
    def __init__(self, items, error=None):
        self._items = items
        self._error = error

    def list(self):
        if self._error is not None:
            raise self._error
        return list(self._items)


class FakeClient:
    def __init__(self, items, error=None):
        self.models = FakeModels(items, error)


def join_refresher():
    for _ in range(400):
        worker = next(
            (t for t in threading.enumerate() if t.name == "ModelCatalogRefresher"), None
        )
        if worker is None:
            return
        worker.join(0.05)


def catalog_snapshot(cat):
    return {
        "items": [list(i) for i in cat.get_models()],
        "details": cat.get_all_details(),
    }


catalog_fx = {}
try:
    ModelCatalog._instance = None
    cat = ModelCatalog.get_instance()
    catalog_fx["singleton_same"] = ModelCatalog.get_instance() is cat
    catalog_fx["constants"] = catalog_snapshot(cat)
    catalog_fx["info_known"] = cat.get_model_info("gemini-3.5-flash")
    catalog_fx["info_unknown"] = cat.get_model_info("some-brand-new-model")
    catalog_fx["info_empty"] = cat.get_model_info("")

    remote = [
        FakeRemoteModel("models/gemini-3.5-flash", "Gemini 3.5 Flash (remote)"),
        FakeRemoteModel("gemini-3.5-flash-lite"),
        FakeRemoteModel("brand-new-model", "Brand New"),
        FakeRemoteModel("unknown-no-display"),
        FakeRemoteModel("empty-display", ""),
        FakeRemoteModel(None),
        FakeRemoteModel("", "Blank"),
        FakeRemoteModel("imagen-3.0-generate-002", "Imagen remote"),
    ]
    events = []
    cat.set_update_listener(lambda: events.append("updated"))
    cat.refresh_async(FakeClient(remote))
    join_refresher()
    catalog_fx["after_refresh"] = catalog_snapshot(cat)
    catalog_fx["refresh_events"] = events

    # A raising listener is swallowed by the worker's try/except.
    ModelCatalog._instance = None
    cat2 = ModelCatalog.get_instance(client=FakeClient(remote))
    boom = []

    def raise_listener():
        boom.append(1)
        raise RuntimeError("ui is gone")

    cat2.set_update_listener(raise_listener)
    cat2.refresh_async()
    join_refresher()
    catalog_fx["listener_error_kept_merge"] = [list(i) for i in cat2.get_models()]
    catalog_fx["listener_error_count"] = boom

    # Empty remote list leaves the built-in catalog untouched.
    ModelCatalog._instance = None
    cat3 = ModelCatalog.get_instance(client=FakeClient([]))
    called = []
    cat3.set_update_listener(lambda: called.append(1))
    cat3.refresh_async()
    join_refresher()
    catalog_fx["empty_remote"] = [list(i) for i in cat3.get_models()]
    catalog_fx["empty_remote_called"] = called

    # Network/API failure keeps the fast built-in list and reports nothing.
    ModelCatalog._instance = None
    cat4 = ModelCatalog.get_instance(client=FakeClient([], error=RuntimeError("401 UNAUTHENTICATED")))
    failed = []
    cat4.set_update_listener(lambda: failed.append(1))
    cat4.refresh_async()
    join_refresher()
    catalog_fx["error_remote"] = [list(i) for i in cat4.get_models()]
    catalog_fx["error_remote_called"] = failed

    # No client at all: refresh_async returns before starting a thread.
    ModelCatalog._instance = None
    cat5 = ModelCatalog.get_instance()
    cat5.refresh_async()
    join_refresher()
    catalog_fx["no_client"] = [list(i) for i in cat5.get_models()]

    # get_instance(client=...) only backfills a missing client, never replaces one.
    ModelCatalog._instance = None
    base_client = FakeClient(remote)
    cat6 = ModelCatalog.get_instance(client=base_client)
    other_client = FakeClient([])
    cat7 = ModelCatalog.get_instance(client=other_client)
    catalog_fx["client_backfill"] = [cat6 is cat7, cat7.client is base_client]
    ModelCatalog._instance = None
    cat8 = ModelCatalog.get_instance()
    cat9 = ModelCatalog.get_instance(client=other_client)
    catalog_fx["client_attach"] = cat9.client is other_client
finally:
    ModelCatalog._instance = None

# ---------------------------------------------------------------- model controller
cd = Path(tempfile.mkdtemp(prefix="gemibot-parity-controller-")).resolve()
try:
    ModelCatalog._instance = None
    ctrl = ModelController(cd)
    controller_fx = {
        "initial_model": ctrl.current_model,
        "initial_effort": ctrl.current_effort.value,
        "initial_badge": ctrl.get_status_badge(),
        "initial_config": (lambda c: None if c is None else [c.thinking_budget, c.include_thoughts])(
            ctrl.get_thinking_config()
        ),
        "settings_before": None,
        "badges": [],
        "configs": [],
        "supports": [
            [None, ctrl.supports_thinking()],
            ["veo-3.1-generate-preview", ctrl.supports_thinking("veo-3.1-generate-preview")],
            ["", ctrl.supports_thinking("")],
        ],
        "notifications": [],
    }
    for level in EffortLevel.all_levels():
        ctrl.select_effort_level(level)
        controller_fx["badges"].append([level.value, ctrl.get_status_badge()])
        cfg = ctrl.get_thinking_config()
        controller_fx["configs"].append(
            [level.value, None if cfg is None else cfg.thinking_budget]
        )
    controller_fx["badges_std"] = []
    ctrl.select_model("gemini-2.5-flash-image")
    for level in EffortLevel.all_levels():
        ctrl.select_effort_level(level)
        controller_fx["badges_std"].append([level.value, ctrl.get_status_badge()])

    seen = []
    ctrl.add_listener(lambda m, e: seen.append([m, e.value]))
    ctrl.add_listener(lambda m, e: seen.append([m, e.value]))
    dup = ctrl._listeners[0] if ctrl._listeners else None
    before = len(ctrl._listeners)
    if dup is not None:
        ctrl.add_listener(dup)
    controller_fx["dedupe"] = [before, len(ctrl._listeners)]
    ctrl.select_model("  gemini-3.5-pro  ")
    ctrl.select_model("")
    ctrl.select_model(None)
    ctrl.select_effort_level("extra-high")
    ctrl.select_effort_level(None)
    ctrl.select_effort_level(7)
    controller_fx["notifications"] = seen
    controller_fx["after"] = {
        "model": ctrl.current_model,
        "effort": ctrl.current_effort.value,
        "badge": ctrl.get_status_badge(),
        "store_model": ctrl.store.get_model(),
        "store_effort": ctrl.store.get_effort_level().value,
        "store_all": ctrl.store.get_all(),
    }
    sp = cd / AppConstants.SETTINGS_REL_PATH
    controller_fx["settings_after"] = (
        None if not sp.exists() else scrub(sp.read_text(encoding="utf-8"), cd)
    )
finally:
    shutil.rmtree(cd, ignore_errors=True)
    ModelCatalog._instance = None

# ---------------------------------------------------------------- settings files
std = Path(tempfile.mkdtemp(prefix="gemibot-parity-settingsstorage-")).resolve()
try:
    storage_fx = {}
    sstore = SettingsStorage(std)
    storage_fx["missing_path"] = str(sstore.settings_path().relative_to(std)).replace("\\", "/")
    storage_fx["missing_dict"] = sstore.read_settings_dict()
    storage_fx["missing_still_absent"] = sstore.settings_path().exists()

    path = sstore.ensure_settings_file("gemini-3.5-flash", "all", "build")
    storage_fx["default_file"] = scrub(path.read_text(encoding="utf-8"), std)
    storage_fx["default_dict"] = sstore.read_settings_dict()
    storage_fx["ensure_again_unchanged"] = scrub(path.read_text(encoding="utf-8"), std)

    sstore.save_settings({"theme": "not_so_dark", "zz_extra": "42"})
    storage_fx["after_save"] = scrub(path.read_text(encoding="utf-8"), std)
    sstore.save_settings({"model": "gemini-2.5-pro", "effort_level": "turbo"})
    storage_fx["after_reorder"] = scrub(path.read_text(encoding="utf-8"), std)
    storage_fx["after_reorder_dict"] = sstore.read_settings_dict()

    # Re-reading a file whose keys were saved in a different order keeps the file order.
    path.write_text(
        AppConstants.SETTINGS_HEADER
        + "- **zz_extra:** `42`\n"
        + "- **model:** `gemini-3.5-flash`\n"
        + "custom: value\n",
        encoding="utf-8",
    )
    sstore.save_settings({"mode": "plan"})
    storage_fx["sparse_saved"] = scrub(path.read_text(encoding="utf-8"), std)

    # The wrapper-directory rule: an app dir nested next to a sibling memory/ folder.
    wrap = std / "chatbot"
    wrap.mkdir(exist_ok=True)
    (std / "memory").mkdir(exist_ok=True)
    wrapped = SettingsStorage(wrap)
    storage_fx["wrapped_path"] = str(wrapped.settings_path().relative_to(std)).replace("\\", "/")
    nested = SettingsStorage(std / "gemibot-cli" / "src")
    storage_fx["nested_path"] = str(nested.settings_path().relative_to(std)).replace("\\", "/")

    # Wrapper name without the sibling memory/ directory falls back to the app dir.
    lonely = SettingsStorage(std / "no-memory-here" / "gemibot")
    storage_fx["lonely_path"] = str(lonely.settings_path().relative_to(std)).replace("\\", "/")

    store = SettingsStore(std)
    storage_fx["store_model"] = store.get_model()
    storage_fx["store_effort"] = store.get_effort_level().value
    store.set_model("")
    storage_fx["set_model_empty"] = scrub(
        store.storage.settings_path().read_text(encoding="utf-8"), std
    )
    store.set_model("  gemini-3.5-flash-lite  ")
    store.set_effort_level("low")
    store.set_effort_level(EffortLevel.EXTRA_HIGH)
    store.set_effort_level("nonsense")
    store.update({"target_directory": "", "ui_scale": "13px"})
    storage_fx["store_after"] = scrub(
        store.storage.settings_path().read_text(encoding="utf-8"), std
    )
    storage_fx["store_effort_after"] = store.get_effort_level().value
    storage_fx["store_all_after"] = store.get_all()

    empty_dir = Path(tempfile.mkdtemp(prefix="gemibot-parity-store-empty-")).resolve()
    try:
        fresh = SettingsStore(empty_dir)
        storage_fx["fresh_model"] = fresh.get_model()
        storage_fx["fresh_effort"] = fresh.get_effort_level().value
        storage_fx["fresh_all"] = fresh.get_all()
        storage_fx["fresh_created"] = fresh.storage.settings_path().exists()
        fresh.set_model("gemini-3.5-flash")
        storage_fx["fresh_saved"] = scrub(
            fresh.storage.settings_path().read_text(encoding="utf-8"), empty_dir
        )
    finally:
        shutil.rmtree(empty_dir, ignore_errors=True)
finally:
    shutil.rmtree(std, ignore_errors=True)

catalog_fx["controller"] = controller_fx
catalog_fx["settings"] = storage_fx
dump("v1-catalog.json", catalog_fx)

# ---------------------------------------------------------------- session
import contextlib  # noqa: E402

from storage.session_storage import SessionStorage  # noqa: E402


def session_agent(base):
    """An Agent carrying only the state the session/undo methods touch.

    `build_system` is replaced by a counter: its real body needs the AI client and
    the directory tree (Stage 2d). Everything else runs as production v1.0 code, and
    the fixture records how many times the engine asked for a rebuilt system prompt.
    """
    agent = SimpleNamespace()
    agent.app_root = Path(base)
    agent.root = Path(base)
    agent.model = "gemini-3.5-flash"
    agent.mode = "build"
    agent.active_function = "all"
    agent.contents = []
    agent.checkpoints = []
    agent.undo_stack = []
    agent.todos = []
    agent.timeline_history = []
    agent.turn_tool_logs = []
    agent.turn_file_changes = []
    agent.always = set()
    agent.system = None
    agent.builds = 0

    def build_system():
        agent.builds += 1
        return "<SYSTEM-REBUILT>"

    agent.build_system = build_system
    for name in (
        "settings_path",
        "ensure_settings_file",
        "read_settings_dict",
        "save_settings",
        "memory_path",
        "ensure_memory_file",
        "clear_memory",
        "read_memory_content",
        "is_within_target",
        "resolve",
        "rel",
        "session_file",
        "save",
        "load",
        "_rebuild_checkpoints_from_contents",
        "_pop_and_restore_file",
        "undo",
        "revert",
        "rollback_to_checkpoint",
    ):
        setattr(agent, name, getattr(window_app.Agent, name).__get__(agent))
    return agent


def run_captured(fn, base=None):
    """Return (printed bytes, returned value) with the temp root blanked out."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        value = fn()
    return scrub(buffer.getvalue(), base or base_dir), value


def dump_state(agent):
    return {
        "mode": agent.mode,
        "active_function": agent.active_function,
        "contents": [c.model_dump_json(exclude_none=True) for c in agent.contents],
        "checkpoints": agent.checkpoints,
        "undo": [[agent.rel(full), old, crlf] for full, old, crlf in agent.undo_stack],
        "todos": agent.todos,
        "timeline_history": agent.timeline_history,
        "builds": agent.builds,
    }


session_fx = {}
base_dir = Path(tempfile.mkdtemp(prefix="gemibot-parity-session-")).resolve()
try:
    agent = session_agent(base_dir)
    agent.ensure_memory_file()
    agent.ensure_settings_file()

    contents = [
        gt.Content(role="user", parts=[gt.Part(text="hello")]),
        gt.Content(
            role="model",
            parts=[
                gt.Part(text="reading it"),
                gt.Part(
                    function_call=gt.FunctionCall(
                        id="call_1",
                        name="read_file",
                        args={"path": "src/app.py", "offset": 0, "limit": 3.0},
                    )
                ),
            ],
        ),
        gt.Content(
            role="user",
            parts=[
                gt.Part(
                    function_response=gt.FunctionResponse(
                        id="call_1",
                        name="read_file",
                        response={"output": "def f():\n    return 1\n"},
                    )
                ),
                gt.Part(thought=True, text="ok — ünïcode"),
            ],
        ),
        gt.Content(
            role="model",
            parts=[
                gt.Part(
                    inline_data=gt.Blob(
                        data=b"\x89PNG\r\n\x1a\n\x00\x01\xff",
                        mime_type="image/png",
                        display_name="shot",
                    )
                )
            ],
        ),
        gt.Content(role="model", parts=[gt.Part(text="done")]),
    ]
    checkpoints = [
        {
            "prompt": "hello",
            "time": "10:11:12",
            "contents_len": 0,
            "undo_len": 0,
            "todos": [{"content": "x", "status": "pending"}],
            "memory_len": 1234,
        },
        {
            "prompt": "make it so",
            "time": "10:12:00",
            "contents_len": 1,
            "undo_len": 1,
            "todos": [],
            "memory_len": 2,
        },
    ]
    (base_dir / "src").mkdir(parents=True, exist_ok=True)
    (base_dir / "src" / "app.py").write_bytes(b"def f():\r\n    return 2\r\n")
    (base_dir / "new.txt").write_bytes(b"brand new")
    undo = [
        (base_dir / "src" / "app.py", "def f():\r\n    return 1\r\n", True),
        (base_dir / "new.txt", None, False),
    ]
    todos = [{"content": "ship", "status": "in_progress"}]
    timeline = [
        {
            "prompt": "hello",
            "timestamp": "10:11:12",
            "replies": ["hi"],
            "events": [{"kind": "tool", "label": "read_file"}],
            "file_changes": [],
        }
    ]

    # ---- storage/session_storage.py on its own
    ss = SessionStorage(base_dir, base_dir)
    ss.save("plan", "code", contents, checkpoints, undo, todos, timeline, agent.rel)
    session_fx["storage"] = {}
    session_fx["storage"]["bytes"] = scrub(
        (base_dir / AppConstants.SESSION_DIR / "session.json").read_text(encoding="utf-8"),
        base_dir,
    )
    loaded = ss.load(agent.resolve)
    session_fx["storage"]["loaded"] = {
        "contents": [c.model_dump_json(exclude_none=True) for c in loaded[0]],
        "mode": loaded[1],
        "active_function": loaded[2],
        "todos": loaded[3],
        "undo": [[agent.rel(full), old, crlf] for full, old, crlf in loaded[4]],
        "checkpoints": loaded[5],
        "timeline_history": loaded[6],
    }

    def load_missing():
        missing = Path(tempfile.mkdtemp(prefix="gemibot-parity-nosession-"))
        try:
            printed, result = run_captured(
                lambda: SessionStorage(missing, missing).load(lambda p: p), missing
            )
            return [printed, result]
        finally:
            shutil.rmtree(missing, ignore_errors=True)

    printed, result = load_missing()
    session_fx["storage"]["missing_print"] = printed
    session_fx["storage"]["missing_return"] = result

    # ---- the Agent-level session methods
    agent.mode = "plan"
    agent.active_function = "code"
    agent.contents = contents
    agent.checkpoints = checkpoints
    agent.undo_stack = undo
    agent.todos = todos
    agent.timeline_history = timeline
    agent.save()
    session_fx["agent"] = {}
    session_fx["agent"]["save_bytes"] = scrub(
        (base_dir / AppConstants.SESSION_DIR / "session.json").read_text(encoding="utf-8"),
        base_dir,
    )
    # v1.0 duplicates save() in Agent and in SessionStorage; both must agree.
    session_fx["agent"]["save_matches_storage"] = (
        session_fx["agent"]["save_bytes"] == session_fx["storage"]["bytes"]
    )
    session_fx["agent"]["rel_cases"] = [
        [
            str(p.relative_to(base_dir)).replace("\\", "/"),
            scrub(agent.rel(p), base_dir),
        ]
        for p in [base_dir / "src" / "app.py", base_dir / "memory" / "memory.md", base_dir]
    ]
    outside = base_dir.parent / "gemibot-parity-outside.txt"
    session_fx["agent"]["rel_outside_absolute"] = agent.rel(outside) == str(Path(outside).resolve())
    # Scrubbed against the parent so the random temp suffix inside `<WS>` disappears.
    session_fx["agent"]["rel_outside"] = [
        scrub(agent.rel(outside), base_dir.parent),
        scrub(str(Path(outside).resolve()), base_dir.parent),
    ]
    # `relative_to()` is case-sensitive even though `is_within_target()` is not, so a
    # differently-cased child raises ValueError and falls back to the argument verbatim.
    oddly = str(base_dir.parent / base_dir.name.upper() / "src" / "app.py")
    rel_cm = agent.rel(oddly)
    session_fx["agent"]["rel_case_mismatch"] = {
        "returns_argument": rel_cm == oddly,
        "is_absolute": Path(rel_cm).is_absolute(),
        "posix_relative": rel_cm.replace("\\", "/") == "src/app.py",
    }
    # The same mismatch for a path that does not exist, so `resolve()` cannot
    # canonicalise its case against the filesystem.
    ghost = str(base_dir.parent / base_dir.name.upper() / "nope-dir" / "ghost.py")
    rel_ghost = agent.rel(ghost)
    session_fx["agent"]["rel_case_ghost"] = {
        "returns_argument": rel_ghost == ghost,
        "posix_relative": rel_ghost.replace("\\", "/") == "nope-dir/ghost.py",
        "resolved_abs": rel_ghost.replace("\\", "/") == str(Path(ghost).resolve()).replace("\\", "/"),
    }
    session_fx["agent"]["resolve_cases"] = []
    for raw in [
        "src/app.py",
        "./src/../src/app.py",
        "memory/memory.md",
        "memory/settings.md",
        "memory\\memory.md",
        "  src/app.py  ",
        "'src/app.py'",
        "/src/app.py",
        "\\src\\app.py",
        ".",
        "",
        None,
        str(base_dir / "src" / "app.py"),
        '"src/app.py"',
        "~/outside.py",
        "../outside.txt",
        "..\\..\\secrets.env",
        "src/../../escape.py",
        str(base_dir.parent / "gemibot-parity-outside.py"),
        "C:\\Windows\\win.ini",
        "*",
        "NUL",
    ]:
        try:
            got = agent.resolve(raw)
            session_fx["agent"]["resolve_cases"].append(
                [
                    scrub(raw, base_dir) if isinstance(raw, str) else raw,
                    scrub(str(got), base_dir),
                    None,
                ]
            )
        except Exception as exc:
            session_fx["agent"]["resolve_cases"].append(
                [
                    scrub(raw, base_dir) if isinstance(raw, str) else raw,
                    None,
                    scrub(f"{type(exc).__name__}: {exc}", base_dir),
                ]
            )

    # A workspace with no session.json prints the "no previous session" line.
    bare = Path(tempfile.mkdtemp(prefix="gemibot-parity-bare-"))
    try:
        fresh = session_agent(bare)
        printed, _ = run_captured(fresh.load, bare)
        session_fx["agent"]["load_missing_print"] = printed
        session_fx["agent"]["load_missing_state"] = dump_state(fresh)
    finally:
        shutil.rmtree(bare, ignore_errors=True)

    (base_dir / AppConstants.SESSION_DIR / "session.json").unlink()
    agent.contents = contents
    agent.checkpoints = []
    printed, _ = run_captured(agent.load)
    session_fx["agent"]["load_print"] = printed
    agent.save()
    agent.contents = []
    agent.checkpoints = []
    agent.undo_stack = []
    printed, _ = run_captured(agent.load)
    session_fx["agent"]["reload_print"] = printed
    session_fx["agent"]["reload_state"] = dump_state(agent)

    # checkpoints rebuilt from the transcript: framed prompts, notes, empty parts.
    framed = [
        gt.Content(
            role="user",
            parts=[
                gt.Part(
                    text=f"prefix noise\nUser Request:\nreal question\n\n{AppConstants.MEMORY_LAST_NOTE}"
                )
            ],
        ),
        gt.Content(role="user", parts=[gt.Part(text="plain prompt\n\nReferenced files:\nsrc/app.py")]),
        gt.Content(role="model", parts=[gt.Part(text="a reply")]),
        gt.Content(role="user", parts=[]),
        gt.Content(role="user", parts=[gt.Part(text="")]),
        gt.Content(
            role="user",
            parts=[gt.Part(function_response=gt.FunctionResponse(name="f", response={}))],
        ),
        gt.Content(role="user", parts=[gt.Part(text="last prompt")]),
    ]
    agent.contents = framed
    agent.undo_stack = [(base_dir / "src" / "app.py", "old", False)]
    session_fx["agent"]["rebuilt"] = agent._rebuild_checkpoints_from_contents()
    session_fx["agent"]["rebuilt_print"] = run_captured(agent.load)[0]

    # undo: restore a modified file, then delete a created one, then the empty stack.
    agent.contents = []
    agent.checkpoints = []
    agent.undo_stack = [
        (base_dir / "src" / "app.py", "def f():\r\n    return 1\r\n", True),
        (base_dir / "made" / "new.txt", None, False),
    ]
    printed, _ = run_captured(agent.undo)
    session_fx["agent"]["undo_1_print"] = printed
    session_fx["agent"]["undo_1_file"] = (base_dir / "src" / "app.py").read_bytes().decode("utf-8")
    printed, _ = run_captured(agent.undo)
    session_fx["agent"]["undo_2_print"] = printed
    session_fx["agent"]["undo_2_exists"] = (base_dir / "made" / "new.txt").exists()
    session_fx["agent"]["undo_2_dir_exists"] = (base_dir / "made").exists()
    printed, _ = run_captured(agent.undo)
    session_fx["agent"]["undo_empty_print"] = printed
    session_fx["agent"]["undo_session_bytes"] = scrub(
        (base_dir / AppConstants.SESSION_DIR / "session.json").read_text(encoding="utf-8"),
        base_dir,
    )

    # _pop_and_restore_file restoring into a directory that no longer exists.
    agent.undo_stack = [(base_dir / "deep" / "nest" / "f.md", "# heading\n", False)]
    printed, _ = run_captured(agent._pop_and_restore_file)
    session_fx["agent"]["restore_new_dir_print"] = printed
    session_fx["agent"]["restore_new_dir_bytes"] = (
        (base_dir / "deep" / "nest" / "f.md").read_bytes().decode("utf-8")
    )

    # revert: the labels v1.0 offers, then the rollback it performs.
    memory_text = agent.read_memory_content()
    agent.contents = [
        gt.Content(role="user", parts=[gt.Part(text="one")]),
        gt.Content(role="model", parts=[gt.Part(text="two")]),
    ]
    agent.checkpoints = [
        {
            "prompt": "first prompt",
            "time": "09:00:00",
            "contents_len": 0,
            "undo_len": 0,
            "todos": [{"content": "a", "status": "pending"}],
            "memory_len": len(memory_text),
        },
        {
            "prompt": "second prompt with a very long line that should be cut at exactly fifty two characters for the preview",
            "time": "09:01:00",
            "contents_len": 1,
            "undo_len": 1,
            "todos": [],
            "memory_len": len(memory_text),
        },
        {
            "prompt": "third",
            "time": "09:02:00",
            "contents_len": 2,
            "undo_len": 2,
            "todos": [],
            "memory_len": None,
        },
    ]
    agent.todos = [{"content": "live", "status": "pending"}]
    agent.undo_stack = [
        (base_dir / "src" / "app.py", "first\n", False),
        (base_dir / "deep" / "nest" / "f.md", "# older\n", False),
        (base_dir / "made" / "gone.txt", "created\n", False),
    ]
    (base_dir / "made").mkdir(parents=True, exist_ok=True)
    (base_dir / "made" / "gone.txt").write_bytes(b"created\n")
    (base_dir / "memory" / "memory.md").write_bytes((memory_text + "APPENDED ENTRY\n").encode("utf-8"))

    choices = {}
    real_choose = window_app.choose

    def fake_choose(title, items, current=None, page=25):
        choices["title"] = title
        choices["items"] = items
        choices["page"] = page
        return items[1][0] if items else None

    window_app.choose = fake_choose
    try:
        printed, _ = run_captured(agent.revert)
    finally:
        window_app.choose = real_choose
    session_fx["agent"]["revert"] = {
        "title": choices.get("title", ""),
        "items": choices.get("items", []),
        "page": choices.get("page"),
        "print": printed,
        "state": dump_state(agent),
        "memory": agent.read_memory_content(),
        "files": {
            "src/app.py": (base_dir / "src" / "app.py").read_bytes().decode("utf-8"),
            "deep/nest/f.md": (base_dir / "deep" / "nest" / "f.md").read_bytes().decode("utf-8"),
            "made/gone.txt_exists": (base_dir / "made" / "gone.txt").exists(),
        },
        "session_bytes": scrub(
            (base_dir / AppConstants.SESSION_DIR / "session.json").read_text(encoding="utf-8"),
            base_dir,
        ),
    }

    # revert declined, and revert with no checkpoints at all.
    window_app.choose = lambda title, items, current=None, page=25: None
    try:
        declined, _ = run_captured(agent.revert)
    finally:
        window_app.choose = real_choose
    session_fx["agent"]["revert_declined_print"] = declined
    empty = session_agent(base_dir)
    empty.ensure_memory_file()
    declined_empty, _ = run_captured(empty.revert)
    session_fx["agent"]["revert_empty_print"] = declined_empty

    # rollback_to_checkpoint: the same rollback without the picker, plus its bounds.
    agent2 = session_agent(base_dir)
    agent2.ensure_memory_file()
    agent2.contents = [
        gt.Content(role="user", parts=[gt.Part(text="one")]),
        gt.Content(role="model", parts=[gt.Part(text="two")]),
    ]
    agent2.checkpoints = agent.checkpoints
    agent2.undo_stack = [(base_dir / "src" / "app.py", "rollback\n", False)]
    agent2.todos = [{"content": "live", "status": "pending"}]
    printed, ok = run_captured(lambda: agent2.rollback_to_checkpoint(0))
    session_fx["agent"]["rollback"] = {
        "returned": ok,
        "print": printed,
        "state": dump_state(agent2),
        "app_py": (base_dir / "src" / "app.py").read_bytes().decode("utf-8"),
    }
    printed, bad = run_captured(lambda: agent2.rollback_to_checkpoint(9))
    session_fx["agent"]["rollback_out_of_range"] = [bad, printed, dump_state(agent2)]
    printed, neg = run_captured(lambda: agent2.rollback_to_checkpoint(-1))
    session_fx["agent"]["rollback_negative"] = [neg, printed]

    # A session.json whose contents entry is not a valid Content: v1.0 prints the
    # "no previous session" line and keeps whatever state it already had.
    (base_dir / AppConstants.SESSION_DIR).mkdir(parents=True, exist_ok=True)
    (base_dir / AppConstants.SESSION_DIR / "session.json").write_text(
        '{"mode": "plan", "active_function": "docs", "contents": ["{\\"role\\": \\"user\\", \\"bogus\\": 1}"], "checkpoints": [], "undo_stack": [], "todos": [], "timeline_history": []}',
        encoding="utf-8",
    )
    broken = session_agent(base_dir)
    printed, _ = run_captured(broken.load)
    session_fx["agent"]["load_broken_print"] = printed
    session_fx["agent"]["load_broken_state"] = dump_state(broken)

    # Half-written JSON takes the same branch.
    (base_dir / AppConstants.SESSION_DIR / "session.json").write_text('{"mode": ', encoding="utf-8")
    printed, _ = run_captured(session_agent(base_dir).load)
    session_fx["agent"]["load_truncated_print"] = printed
finally:
    shutil.rmtree(base_dir, ignore_errors=True)

dump("v1-session.json", session_fx)
