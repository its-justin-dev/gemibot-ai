"""Dump every helper the python encoder uses to choose modes, size the length fields and build the
codeword buffer, so the port can reproduce chunking and bit packing exactly."""

import inspect

from qrcode import util

for name in [
    "optimal_data_chunks",
    "optimal_split",
    "check_optimal_mode",
    "mode_sizes_for_version",
    "length_in_bits",
    "create_data",
    "create_bytes",
    "QRData.__init__",
    "QRData.write",
    "QRData.__len__",
    "QRNum.__init__",
    "QRNum.__len__",
    "QRAlNum.__len__",
    "QRAlNum.write",
    "QRAlphaNum.__len__",
    "BitBuffer.__init__",
    "BitBuffer.put",
    "BitBuffer.__len__",
    "RSBlock.get_blocks",
    "check_version",
]:
    parts = name.split(".")
    obj = util
    ok = True
    for part in parts:
        obj = getattr(obj, part, None)
        if obj is None:
            print(f"### {name}\n[missing]")
            ok = False
            break
    if not ok:
        continue
    try:
        print(f"### {name}\n{inspect.getsource(obj)}")
    except Exception as e:  # noqa: BLE001
        print(f"### {name}\n[unavailable {type(e).__name__}: {e}] {obj!r}")

print("### constants")
print("MODE_NUMBER", util.MODE_NUMBER, "MODE_ALPHA_NUM", util.MODE_ALPHA_NUM)
print("MODE_8BIT_BYTE", util.MODE_8BIT_BYTE, "MODE_KANJI", util.MODE_KANJI)
print("NUMBER_LENGTH", util.NUMBER_LENGTH)
print("ALPHA_NUM", util.ALPHA_NUM)
print("BIT_LIMIT_TABLE rows 0-2:", [list(row[:6]) for row in util.BIT_LIMIT_TABLE])
print("mode_sizes_for_version(1)", util.mode_sizes_for_version(1))
print("mode_sizes_for_version(10)", util.mode_sizes_for_version(10))
print("mode_sizes_for_version(27)", util.mode_sizes_for_version(27))
print("util classes", [n for n in dir(util) if n.startswith("QR")])
print("### QRAlNum")
print(inspect.getsource(util.QRAlNum))
print("### QR8BitByte")
print(inspect.getsource(util.QR8BitByte))
print("### QRNum")
print(inspect.getsource(util.QRNum))
