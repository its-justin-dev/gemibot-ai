"""Generate the pptx oracle: run v1.0's own `tool_pptx_*` bodies over generated decks.

The tool source is copied verbatim out of `current.v1.0/src/views/window_app.py` — never
retyped — and executed against a shim that provides the handful of `self.` attributes those
bodies touch.  Print the output, then paste it into `tests/unit/parity-tools.test.ts`.

`tools/parity/probe-pptxgen.mjs` must run first: it writes the deck v2.0's writer will produce,
and this harness reads it back through v1.0 so the round trip is pinned from both sides.
"""

import os
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
root = os.environ.get('GEMI_ROOT', str(HERE.parent))
fx = str(HERE / 'tests' / 'fixtures')
work = os.path.join(os.environ['TEMP'], 'oracle-pptx-root')
node_deck = os.path.join(os.environ['TEMP'], 'oracle-pptx-node.pptx')

shutil.rmtree(work, ignore_errors=True)
os.makedirs(work, exist_ok=True)

src = open(os.path.join(root, 'current.v1.0', 'src', 'views', 'window_app.py'), encoding='utf-8').read()


def extract(name):
    return re.search(rf"(    def {name}\(.*?)(?=\n    def )", src, re.S).group(1)


lines = [
    "import os, re, shutil, sys",
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
for name in ["tool_pptx_read", "tool_pptx_write"]:
    lines.append(extract(name))

lines += [
    "import pptx",
    "from pptx.util import Inches, Pt",
    "s = Shim()",
    "",
    "# Printed the way `execute()` renders a failure: `type(e).__name__`, not the module path.",
    "def attempt(label, fn):",
    "    try:",
    "        print(label, repr(fn()))",
    "    except Exception as e:",
    "        print(label, type(e).__name__ + ':', e)",
    "",
    "# What the default template actually is: the writer has to reproduce its page size and the",
    "# placeholder set its two layouts feed into the read output.",
    "prs = pptx.Presentation()",
    "print('slide size EMU', prs.slide_width, prs.slide_height)",
    "for i, lay in enumerate(prs.slide_layouts):",
    "    print('layout', i, lay.name, [(p.placeholder_format.idx, str(p.placeholder_format.type)) for p in lay.placeholders])",
    # Geometry of the two layouts the writer puts its text into, in EMU.
    "for i in (0, 1):",
    "    for ph in prs.slide_layouts[i].placeholders:",
    "        print('geom', i, ph.placeholder_format.idx, ph.left, ph.top, ph.width, ph.height)",
    "print('=====8<=====')",
    # The deck v2.0's writer has to reproduce, read back through v1.0's own reader.
    "print(s.tool_pptx_write('oracle-deck.pptx', 'Deck Title', [",
    "    {'heading': 'Slide One', 'bullets': ['first bullet', 'second bullet', 'Ünïcode — naïve ✓'],",
    "     'notes': 'Notes for slide one'},",
    "    {'heading': 'No Bullets', 'bullets': []},",
    "    {'heading': 'Wide', 'bullets': ['x' * 200, '', 'tail']},",
    "], 'Deck Subtitle'))",
    "print(s.artifacts[-1])",
    "print(s.tool_pptx_read('oracle-deck.pptx'))",
    "print('=====8<=====')",
    # The default subtitle, an explicit empty one, and the two no-content shapes of the API.
    "print(s.tool_pptx_write('oracle-sub.pptx', 'T', [{'heading': 'H', 'bullets': ['b']}]))",
    "print(s.tool_pptx_read('oracle-sub.pptx'))",
    "print('=====8<=====')",
    "print(s.tool_pptx_write('oracle-nosub.pptx', 'T', [{'heading': 'H', 'bullets': ['b']}], ''))",
    "print(repr(s.tool_pptx_read('oracle-nosub.pptx')))",
    "print('=====8<=====')",
    "print(s.tool_pptx_write('oracle-empty.pptx', 'Empty Deck', []))",
    "print(repr(s.tool_pptx_read('oracle-empty.pptx')))",
    "print('=====8<=====')",
    "print(s.tool_pptx_write('oracle-noslides.pptx', 'None Arg', None))",
    "print(repr(s.tool_pptx_read('oracle-noslides.pptx')))",
    "print('=====8<=====')",
    # A deck the writer cannot produce, to pin what the reader skips: a table, a picture, a group
    # with a text box inside it, an empty text frame, and notes with padding around them.
    "prs = pptx.Presentation()",
    "blank = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[-1]",
    "sl = prs.slides.add_slide(blank)",
    "tb = sl.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(2))",
    "tb.text_frame.text = 'box paragraph one'",
    "tb.text_frame.add_paragraph().text = 'box paragraph two'",
    "sl.shapes.add_textbox(Inches(1), Inches(3), Inches(2), Inches(1))",
    "gf = sl.shapes.add_table(2, 2, Inches(1), Inches(4), Inches(4), Inches(1))",
    "gf.table.cell(0, 0).text = 'A1'",
    "gf.table.cell(0, 1).text = 'B1'",
    "pic = sl.shapes.add_picture(r'%s', Inches(6), Inches(1), Inches(2))" % os.path.join(fx, 'exif-sample.jpg'),
    "grp = sl.shapes.add_group_shape()",
    "grp.left, grp.top, grp.width, grp.height = Inches(6), Inches(4), Inches(3), Inches(2)",
    "gtb = grp.shapes.add_textbox(Inches(6), Inches(4), Inches(3), Inches(1))",
    "gtb.text_frame.text = 'text inside a group'",
    "sl.notes_slide.notes_text_frame.text = '  spaced notes  '",
    "sl.notes_slide.notes_text_frame.add_paragraph().text = ' second line '",
    # Slide 2: the run-level markup `text_frame.text` has to fold into the printed string —
    # a line break and a tab inside one paragraph, a field, and an empty trailing paragraph.
    "from pptx.oxml import parse_xml",
    "from pptx.oxml.ns import nsdecls",
    "from pptx.enum.shapes import MSO_SHAPE",
    "sl2 = prs.slides.add_slide(blank)",
    "tb2 = sl2.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(3))",
    "tb2.text_frame.text = 'first paragraph'",
    "tx = tb2.text_frame._txBody",
    "P_BR = ('<a:p %s><a:r><a:t>run a</a:t></a:r><a:br/><a:r><a:t>after br</a:t></a:r>"
    "<a:tab/><a:r><a:t>after tab</a:t></a:r></a:p>') % nsdecls('a')",
    "P_FLD = ('<a:p %s><a:fld id=\"{2C1E3A94-8C0B-4D4B-9E0F-1A2B3C4D5E6F}\" type=\"slidenum\">"
    "<a:t>12</a:t></a:fld><a:r><a:t> after field</a:t></a:r></a:p>') % nsdecls('a')",
    "P_EMPTY = '<a:p %s></a:p>' % nsdecls('a')",
    "tx.append(parse_xml(P_BR))",
    "tx.append(parse_xml(P_FLD))",
    "tx.append(parse_xml(P_EMPTY))",
    "auto = sl2.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(4), Inches(3), Inches(1))",
    "auto.text_frame.text = 'inside an autoshape'",
    # A connector: python-pptx decides by class whether it exposes a text frame at all.
    "from pptx.enum.shapes import MSO_CONNECTOR",
    "try:",
    "    conn = sl2.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(7), Inches(5), Inches(9), Inches(6))",
    "    print('connector has_text_frame:', conn.has_text_frame)",
    "    ct = getattr(conn, 'text_frame', None)",
    "    if ct is not None:",
    "        ct.text = 'connector text'",
    "except Exception as e:",
    "    print('connector error:', type(e).__name__, e)",
    # Slide 3: a title placeholder nobody filled in, so the slide prints as an empty block.
    "sl3 = prs.slides.add_slide(prs.slide_layouts[5])",
    "prs.save(str(Path(work) / 'oracle-rich.pptx'))",
    "print(repr(s.tool_pptx_read('oracle-rich.pptx')))",
    "print('=====8<=====')",
    # The same deck read from a subdirectory: `rel` is a posix path inside the target directory.
    "os.makedirs(str(Path(work) / 'sub'), exist_ok=True)",
    "shutil.copy(str(Path(work) / 'oracle-rich.pptx'), str(Path(work) / 'sub' / 'rich.pptx'))",
    "print(s.tool_pptx_read('sub/rich.pptx').splitlines()[0])",
    "print('=====8<=====')",
    # What v1.0's reader makes of the deck the npm writer produced.
    "attempt('node-read', lambda: s.tool_pptx_read(r'%s'))" % node_deck,
    "print('=====8<=====')",
    # A missing file, a file that is not a pptx, and a zip that is not a presentation.
    "try:",
    "    s.tool_pptx_read('oracle-nope.pptx')",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "open(str(Path(work) / 'oracle-junk.pptx'), 'w').write('not a pptx at all')",
    "try:",
    "    print(s.tool_pptx_read('oracle-junk.pptx'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "import zipfile",
    "z = zipfile.ZipFile(str(Path(work) / 'oracle-zip.pptx'), 'w')",
    "z.writestr('hello.txt', 'not a presentation')",
    "z.close()",
    "try:",
    "    print(s.tool_pptx_read('oracle-zip.pptx'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    # A package whose content types are present but that carries no presentation part.
    "z = zipfile.ZipFile(str(Path(work) / 'oracle-notpres.pptx'), 'w')",
    "z.writestr('[Content_Types].xml',",
    "          '<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>')",
    "z.close()",
    "try:",
    "    print(s.tool_pptx_read('oracle-notpres.pptx'))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "try:",
    "    print(s.tool_pptx_write('sub/new.pptx', 'Denied?', [{'heading': 'H', 'bullets': ['b']}]))",
    "except Exception as e:",
    "    print(type(e).__module__ + '.' + type(e).__name__ + ':', e)",
    "print('=====8<=====')",
    # Packages with a broken relationship graph, and a `p:sp` that carries no text body: what a
    # hand-edited or half-written file does to the reader.
    "def rewrite(name, edits, drops=(), base='oracle-deck.pptx'):",
    "    zin = zipfile.ZipFile(str(Path(work) / base))",
    "    with zipfile.ZipFile(str(Path(work) / name), 'w') as zout:",
    "        for item in zin.infolist():",
    "            if item.filename in drops:",
    "                continue",
    "            blob = zin.read(item.filename)",
    "            for part, find, sub in edits:",
    "                if item.filename == part:",
    "                    blob = re.sub(find, sub, blob.decode('utf-8'), count=1, flags=re.S).encode('utf-8')",
    "            zout.writestr(item, blob)",
    "    return name",
    "attempt('drop-slide-rel', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-nosliderel.pptx',",
    "    [('ppt/_rels/presentation.xml.rels', r'<Relationship[^>]*Target=\"slides/slide2.xml\"[^>]*/>', '')])))",
    "attempt('drop-slide-part', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-noslidepart.pptx', [], ('ppt/slides/slide2.xml',))))",
    "attempt('no-txbody', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-notxbody.pptx',",
    "    [('ppt/slides/slide1.xml', r'<p:txBody>.*?</p:txBody>', '')])))",
    "attempt('no-runs', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-norun.pptx',",
    "    [('ppt/slides/slide1.xml', r'<a:r>.*?</a:r>', '')], base='oracle-sub.pptx')))",
    # An `a:r` with no `a:t` child at all.
    "attempt('run-no-t', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-runnot.pptx',",
    "    [('ppt/slides/slide2.xml', r'<a:t>[^<]*</a:t>', '')], base='oracle-rich.pptx')))",
    "attempt('no-sldidlst', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-nosldidlst.pptx',",
    "    [('ppt/presentation.xml', r'<p:sldIdLst>.*?</p:sldIdLst>', '')])))",
    "attempt('empty-sldidlst', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-emptysld.pptx',",
    "    [('ppt/presentation.xml', r'<p:sldIdLst>.*?</p:sldIdLst>', '<p:sldIdLst></p:sldIdLst>')])))",
    "attempt('no-cSld', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-nocsld.pptx',",
    "    [('ppt/slides/slide1.xml', r'<p:cSld>.*?</p:cSld>', '')])))",
    "attempt('no-spTree', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-notree.pptx',",
    "    [('ppt/slides/slide1.xml', r'<p:spTree>.*?</p:spTree>', '')])))",
    # Two relationships of the same type: `part_related_by()` refuses instead of picking one.
    "attempt('two-notes', lambda: s.tool_pptx_read(rewrite(",
    "    'oracle-twonotes.pptx',",
    "    [('ppt/slides/_rels/slide1.xml.rels',",
    "      r'Target=\"../notesSlides/notesSlide1.xml\"',",
    "      'Target=\"../notesSlides/notesSlide1.xml\"/><Relationship Id=\"rId99\" '\n"
    "      'Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide\" '\n"
    "      'Target=\"../notesSlides/notesSlide1.xml\"')], base='oracle-rich.pptx')))",
    "print('=====8<=====')",
    # The argument ladder: `str()` on each bullet, `.get()` defaults, and what python-pptx's
    # text setter does to a value it cannot split.
    "attempt('title-none', lambda: s.tool_pptx_write('c1.pptx', None, []))",
    "attempt('heading-missing', lambda: s.tool_pptx_write('c2.pptx', 'T', [{'bullets': ['b']}]))",
    "attempt('heading-none', lambda: s.tool_pptx_write('c3.pptx', 'T', [{'heading': None, 'bullets': []}]))",
    "attempt('heading-int', lambda: s.tool_pptx_write('c4.pptx', 'T', [{'heading': 42, 'bullets': []}]))",
    "attempt('slide-empty-dict', lambda: s.tool_pptx_write('c5.pptx', 'T', [{}]))",
    "attempt('slides-str', lambda: s.tool_pptx_write('c6.pptx', 'T', 'abc'))",
    "attempt('slides-none-entry', lambda: s.tool_pptx_write('c7.pptx', 'T', [None]))",
    "attempt('subtitle-none', lambda: s.tool_pptx_write('c8.pptx', 'T', [{'heading': 'H', 'bullets': ['b']}], None))",
    "attempt('bullets-none-key', lambda: s.tool_pptx_write('c9.pptx', 'T', [{'heading': 'H'}]))",
    "attempt('bullets-int', lambda: s.tool_pptx_write('c10.pptx', 'T', [{'heading': 'H', 'bullets': 7}]))",
    "attempt('bullets-str', lambda: s.tool_pptx_write('c11.pptx', 'T', [{'heading': 'H', 'bullets': 'ab'}]))",
    "attempt('notes-zero', lambda: s.tool_pptx_write('c12.pptx', 'T', [{'heading': 'H', 'bullets': [], 'notes': 0}]))",
    # Bullet items go through `str()`, so a non-string becomes its Python spelling; control
    # characters are escaped by python-pptx into plain text like `_x0007_`.
    "attempt('bullet-types', lambda: s.tool_pptx_write('oracle-coerce.pptx', 'T', [",
    "    {'heading': 'Types', 'bullets': [42, True, None, 3.5, [1, 'a'], {'k': 'v'}]},",
    "    {'heading': 'Line\\nBreak', 'bullets': ['first\\nsecond', 'a\\vb', 'q\\tx'], 'notes': 'n1\\nn2'},",
    "    {'heading': 'Ctrl', 'bullets': ['\\x07bell', 'cr\\rhere', '\\x1besc']},",
    # Bullet 0 is assigned through `text_frame.text` (a newline starts a paragraph); later bullets
    # go through `paragraph.text`, where a newline is a line break inside one paragraph.
    "    {'heading': 'Later breaks', 'bullets': ['b0\\nx', 'b1\\ny', 'b2\\vy']},",
    "]))",
    "print(repr(s.tool_pptx_read('oracle-coerce.pptx')))",
    "attempt('multiline-title', lambda: s.tool_pptx_write('oracle-multi.pptx', 'Up\\nDown', [{'heading': 'H', 'bullets': ['b']}], 'S1\\nS2'))",
    "print(repr(s.tool_pptx_read('oracle-multi.pptx')))",
    # A zip that has the content types part but no package relationships at all.
    "z = zipfile.ZipFile(str(Path(work) / 'oracle-norels.pptx'), 'w')",
    "z.writestr('[Content_Types].xml',",
    "          '<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>')",
    "z.close()",
    "attempt('no-rels', lambda: s.tool_pptx_read('oracle-norels.pptx'))",
    "print('=====8<=====')",
    # The decks the unit tests stage straight into their target directory.
    "for n in ['deck', 'sub', 'nosub', 'empty', 'noslides', 'rich', 'junk', 'coerce', 'multi',",
    "            'zip', 'notpres', 'norels', 'nosliderel', 'noslidepart', 'notxbody', 'norun',",
    "            'runnot', 'nosldidlst', 'emptysld', 'nocsld', 'notree', 'twonotes']:",
    "    src_p = Path(work) / ('oracle-' + n + '.pptx')",
    "    if src_p.is_file(): shutil.copy(str(src_p), os.path.join(r'%s', src_p.name))" % fx,
    "shutil.copy(r'%s', os.path.join(r'%s', 'oracle-node.pptx'))" % (node_deck, fx),
    "print('WROTE FIXTURES')",
]

out = os.path.join(os.environ['TEMP'], 'oracle_pptx_run.py')
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(out)
