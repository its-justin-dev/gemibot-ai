"""Write the archive fixtures the parity tests read, using the same `zipfile`/`tarfile` build v1.0 ran.

    python tools/parity/make-archive-fixtures.py tests/fixtures

Every file here is what the oracle produced, not what the port produces, so a wrong reader cannot
validate itself.  The tree layout and the member order are the ones `probe-archive-qr.py` measured;
`IGNORED` is applied exactly as `tool_archive_manage()` applies it.
"""

import os
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

V1_ROOT = Path(__file__).resolve().parents[3] / "current.v1.0"
sys.path.insert(0, str(V1_ROOT / "src"))

from configs.constants import AppConstants  # noqa: E402  (v1.0's own set, not a copy of it)

IGNORED = AppConstants.IGNORED

FILES = {
    "alpha.txt": b"alpha\n",
    "zulu.txt": b"zulu\n",
    "ünīcode.txt": b"unicode\n",
    ".git/config": b"git\n",
    "node_modules/dep.txt": b"dep\n",
    "sub/alpha.txt": b"sub-alpha\n",
    "sub/beta.txt": b"beta\n",
    "sub/deep/gamma.txt": b"gamma\n",
    "sub/.gemibot/session.json": b"{}\n",
    "dist-like/x.txt": b"dist-like\n",
    "keep/env.txt": b"keep-env\n",
    "empty_dir/.keep": b"kept\n",
}

# A name longer than the 99-byte ustar field, so `tarfile` has to write a PaxHeader member.
LONG = "/".join(f"directory-number-{i:02d}" for i in range(6)) + "/long-name.txt"

OUT = Path(__file__).resolve().parents[2] / (sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="gemibot-archive-fixtures-"))


def build(base: Path, files: dict) -> None:
    for name, data in files.items():
        target = base / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def tool_zip(src: Path, dst: Path) -> None:
    """`ZipFile(dst,'w',ZIP_DEFLATED)` over `src.rglob('*')` filtered the way the tool filters it."""
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
        if src.is_file():
            zf.write(src, src.name)
            return
        for p in src.rglob("*"):
            if p.is_file() and not any(ig in p.parts for ig in IGNORED):
                zf.write(p, p.relative_to(src))


src = ROOT / "src"
build(src, FILES)
tool_zip(src, OUT / "v1-tree.zip")

with tarfile.open(OUT / "v1-tree.tar.gz", "w:gz") as tf:
    tf.add(src, arcname=src.name)
with tarfile.open(OUT / "v1-tree.tar", "w") as tf:
    tf.add(src, arcname=src.name)

deep = ROOT / "deep"
build(deep, {LONG: b"long\n", "top.txt": b"top\n"})
with tarfile.open(OUT / "v1-long.tar.gz", "w:gz") as tf:
    tf.add(deep, arcname=deep.name)


def raw_tar(path: Path, members: list) -> None:
    """Members written straight through the low-level interface, so the hostile names survive.

    `TarInfo.type` has to be the bytes the on-disk field holds while `linkname` has to stay a
    `str`; encoding both makes the writer itself raise before anything is written.
    """
    import io

    with tarfile.open(path, "w") as tf:
        for name, typeflag, linkname, data in members:
            ti = tarfile.TarInfo(name)
            ti.type = typeflag.encode("ascii")
            ti.linkname = linkname
            ti.mode = 0o644
            if typeflag == "5":
                ti.size = 0
                tf.addfile(ti)
                continue
            payload = data or b""
            ti.size = len(payload)
            tf.addfile(ti, io.BytesIO(payload))


raw_tar(
    OUT / "v1-hostile.tar",
    [
        ("../escaped.txt", "0", "", b"escaped\n"),
        ("/abs.txt", "0", "", b"abs\n"),
        ("./current.txt", "0", "", b"current\n"),
        ("a/../../kept.txt", "0", "", b"kept\n"),
        ("dir/", "5", "", None),
        ("dangling.txt", "0", "", b"dangling\n"),
    ],
)

# A gzip stream that stops mid-way, which is the `EOFError` the tool has to report.
(OUT / "v1-cut.tar.gz").write_bytes((OUT / "v1-tree.tar.gz").read_bytes()[:100])

HOSTILE = [
    "sub/beta.txt",
    "sub\\beta.txt",
    "/abs.txt",
    "C:/drive.txt",
    "../up.txt",
    "a/../../kept.txt",
    "bad\x00name.txt",
    "win:illegal?.txt",
    "trail.  ",
    "dirpart/",
    "C:\\back\\slash.txt",
]


def stored_zip(path: Path, names: list) -> None:
    """`ZipFile(dst,'w')` + `writestr()` per name, so the stored names are `zipfile`'s own."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, name)


stored_zip(OUT / "v1-hostile.zip", HOSTILE)
# `''` is a name `zipfile` will store and `extractall()` refuses, which is the
# `ValueError: Empty filename.` the tool raises; the members before it are already on disk and the
# ones after it never are.
stored_zip(OUT / "v1-empty.zip", ["before.txt", "", "after.txt"])
stored_zip(OUT / "v1-collide.zip", ["d/f.txt", "d"])

links = ROOT / "links"
build(links, {"real.txt": b"real\n", "sub/inner.txt": b"inner\n"})
os.symlink("real.txt", links / "sym.txt")
os.link(links / "real.txt", links / "hard.txt")
with tarfile.open(OUT / "v1-links.tar", "w") as tf:
    tf.add(links, arcname=".")

print("fixtures written to", OUT)
for name in sorted(os.listdir(OUT)):
    if name.startswith("v1-") and (".tar" in name or ".zip" in name):
        print(f"  {name} {(OUT / name).stat().st_size} bytes")
