"""Dump python's own segmentation (mode + char count per chunk) and the resulting version for the
payloads the node renderer is being compared against."""

import json
import sys
from pathlib import Path

import qrcode
from qrcode import util

from qr_payloads import PAYLOADS

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

rows = []
for payload in PAYLOADS:
    chunks = util.optimal_data_chunks(payload, minimum=20)
    qr = qrcode.QRCode()
    qr.add_data(payload)
    entry = {
        "payload": payload,
        "chunks": [
            {"mode": type(c).__name__, "value": c.mode, "len": len(c), "bytes": len(c.data)}
            for c in chunks
        ],
        "nbits": [len(c) for c in chunks],
    }
    try:
        qr.make(fit=True)
        entry["version"] = qr.version
        # ``make()`` does not keep the pattern it chose, and re-running the selection leaves the
        # modules in the ``test=True`` grid of the last pattern tried, so the chosen mask is
        # applied again before the matrix is read.
        entry["mask"] = qr.best_mask_pattern()
        qr.makeImpl(False, entry["mask"])
        entry["matrix"] = [["1" if cell else "0" for cell in row] for row in qr.get_matrix()]
    except Exception as e:  # noqa: BLE001
        entry["error"] = f"{type(e).__name__}: {e}"
    rows.append(entry)

out = ROOT / "oracle-qr-seg.json"
out.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size} bytes)")
for entry in rows:
    print(
        f"{ascii(entry['payload'][:26]):30} v={entry.get('version')} mask={entry.get('mask')} "
        f"modes={entry.get('modes')} chunks={entry['chunks']} err={entry.get('error')}"
    )
