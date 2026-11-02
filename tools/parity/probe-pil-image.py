"""Probe PIL header-sniffing semantics used by DiffService._extract_binary_metadata."""

import io
from PIL import Image

Image.init()
print("openable formats:", sorted(Image.ID))


for label, sizes in (("largest last", [(32, 32), (16, 16)]), ("largest first", [(16, 16), (32, 32)])):
    stream = io.BytesIO()
    Image.new("RGB", sizes[0], (200, 30, 60)).save(stream, "ICO", sizes=sizes)
    handle = Image.open(io.BytesIO(stream.getvalue()))
    print(label, "->", handle.format, handle.size, Image.MIME.get(handle.format))

real = io.BytesIO()
Image.new("RGB", (7, 5), (200, 30, 60)).save(real, "BMP")
print("bmp ->", Image.open(io.BytesIO(real.getvalue())).format)

buf = io.BytesIO()
Image.new("RGB", (7, 5), (200, 30, 60)).save(buf, "DIB")
print("dib bytes ->", Image.open(io.BytesIO(buf.getvalue())).format)

for label, payload in (
    ("P1", b"P1 2 2 0101"),
    ("P4", b"P4 2 2 \x80\x00"),
    ("P2", b"P2 2 2 255 1 2 3 4"),
    ("P5", b"P5 2 2 255 abcdef"),
    ("P6", b"P6 2 2 255 " + bytes(range(12))),
    ("comment", b"P6\n# hi\n2 2\n255\n" + bytes(12)),
    ("longline", b"P6 " + b"1" * 300 + b" 2 2 255 " + bytes(12)),
    ("no-max", b"P6 2 2\n" + bytes(12)),
    ("bmp-short", b"BM" + bytes(6)),
    ("gif-short", b"GIF89a" + bytes(2)),
    ("png-short", b"\x89PNG\r\n\x1a\n" + bytes(12)),
    ("tga", b"\x00\x00\x02\x00" + bytes(18)),
):
    try:
        probe = Image.open(io.BytesIO(payload))
        print(label, "->", probe.format, probe.size, Image.MIME.get(probe.format))
    except Exception as exc:
        print(label, "-> error", type(exc).__name__, exc)
