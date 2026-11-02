"""Generate the corrupt-package oracle: what v1.0's readers answer for a broken office file.

`make-pptx.py` pinned the pptx side.  The docx and excel tools go through the same OPC loader
(python-docx) or the same zip reader (openpyxl), but the ports use jszip/exceljs, whose own errors
are JS wordings — so every message here is a literal the port has to reproduce.  The tool bodies
are copied verbatim out of `current.v1.0/src/views/window_app.py` and run against a shim.

The corrupted packages are also written into `tests/fixtures` as `corrupt-*` with the office suffix
each case needs (.docx, .xlsx, .xls, .xlsb, .ods) so the parity tests keep passing after
current.v1.0 is shut down.
"""

import os
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
root = os.environ.get('GEMI_ROOT', str(HERE.parent))
fx = str(HERE / 'tests' / 'fixtures')
work = os.path.join(os.environ['TEMP'], 'oracle-corrupt-root')

shutil.rmtree(work, ignore_errors=True)
os.makedirs(work, exist_ok=True)

src = open(os.path.join(root, 'current.v1.0', 'src', 'views', 'window_app.py'), encoding='utf-8').read()


def extract(name):
    return re.search(rf"(    def {name}\(.*?)(?=\n    def )", src, re.S).group(1)


lines = [
    "import csv, io, os, re, shutil, sys, zipfile",
    "from pathlib import Path",
    "sys.path.insert(0, r'%s')" % os.path.join(root, 'current.v1.0', 'src'),
    "",
    "fx = r'%s'" % fx,
    "work = r'%s'" % work,
    "",
    "class ToolError(Exception):\n    pass",
    "",
    "# `read_text` is only reachable from the .csv branch, which no case here feeds.",
    "def read_text(full):",
    "    return full.read_text(encoding='utf-8'), False",
    "",
    "class Shim:",
    "    root = Path(r'%s')" % work,
    "    def __init__(self):",
    "        self.artifacts = []",
    "    def rel(self, full):",
    "        p = Path(str(full)).resolve()",
    "        try:",
    "            return p.relative_to(self.root.resolve()).as_posix()",
    "        except Exception:",
    "            return p.name",
    "    def resolve(self, path):",
    "        p = Path(str(path))",
    "        return p if p.is_absolute() else self.root / p",
    "    def allowed(self, *a): return True",
    "    def record_binary_artifact(self, full, action, summary):",
    "        self.artifacts.append((action, str(Path(str(full)).name), summary))",
]
for name in [
    'tool_docx_read',
    'tool_docx_analyze',
    'tool_docx_edit',
    'tool_excel_read',
    'tool_excel_analyze',
    'tool_excel_write',
]:
    lines.append(extract(name))

lines += [
    "import openpyxl",
    "s = Shim()",
    "",
    "# Printed the way `execute()` renders it: `type(e).__name__` and `str(e)`, and TypeError",
    "# goes through the `Bad arguments:` branch instead.",
    "def attempt(label, fn):",
    "    try:",
    "        print(label, repr(fn()))",
    "    except Exception as e:",
    "        n = type(e).__name__",
    "        print(label, ('Bad arguments: ' if n == 'TypeError' else n + ': ') + str(e))",
    "",
    "# The damaged inputs, built from the healthy fixtures the earlier oracles left in tests/fixtures.",
    "def write_bytes(name, blob):",
    "    Path(work, name).write_bytes(blob if isinstance(blob, bytes) else blob.encode())",
    "    return name",
    "def rebuild(name, base, drops=(), edits=()):",
    "    zin = zipfile.ZipFile(str(Path(fx, base)))",
    "    with zipfile.ZipFile(str(Path(work, name)), 'w') as zout:",
    "        for item in zin.infolist():",
    "            if item.filename in drops:",
    "                continue",
    "            blob = zin.read(item.filename)",
    "            for part, find, sub in edits:",
    "                if item.filename == part:",
    "                    blob = re.sub(find, sub, blob.decode('utf-8'), count=1, flags=re.S).encode('utf-8')",
    "            zout.writestr(item, blob)",
    "    return name",
    "def zipof(name, entries):",
    "    with zipfile.ZipFile(str(Path(work, name)), 'w') as z:",
    "        for member, blob in entries:",
    "            z.writestr(member, blob)",
    "    return name",
    "EMPTY_CT = '<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>'",
    "",
    "write_bytes('corrupt-text.docx', 'not a docx at all')",
    "write_bytes('corrupt-empty.docx', b'')",
    "write_bytes('corrupt-text.xlsx', 'not an xlsx at all')",
    "write_bytes('corrupt-empty.xlsx', b'')",
    "zipof('corrupt-zip.docx', [('hello.txt', 'not a document')])",
    "zipof('corrupt-ct.docx', [('[Content_Types].xml', EMPTY_CT)])",
    "zipof('corrupt-zip.xlsx', [('hello.txt', 'not a workbook')])",
    "zipof('corrupt-ct.xlsx', [('[Content_Types].xml', EMPTY_CT)])",
    "rebuild('corrupt-nopart.docx', 'oracle-sample.docx', ('word/document.xml',))",
    "rebuild('corrupt-norel.docx', 'oracle-sample.docx', (),",
    "        [('_rels/.rels', r'<Relationship[^>]*word/document\\.xml\"[^>]*/>', '')])",
    "rebuild('corrupt-nosheet.xlsx', 'oracle-sample.xlsx', ('xl/worksheets/sheet1.xml',))",
    "rebuild('corrupt-norel.xlsx', 'oracle-sample.xlsx', (),",
    "        [('xl/_rels/workbook.xml.rels', r'<Relationship[^>]*worksheets/sheet1.xml\"[^>]*/>', '')])",
    "",
    "# The formats pandas claims by content but openpyxl refuses by suffix, plus an archive whose",
    "# central directory is gone: pandas and openpyxl both hand `zipfile`'s BadZipFile back.",
    "write_bytes('corrupt-legacy.xls', b'\\xd0\\xcf\\x11\\xe0\\xa1\\xb1\\x1a\\xe1' + b'\\x00' * 504)",
    "zipof('corrupt-xlsb.xlsb', [('[Content_Types].xml', EMPTY_CT), ('xl/workbook.bin', 'binary')])",
    "zipof('corrupt-ods.ods', [('mimetype', 'application/vnd.oasis.opendocument.spreadsheet'),",
    "                           ('content.xml', '<office:document-content/>')])",
    "write_bytes('corrupt-trunc.xlsx', Path(fx, 'oracle-sample.xlsx').read_bytes()[:64])",
    "",
    "CASES = ['corrupt-text.docx', 'corrupt-empty.docx', 'corrupt-zip.docx', 'corrupt-ct.docx',",
    "         'corrupt-nopart.docx', 'corrupt-norel.docx',",
    "         'corrupt-text.xlsx', 'corrupt-empty.xlsx', 'corrupt-zip.xlsx', 'corrupt-ct.xlsx',",
    "         'corrupt-nosheet.xlsx', 'corrupt-norel.xlsx',",
    "         'corrupt-legacy.xls', 'corrupt-xlsb.xlsb', 'corrupt-ods.ods', 'corrupt-trunc.xlsx']",
    "# Keep the damaged packages: the parity tests stage them straight into their target folder.",
    "# Copied *before* the cases run, because a case can repair the file it was handed —",
    "# `tool_excel_write()` writes over `corrupt-nosheet.xlsx` and leaves it a healthy workbook.",
    "for n in CASES:",
    "    shutil.copy(str(Path(work, n)), os.path.join(fx, n))",
    "",
    "for c in CASES:",
    "    if c.endswith('.docx'):",
    "        attempt(c, lambda c=c: s.tool_docx_read(c))",
    "        attempt(c + ' analyze', lambda c=c: s.tool_docx_analyze(c))",
    "        attempt(c + ' edit', lambda c=c: s.tool_docx_edit(c, find_text='a', replace_text='b'))",
    "    else:",
    "        attempt(c, lambda c=c: s.tool_excel_read(c))",
    "        attempt(c + ' analyze', lambda c=c: s.tool_excel_analyze(c))",
    "        attempt(c + ' write', lambda c=c: s.tool_excel_write(c, headers=['h'], rows=[['v']]))",
    "print('=====8<=====')",
    "# The missing-file lines, for completeness next to the corrupt ones.",
    "attempt('nope.docx', lambda: s.tool_docx_read('nope.docx'))",
    "attempt('nope.xlsx', lambda: s.tool_excel_read('nope.xlsx'))",
    "",
    "# The fixtures copied above are the ones the parity tests read; these work files may have been",
    "# repaired or overwritten by the cases that just ran on them.",
    "print('WROTE FIXTURES')",
]

out = os.path.join(os.environ['TEMP'], 'oracle_corrupt_run.py')
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(out)
