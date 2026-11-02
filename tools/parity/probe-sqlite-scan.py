"""
Second read-only oracle for `tool_sqlite_query()` (views/window_app.py:2441).

`probe-sqlite-rows.py` freezes what the tool prints for the values themselves.  This one freezes the
three things that are CPython-only and therefore cannot be inferred from SQLite:

* how `cur.execute()` decides that the text holds more than one statement — the trailing-comment,
  in-string-semicolon and `CREATE TRIGGER ... BEGIN ... END` shapes that a hand-written scanner has
  to classify exactly like `sqlite3` does;
* the `type(e).__name__: message` line for a non-string `sql` and for a string containing NUL, which
  is what `execute()` shows the model;
* the storage class Python reports for `1`, `1.0`, `1/0`, `total()` and friends, because `str()` on
  an `int` and on a `float` print differently and node hands both back as a JS `number`.

Run from the project root with:

    PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe -u tools/parity/probe-sqlite-scan.py > ../.recovered/oracle-sqlite-scan.txt
"""

import os
import re
import shutil
import sqlite3
import tempfile

FIXTURE = os.path.join("tests", "fixtures", "data-sample.db")
TMP = tempfile.mkdtemp(prefix="gemibot-sqlite-scan-")
CASE_DB = os.path.join(TMP, "case.db")


def run_tool(sql):
    """The body of `tool_sqlite_query`, minus the permission gate."""
    conn = sqlite3.connect(CASE_DB)
    try:
        cur = conn.cursor()
        cur.execute(sql)
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = cur.fetchmany(200)
            lines = [" | ".join(cols), " | ".join("---" for _ in cols)]
            for r in rows:
                lines.append(" | ".join(str(v) for v in r))
            return "\n".join(lines) + f"\n[{len(rows)} row(s)]"
        conn.commit()
        return f"Query executed successfully. Rows affected: {cur.rowcount}"
    finally:
        conn.close()


def report(label, sql):
    shutil.copyfile(FIXTURE, CASE_DB)
    print(f"\n=== {label}: {sql!r}")
    try:
        print("[out]")
        print(run_tool(sql))
    except Exception as e:
        print(f"[err] {type(e).__name__}: {e}")


# --- statement boundaries: does execute() see one statement or two? ---
SCANS = [
    "SELECT 1;",
    "SELECT 1; ",
    "SELECT 1;;",
    "SELECT 1 ; ;",
    "SELECT 1; -- hi",
    "SELECT 1; -- hi\n",
    "SELECT 1; /* hi */",
    "SELECT 1; /* hi */ SELECT 2",
    "SELECT 1;--x\nSELECT 2",
    "SELECT 1;SELECT",
    "SELECT 1; SELECT 2",
    "SELECT 1; SELECT 2; SELECT 3",
    "SELECT 'a;b'",
    "SELECT 'a;b';",
    "SELECT \"a;b\"",
    "SELECT [a;b]",
    "SELECT `a;b`",
    "SELECT 1 /* ; */",
    "SELECT ';' ",
    "SELECT 1;PRAGMA user_version",
    "PRAGMA user_version;PRAGMA user_version",
    "  ",
    "\n\n\t ",
    "-- only comment",
    "-- only comment\n",
    "/* only */",
    "/* unterminated",
    ";",
    "; ;",
    ";SELECT 1",
    "\n\t SELECT 1",
    "   ;   ",
    "INSERT INTO big (n) VALUES (1); SELECT 1",
    "CREATE TRIGGER t AFTER INSERT ON big BEGIN SELECT 1; END",
    "CREATE TRIGGER t AFTER INSERT ON big BEGIN SELECT 1; END;",
    "CREATE TRIGGER t AFTER INSERT ON big BEGIN SELECT 1; END; SELECT 2",
    "DROP TRIGGER IF EXISTS t; ",
    "SELECT 1 /* unterminated",
    'SELECT "unterminated',
    "SELECT 'unterminated",
    "SELECT 1; /* x",
    "SELECT 1; --",
    "SELECT 1; '",
    "SELECT 1; /*x*/ /*y*/",
    "SELECT 1 --x\n;",
    "SELECT 1;SELECT 1 FROM (",
    "  SELECT  1  ;  ",
    "VALUES (1)",
    "SELECT 1 UNION SELECT 2;",
    "SAVEPOINT s",
    "INSERT INTO big (n) VALUES (1); ",
    "INSERT OR IGNORE INTO users (id, name) VALUES (1, 'x')",
    "REPLACE INTO big (n) VALUES (1); ",
    ";INSERT INTO big (n) VALUES (1)",
    "-- c\nINSERT INTO big (n) VALUES (1)",
    "/* c */ SELECT 1",
    "CREATE TABLE z(a)",
    "DROP TABLE nope",
    "BEGIN",
    "COMMIT",
    "VACUUM",
    "ANALYZE",
    "CREATE INDEX ix ON big(n)",
    "DROP INDEX IF EXISTS nope",
    "CREATE VIEW v AS SELECT 1",
    "PRAGMA journal_mode=wal",
    "INSERT INTO big (n) VALUES (6) RETURNING n",
    "UPDATE big SET n=7 WHERE n=999",
    "WITH t AS (SELECT 1 AS x) INSERT INTO big (n) SELECT x FROM t",
    "SELECT 1;",
]

print("\n########## statement scanning")
for sql in SCANS:
    report(repr(sql), sql)

print("\n########## non-string sql (this is the dispatcher's Bad arguments line)")
for value in [7, None, 1.5, True, ["SELECT 1"], b"SELECT 1", {}, 1 + 2j]:
    shutil.copyfile(FIXTURE, CASE_DB)
    print(f"\n=== sql={value!r}")
    try:
        is_write = not bool(re.match(r"^\s*(SELECT|PRAGMA|EXPLAIN)\b", value, re.I))
        print("[gate] is_write =", is_write)
        print(run_tool(value))
    except Exception as e:
        print(f"[err] {type(e).__name__}: {e}")

print("\n########## sql containing a NUL byte")
for sql in ["SELECT 1\x00", "SEL\x00ECT 1", "SELECT 'a\x00b'"]:
    report(repr(sql), sql)

print("\n########## storage class: int vs float printing")
VALUES = [
    "SELECT 1",
    "SELECT 1.0",
    "SELECT 1.5",
    "SELECT -0.0",
    "SELECT CAST(-0.0 AS REAL)",
    "SELECT 0.0",
    "SELECT 1/0",
    "SELECT 3/2",
    "SELECT 4/2",
    "SELECT 1.0*1",
    "SELECT 0.1+0.2",
    "SELECT abs(-2)",
    "SELECT round(2.5)",
    "SELECT round(2.0)",
    "SELECT length('abc')",
    "SELECT hex(x'00ff')",
    "SELECT typeof(1), typeof(1.0), typeof('1'), typeof(x'01')",
    "SELECT sum(i) FROM many",
    "SELECT total(i) FROM many",
    "SELECT max(score), min(score), avg(score) FROM users",
    "SELECT count(*) FROM many",
    "SELECT 9223372036854775807",
    "SELECT -9223372036854775808",
    "SELECT 9223372036854775807 + 1",
    "SELECT 9223372036854775807 / 2",
    "SELECT 1e20",
    "SELECT 1e19",
    "SELECT 1e15",
    "SELECT 1e16",
    "SELECT 12345678901234567890",
    "SELECT CAST('12345678901234567890' AS INTEGER)",
    "SELECT CAST(1e20 AS INTEGER)",
    "SELECT CAST('1.0' AS REAL)",
    "SELECT CAST('x' AS INTEGER)",
    "SELECT CAST('x' AS REAL)",
    "SELECT 1 = 1.0",
    "SELECT '1' + 1",
    "SELECT '1' || 1",
    "SELECT 1e-7",
    "SELECT 1e-5",
    "SELECT 1e-4",
    "SELECT 0.0001",
    "SELECT 1e100",
    "SELECT 1.5e300",
    "SELECT 1.0/3.0",
    "SELECT 10e10",
    "SELECT 1.0000000000000002",
    "SELECT 123456789012345678",
    "SELECT random()*0",
    "SELECT x'4142'",
    "SELECT CAST(x'4142' AS TEXT)",
    "SELECT char(65, 66)",
    "SELECT zeroblob(3)",
    "SELECT quote('a''b'), quote(NULL), quote(1.0), quote(x'00')",
    "SELECT json_extract('{\"a\":1.0}', '$.a'), json_extract('{\"a\":2}', '$.a')",
]
for sql in VALUES:
    report("value", sql)

print("\n########## error classes for the remaining sqlite result codes")
# a malformed image: keep the header, scribble the body pages
shutil.copyfile(FIXTURE, CASE_DB)
with open(CASE_DB, "r+b") as fh:
    fh.seek(4096)
    fh.write(b"\xde\xad\xbe\xef" * 64)
print("\n=== corrupt db: SELECT count(*) FROM sqlite_master")
try:
    print(run_tool("SELECT count(*) FROM sqlite_master"))
except Exception as e:
    print(f"[err] {type(e).__name__}: {e}")
    print(f"      errcode hint: {getattr(e, 'sqlite_errorcode', 'n/a')}")

shutil.copyfile(FIXTURE, CASE_DB)
with open(CASE_DB, "wb") as fh:
    fh.write(b"SQLite format 3\x00" + b"\x00" * 4080 + b"junk")
print("\n=== short-header db: SELECT 1")
try:
    print(run_tool("SELECT 1"))
except Exception as e:
    print(f"[err] {type(e).__name__}: {e}")
    print(f"      errcode hint: {getattr(e, 'sqlite_errorcode', 'n/a')}")

print("\nsqlite3", sqlite3.sqlite_version, "module", sqlite3.version)
