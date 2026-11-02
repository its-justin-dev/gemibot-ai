"""Dump the parts of the qrcode engine that choose the mask and score it."""

import inspect

from qrcode import util
from qrcode.main import QRCode

print("### QRCode members")
print(sorted(n for n in dir(QRCode) if not n.startswith("__")))
print("### util members")
print(sorted(n for n in dir(util) if not n.startswith("__")))


def dump(label):
    parts = label.split(".")
    obj = QRCode if parts[0] == "QRCode" else util
    for part in parts[1:]:
        obj = getattr(obj, part, None)
        if obj is None:
            print(f"### {label}\n[missing]")
            return
    try:
        print(f"### {label}\n{inspect.getsource(obj)}")
    except Exception as e:  # noqa: BLE001
        print(f"### {label}\n[unavailable {type(e).__name__}: {e}] {obj!r}")


for label in [
    "QRCode.makeImpl",
    "QRCode.make_impl",
    "QRCode.best_mask_pattern",
    "QRCode.map_data",
    "QRCode.map_modules",
    "QRCode.make_func_patterns",
    "QRCode.make_file_patterns",
    "QRCode.setup_timing_patterns",
    "QRCode.get_matrix",
    "QRCode.get_modes",
    "QRCode.best_fit",
    "QRCode.add_data",
    "QRCode.make",
    "util.lost_point",
    "util._lost_point_level1",
    "util._lost_point_level2",
    "util._lost_point_level3",
    "util._lost_point_level4",
    "util.lost_point_level3",
    "util.mask_func_pattern",
    "util._lost_point_gen",
    "util._lost_point_gen_2x2",
]:
    dump(label)

print("### QRCode.__init__ signature", inspect.signature(QRCode.__init__))
qr = QRCode()
qr.add_data("hello world")
qr.make(fit=True)
print("border", qr.border, "box_size", qr.box_size, "version", qr.version, "mask", qr.mask_pattern)
print("modules_count", qr.modules_count, "len(modules)", len(qr.modules), "row len", len(qr.modules[0]))
