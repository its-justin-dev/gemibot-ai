import os
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
root = os.environ.get('GEMI_ROOT', str(HERE.parent))
fx = str(HERE / 'tests' / 'fixtures')
import openpyxl, pandas as pd, re, shutil

# A throw-away "target directory" for the write cases, so rel() behaves like the real app.
work = os.path.join(os.environ['TEMP'], 'oracle-excel-root')
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work, exist_ok=True)

with open(os.path.join(fx, 'oracle-sample.csv'), 'w', newline='', encoding='utf-8') as f:
    f.write('name,age,score,active\nAlice,34,91.5,True\nBob,28,78,False\nCara,,85.0,True\nDan,41,,True\n')

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Data'
ws.append(['name', 'age', 'score'])
ws.append(['Alice', 34, 91.5])
ws.append(['Bob', 28, '=B2+B3'])
ws.append([None, None, None])
ws2 = wb.create_sheet('Notes')
ws2['A1'] = 'hello'
wb.save(os.path.join(fx, 'oracle-sample.xlsx'))

src = open(os.path.join(root, 'current.v1.0', 'src', 'views', 'window_app.py'), encoding='utf-8').read()
def extract(name):
    return re.search(rf"(    def {name}\(.*?)(?=\n    def )", src, re.S).group(1)
def extract_global(name):
    return re.search(rf"^(def {name}\(.*?)(?=\ndef )", src, re.S | re.M).group(1)
lines = ["import io, csv, re, os", "from pathlib import Path", "import sys",
         "sys.path.insert(0, r'%s')" % os.path.join(root, 'current.v1.0', 'src'), ""]
# The module-level helpers the tools call are taken verbatim from v1.0, not re-typed here.
lines.append("class ToolError(Exception):\n    pass")
for gname in ["is_binary", "read_text"]:
    lines.append(extract_global(gname))
lines.append("")
lines.append("class Shim:")
lines.append("    root = Path(r'%s')" % work)
lines.append(
    "    def rel(self, full):\n"
    "        p = Path(str(full)).resolve()\n"
    "        try:\n"
    "            return p.relative_to(self.root.resolve()).as_posix()\n"
    "        except Exception:\n"
    "            return p.name\n"
)
lines.append(
    "    def resolve(self, path):\n"
    "        p = Path(str(path))\n"
    "        return p if p.is_absolute() else self.root / p\n"
)
lines.append("    def allowed(self, *a): return True")
lines.append("    def record_binary_artifact(self, *a): pass")
for name in ["tool_excel_read", "tool_excel_analyze", "tool_excel_write"]:
    for line in extract(name).splitlines():
        lines.append(line)
lines += [
    "s = Shim()",
    "c = os.path.join(r'%s', 'oracle-sample.csv')" % fx,
    "x = os.path.join(r'%s', 'oracle-sample.xlsx')" % fx,
    "print(s.tool_excel_read(c))",
    "print('=====8<=====')",
    "print(s.tool_excel_read(x))",
    "print('=====8<=====')",
    "print(s.tool_excel_analyze(c))",
    "print('=====8<=====')",
    "print(s.tool_excel_analyze(x))",
    "print('=====8<=====')",
    # excel_write on a fresh path, then again on the same file (the workbook-exists branch).
    "import openpyxl",
    "b = 'out/book.xlsx'",
    "print(s.tool_excel_write(b, ['name', 'qty'], [['Apple', '3'], ['Pear', '=SUM(B2:B3)']], 'Data'))",
    "print(s.tool_excel_read(b))",
    "print('widths:', {k: v.width for k, v in openpyxl.load_workbook(str(s.root / b))['Data'].column_dimensions.items()})",
    "print(s.tool_excel_write(b, ['a', 'b'], [['1', '2.50']], 'Extra'))",
    "print(s.tool_excel_read(b))",
    "print(s.tool_excel_read(b, sheet='Extra'))",
    "print('sheets:', openpyxl.load_workbook(str(s.root / b)).sheetnames)",
    "print('widths:', {k: v.width for k, v in openpyxl.load_workbook(str(s.root / b))['Extra'].column_dimensions.items()})",
]
out = os.path.join(os.environ['TEMP'], 'oracle_excel_run.py')
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(out)
