"""The second half of the archive measurements: the `zipfile` timestamp ladder through the tool's
own call shape, and the exact four lines `tarfile.open(name, "r:*")` answers with for each of the
shapes the parity test crafts.

Run with the v1.0 venv; writes only inside a temp directory.
"""

import os
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="gemibot-archive-4-"))


def show(label, fn):
    print(f"\n=== {label}")
    try:
        value = fn()
        if value is not None:
            print(f"[out] {value}")
    except Exception as e:  # noqa: BLE001
        print(f"[err] {type(e).__name__}: {e}")


def epoch(text):
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp()


print("local timezone offset hours:", -datetime.now(timezone.utc).utcoffset().total_seconds() / 3600)

old = ROOT / "old.txt"
old.write_text("old\n")


def zip_at(iso, dst_name):
    e = epoch(iso)
    os.utime(old, (e, e))
    st = os.stat(old)
    out = ROOT / dst_name
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(old, old.name)
    except Exception as exc:  # noqa: BLE001
        print(f"  stat mtime={datetime.fromtimestamp(st.st_mtime).isoformat()}")
        print(f"  [err] {type(exc).__name__}: {exc}")
    else:
        print(f"  [ok] wrote {out.name}")
    finally:
        print(f"  file exists={out.exists()} size={out.stat().st_size if out.exists() else '-'}")
        if out.exists():
            try:
                with zipfile.ZipFile(out) as zf:
                    print(f"  namelist={zf.namelist()} date_time={zf.infolist()[0].date_time if zf.namelist() else '-'}")
            except Exception as exc:  # noqa: BLE001
                print(f"  read err {type(exc).__name__}: {exc}")


zip_at("1979-06-01T00:00:00", "y1979.zip")
zip_at("1980-01-01T00:00:00", "y1980.zip")
zip_at("2001-03-04T05:06:07", "y2001.zip")
zip_at("2099-12-31T23:59:59", "y2099.zip")
zip_at("2107-06-01T00:00:00", "y2107.zip")
zip_at("2107-12-31T23:59:59", "y2107dec.zip")
zip_at("2108-01-01T00:00:00", "y2108.zip")
zip_at("2108-06-01T00:00:00", "y2108jun.zip")

# --- the tarfile open ladder for the shapes the parity test crafts
src = ROOT / "src"
src.mkdir()
(src / "a.txt").write_text("a\n")

good = ROOT / "plain.tar"
with tarfile.open(good, "w") as tf:
    tf.add(src, arcname="src")
raw = bytearray(good.read_bytes())
broken = bytearray(raw)
broken[148] = 0x39
(ROOT / "badck.tar").write_bytes(bytes(broken))

magic = bytearray(raw)
magic[257] = 0x20  # keep the checksum, break the ustar magic
(ROOT / "nomagic.tar").write_bytes(bytes(magic))

zp = ROOT / "zip.tar"
with zipfile.ZipFile(zp, "w") as zf:
    zf.writestr("a.txt", "a\n")
(ROOT / "rand.tar").write_bytes(bytes((i * 37 + 11) % 256 for i in range(600)))
(ROOT / "short.tar").write_text("tarfil")
(ROOT / "empty.tar.gz").write_bytes(b"")
(ROOT / "text.bin").write_text("not a zip at all\n" * 40)

for name in ["badck.tar", "nomagic.tar", "zip.tar", "rand.tar", "short.tar", "empty.tar.gz", "text.bin", "plain.tar"]:
    show(f"open r:* {name}", lambda n=name: tarfile.open(ROOT / n, "r:*").getmembers() and "opened")

print("\nroot:", ROOT)
