"""Oracle: what `img.save(str(path))` does for every extension the model might hand the QR tool,
given the mode-"1" image qrcode builds."""

import sys
import traceback
from pathlib import Path

import qrcode
from PIL import Image

ROOT = Path(sys.argv[1])
ROOT.mkdir(parents=True, exist_ok=True)

EXTS = [
    ".png",
    ".PNG",
    ".PnG",
    ".jpg",
    ".jpeg",
    ".JPG",
    ".gif",
    ".bmp",
    ".webp",
    ".tif",
    ".ppm",
    ".txt",
    ".qr",
    "",
    ".",
    ".png.bak",
    ".png.zip",
]

data = "hello world"
for ext in EXTS:
    out = ROOT / f"qr{ext if ext.startswith('.') else '.' + ext}"
    if not ext:
        out = ROOT / "qrx"
    img = qrcode.make(data)
    print(f"### ext={ext!r} path={out.name!r} img={img.__class__.__name__} mode={img.mode} size={img.size}")
    try:
        img.save(str(out))
    except Exception as e:  # noqa: BLE001
        print(f"    [err] {type(e).__name__}: {e}")
        print(f"    exists={out.exists()}")
        continue
    raw = out.read_bytes()
    with Image.open(out) as opened:
        print(
            f"    ok bytes={len(raw)} format={opened.format} mode={opened.mode} size={opened.size}"
            f" head={raw[:12].hex()}"
        )
        if opened.mode != "1":
            print(f"    converted-mode {opened.getpixel((0, 0))} {opened.getpixel((opened.size[0] // 2, opened.size[1] // 2))}")

print("### image factory")
print(type(qrcode.make(data)).__module__, type(qrcode.make(data)).__name__)
print("### save into a directory")
try:
    qrcode.make(data).save(str(ROOT))
except Exception as e:  # noqa: BLE001
    print(f"    [err] {type(e).__name__}: {e}")
print("### save with a path whose parent is missing")
try:
    qrcode.make(data).save(str(ROOT / "nope" / "x.png"))
except Exception as e:  # noqa: BLE001
    print(f"    [err] {type(e).__name__}: {e}")
print("### empty payload image")
try:
    img = qrcode.make("")
    print("    ok", img.mode, img.size)
except Exception as e:  # noqa: BLE001
    print(f"    [err] {type(e).__name__}: {e}")
print("### non-str payloads through the tool path")
for value in [7, 1.5, None, True, ["a"], {"a": 1}, b"hi"]:
    try:
        img = qrcode.make(value)
        target = ROOT / "qr-ns.png"
        img.save(str(target))
        summary = f"Generated QR code at x for payload: {value[:80]}"
        print(f"    {value!r} -> ok size={img.size} summary={summary!r}")
    except Exception as e:  # noqa: BLE001
        print(f"    {value!r} -> {type(e).__name__}: {e}")
print("### long payload truncation")
long = "z" * 300
try:
    qrcode.make(long)
    print("    300 chars ok")
except Exception as e:  # noqa: BLE001
    print(f"    300 chars [err] {type(e).__name__}: {e}")
overflow = "z" * 5000
try:
    qrcode.make(overflow)
except Exception as e:  # noqa: BLE001
    print(f"    5000 chars [err] {type(e).__name__}: {e}")
    traceback.print_exc(limit=0)
sys.exit(0)
