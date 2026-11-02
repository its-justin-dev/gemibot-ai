"""`psutil.disk_usage()` for a path that is not there, and the exact line shapes."""
import os
import psutil

for bad in ("C:\no-such-dir-here", "C:\no-such-dir-here\sub"):
    try:
        psutil.disk_usage(bad)
        print(bad, "-> no error")
    except Exception as e:
        print(f"{bad} -> {type(e).__name__}: {e}")

# a file path (not a directory) is accepted, which is what str(self.root) can be
print("file  ->", psutil.disk_usage(os.path.abspath(__file__)).total)

vm = psutil.virtual_memory()
print("percent repr", repr(f"({vm.percent}%)"))
du = psutil.disk_usage("C:\\")
print("ram ", f"- RAM: {vm.used // (1024 ** 2):,} MB / {vm.total // (1024 ** 2):,} MB ({vm.percent}%)")
print("disk", f"- Disk Free: {du.free // (1024 ** 3):,} GB / {du.total // (1024 ** 3):,} GB")
print("cpu ", f"- CPU Cores: {psutil.cpu_count(logical=True)} logical")
