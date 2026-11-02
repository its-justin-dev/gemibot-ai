"""Two leftovers: which PNG filters Pillow actually emitted for the frozen QR images, and the exact
failure shape of a payload that no QR version can hold."""

import re
import sys
import traceback
import zlib
from pathlib import Path

import qrcode

TXT = Path(sys.argv[1]) / "oracle-archive-qr3.txt"
text = TXT.read_text(encoding="utf-8")

print("### png filter bytes")
for block in re.finditer(r"=== (\S+).*?\n(?:.*\n)*?     png hex=([0-9a-f]+)", text):
    name, hex_ = block.group(1), block.group(2)
    raw = bytes.fromhex(hex_)
    idat = b""
    i = 8
    sizes = []
    while i < len(raw):
        length = int.from_bytes(raw[i : i + 4], "big")
        kind = raw[i + 4 : i + 8].decode("ascii")
        body = raw[i + 8 : i + 8 + length]
        if kind == "IDAT":
            idat += body
        if kind == "IHDR":
            sizes.append(
                (int.from_bytes(body[0:4], "big"), int.from_bytes(body[4:8], "big"), body[8], body[9])
            )
        i += 12 + length
    inflated = zlib.decompress(idat)
    width, height, depth, color = sizes[0]
    stride = (width * depth + 7) // 8
    filters = [inflated[r * (stride + 1)] for r in range(height)]
    print(f"[{name}] ihdr={sizes[0]} stride={stride} raw={len(inflated)} filters_unique={sorted(set(filters))}")

print("### overflow")
for n in [417, 418, 700, 1200, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2900, 3000]:
    payload = "z" * n
    try:
        qrcode.make(payload)
        print(f"  {n} ok")
    except Exception as e:  # noqa: BLE001
        print(f"  {n} {type(e).__name__}: {e}")
print("### traceback for the overflow")
try:
    qrcode.make("z" * 3000)
except Exception:  # noqa: BLE001
    traceback.print_exc()
print("### numeric overflow")
try:
    qrcode.make("1" * 8000)
except Exception as e:  # noqa: BLE001
    print(f"  {type(e).__name__}: {e}")
