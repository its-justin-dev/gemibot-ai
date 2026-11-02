"""Probe the pandas half of `tool_excel_analyze` against the damaged workbooks.

The oracle run pinned the *messages* (`No such keys(s): 'io.excel.zip.reader'` vs
`'rId1'` vs `Excel file format cannot be determined…`) but not the condition that selects each,
and the port needs the condition.  Prints the traceback for every fixture so the rule can be read
off the library rather than guessed.  Read-only; nothing is written.
"""

import os
import traceback
from pathlib import Path

import pandas as pd

fx = str(Path(__file__).resolve().parents[2] / 'tests' / 'fixtures')

for name in [
    'corrupt-text.xlsx',
    'corrupt-empty.xlsx',
    'corrupt-zip.xlsx',
    'corrupt-ct.xlsx',
    'corrupt-nosheet.xlsx',
    'corrupt-norel.xlsx',
    'corrupt-legacy.xls',
    'corrupt-xlsb.xlsb',
    'corrupt-ods.ods',
    'corrupt-trunc.xlsx',
    'oracle-sample.xlsx',
]:
    path = os.path.join(fx, name)
    try:
        df = pd.read_excel(path)
        print('===== %s -> ok, shape=%s' % (name, df.shape))
    except Exception as e:
        print('===== %s -> %s: %s' % (name, type(e).__name__, e))
        traceback.print_exc()
    print()

print('pandas', pd.__version__)
