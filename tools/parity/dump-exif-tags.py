"""Emit PIL's EXIF tag-name tables (`PIL.ExifTags.TAGS` / `GPSTAGS`) as a TS module.

`tool_image_read` prints `ExifTags.TAGS.get(k, str(k))`, so v2.0 needs the exact names Pillow
answers with.  Regenerate with:

    PYTHONIOENCODING=utf-8 ./current.v1.0/.venv/Scripts/python.exe "Gemibot AI Bro/tools/parity/dump-exif-tags.py" > "Gemibot AI Bro/src/shared/constants/exif-tags.ts"
"""

import json

from PIL.ExifTags import GPSTAGS, TAGS

body = json.dumps(
    {
        "TAGS": {str(k): v for k, v in TAGS.items()},
        "GPSTAGS": {str(k): v for k, v in GPSTAGS.items()},
    },
    indent=1,
    sort_keys=True,
    ensure_ascii=False,
)

print(
    "/**\n"
    " * The EXIF tag-name tables v1.0's Pillow answers with, dumped verbatim from the v1.0\n"
    " * interpreter.  Regenerate with `tools/parity/dump-exif-tags.py`; do not edit by hand.\n"
    " */\n"
    "export const EXIF_TAGS = "
    + body
    + " as const\n"
)
