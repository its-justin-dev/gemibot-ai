"""Freeze the PIL PNG bytes qrcode+Pillow write for the payloads the parity fixture covers.

The rendered pixels, not the encoder, are what parity is judged on: the test decodes the frozen PNG
with sharp and compares it against the PNG this build writes for the same payload.
"""

import base64
import json
import sys
from io import BytesIO
from pathlib import Path

import qrcode
from PIL import Image

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

PAYLOADS = [
    "",
    "a",
    "hello world",
    "12345",
    "HELLO WORLD",
    "01234567890123456789",
    "h\u00e9llo w\u00f6rld \u65e5\u672c\u8a9e",
    "\U0001f600\U0001f600\U0001f600\U0001f600\U0001f600\U0001f600\U0001f600\U0001f600",
    "x" * 80,
    "HELLO12345678901234567890123456789" + "world",
]

rows = []
for payload in PAYLOADS:
    img = qrcode.make(payload)
    buf = BytesIO()
    img.save(buf, format="PNG")
    png = buf.getvalue()
    with Image.open(BytesIO(png)) as opened:
        size = [opened.width, opened.height]
        mode = opened.mode
    rows.append(
        {
            "payload": payload,
            "mode": mode,
            "size": size,
            "png_b64": base64.b64encode(png).decode("ascii"),
        }
    )

out = ROOT / "oracle-qr-png.json"
out.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size} bytes)")
for row in rows:
    print(f"{ascii(row['payload'][:26]):30} {row['size']} mode={row['mode']} png={len(row['png_b64'])}")
