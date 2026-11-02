"""Dump the two functions that place the format and version info modules, plus the module-writing
helpers, so the reserved-cell coordinates can be reproduced exactly."""

import inspect

from qrcode.main import QRCode

for name in [
    "setup_type_info",
    "setup_type_number",
    "setup_position_probe_pattern",
    "setup_position_adjust_pattern",
    "setup_timing_pattern",
    "active_with_neighbors",
    "is_constrained",
]:
    fn = getattr(QRCode, name, None)
    if fn is None:
        print(f"### {name}\n[missing]")
        continue
    print(f"### {name}\n{inspect.getsource(fn)}")
