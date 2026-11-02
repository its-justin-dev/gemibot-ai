"""What `img.save()` does when the target path is a directory, and what `data[:80]` raises."""
import os
import sys
import tempfile

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import qrcode

root = tempfile.mkdtemp(prefix="qrprobe-")
adir = os.path.join(root, "adir")
os.mkdir(adir)

img = qrcode.make("x")
for label, call in [("save-dir", lambda: img.save(str(adir)))]:
    try:
        call()
        print(label, "-> no error")
    except Exception as e:
        print(f"{label} -> {type(e).__name__}: {e}")

# and the dispatcher's own rendering of a TypeError raised inside a tool body
for value in (7, 1.5, None, True):
    try:
        f"payload: {value[:80]}"
    except TypeError as e:
        print(f"slice {type(value).__name__} -> Bad arguments: {e}")
