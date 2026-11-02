"""The remaining `tool_archive_manage` / `tool_qr_generate` failure texts, measured rather than assumed.

Covers the mkdir collisions the tool can hit, a tar holding a symlink or a hard link, an empty
member name, and a QR written onto a directory.
"""

import io
import os
import tarfile
import tempfile
import zipfile
from pathlib import Path

import qrcode

ROOT = Path(tempfile.mkdtemp(prefix="gemibot-archive-edge-"))
(ROOT / "afile.txt").write_bytes(b"hi\n")
(ROOT / "d1").mkdir()


def show(label, fn):
    print(f"\n=== {label}")
    try:
        value = fn()
        if value is not None:
            print(f"[out] {value}")
    except Exception as e:  # noqa: BLE001
        print(f"[err] {type(e).__name__}: {e}")


# --- mkdir(parents=True, exist_ok=True) when a parent is a regular file
show("zip dst parent is a file", lambda: (ROOT / "afile.txt" / "sub").mkdir(parents=True, exist_ok=True))
show("unzip dst is a file", lambda: (ROOT / "afile.txt").mkdir(parents=True, exist_ok=True))
show("unzip dst ok", lambda: (ROOT / "d1" / "nested" / "deep").mkdir(parents=True, exist_ok=True))


def untar(name, members, mode="w"):
    """Write a tar of raw members and extract it with the tool's own call shape."""
    tp = ROOT / name
    with tarfile.open(tp, mode) as tf:
        for ti, data in members:
            if data is None:
                tf.addfile(ti)
            else:
                tf.addfile(ti, io.BytesIO(data))
    out = ROOT / f"{name}-out"
    out.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tp, "r:*") as tf:
        tf.extractall(out)
    return out


def tarinfo(name, typeflag="0", linkname="", size=0):
    ti = tarfile.TarInfo(name)
    # `type` is stored as bytes by the writer, `linkname` as str; encoding the latter makes the
    # writer itself raise before extraction is reached.
    ti.type = typeflag.encode("ascii")
    ti.linkname = linkname
    ti.size = size
    ti.mode = 0o644
    return ti


show("untar symlink member", lambda: untar("sym.tar", [(tarinfo("s", "2", "target.txt"), None)]))
show("untar hardlink member", lambda: untar("hard.tar", [(tarinfo("h", "1", "src.txt"), None)]))
show("untar symlink to missing", lambda: untar("sym2.tar", [(tarinfo("s2", "2", "gone.txt"), None)]))
show(
    "untar empty name",
    lambda: untar("empty-name.tar", [(tarinfo("", "0", "", 2), b"x\n")]),
)
show(
    "untar trailing-slash file",
    lambda: untar("tslash.tar", [(tarinfo("x/", "0", "", 2), b"x\n")]),
)
show(
    "untar dir then file of that name",
    lambda: untar(
        "dirfile.tar",
        [(tarinfo("d", "5", "", 0), None), (tarinfo("d", "0", "", 2), b"x\n")],
    ),
)

# --- zip extraction edges
zp = ROOT / "dup.zip"
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("a.txt", "one")
    zf.writestr("a.txt", "two")
out = ROOT / "dup-out"


def unzip(path, dst):
    dst.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "r") as zf:
        zf.extractall(dst)


show("unzip duplicate names", lambda: unzip(zp, out))
show("tree", lambda: sorted(os.listdir(out)))

zp2 = ROOT / "filedir.zip"
with zipfile.ZipFile(zp2, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("d", "content")
    zf.writestr("d/inner.txt", "inner")
show("unzip file then dir of that name", lambda: unzip(zp2, ROOT / "filedir-out"))


def zip_with(label, names, dates):
    """The tool's own `ZipFile(dst, 'w', ZIP_DEFLATED)` loop, then what the file holds."""
    dst = ROOT / f"dates-{label}.zip"
    try:
        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, stamp in zip(names, dates):
                info = zipfile.ZipInfo(name, date_time=stamp)
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, name)
    except Exception as e:  # noqa: BLE001
        print(f"\n=== zip {label} {names} dates {dates}")
        print(f"[err] {type(e).__name__}: {e}")
        print(f"[dst] exists={dst.exists()} size={dst.stat().st_size if dst.exists() else None}")
        if dst.exists():
            try:
                with zipfile.ZipFile(dst) as check:
                    print(f"[namelist] {check.namelist()}")
            except Exception as e2:  # noqa: BLE001
                print(f"[reopen] {type(e2).__name__}: {e2}")
        return
    print(f"\n=== zip {label} {names} dates {dates}")
    print(f"[ok] size={dst.stat().st_size}")


zip_with("old1", ["old.txt"], [(1979, 1, 1, 0, 0, 0)])
zip_with("old2", ["old.txt"], [(1979, 12, 31, 23, 59, 59)])
zip_with("new1", ["new.txt"], [(2108, 1, 1, 0, 0, 0)])
zip_with("new2", ["new.txt"], [(2107, 12, 31, 23, 59, 59)])
zip_with("mid-old", ["ok1.txt", "old.txt", "ok2.txt"], [(2020, 1, 1, 1, 1, 1), (1979, 1, 1, 0, 0, 0), (2020, 1, 1, 1, 1, 1)])
zip_with("mid-new", ["ok1.txt", "new.txt"], [(2020, 1, 1, 1, 1, 1), (2108, 1, 1, 0, 0, 0)])

# --- QR onto a directory
show("qr save onto dir", lambda: qrcode.make("hi").save(str(ROOT / "d1")))
show("qr save missing parent", lambda: qrcode.make("hi").save(str(ROOT / "no" / "deep" / "q.png")))
show("qr save None payload", lambda: qrcode.make(None).save(str(ROOT / "none.png")))

print("\nroot:", ROOT)
