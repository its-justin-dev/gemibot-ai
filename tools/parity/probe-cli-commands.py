"""Freeze the console output of every slash command `Agent.command()` handles.

`views/window_app.py:3367` (`execute_single_command`), `:3483` (`command`), `:3272`/`:3281`
(the status printers), `:3291`-`:3338` (the pickers) and `controllers/changes_controller.py:97`
(the `/changes` table) all print straight to the console, so their bytes are captured here and
replayed by `tests/unit/parity-cli.test.ts`.

The interactive helpers are driven from a script instead of a terminal: `input()` is replaced
with a queue, an empty queue raises `EOFError` the way a closed stdin does, and the prompt each
call received is recorded next to the transcript.  A `{TMP}` token in a case line expands to that
case's own temp folder, which is then scrubbed back out of the captured bytes, so the fixture
stays comparable on another machine.

The catalog's background refresh is stubbed: v1.0 prints the cache it was seeded with from
`AppConstants` long before the worker thread can say anything, and that seeded cache is what
`tests/unit/parity-model.test.ts` already pins.

Read-only with respect to current.v1.0.  Run with the v1.0 interpreter:
  current.v1.0/.venv/Scripts/python.exe "Gemibot AI Bro/tools/parity/probe-cli-commands.py"
"""

import builtins
import collections
import contextlib
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

os.environ["COLUMNS"] = "100"
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

V1_ROOT = Path(__file__).resolve().parents[3] / "current.v1.0"
sys.path.insert(0, str(V1_ROOT / "src"))

from google import genai  # noqa: E402
import views.window_app as wa  # noqa: E402
from configs.constants import AppConstants  # noqa: E402
from models.file_change import ChangeType  # noqa: E402
from services.model_catalog import ModelCatalog  # noqa: E402

ModelCatalog.refresh_async = lambda self, client=None: None

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "v1-cli-commands.json"

PROMPTS = collections.deque()
ANSWERS = collections.deque()


def scripted_input(prompt=""):
    PROMPTS.append(prompt)
    if not ANSWERS:
        raise EOFError()
    return ANSWERS.popleft()


def scrub(text, tmp):
    resolved = str(Path(tmp).resolve())
    variants = {tmp, resolved, Path(tmp).as_posix(), Path(tmp).name, os.getcwd(), str(Path.cwd())}
    for variant in sorted((v for v in variants if v), key=len, reverse=True):
        text = re.sub(re.escape(variant), "<TMP>", text, flags=re.IGNORECASE)
    # The change table stamps each row with the wall clock; the shape of the row is the parity
    # surface, the clock is not.
    text = re.sub(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", "<STAMP>", text)
    return re.sub(r"\d{2}:\d{2}:\d{2}", "<TIME>", text)


def make_agent(tmp):
    return wa.Agent(
        genai.Client(api_key="parity-test-placeholder"),
        Path(tmp).resolve(),
        AppConstants.MODELS[0],
        False,
        False,
    )


def prepare_plain(agent, tmp):
    (Path(tmp) / "sub").mkdir()
    (Path(tmp) / "afile.txt").write_text("plain\n", encoding="utf-8")


def stage_change(agent, tmp):
    """One change of every type plus reads, so `/changes` has a table to print."""
    keep = Path(tmp) / "kept.txt"
    keep.write_text("hello\n", encoding="utf-8")
    agent.change_tracker.record_change("kept.txt", str(keep), ChangeType.ADDED, "fresh file")

    gone = Path(tmp) / "gone.txt"
    gone.write_text("bye\n", encoding="utf-8")
    agent.change_tracker.record_change("gone.txt", str(gone), ChangeType.DELETED, "removed")

    doc = Path(tmp) / "notes.md"
    doc.write_text("# notes\n", encoding="utf-8")
    agent.change_tracker.record_change("notes.md", str(doc), ChangeType.DOCX_EDITED,
                                      "docx touched")

    art = Path(tmp) / "art.png"
    art.write_bytes(b"\x89PNG\r\n\x1a\n")
    agent.change_tracker.record_change("art.png", str(art), ChangeType.GENERATED, "image",
                                       is_binary=True)

    big = Path(tmp) / "wide-filename-that-overflows-the-column-padding-rule.txt"
    big.write_text("x\n", encoding="utf-8")
    agent.change_tracker.record_change(
        big.name, str(big), ChangeType.MODIFIED, "edit"
    )

    for name in ("kept.txt", "gone.txt", "notes.md", "art.png", big.name):
        agent.change_tracker.record_read(name)
    (Path(tmp) / "extra.txt").write_text("y\n", encoding="utf-8")
    agent.change_tracker.record_read("extra.txt")
    (Path(tmp) / "sub").mkdir(exist_ok=True)
    (Path(tmp) / "afile.txt").write_text("plain\n", encoding="utf-8")


def run_case(label, line, answers=(), prepare=None):
    tmp = tempfile.mkdtemp(prefix="gemibot-cli-")
    agent = make_agent(tmp)
    prepare(agent, tmp)
    resolved = str(Path(tmp).resolve())
    answer_list = [str(a).replace("{TMP}", resolved) if isinstance(a, str) else a for a in answers]
    ANSWERS.clear()
    ANSWERS.extend(answer_list)
    PROMPTS.clear()

    buf = io.StringIO()
    error = None
    result = None
    try:
        with contextlib.redirect_stdout(buf):
            result = agent.command(line.replace("{TMP}", resolved))
    except BaseException as exc:  # noqa: BLE001 - the exception is itself an observation
        error = f"{type(exc).__name__}: {exc}"

    return {
        "label": label,
        "line": scrub(line.replace("{TMP}", resolved), tmp),
        "answers": [scrub(str(a), tmp) for a in answer_list],
        "prompts": list(PROMPTS),
        "out": scrub(buf.getvalue(), tmp),
        "result": result,
        "error": error,
        "state": {
            "mode": agent.mode,
            "active_function": agent.active_function,
            "model": agent.model,
            "pinned": agent.pinned,
            "effort_level": getattr(getattr(agent, "effort_level", None), "value", None),
            "root": scrub(str(agent.root), tmp),
            "pending": agent.change_tracker.get_summary()["total_changes"],
        },
    }


CASES = [
    ("help", "/help", (), prepare_plain),
    ("usage", "/usage", (), prepare_plain),
    ("settings", "/settings", (), prepare_plain),
    ("memory", "/memory", (), prepare_plain),
    ("target_default", "/target", (), prepare_plain),
    ("target_clear", "/target clear", (), prepare_plain),
    ("target_missing", "/target C:/definitely/not/here/nope", (), prepare_plain),
    ("target_sub", "/target {TMP}/sub", (), prepare_plain),
    ("target_file", "/target {TMP}/afile.txt", (), prepare_plain),
    ("target_weird", "/target 'clear'", (), prepare_plain),
    ("plan", "/plan", (), prepare_plain),
    ("read", "/read", (), prepare_plain),
    ("build", "/build", (), prepare_plain),
    ("todos", "/todos", (), prepare_plain),
    ("totos", "/totos", (), prepare_plain),
    ("function_cancel", "/function", (), prepare_plain),
    ("function_pick_3", "/function", ["3"], prepare_plain),
    ("function_pick_last", "/function", ["999", "1"], prepare_plain),
    ("function_direct_known", "/function docx_management", (), prepare_plain),
    ("function_direct_bogus", "/function nope", (), prepare_plain),
    ("function_alias_fn", "/fn", ["1"], prepare_plain),
    ("function_pip_entry", "/function", ["17"], prepare_plain),
    ("model_cancel", "/model", (), prepare_plain),
    ("model_pick_2", "/model", ["2"], prepare_plain),
    ("model_by_name", "/model", ["gemini-3.5-flash-lite"], prepare_plain),
    ("model_invalid_number", "/model", ["999", ""], prepare_plain),
    ("model_invalid_name", "/model", ["nope", ""], prepare_plain),
    ("model_direct", "/model gemini-9.9-parity", (), prepare_plain),
    ("models_alias_direct", "/models gemini-9.9-parity2", (), prepare_plain),
    ("effort_cancel", "/effort", (), prepare_plain),
    ("effort_pick_3", "/effort", ["3"], prepare_plain),
    ("effort_direct_high", "/effort high", (), prepare_plain),
    ("effort_direct_bogus", "/effort bogus", (), prepare_plain),
    ("thinking_alias", "/thinking extra_high", (), prepare_plain),
    ("reasoning_alias", "/reasoning low", (), prepare_plain),
    ("pip_eof", "/pip", (), prepare_plain),
    ("pip_no", "/pip", ["n"], prepare_plain),
    ("accept_empty", "/accept", (), prepare_plain),
    ("reject_empty", "/reject", (), prepare_plain),
    ("changes_empty", "/changes", (), prepare_plain),
    ("accept_staged", "/accept", (), stage_change),
    ("accept_all_alias", "/accept_all", (), stage_change),
    ("reject_staged", "/reject", (), stage_change),
    ("reject_all_alias", "/reject_all", (), stage_change),
    ("changes_staged", "/changes", (), stage_change),
    ("pending_alias", "/pending", (), stage_change),
    ("clear_staged", "/clear", (), stage_change),
    ("undo_empty", "/undo", (), prepare_plain),
    ("revert_empty", "/revert", (), prepare_plain),
    ("numeric_help", "/13", (), prepare_plain),
    ("numeric_usage", "/12", (), prepare_plain),
    ("numeric_chain", "/1 + /3 + /6", (), prepare_plain),
    ("chain_plan_build", "/plan+/build", (), prepare_plain),
    ("chain_with_exit", "/plan + /exit", (), prepare_plain),
    ("slash_slash_plan", "//plan", (), prepare_plain),
    ("slash_space_plan", "/ plan", (), prepare_plain),
    ("unknown", "/bogus", (), prepare_plain),
    ("unknown_case", "/BOGUS Thing", (), prepare_plain),
    ("exit", "/exit", (), prepare_plain),
    ("quit", "/quit", (), prepare_plain),
    ("q", "/q", (), prepare_plain),
    ("bare_plus_noop", "/build+", (), prepare_plain),
    ("plus_only", "+", (), prepare_plain),
]


def main():
    real_input = builtins.input
    builtins.input = scripted_input
    records = []
    try:
        for label, line, answers, prepare in CASES:
            records.append(run_case(label, line, answers, prepare))
            print("captured", label)
    finally:
        builtins.input = real_input

    OUT.write_text(
        json.dumps({"width": wa.WIDTH, "cases": records}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print("wrote", OUT)


if __name__ == "__main__":
    main()
