"""Measure the exact UnicodeEncodeError text `qrcode.make()` raises for payloads holding surrogates.

v1.0's `to_bytestring()` is what encodes, so each case is handed straight to `qrcode.make()`.
"""

import sys

import qrcode

CASES = [
    "\ud800",
    "\ud800a",
    "a\udc00",
    "\ud800\ud800",
    "\ud800\udc00",
    "\ud800a\ud801",
    "a\ud800b\udc00c",
    "\ud83d\ude00",
    "\ud83d\ud83d",
    "\udfff",
    "😀\ud800",
    "\U0001f600\ud800\U0001f600",
    "日本語\ud800",
]

for text in CASES:
    try:
        qrcode.make(text)
        print(f"{ascii(text):28} ok")
    except Exception as e:  # noqa: BLE001
        print(f"{ascii(text):28} {type(e).__name__}: {e}")

print()
print("to_bytestring source:")
import inspect  # noqa: E402

from qrcode import util  # noqa: E402

print(inspect.getsource(util.to_bytestring))
print(inspect.getsource(util.optimal_mode))
