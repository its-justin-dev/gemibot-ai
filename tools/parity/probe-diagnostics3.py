r"""`psutil.disk_usage()` failures, and Node's `fs.statfs()` answer for the same paths.

`tool_system_diagnostics` calls `psutil.disk_usage(str(self.root))` outside any `except` of its
own, so whatever that raises is what `execute()` renders.  A project root that has been deleted
underneath a running agent is the case that reaches it.
"""
import os

import psutil

for bad in ("C:\\no-such-dir-here", "C:\\no-such-dir-here\\sub", "C:\\Windows\\notepad.exe"):
    try:
        psutil.disk_usage(bad)
        print(f"{bad} -> no error")
    except Exception as e:
        print(f"{bad} -> {type(e).__name__}: {e}")
