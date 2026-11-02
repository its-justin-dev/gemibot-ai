"""Oracle: for each payload, dump the mask Python picks, the penalty it scored for every mask
(test grid, i.e. ``makeImpl(True, i)``), the penalty on the finished grid, and both grids for all
eight masks so the node renderer can be compared cell by cell."""

import json
import sys
from pathlib import Path

import qrcode
from qrcode import util

from qr_payloads import PAYLOADS

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

cases = []
for payload in PAYLOADS:
    qr = qrcode.QRCode()
    qr.add_data(payload)
    try:
        qr.make(fit=True)
    except Exception as e:  # noqa: BLE001
        cases.append({"payload": payload, "error": f"{type(e).__name__}: {e}"})
        continue
    # ``make()`` does not keep the chosen pattern, so re-run the same selection.
    chosen = qr.best_mask_pattern()
    case = {
        "payload": payload,
        "version": qr.version,
        "mask": chosen,
        "modes": [type(d).__name__ for d in qr.data_list],
        "penalties_test": [],
        "penalties_final": [],
        "grids_test": [],
        "grids_final": [],
    }
    for i in range(8):
        qr.makeImpl(True, i)
        case["penalties_test"].append(util.lost_point(qr.modules))
        if len(qr.modules) <= 61:
            case["grids_test"].append(["".join("1" if c else "0" for c in row) for row in qr.modules])
        else:
            case["grids_test"].append(None)
        qr.makeImpl(False, i)
        case["penalties_final"].append(util.lost_point(qr.modules))
        case["grids_final"].append(["".join("1" if c else "0" for c in row) for row in qr.modules])
    cases.append(case)

out = ROOT / "oracle-qr-grids.json"
out.write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size} bytes)")
for case in cases:
    if "error" in case:
        print(f"[{case['payload'][:24]!r}] error {case['error']}")
        continue
    print(
        f"[{ascii(case['payload'][:24])}] v={case['version']} mask={case['mask']} "
        f"modes={case['modes']} test={case['penalties_test']} final={case['penalties_final']}"
    )
