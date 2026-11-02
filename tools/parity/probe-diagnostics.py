"""Every value `tool_system_diagnostics` reads, as this machine answers it.

The line formats are in `views/window_app.py:2513`; this records what the fields actually look
like, so the port can map each one onto the Node API that answers the same question.
"""
import platform
import sys

print("system     ", repr(platform.system()))
print("release    ", repr(platform.release()))
print("version    ", repr(platform.version()))
print("machine    ", repr(platform.machine()))
print("py_version ", repr(platform.python_version()))
print("prefix     ", repr(sys.prefix))
print("base_prefix", repr(sys.base_prefix))
print("venv       ", repr(sys.prefix != sys.base_prefix))
print("executable ", repr(sys.executable))

try:
    import psutil
except ImportError as e:
    print("psutil     -> ImportError:", e)
else:
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("C:\\")
    print("cpu_count  ", repr(psutil.cpu_count(logical=True)))
    print("virtual    ", {k: getattr(vm, k) for k in ("total", "available", "used", "percent")})
    print("disk       ", {k: getattr(du, k) for k in ("total", "used", "free", "percent")})
    print("ram_line   ", f"- RAM: {vm.used // (1024 ** 2):,} MB / {vm.total // (1024 ** 2):,} MB ({vm.percent}%)")
    print("disk_line  ", f"- Disk Free: {du.free // (1024 ** 3):,} GB / {du.total // (1024 ** 3):,} GB")

mods = [
    "google.genai", "PIL", "docx", "openpyxl", "pandas", "pypdf", "fitz", "reportlab",
    "pptx", "cv2", "librosa", "soundfile", "edge_tts", "gtts", "pyttsx3", "qrcode",
]
for name in mods:
    try:
        __import__(name)
        state = "OK"
    except ImportError:
        state = "MISSING"
    print(f"mod {name:14s} {state}")
