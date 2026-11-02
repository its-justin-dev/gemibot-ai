"""The tarfile open ladder for the exact bytes the parity test feeds it, read out of the frozen
fixtures in `tests/fixtures` so the expectation can never be a guess.

Run with the v1.0 venv from anywhere; copies each shape into a temp directory first.
"""

import shutil
import tarfile
import tempfile
from pathlib import Path

FIX = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
ROOT = Path(tempfile.mkdtemp(prefix="gemibot-archive-5-"))


def show(label, path):
    print(f"\n=== {label}")
    try:
        with tarfile.open(path, "r:*") as tf:
            print(f"[ok] {[ti.name for ti in tf.getmembers()]}")
    except Exception as e:  # noqa: BLE001
        print(f"[err] {type(e).__name__}: {e}")


def copy(name):
    dst = ROOT / name
    shutil.copyfile(FIX / name, dst)
    return dst


show("v1-tree.tar", copy("v1-tree.tar"))
show("v1-tree.tar.gz", copy("v1-tree.tar.gz"))
show("v1-cut.tar.gz", copy("v1-cut.tar.gz"))
show("v1-tree.zip as tar", copy("v1-tree.zip"))
show("v1-hostile.tar", copy("v1-hostile.tar"))
show("v1-links.tar", copy("v1-links.tar"))

tar = copy("v1-tree.tar")
data = bytearray(tar.read_bytes())
broken = bytearray(data)
broken[148] = 0x39
(ROOT / "badck.tar").write_bytes(bytes(broken))
show("byte 148 -> '9'", ROOT / "badck.tar")

magic = bytearray(data)
magic[257] = 0x20
(ROOT / "nomagic.tar").write_bytes(bytes(magic))
show("byte 257 -> space", ROOT / "nomagic.tar")

# A header broken in the MIDDLE of the archive: does getmembers() stop or fail?
mid = bytearray(data)
second = 3 * 512  # the second header block of this archive starts here
print("\nsecond header name:", bytes(mid[second : second + 100]).rstrip(b"\x00"))
mid[second + 124] = 0x39  # break the size field's first digit
(ROOT / "mid.tar").write_bytes(bytes(mid))
show("mid-archive invalid size field", ROOT / "mid.tar")

# A member whose data is cut short: the walk meets a short block.
(ROOT / "cut-tar.tar").write_bytes(bytes(data[:100]))
show("tar cut to 100 bytes", ROOT / "cut-tar.tar")

print("\nroot:", ROOT)
