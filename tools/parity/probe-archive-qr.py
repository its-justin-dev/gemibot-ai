"""Test-time oracle for `tool_archive_manage` and `tool_qr_generate`.

Read-only against `current.v1.0`: every function below is a transcription of the corresponding
`Agent` method from `src/views/window_app.py` (2465-2512) with the `allowed()` gate removed, run
against a throw-away tree under %TEMP%.  Nothing here ships; it exists to freeze the literals the
Electron port has to reproduce.

Run:  PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe -u \
        tools/parity/probe-archive-qr.py > ../.recovered/oracle-archive-qr.txt
"""

import io
import os
import shutil
import sys
import tempfile
import tarfile
import traceback
import zipfile

from pathlib import Path

import qrcode

sys.stderr = sys.stdout

# AppConstants.IGNORED (configs/constants.py:309) plus AppConstants.SESSION_DIR.
SESSION_DIR = ".gemibot"
IGNORED = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    "dist",
    "build",
    ".idea",
    ".vscode",
    ".next",
    "target",
    ".pytest_cache",
    SESSION_DIR,
}

ROOT = Path(os.environ.get("TEMP", tempfile.gettempdir())) / "gemibot-archive-qr-oracle"


def rel(p):
    return str(Path(p))


def show(label, fn):
    print(f"\n=== {label}")
    try:
        value = fn()
    except Exception as e:  # noqa: BLE001 - the point is the class and the text
        print(f"[err] {type(e).__name__}: {e}")
        return None
    if value is not None:
        print(f"[out] {value}")
    return value


def tree(base):
    """Every path under `base`, relative, with a trailing slash for directories."""
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(dirnames):
            out.append(str(Path(dirpath, name).relative_to(base)) + "/")
        for name in sorted(filenames):
            out.append(str(Path(dirpath, name).relative_to(base)))
    return out


# ----------------------------------------------------------------------------------------------
# source tree
# ----------------------------------------------------------------------------------------------
SRC = ROOT / "src"
FILES = {
    "alpha.txt": b"alpha\n",
    "zulu.txt": b"zulu\n",
    "sub/beta.txt": b"beta\n",
    "sub/deep/gamma.txt": b"gamma\n",
    "sub/alpha.txt": b"sub-alpha\n",
    "node_modules/dep.txt": b"dep\n",
    ".git/config": b"git\n",
    "keep/env.txt": b"in-env-dir\n",
    "dist-like/x.txt": b"dist-like is not dist\n",
    "sub/.gemibot/session.json": b"{}\n",
    "ünīcode.txt": "unicode name\n".encode("utf-8"),
}


def build():
    if ROOT.exists():
        shutil.rmtree(ROOT, ignore_errors=True)
    for name, data in FILES.items():
        p = SRC / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    (SRC / "empty_dir").mkdir()


# --------------------------------------------------------- transcriptions of the two tool bodies
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
                    if p.is_file() and not any(ig in p.parts for ig in IGNORED):
                        zf.write(p, p.relative_to(src))
        return f"Created ZIP archive {rel(dst)}"
    if act == "unzip":
        dst.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(src, "r") as zf:
            zf.extractall(dst)
        return f"Extracted {rel(src)} to {rel(dst)}"
    if act == "tar":
        dst.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(dst, "w:gz") as tf:
            tf.add(src, arcname=src.name)
        return f"Created TAR.GZ archive {rel(dst)}"
    if act == "untar":
        dst.mkdir(parents=True, exist_ok=True)
        with tarfile.open(src, "r:*") as tf:
            tf.extractall(dst)
        return f"Extracted {rel(src)} to {rel(dst)}"
    raise Exception(f"Unknown archive action: {action}")


def tool_qr_generate(data, output_path):
    full = Path(output_path)
    r = rel(full)
    full.parent.mkdir(parents=True, exist_ok=True)
    img = qrcode.make(data)
    img.save(str(full))
    return f"Generated QR code at {r} for payload: {data[:80]}"


# -----------------------------------------------------------------------------------------------
build()
print("os.sep", repr(os.sep), "altsep", repr(os.altsep), "python", sys.version.split()[0])
print("rglob order (files kept):")
for p in SRC.rglob("*"):
    keep = p.is_file() and not any(ig in p.parts for ig in IGNORED)
    print("   ", "KEEP" if keep else "skip", str(p.relative_to(SRC)), "| parts", len(p.parts))

# ---- zip of a directory: the stored names decide what the port has to write
z = ROOT / "out" / "dir.zip"
show("zip dir", lambda: tool_archive_manage("zip", SRC, z))
with zipfile.ZipFile(z) as zf:
    print("[namelist]")
    for info in zf.infolist():
        print("   ", repr(info.filename), info.file_size, "compress_type", info.compress_type)
    print("[testzip]", zf.testzip())

show("zip dir again (overwrite)", lambda: tool_archive_manage("ZIP ", SRC, z))
show("zip single file", lambda: tool_archive_manage("zip", SRC / "alpha.txt", ROOT / "out" / "one.zip"))
with zipfile.ZipFile(ROOT / "out" / "one.zip") as zf:
    print("[namelist]", zf.namelist())
show("zip missing source", lambda: tool_archive_manage("zip", SRC / "nope", ROOT / "out" / "miss.zip"))
print("[miss.zip exists]", (ROOT / "out" / "miss.zip").exists(), (ROOT / "out" / "miss.zip").stat().st_size if (ROOT / "out" / "miss.zip").exists() else "-")
show("zip unknown action", lambda: tool_archive_manage("rar", SRC, ROOT / "out" / "rar.zip"))
show("zip empty action", lambda: tool_archive_manage("", SRC, ROOT / "out" / "e.zip"))
show("zip action None", lambda: tool_archive_manage(None, SRC, ROOT / "out" / "n.zip"))

# ---- unzip into a fresh directory
u = ROOT / "out" / "unzipped"
show("unzip dir.zip", lambda: tool_archive_manage("unzip", z, u))
print("[tree]", tree(u))

# ---- hostile member names: what does extractall make of them?
def made_with(names, path, data=b"x\n"):
    with zipfile.ZipFile(path, "w") as zf:
        for n in names:
            zf.writestr(n, data)
    return path


for label, names in [
    ("backslash", ["sub\\beta.txt"]),
    ("dotdot", ["../escaped.txt"]),
    ("inside-dotdot", ["a/../../escaped2.txt"]),
    ("absolute", ["/etc/passed.txt"]),
    ("drive", ["C:/outside/drive.txt"]),
    ("leading-slash", ["/leading.txt"]),
    ("drive-backslash", ["C:\\outside\\driveb.txt"]),
    ("empty-name", [""]),
    ("only-separators", ["///"]),
    ("nul-name", ["bad\u0000name.txt"]),
]:
    p = ROOT / f"hostile-{label}.zip"
    made_with(names, p)
    d = ROOT / f"hostile-{label}-out"
    show(f"unzip {label}", lambda p=p, d=d: tool_archive_manage("unzip", p, d))
    print("[tree]", tree(d) if d.exists() else "(no directory)")

print("\n[escaped leak outside dest?]", sorted(os.listdir(ROOT))[:20])

show("unzip missing", lambda: tool_archive_manage("unzip", ROOT / "nope.zip", ROOT / "out" / "x"))
show("unzip non-zip", lambda: tool_archive_manage("unzip", SRC / "alpha.txt", ROOT / "out" / "x"))
show("unzip onto a file", lambda: tool_archive_manage("unzip", z, SRC / "alpha.txt"))
show("unzip source is a dir", lambda: tool_archive_manage("unzip", SRC, ROOT / "out" / "y"))
show("truncated zip", lambda: tool_archive_manage("unzip", made_with(["a.txt"], ROOT / "trunc.zip").with_suffix(".zip"), ROOT / "out" / "t"))
raw = (ROOT / "trunc.zip").read_bytes()
(ROOT / "trunc-cut.zip").write_bytes(raw[: len(raw) - 8])
show("cut zip", lambda: tool_archive_manage("unzip", ROOT / "trunc-cut.zip", ROOT / "out" / "tc"))

# ---- tar
t = ROOT / "out" / "dir.tar.gz"
show("tar dir", lambda: tool_archive_manage("tar", SRC, t))
with tarfile.open(t, "r:*") as tf:
    print("[getnames]")
    for n in tf.getnames():
        print("   ", repr(n))
tu = ROOT / "out" / "untarred"
show("untar dir.tar.gz", lambda: tool_archive_manage("untar", t, tu))
print("[tree]", tree(tu))
show("tar single file", lambda: tool_archive_manage("tar", SRC / "alpha.txt", ROOT / "out" / "one.tar.gz"))
with tarfile.open(ROOT / "out" / "one.tar.gz") as tf:
    print("[getnames]", tf.getnames())
show("tar missing source", lambda: tool_archive_manage("tar", SRC / "nope", ROOT / "out" / "miss.tar.gz"))
show("untar missing", lambda: tool_archive_manage("untar", ROOT / "nope.tar.gz", ROOT / "out" / "q"))
show("untar non-tar", lambda: tool_archive_manage("untar", SRC / "alpha.txt", ROOT / "out" / "q"))
show("untar a zip", lambda: tool_archive_manage("untar", z, ROOT / "out" / "q2"))

# a plain (uncompressed) tar and a .bz2 both open under "r:*"
with tarfile.open(ROOT / "out" / "plain.tar", "w") as tf:
    tf.add(SRC / "alpha.txt", arcname="alpha.txt")
show("untar plain tar", lambda: tool_archive_manage("untar", ROOT / "out" / "plain.tar", ROOT / "out" / "plain-out"))
for label, names in [("tar-dotdot", ["../tescaped.txt"]), ("tar-abs", ["/etc/tpassed.txt"]), ("tar-member-dir", ["d/","d/in.txt"])]:
    tp = ROOT / f"{label}.tar"
    with tarfile.open(tp, "w") as tf:
        for n in names:
            ti = tarfile.TarInfo(n)
            ti.size = 2
            tf.addfile(ti, io.BytesIO(b"x\n"))
    d = ROOT / f"{label}-out"
    show(f"untar {label}", lambda tp=tp, d=d: tool_archive_manage("untar", tp, d))
    print("[tree]", tree(d) if d.exists() else "(no directory)")
    print("[leak?]", sorted(os.listdir(ROOT))[:20])

# ---- QR
print("\n=== qrcode")
PAYLOADS = [
    "12345",
    "HELLO WORLD",
    "https://example.com/path?a=1&b=2",
    "a",
    "",
    "x" * 80,
    "x" * 300,
    "héllo wörld 日本語",
    "0123456789" * 8,
    "AB12 $%*+-./:  ",
    "MiXeD CaSe 42!",
    "\n\t",
    "emoji \U0001f600",
]
for payload in PAYLOADS:
    qr = qrcode.QRCode()
    label = repr(payload[:24])
    try:
        qr.add_data(payload)
        qr.make(fit=True)
        matrix = qr.get_matrix()
    except Exception as e:  # noqa: BLE001
        print(f"[{label}] [err] {type(e).__name__}: {e}")
        continue
    size = len(matrix)
    print(f"[{label}] version={qr.version} ecs={qr.error_correction_level} mask={qr.mask_pattern} modules={size}")
    print("     pixels", (qrcode.make(payload).get_image().size) if True else None)
    for row in matrix:
        print("     " + "".join("1" if c else "0" for c in row))

q = ROOT / "out" / "qr" / "code.png"
show("qr generate", lambda: tool_qr_generate("hello world", q))
from PIL import Image  # noqa: E402

im = Image.open(q)
print("[png]", im.format, im.size, im.mode)
print("[bytes]", len(q.read_bytes()), "head", q.read_bytes()[:16].hex())
show("qr long payload slice", lambda: tool_qr_generate("y" * 120, ROOT / "out" / "qr" / "long.png"))
show("qr empty payload", lambda: tool_qr_generate("", ROOT / "out" / "qr" / "empty.png"))
show("qr non-str payload", lambda: tool_qr_generate(7, ROOT / "out" / "qr" / "n.png"))
show("qr bytes payload", lambda: tool_qr_generate(b"bytes", ROOT / "out" / "qr" / "b.png"))
show("qr into missing dir", lambda: tool_qr_generate("x", ROOT / "out" / "deep" / "deeper" / "c.png"))
show("qr onto a directory", lambda: tool_qr_generate("x", ROOT / "out" / "qr"))
print("[qr version for 'hello world'] ", end="")
qr = qrcode.QRCode()
qr.add_data("hello world")
qr.make(fit=True)
print(qr.version, qr.modules_count)
