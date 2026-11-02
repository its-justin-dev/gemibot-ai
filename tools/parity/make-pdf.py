"""Generate the PDF oracle: run v1.0's own `tool_pdf_*` bodies over generated fixtures.

The tool source is copied verbatim out of `current.v1.0/src/views/window_app.py` — never
retyped — and executed against a shim that provides the handful of `self.` attributes those
bodies touch.  Print the output, then paste it into `tests/unit/parity-tools.test.ts`.
"""

import os
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
root = os.environ.get('GEMI_ROOT', str(HERE.parent))
fx = str(HERE / 'tests' / 'fixtures')

# A throw-away "target directory" so rel() behaves like the real app for the write cases.
work = os.path.join(os.environ['TEMP'], 'oracle-pdf-root')
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work, exist_ok=True)

src = open(os.path.join(root, 'current.v1.0', 'src', 'views', 'window_app.py'), encoding='utf-8').read()


def extract(name):
    return re.search(rf"(    def {name}\(.*?)(?=\n    def )", src, re.S).group(1)


lines = [
    "import io, os, re, shutil, sys, textwrap",
    "from pathlib import Path",
    "sys.path.insert(0, r'%s')" % os.path.join(root, 'current.v1.0', 'src'),
    "",
    "work = r'%s'" % work,
    "",
    "class ToolError(Exception):\n    pass",
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
for name in ["tool_pdf_read", "tool_pdf_analyze", "tool_pdf_write"]:
    lines.append(extract(name))

LONG = "\n".join(
    [
        'Report of the Q3 field study.',
        '',
        '# Heading one',
        'The quick brown fox jumps over the lazy dog ' * 4,
        'A short line.',
        'x' * 200,
        '',
        '   indented line keeps its leading spaces',
        'trailing spaces   ',
        'final line',
    ]
)

lines += [
    "s = Shim()",
    "from reportlab.lib.pagesizes import LETTER",
    "from reportlab.pdfgen import canvas",
    # pdf_write on a fresh path, exactly as the model would call it.
    "print(s.tool_pdf_write('oracle-report.pdf', %r))" % LONG,
    "print(s.artifacts[-1])",
    "print('=====8<=====')",
    "print(s.tool_pdf_read('oracle-report.pdf'))",
    "print('=====8<=====')",
    "print(s.tool_pdf_analyze('oracle-report.pdf'))",
    "print('=====8<=====')",
    # Page window: v1.0 clamps start to >= 1 and end to >= start, then stops at the total.
    "print(s.tool_pdf_read('oracle-report.pdf', 2, 3))",
    "print('=====8<=====')",
    "print(s.tool_pdf_read('oracle-report.pdf', 0, 0))",
    "print('=====8<=====')",
    "print(s.tool_pdf_read('oracle-report.pdf', 5, 2))",
    "print('=====8<=====')",
    # A short one-pager.
    "print(s.tool_pdf_write('oracle-meta.pdf', 'Tiny body.', 'Tiny Title'))",
    "print(s.tool_pdf_analyze('oracle-meta.pdf'))",
    "print(s.tool_pdf_read('oracle-meta.pdf'))",
    "print('=====8<=====')",
    # Empty content still draws the title.
    "print(s.tool_pdf_write('oracle-empty.pdf', ''))",
    "print(s.tool_pdf_analyze('oracle-empty.pdf'))",
    "print(repr(s.tool_pdf_read('oracle-empty.pdf')))",
    "print('=====8<=====')",
    # Encrypted output: whatever pypdf raises is what the tool raises.
    "from reportlab.lib.pdfencrypt import StandardEncryption",
    "c = canvas.Canvas(str(Path(work) / 'oracle-secret.pdf'), pagesize=LETTER)",
    "c.setFont('Helvetica', 10)",
    "c.drawString(50, LETTER[1] - 55, 'Hidden words here')",
    "c.setEncrypt(StandardEncryption('pw', 'pw'))",
    "c.save()",
    "try:",
    "    print(s.tool_pdf_analyze('oracle-secret.pdf'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "try:",
    "    print(s.tool_pdf_read('oracle-secret.pdf'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "print('=====8<=====')",
    # Encrypted with an empty user password: pypdf decrypts on its own, so `is_encrypted` is True
    # while the text still comes out.  This is what pins the Encrypted line's source.
    "c = canvas.Canvas(str(Path(work) / 'oracle-openenc.pdf'), pagesize=LETTER)",
    "c.setFont('Helvetica', 10)",
    "c.drawString(50, LETTER[1] - 55, 'Readable though encrypted')",
    "c.setEncrypt(StandardEncryption('', 'owner'))",
    "c.save()",
    "print(s.tool_pdf_analyze('oracle-openenc.pdf'))",
    "print(s.tool_pdf_read('oracle-openenc.pdf'))",
    "print('=====8<=====')",
    # A document that carries real /Info entries, to pin the metadata lines.
    "c = canvas.Canvas(str(Path(work) / 'oracle-titled.pdf'), pagesize=LETTER)",
    "c.setTitle('Measured Titles')",
    "c.setAuthor('Ada Lovelace')",
    "c.setCreator('Reportlab Canvas')",
    "c.setFont('Helvetica', 10)",
    "c.drawString(50, LETTER[1] - 55, 'Body text with four words')",
    "c.save()",
    "print(s.tool_pdf_analyze('oracle-titled.pdf'))",
    "print(s.tool_pdf_read('oracle-titled.pdf'))",
    "print('=====8<=====')",
    # A two page document, to pin the page-window and per-page blocks together.
    "print(s.tool_pdf_write('oracle-pages.pdf', 'page one body\\n' + ('filler words ' * 400) + '\\nlast line', 'Two Pages'))",
    "print(repr(s.tool_pdf_read('oracle-pages.pdf', 1, 2)))",
    "print(s.tool_pdf_read('oracle-pages.pdf', 2, 9))",
    "print(s.tool_pdf_analyze('oracle-pages.pdf'))",
    "print('=====8<=====')",
    # Exact whitespace, since a console print hides trailing blanks.
    "print(repr(s.tool_pdf_read('oracle-report.pdf')))",
    # Content the Helvetica standard encoding cannot represent.
    "try:",
    "    print(s.tool_pdf_write('oracle-unicode.pdf', 'Café — naïve ✓', 'Ünïcode'))",
    "    print(repr(s.tool_pdf_read('oracle-unicode.pdf')))",
    "    print(s.tool_pdf_analyze('oracle-unicode.pdf'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "print('=====8<=====')",
    # A missing file, and the .pdf that is not really a pdf.
    "try:",
    "    s.tool_pdf_read('oracle-nope.pdf')",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "open(str(Path(work) / 'oracle-junk.pdf'), 'w').write('not a pdf at all')",
    "try:",
    "    print(s.tool_pdf_analyze('oracle-junk.pdf'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "try:",
    "    print(s.tool_pdf_read('oracle-junk.pdf'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "print('=====8<=====')",
    # The files the unit tests stage straight into their target directory.
    "for n in ['report', 'meta', 'empty', 'titled', 'openenc', 'pages', 'secret', 'junk', 'unicode']:",
    "    src_p = Path(work) / ('oracle-' + n + '.pdf')",
    "    if src_p.is_file(): shutil.copy(str(src_p), os.path.join(r'%s', src_p.name))" % fx,
    "print('WROTE FIXTURES')",
]

out = os.path.join(os.environ['TEMP'], 'oracle_pdf_run.py')
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(out)
