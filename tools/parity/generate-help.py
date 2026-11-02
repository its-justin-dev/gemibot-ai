"""Generate src/shared/constants/help.ts from the captured v1.0 HELP string.

Doing this from the fixture (instead of re-typing the block by hand) guarantees
the alignment whitespace in v1.0's help menu is reproduced exactly.
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "v1-ui.json"
OUT = ROOT / "src" / "shared" / "constants" / "help.ts"

COLOR_NAMES = {
    "\x1b[0m": "RESET",
    "\x1b[1m": "BOLD",
    "\x1b[2m": "DIM",
    "\x1b[3m": "ITALIC",
    "\x1b[96m": "CYAN",
    "\x1b[92m": "GREEN",
    "\x1b[93m": "YELLOW",
    "\x1b[91m": "RED",
    "\x1b[95m": "MAGENTA",
    "\x1b[94m": "BLUE",
    "\x1b[97m": "WHITE",
    "\x1b[90m": "GRAY",
}


def main() -> None:
    help_text = json.loads(FIXTURE.read_text(encoding="utf-8"))["HELP"]
    for esc, name in COLOR_NAMES.items():
        help_text = help_text.replace(esc, "${C." + name + "}")

    body = (
        help_text.replace("\\", "\\\\")
        .replace("`", "\\`")
        .replace("${C.", "\x00C.")  # protect the interpolations we just made
        .replace("$", "\\$")
        .replace("\x00C.", "${C.")
    )

    OUT.write_text(
        "/**\n"
        " * Port of the `HELP = rf\"\"\"...\"\"\"` block in `views/window_app.py`.\n"
        " *\n"
        " * Generated from the captured v1.0 output so the column alignment of every\n"
        " * command line matches byte for byte. Regenerate with\n"
        " * `python tools/parity/generate-help.ts.py` if v1.0's help text ever changes.\n"
        " */\n\n"
        "import { C } from './colors'\n\n"
        "export const HELP = `" + body + "`\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
