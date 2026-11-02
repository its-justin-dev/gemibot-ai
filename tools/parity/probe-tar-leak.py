"""Confirm where `tarfile.extractall()` puts members whose names escape the destination.

The first archive probe truncated its leak listing to twenty entries, so the escaped members were
never accounted for.  This one writes into a fresh directory and reports every path it can find.
"""

import io
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

root = Path(tempfile.mkdtemp(prefix="gemibot-tar-leak-"))
dest = root / "dest"
dest.mkdir()

CASES = {
    "dotdot.tar": ["../escaped.txt"],
    "deep-dotdot.tar": ["a/../../escaped2.txt"],
    "abs.tar": ["/tmp/qoder-tar-leak-probe.txt"],
    "drive.tar": ["C:/tmp/qoder-tar-leak-probe-drive.txt"],
    "simple.tar": ["plain.txt"],
}

for name, members in CASES.items():
    tp = root / name
    with tarfile.open(tp, "w") as tf:
        for m in members:
            ti = tarfile.TarInfo(m)
            ti.size = 2
            tf.addfile(ti, io.BytesIO(b"x\n"))

for name in CASES:
    d = root / f"{name}-out"
    with tarfile.open(root / name, "r:*") as tf:
        try:
            tf.extractall(d)
            print(f"{name:18} ok")
        except Exception as e:  # noqa: BLE001
            print(f"{name:18} {type(e).__name__}: {e}")

print("\nunder the temp root:")
for dirpath, dirnames, filenames in os.walk(root):
    for f in sorted(filenames):
        p = Path(dirpath, f)
        if p.suffix == ".tar":
            continue
        print("   ", p.relative_to(root))
print("\nleaked to the drive root?")
for candidate in [Path("C:/tmp/qoder-tar-leak-probe.txt"), Path("C:/tmp/qoder-tar-leak-probe-drive.txt")]:
    print("   ", candidate, candidate.exists())
    if candidate.exists():
        candidate.unlink()

shutil.rmtree(root, ignore_errors=True)
