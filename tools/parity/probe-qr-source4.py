"""Dump the mode-choice helpers: ``_optimal_split``, ``optimal_mode``, ``to_bytestring`` and the
encoding default, plus the version-limit table used by ``best_fit``."""

import inspect

from qrcode import constants, util

for name in ["_optimal_split", "optimal_mode", "to_bytestring", "byteify"]:
    obj = getattr(util, name, None)
    if obj is None:
        print(f"### {name}\n[missing]")
        continue
    try:
        print(f"### {name}\n{inspect.getsource(obj)}")
    except Exception as e:  # noqa: BLE001
        print(f"### {name}\n[unavailable {type(e).__name__}: {e}]")

print("### util.DEFAULT_ENCODING", repr(getattr(util, "DEFAULT_ENCODING", None)))
print("### RE_ALPHA_NUM", repr(getattr(util, "RE_ALPHA_NUM", None)))
print("### BIT_LIMIT_TABLE")
for i, row in enumerate(util.BIT_LIMIT_TABLE):
    print(i, list(row))
print("### QRCode encoding attr")
import qrcode  # noqa: E402

qr = qrcode.QRCode()
print("has encoding", getattr(qr, "encoding", None))
print("### chunk shapes")
CASES = [
    "0123456789" * 2 + "ABCDEFGHIJ" * 2,
    "012345678901234567890" + "abcdefghijklmnopqrstuvwxyz",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" * 4,
    "https://example.com/" + "0123456789" * 4,
    "x" * 19 + "12345678901234567890123",
    "12345678901234567890",
    "1234567890123456789",
    "ABCDEFGHIJKLMNPQRSTUVWXYZ" + "abcdefghij",
    "HELLO123456789012345678901234567890world",
    "\x00" * 25,
]
for case in CASES:
    chunks = list(util.optimal_data_chunks(case, minimum=20))
    qr = qrcode.QRCode()
    qr.add_data(case)
    version = qr.best_fit(start=1)
    print(ascii(case[:34]), [(c.mode, len(c)) for c in chunks], "v", version)
