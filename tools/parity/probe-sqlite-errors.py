"""
Third read-only oracle for `tool_sqlite_query()`: which Python exception class each SQLite result
code lands on.

`execute()` lets `sqlite3` errors escape as `type(e).__name__: str(e)`, so the class name is part of
the printed line.  Node's `node:sqlite` hands back the same engine messages plus a numeric
`errcode`, so this dumps `class | errorcode | message` for every failure the tool can actually reach
and the port maps the code to the class.

Run from the project root with:

    PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe -u tools/parity/probe-sqlite-errors.py > ../.recovered/oracle-sqlite-errors.txt
"""

import os
import shutil
import sqlite3
import tempfile
import traceback

FIXTURE = os.path.join("tests", "fixtures", "data-sample.db")
TMP = tempfile.mkdtemp(prefix="gemibot-sqlite-err-")
CASE_DB = os.path.join(TMP, "case.db")


def tool(db_path, sql):
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(sql)
        if cur.description:
            return f"[rows] {len(cur.fetchmany(3))}"
        conn.commit()
        return f"[ok] rowcount={cur.rowcount}"
    finally:
        conn.close()


def show(label, sql, path=None, hold=None):
    """Print one line per failure: class, numeric code, engine message."""
    print(f"\n--- {label}")
    target = path if path else CASE_DB
    if not path:
        shutil.copyfile(FIXTURE, CASE_DB)
    other = None
    try:
        if hold:
            # a second connection that keeps an exclusive lock on the file
            other = sqlite3.connect(CASE_DB)
            other.isolation_level = None
            other.execute(hold)
        print("     ", tool(target, sql))
    except Exception as e:
        code = getattr(e, "sqlite_errorcode", None)
        errstr = getattr(e, "sqlite_errmsg", None)
        print(f"      {type(e).__name__} | code={code} | errmsg={errstr!r} | str={str(e)!r}")
    finally:
        if other:
            other.close()


print("python sqlite3", sqlite3.sqlite_version, "errorcode attribute:", hasattr(sqlite3.Error, "sqlite_errorcode"))

show("no-such-table (SQLITE_ERROR)", "SELECT * FROM nope")
show("syntax (SQLITE_ERROR)", "SEL 1")
show("unrecognized-token (SQLITE_ERROR)", "SELECT 'unterminated")
show("no-such-column (SQLITE_ERROR)", "SELECT [a;b]")
show("no-such-function (SQLITE_ERROR)", "SELECT nope(1)")
show("no-such-collation (SQLITE_ERROR)", "SELECT 1 ORDER BY 1 COLLATE nope")
show("table-exists (SQLITE_ERROR)", "CREATE TABLE users (a)")
show("no-table-drop (SQLITE_ERROR)", "DROP TABLE nope")
show("commit-no-txn (SQLITE_ERROR)", "COMMIT")
show("unique (SQLITE_CONSTRAINT)", "INSERT INTO users (id, name) VALUES (1, 'dup')")
show("not-null (SQLITE_CONSTRAINT)", "INSERT INTO big (n) VALUES (NULL)")
show("pk-violation (SQLITE_CONSTRAINT)", "UPDATE big SET n = 5 WHERE n = 0")
show("datatype (SQLITE_CONSTRAINT)", "INSERT INTO users (rowid, name) VALUES ('text', 'x')")
show("trigger-raise-abort (SQLITE_CONSTRAINT)", "SELECT 1")
show("toobig (SQLITE_TOOBIG)", "SELECT zeroblob(9223372036854775807)")
os.makedirs(os.path.join(TMP, "adir"), exist_ok=True)
junk0 = os.path.join(TMP, "junk.db")
with open(junk0, "wb") as fh:
    fh.write(b"this is not a database at all\n" * 5)
show("cantopen-dir (SQLITE_CANTOPEN)", "SELECT 1", path=os.path.join(TMP, "adir"))
show("notadb (SQLITE_NOTADB)", "SELECT 1", path=os.path.join(TMP, "junk.db"))
show("busy (SQLITE_BUSY)", "SELECT count(*) FROM users", hold="BEGIN EXCLUSIVE")
show("insert-under-lock (SQLITE_BUSY)", "INSERT INTO big (n) VALUES (4242)", hold="BEGIN EXCLUSIVE")

# a truncated image: the row pages are gone, so the b-tree walk fails
trunc = os.path.join(TMP, "trunc.db")
shutil.copyfile(FIXTURE, trunc)
with open(trunc, "r+b") as fh:
    fh.truncate(12288)
show("malformed (SQLITE_CORRUPT)", "SELECT count(*) FROM many", path=trunc)
show("malformed-2 (SQLITE_CORRUPT)", "SELECT * FROM users", path=trunc)

# rewrite the rootpage of a table so the walker lands on a garbage page
bad = os.path.join(TMP, "root.db")
shutil.copyfile(FIXTURE, bad)
conn = sqlite3.connect(bad)
root = conn.execute("SELECT rootpage FROM sqlite_master WHERE name='users'").fetchone()[0]
conn.close()
with open(bad, "r+b") as fh:
    # sqlite_master row for `users` lives on page 1; point its rootpage at page 99 (past EOF)
    data = bytearray(open(bad, "rb").read())
    needle = f"users\x0b\x02{root}".encode("utf-8", "surrogateescape")
    idx = bytes(data).find(b"users")
    print("\n--- page1 offset of 'users':", idx, "rootpage:", root, "needle found:", idx >= 0)

print("\n--- mismatch (SQLITE_MISMATCH) direct")
try:
    raise sqlite3.InterfaceError("x")
except Exception as e:
    print("      ", type(e).__name__)

print("\n--- attach a non-database file")
shutil.copyfile(FIXTURE, CASE_DB)
junk = os.path.join(TMP, "notdb.db")
with open(junk, "wb") as fh:
    fh.write(b"this is not a database at all\n" * 5)
try:
    conn = sqlite3.connect(CASE_DB)
    try:
        conn.execute(f"ATTACH DATABASE {junk!r} AS j")
        print("      attached ok")
    except Exception as e:
        print(f"      {type(e).__name__} | code={getattr(e, 'sqlite_errorcode', None)} | str={str(e)!r}")
    finally:
        conn.close()
except Exception as e:
    print(f"      connect {type(e).__name__}: {e}")

print("\n--- vacuum into an unusable path")
shutil.copyfile(FIXTURE, CASE_DB)
try:
    print("     ", tool(CASE_DB, "VACUUM INTO 'z:/nope/nope.db'"))
except Exception as e:
    print(f"      {type(e).__name__} | code={getattr(e, 'sqlite_errorcode', None)} | str={str(e)!r}")

print("\n--- recursive trigger depth")
shutil.copyfile(FIXTURE, CASE_DB)
try:
    conn = sqlite3.connect(CASE_DB)
    conn.execute("PRAGMA recursive_triggers=ON")
    conn.execute(
        "CREATE TRIGGER r1 AFTER INSERT ON big BEGIN INSERT INTO big (n) VALUES (NEW.n + 1); END"
    )
    conn.commit()
    try:
        conn.execute("INSERT INTO big (n) VALUES (1)")
        conn.commit()
        print("      insert ok")
    except Exception as e:
        print(f"      {type(e).__name__} | code={getattr(e, 'sqlite_errorcode', None)} | str={str(e)!r}")
    finally:
        conn.close()
except Exception as e:
    print(f"      setup {type(e).__name__}: {e}")

print("\n--- wrong number of bound params (SQLITE_RANGE)")
shutil.copyfile(FIXTURE, CASE_DB)
try:
    conn = sqlite3.connect(CASE_DB)
    try:
        conn.execute("INSERT INTO big (n) VALUES (?)", (1, 2))
        print("      bound ok")
    except Exception as e:
        print(f"      {type(e).__name__} | code={getattr(e, 'sqlite_errorcode', None)} | str={str(e)!r}")
    finally:
        conn.close()
except Exception as e:
    print(f"      setup {type(e).__name__}: {e}")
