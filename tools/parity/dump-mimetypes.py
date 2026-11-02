"""Emit the MIME tables the v1.0 interpreter actually answers with, as a TS module.

`mimetypes.init()` folds in the built-in table, `/etc/mime.types`-style files and, on Windows,
the registry, so the dicts written here are what `mimetypes.guess_type()` really consults — that
is what the v2.0 table has to contain, not a hand-typed subset.

    PYTHONIOENCODING=utf-8 ./current.v1.0/.venv/Scripts/python.exe "Gemibot AI Bro/tools/parity/dump-mimetypes.py" > "Gemibot AI Bro/src/shared/constants/mime-table.ts"
"""

import json
import mimetypes

mimetypes.init()
db = mimetypes._db

body = json.dumps(
    {
        "types_map_strict": dict(db.types_map[True]),
        "types_map_nonstrict": dict(db.types_map[False]),
        "suffix_map": db.suffix_map,
        "encodings_map": db.encodings_map,
    },
    indent=1,
    sort_keys=True,
    ensure_ascii=False,
)

print(
    "/**\n"
    " * The MIME tables v1.0's `mimetypes` module answers with on this machine, dumped verbatim\n"
    " * from the v1.0 interpreter (`init()` also folds in the Windows registry).  Regenerate with\n"
    " * `tools/parity/dump-mimetypes.py`; do not edit by hand.\n"
    " */\n"
    "export const MIME_TABLE = "
    + body
    + " as const\n"
)
