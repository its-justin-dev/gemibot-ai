"""Second pass of the archive/QR oracle: destination sanitisation, tar probing and QR matrices.

Companion to `probe-archive-qr.py`; see that file for the ground rules (transcriptions only, no
writes outside %TEMP%, nothing here ships).

Run:  PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe -u \
        tools/parity/probe-archive-qr2.py > ../.recovered/oracle-archive-qr2.txt
"""

import io
import os
import shutil
import sys
import tarfile
import time
import zipfile

from pathlib import Path

import qrcode

sys.stderr = sys.stdout

ROOT = Path(os.environ["TEMP"]) / "gemibot-archive-qr-oracle2"
if ROOT.exists():
    shutil.rmtree(ROOT, ignore_errors=True)
ROOT.mkdir(parents=True)


def show(label, fn):
    print(f"\n=== {label}")
    try:
        value = fn()
    except Exception as e:  # noqa: BLE001
        print(f"[err] {type(e).__name__}: {e}")
        return None
    if value is not None:
        print(f"[out] {value}")
    return value


def listing(base):
    if not Path(base).exists():
        return "(no directory)"
    rows = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(dirnames):
            rows.append(str(Path(dirpath, name).relative_to(base)) + "/")
        for name in sorted(filenames):
            rows.append(str(Path(dirpath, name).relative_to(base)))
    return rows


# ---------------------------------------------------------------- transcriptions (as in probe 1)
def tool_archive_manage(action, source, destination):
    src = Path(source)
    dst = Path(destination)
    act = action.lower().strip()
    if act == "zip":
        dst.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
            if src.is_file():
                zf.write(src, src.name)
            else:
                for p in src.rglob("*"):
                    if p.is_file():
                        zf.write(p, p.relative_to(src))
        return f"Created ZIP archive {dst}"
    if act == "unzip":
        dst.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(src, "r") as zf:
            zf.extractall(dst)
        return f"Extracted {src} to {dst}"
    if act == "tar":
        dst.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(dst, "w:gz") as tf:
            tf.add(src, arcname=src.name)
        return f"Created TAR.GZ archive {dst}"
    if act == "untar":
        dst.mkdir(parents=True, exist_ok=True)
        with tarfile.open(src, "r:*") as tf:
            tf.extractall(dst)
        return f"Extracted {src} to {dst}"
    raise Exception(f"Unknown archive action: {action}")


print("[class attrs]")
for name in ("_ignore_invalid_names", "separator"):
    print("   ", name, "=", repr(getattr(zipfile.ZipFile, name, "<absent>")))
print("   zipfile.__name__", zipfile.__name__)
print("[tarfile filters]", sorted(getattr(tarfile, "FILTERS", {})))
import inspect  # noqa: E402

print("   add():", [ln.strip() for ln in inspect.getsource(tarfile.TarFile.add).splitlines() if "listdir" in ln])
print("   open():", [ln.strip() for ln in inspect.getsource(tarfile.TarFile.open).splitlines() if "ERRMODE" in ln or "def open" in ln])

# a small source tree, plus names that a hostile archive can hold
SRC = ROOT / "tree"
(SRC / "one").mkdir(parents=True)
(SRC / "Aaa").mkdir()
(SRC / "a-b").mkdir()
(SRC / "ab").mkdir()
for relpath in ["top.txt", "one/inside.txt", "Aaa/x.txt", "a-b/y.txt", "ab/z.txt", "Top2.TXT"]:
    (SRC / relpath).write_bytes(relpath.encode())

# ---- sorting: zip walk order vs tar walk order vs readdir order
print("\n=== walk order")
print("   rglob      ", [str(p.relative_to(SRC)) for p in SRC.rglob("*")])
print("   listdir    ", os.listdir(SRC))
print("   sorted     ", sorted(os.listdir(SRC)))
zp = tool_archive_manage("zip", SRC, ROOT / "order.zip")
with zipfile.ZipFile(ROOT / "order.zip") as zf:
    print("   zip names  ", zf.namelist())
tool_archive_manage("tar", SRC, ROOT / "order.tar.gz")
with tarfile.open(ROOT / "order.tar.gz", "r:*") as tf:
    print("   tar names  ", tf.getnames())

# ---- names as stored, for shapes the caller could hand to writestr
print("\n=== stored names (ZipInfo normalisation)")
hostile = ROOT / "hostile.zip"
names = [
    "sub\\beta.txt",
    "sub/beta.txt",
    "/abs.txt",
    "C:/drive.txt",
    "..\\up.txt",
    "a/../../kept.txt",
    "bad\u0000name.txt",
    "win:illegal?.txt",
    "trail.  ",
    "dirpart/",
    "C:\\back\\slash.txt",
]
with zipfile.ZipFile(hostile, "w") as zf:
    for n in names:
        zf.writestr(n, b"x\n")
with zipfile.ZipFile(hostile) as zf:
    print("   namelist")
    for info in zf.infolist():
        print("      ", repr(info.filename), "is_dir", info.is_dir(), "date_time", info.date_time)

# ---- extraction of each hostile name on its own, so one failure cannot hide the rest
for n in names:
    p = ROOT / f"single-{abs(hash(n))}.zip"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr(n, b"x\n")
    d = ROOT / f"single-{abs(hash(n))}-out"
    show(f"unzip {n!r}", lambda p=p, d=d: tool_archive_manage("unzip", p, d))
    print("   [tree]", listing(d))
    print("   [root]", sorted(os.listdir(ROOT)))

# ---- an empty name in the middle: does the abort stop the later members?
mixed = ROOT / "mixed.zip"
with zipfile.ZipFile(mixed, "w") as zf:
    zf.writestr("before.txt", b"b\n")
    zf.writestr("", b"e\n")
    zf.writestr("after.txt", b"a\n")
dm = ROOT / "mixed-out"
show("unzip before/empty/after", lambda: tool_archive_manage("unzip", mixed, dm))
print("   [tree]", listing(dm))

# ---- directory members and collisions
dirmode = ROOT / "dirmode.zip"
with zipfile.ZipFile(dirmode, "w") as zf:
    zf.writestr("d/", b"")
    zf.writestr("d/f.txt", b"f\n")
    zf.writestr("d/", b"")
    zf.writestr("f.txt", b"F\n")
show("unzip dir members", lambda: tool_archive_manage("unzip", dirmode, ROOT / "dirmode-out"))
print("   [tree]", listing(ROOT / "dirmode-out"))
collide = ROOT / "collide.zip"
with zipfile.ZipFile(collide, "w") as zf:
    zf.writestr("d/f.txt", b"f\n")
    zf.writestr("d", b"d-is-a-file\n")
show("unzip file-over-dir", lambda: tool_archive_manage("unzip", collide, ROOT / "collide-out"))
print("   [tree]", listing(ROOT / "collide-out"))

# ---- timestamps before 1980 are rejected on write
old = SRC / "old.txt"
old.write_bytes(b"old\n")
os.utime(old, (3600, 3600))
show("zip a pre-1980 file", lambda: tool_archive_manage("zip", old, ROOT / "old.zip"))
os.utime(old, (4354900000, 4354900000))
show("zip a post-2107 file", lambda: tool_archive_manage("zip", old, ROOT / "old2.zip"))

# ---- tarfile.open('r:*') failure texts for every shape the AI can hand it
shapes = {}
shapes["empty"] = b""
shapes["short"] = b"hello\n"
shapes["gzip-junk"] = __import__("gzip").compress(b"not a tar at all, just text\n")
shapes["zip"] = (ROOT / "order.zip").read_bytes()
shapes["tar-truncated"] = (ROOT / "order.tar.gz").read_bytes()[:100]
tarmad = bytearray((ROOT / "order.tar.gz").read_bytes())
shapes["gz"] = None
plain = ROOT / "plain.tar"
with tarfile.open(plain, "w") as tf:
    tf.add(SRC / "top.txt", arcname="top.txt")
raw = bytearray(plain.read_bytes())
raw[148] = (raw[148] + 1) % 256  # break the header checksum
(ROOT / "badcksum.tar").write_bytes(bytes(raw))
shapes["tar-bad-checksum"] = (ROOT / "badcksum.tar").read_bytes()
(ROOT / "zeros.tar").write_bytes(b"\0" * 512 * 3)
shapes["tar-all-zeros"] = (ROOT / "zeros.tar").read_bytes()
(ROOT / "shortblock.tar").write_bytes(b"\0" * 300)
shapes["tar-short-zeros"] = (ROOT / "shortblock.tar").read_bytes()
bzh = ROOT / "in.tar.bz2"
with tarfile.open(bzh, "w:bz2") as tf:
    tf.add(SRC / "top.txt", arcname="top.txt")
shapes["tar-bz2"] = bzh.read_bytes()
xz = ROOT / "in.tar.xz"
with tarfile.open(xz, "w:xz") as tf:
    tf.add(SRC / "top.txt", arcname="top.txt")
shapes["tar-xz"] = xz.read_bytes()
zst = None
try:
    import compression  # noqa: F401
except Exception:  # noqa: BLE001
    zst = None

for label, data in shapes.items():
    if data is None:
        continue
    p = ROOT / f"shape-{label}.bin"
    p.write_bytes(data)
    d = ROOT / f"shape-{label}-out"
    show(f"untar {label} ({len(data)} bytes)", lambda p=p, d=d: tool_archive_manage("untar", p, d))
    print("   [tree]", listing(d))
    print("   [root]", sorted(os.listdir(ROOT))[:6])

# gzip that decompresses to a real tar
gg = ROOT / "double.tar.gz2"
gg.write_bytes(__import__("gzip").compress(bytes(raw[:512] + b"\0" * 512)))
show("untar gz of tar-ish", lambda: tool_archive_manage("untar", gg, ROOT / "double-out"))

# ---- tar escape behaviour, with the whole temp dir visible
for label, members in [
    ("dotdot", ["../escaped.tar.txt"]),
    ("abs", ["/absolute.tar.txt"]),
    ("dot", ["./current.tar.txt"]),
    ("multi", ["a/../b/nested.tar.txt"]),
]:
    tp = ROOT / f"esc-{label}.tar"
    with tarfile.open(tp, "w") as tf:
        for n in members:
            ti = tarfile.TarInfo(n)
            ti.size = 2
            ti.mode = 0o644
            tf.addfile(ti, io.BytesIO(b"x\n"))
    d = ROOT / f"esc-{label}-out"
    show(f"untar {label}", lambda tp=tp, d=d: tool_archive_manage("untar", tp, d))
    print("   [tree]", listing(d))
    print("   [temp]", [n for n in sorted(os.listdir(ROOT)) if "escape" in n or "absolute" in n or "nested" in n or "current" in n])
    print("   [parent temp leaks]", [n for n in sorted(os.listdir(ROOT.parent)) if n.startswith("gemibot") or "escape" in n])

# symlinks and hard links inside a tar
link = ROOT / "links.tar"
with tarfile.open(link, "w") as tf:
    tf.addfile(tarfile.TarInfo("real.txt"), io.BytesIO(b"real\n"))
    ti = tarfile.TarInfo("sym.txt")
    ti.type = tarfile.SYMTYPE
    ti.linkname = "real.txt"
    tf.addfile(ti)
    ti2 = tarfile.TarInfo("abs-sym.txt")
    ti2.type = tarfile.SYMTYPE
    ti2.linkname = "/etc/passwd"
    tf.addfile(ti2)
show("untar with symlinks", lambda: tool_archive_manage("untar", link, ROOT / "links-out"))
print("   [tree]", listing(ROOT / "links-out"))

# ---- QR matrices
print("\n=== qrcode")
PAYLOADS = [
    "12345",
    "HELLO WORLD",
    "https://example.com/path?a=1&b=2",
    "a",
    "x" * 80,
    "x" * 300,
    "héllo wörld 日本語",
    "0123456789" * 8,
    "AB12 $%*+-./:",
    "MiXeD CaSe 42!",
    "\n\t",
    "emoji \U0001f600",
    "hello world",
]
for payload in PAYLOADS:
    qr = qrcode.QRCode()
    label = repr(payload[:20])
    try:
        qr.add_data(payload)
        qr.make(fit=True)
        matrix = qr.get_matrix()
    except Exception as e:  # noqa: BLE001
        print(f"[{label}] [err] {type(e).__name__}: {e}")
        continue
    print(f"[{label}] version={qr.version} ecs={qr.error_correction} matrix={len(matrix)} modules={qr.modules_count} box=10 border=4")
    for row in matrix:
        print("     " + "".join("1" if c else "0" for c in row))

out = ROOT / "qr.png"
img = qrcode.make("hello world")
img.save(str(out))
from PIL import Image  # noqa: E402

im = Image.open(out)
print("[png]", im.format, im.size, im.mode)
print("[png info]", {k: (repr(v)[:40] if not isinstance(v, bytes) else v[:16].hex()) for k, v in im.info.items()})
print("[png palette]", im.getpalette()[:12] if im.mode == "P" else None)
print("[png corners]", im.getpixel((0, 0)), im.getpixel((1, 1)), im.getpixel((im.size[0] - 1, im.size[1] - 1)))
print("[png bytes]", len(out.read_bytes()))
print("[png chunks]", [out.read_bytes()[i : i + 4].decode("latin1") for i in range(8, min(len(out.read_bytes()), 200), 1)][:0])
data = out.read_bytes()
i, chunks = 8, []
while i < len(data):
    size = int.from_bytes(data[i : i + 4], "big")
    kind = data[i + 4 : i + 8].decode("latin1")
    chunks.append(f"{kind}:{size}")
    i += 12 + size
    if kind == "IEND":
        break
print("[png chunk list]", chunks)
print("[factory]", type(img).__name__)
print("[make defaults]", qrcode.QRCode().box_size, qrcode.QRCode().border, qrcode.constants.ERROR_CORRECT_L, qrcode.constants.ERROR_CORRECT_M, qrcode.constants.ERROR_CORRECT_Q, qrcode.constants.ERROR_CORRECT_H)
print("[empty payload]", end=" ")
try:
    qrcode.make("")
    print("ok")
except Exception as e:  # noqa: BLE001
    print(f"[err] {type(e).__name__}: {e}")
for value in [7, 1.5, None, True, ["a"], {"a": 1}, b"bytes"]:
    print(f"[payload {value!r}] ", end="")
    try:
        qr = qrcode.QRCode()
        qr.add_data(value)
        qr.make(fit=True)
        print(f"version={qr.version} matrix={len(qr.get_matrix())}")
    except Exception as e:  # noqa: BLE001
        print(f"[err] {type(e).__name__}: {e}")
