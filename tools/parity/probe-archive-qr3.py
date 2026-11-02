"""Measurements still missing for the archive parity cases: the call-binding line, `os.path.join`
shapes for a hostile tar member name, the member list `tarfile.add()` writes for the test tree, and
the two `zipfile` timestamp limits.

Run with the v1.0 venv; writes only inside a temp directory.
"""

import os
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="gemibot-archive-3-"))


def show(label, fn):
    print(f"\n=== {label}")
    try:
        value = fn()
        if value is not None:
            print(f"[out] {value}")
    except Exception as e:  # noqa: BLE001
        print(f"[err] {type(e).__name__}: {e}")


# --- the binding line execute() prints for a bad argument list
def tool_archive_manage(action, source, destination):
    return action, source, destination


def call(**kw):
    return tool_archive_manage(**kw)


show("missing 3", lambda: call())
show("missing 2", lambda: call(action="zip"))
show("missing 1", lambda: call(action="zip", source="a"))
show("unexpected kw", lambda: call(act="zip", source="a", destination="b"))
show("too many positional", lambda: tool_archive_manage(*["a"] * 4))


def one(a):
    return a


show("single missing", lambda: one())

# --- os.path.join, exactly as tarfile._extract_member uses it
dst = str(ROOT / "out")
for name in ["../escaped.txt", "/abs.txt", "./current.txt", "a/../../kept.txt", "dir", "", "sub/x.txt"]:
    print(f"join {name!r} -> {os.path.join(dst, name)!r}")

# --- the member list for the test tree the archive test stages
src = ROOT / "src"
(src / "sub" / ".gemibot").mkdir(parents=True)
(src / ".git").mkdir()
(src / "node_modules").mkdir()
(src / "keep").mkdir()
(src / "a.txt").write_text("a\n")
(src / "m.txt").write_text("m\n")
(src / "sub" / "b.txt").write_text("b\n")
(src / ".git" / "config").write_text("git\n")
(src / "node_modules" / "dep.json").write_text("{}\n")
(src / "sub" / ".gemibot" / "session.json").write_text("{}\n")
(src / "keep" / "env.txt").write_text("env\n")

tp = ROOT / "tree.tar.gz"
with tarfile.open(tp, "w:gz") as tf:
    tf.add(src, arcname=src.name)
with tarfile.open(tp, "r:*") as tf:
    for ti in tf.getmembers():
        print(f"  {ti.name!r} {ti.type!r} size={ti.size} mode={oct(ti.mode)}")

# --- zipfile timestamp limits, through the tool's own call shape
old = ROOT / "old.txt"
old.write_text("old\n")


def zip_with(epoch, dst_name):
    os.utime(old, (epoch, epoch))
    out = ROOT / dst_name
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(old, old.name)


show("zip 1979", lambda: zip_with(-332899200, "old.zip"))
show("zip 2108", lambda: zip_with(4358217600, "far.zip"))
show("zip 2107-12-31", lambda: zip_with(4358217599, "last.zip"))
for name in ["old.zip", "far.zip", "last.zip"]:
    p = ROOT / name
    print(f"  {name} exists={p.exists()} size={p.stat().st_size if p.exists() else '-'}")
    if p.exists():
        try:
            with zipfile.ZipFile(p) as zf:
                print(f"    namelist={zf.namelist()}")
        except Exception as e:  # noqa: BLE001
            print(f"    read err {type(e).__name__}: {e}")

# --- what mtime zipfile actually stores for a future date
os.utime(old, (4358217599, 4358217599))
with zipfile.ZipFile(ROOT / "probe.zip", "w", zipfile.ZIP_DEFLATED) as zf:
    zf.write(old, old.name)
with zipfile.ZipFile(ROOT / "probe.zip") as zf:
    print("  stored date_time:", zf.infolist()[0].date_time)

# --- tarfile open ladder for the shapes the test crafts
zp = ROOT / "zip.tar"
with zipfile.ZipFile(zp, "w") as zf:
    zf.writestr("a.txt", "a\n")
show("open a zip as r:*", lambda: tarfile.open(zp, "r:*"))

good = ROOT / "plain.tar"
with tarfile.open(good, "w") as tf:
    tf.add(src, arcname="src")
raw = bytearray(good.read_bytes())
raw[148] = 0x39
bad = ROOT / "badck.tar"
bad.write_bytes(bytes(raw))
show("broken checksum", lambda: tarfile.open(bad, "r:*"))

short = ROOT / "short.tar"
short.write_text("tarfil")
show("six bytes", lambda: tarfile.open(short, "r:*"))

empty = ROOT / "empty.tar.gz"
empty.write_bytes(b"")
show("empty", lambda: tarfile.open(empty, "r:*"))

print("\nroot:", ROOT)
