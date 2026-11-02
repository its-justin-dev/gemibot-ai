"""
Read-only oracle for `tool_sqlite_query()` (views/window_app.py:2441).

The tool prints `str(v)` for every value it fetches, so the observable text is a mix of SQLite's
own error strings and CPython's rendering of `None`, `int`, `float` and `bytes`.  Node's
`node:sqlite` runs the same engine, but its value marshalling is not identical, so every line the
tool can produce is dumped here and frozen into `tests/unit/parity-tools.test.ts`.

Nothing here is shipped.  Run from the project root with:

    PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe -u tools/parity/probe-sqlite-rows.py > ../.recovered/oracle-sqlite.txt
"""

import os
import re
import shutil
import sqlite3
import tempfile

FIXTURE = os.path.join("tests", "fixtures", "data-sample.db")

SCHEMA = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    score REAL,
    active INTEGER,
    note TEXT,
    payload BLOB
);
INSERT INTO users (id, name, score, active, note, payload) VALUES
    (1, 'Ada', 3.5, 1, NULL, x'00ff10'),
    (2, '鲍思', 7.0, 0, 'it''s ok', x'424d'),
    (3, 'O''Neil', -2.25, 1, '', NULL),
    (4, 'wide  space', 100.0, 1, 'multi' || char(10) || 'line', x'0a'),
    (5, NULL, NULL, NULL, NULL, NULL),
    (6, 'tab\there', 0.1, 1, 'b' || char(0) || 'c', x'000102');
CREATE TABLE numbers (n REAL);
INSERT INTO numbers (n) VALUES
    (0.0), (-0.0), (1.0), (0.1), (1e20), (1e-7), (0.3333333333333333),
    (1.5e300), (-3.75), (123456789.1234567);
CREATE TABLE big (n INTEGER NOT NULL);
INSERT INTO big (n) VALUES (9223372036854775807), (-9223372036854775808), (0);
CREATE TABLE weird ("a b" TEXT, "quoted" TEXT, [bracket]);
INSERT INTO weird ("a b", "quoted", [bracket]) VALUES ('x', 'y', 'z');
CREATE TABLE many (i INTEGER, label TEXT);
INSERT INTO many (i, label) VALUES (1, 'first');
"""


def build(path: str) -> None:
    """Write the fixture, then add the 250-row table with a parameter insert."""
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.executemany(
        "INSERT INTO many (i, label) VALUES (?, ?)",
        [(i, f"row{i}") for i in range(2, 251)],
    )
    conn.commit()
    conn.close()


CASES = [
    ("select-all", "SELECT * FROM users"),
    ("select-two", "SELECT id, name FROM users WHERE active = 1 ORDER BY id"),
    ("numbers", "SELECT n FROM numbers"),
    ("big", "SELECT n FROM big"),
    ("weird", "SELECT * FROM weird"),
    ("dup-names", "SELECT 1, 1"),
    ("dup-alias", 'SELECT "a b" AS x, "quoted" AS x FROM weird'),
    ("expr-names", "SELECT id, score * 2, name FROM users WHERE id = 1"),
    ("literal", "SELECT 1"),
    ("literal-aliased", "SELECT 1 AS one, 2.0, 'three'"),
    ("nulls", "SELECT NULL, NULL, NULL"),
    ("pragma", "PRAGMA table_info(users)"),
    ("pragma-integrity", "PRAGMA integrity_check"),
    ("explain", "EXPLAIN SELECT * FROM users"),
    ("cte", "WITH t AS (SELECT 1 AS x) SELECT * FROM t"),
    ("trailing-semi", "SELECT 1;"),
    ("no-table", "SELECT * FROM nope"),
    ("syntax", "SEL 1"),
    ("empty", ""),
    ("only-semi", ";"),
    ("multi", "SELECT 1; SELECT 2"),
    ("create", "CREATE TABLE tmp(a)"),
    ("drop", "DROP TABLE users"),
    ("insert", "INSERT INTO users (id, name) VALUES (99, 'new')"),
    ("insert-many", "INSERT INTO users (id, name) SELECT id + 1000, name FROM users"),
    ("update", "UPDATE users SET note = 'x'"),
    ("update-none", "UPDATE users SET note = 'x' WHERE id = 4242"),
    ("delete", "DELETE FROM users WHERE id > 3"),
    ("delete-all", "DELETE FROM users"),
    ("replace", "INSERT OR REPLACE INTO users (id, name) VALUES (1, 'replaced')"),
    ("cap-200", "SELECT * FROM many"),
    ("cap-200-count", "SELECT count(*) FROM many"),
    ("blob", "SELECT payload FROM users WHERE id = 1"),
    ("blob-literal", "SELECT X'41', typeof(X'41')"),
    ("nul-text", "SELECT 'a' || char(0) || 'b'"),
    ("version", "SELECT sqlite_version()"),
    ("unique", "INSERT INTO users (id, name) VALUES (1, 'dup')"),
    ("not-null", "INSERT INTO big (n) VALUES (NULL)"),
    ("bad-column", "INSERT INTO users (nonexistent) VALUES (1)"),
    ("already-exists", "CREATE TABLE users (a)"),
    ("datatype", "INSERT INTO users (rowid, name) VALUES ('text', 'x')"),
    ("too-big", "SELECT zeroblob(9223372036854775807)"),
    ("bad-collation", "SELECT 1 ORDER BY 1 COLLATE nope"),
    ("transaction", "BEGIN; BEGIN"),
    ("returning", "INSERT INTO users (id, name) VALUES (77, 'r') RETURNING id"),
    ("wal", "PRAGMA journal_mode=wal"),
    ("begin", "BEGIN"),
    ("commit", "COMMIT"),
    ("vacuum", "VACUUM"),
    ("analyze", "ANALYZE"),
    ("replace-keyword", "REPLACE INTO users (id, name) VALUES (1, 'rp')"),
    ("create-index", "CREATE INDEX ix ON users(name)"),
    ("drop-index", "DROP INDEX IF EXISTS nope"),
    ("create-view", "CREATE VIEW v AS SELECT 1"),
    ("with-insert", "WITH t AS (SELECT 1 AS x) INSERT INTO big (n) SELECT x FROM t"),
    ("update-cta", "UPDATE users SET name = 'x' WHERE id IN (SELECT id FROM users)"),
]


def run_tool(sql: str) -> str:
    """The body of `tool_sqlite_query`, minus the permission gate."""
    conn = sqlite3.connect(SQLITE_PATH)
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


SQLITE_PATH = ""


def report(label: str, sql: str) -> None:
    """Print the returned string (or `type(e).__name__: message`) for one statement."""
    global SQLITE_PATH
    SQLITE_PATH = os.path.join(TMP, "case.db")
    # Every case starts from the fixture: one tool call is one process, and a write case that left
    # its mutation on disk would otherwise change what the next read case prints.
    shutil.copyfile(FIXTURE, SQLITE_PATH)
    print(f"\n=== {label}: {sql!r}")
    try:
        out = run_tool(sql)
    except Exception as e:  # noqa: BLE001 - the tool lets this reach execute()'s printer
        print(f"[err] {type(e).__name__}: {e}")
        return
    print("[out]")
    print(out)


TMP = tempfile.mkdtemp(prefix="gemibot-sqlite-")
os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
build(FIXTURE)
print(f"sqlite3 {sqlite3.sqlite_version} (module {sqlite3.version})")
print(f"fixture {FIXTURE} {os.path.getsize(FIXTURE):,} bytes")

for label, sql in CASES:
    report(label, sql)

# `sqlite3.connect()` creates the file, so a path that does not exist is not an error: the tool
# answers with an empty database and SQLite's own "no such table".
missing = os.path.join(TMP, "brand-new.db")
SQLITE_PATH = missing  # the reporter reads this module-level path
print(f"\n=== missing-file: SELECT * FROM nope (path {os.path.exists(missing)} before)")
try:
    print("[out]")
    print(run_tool("SELECT * FROM nope"))
except Exception as e:  # noqa: BLE001
    print(f"[err] {type(e).__name__}: {e}")
print(f"created={os.path.exists(missing)} size={os.path.getsize(missing):,}")
with open(missing, "rb") as handle:
    print(f"magic={handle.read(16)!r}")

# A directory and a non-database file are the other two shapes the tool can be handed.
directory = os.path.join(TMP, "adir")
os.mkdir(directory)
SQLITE_PATH = directory
print("\n=== directory: SELECT 1")
try:
    print("[out]")
    print(run_tool("SELECT 1"))
except Exception as e:  # noqa: BLE001
    print(f"[err] {type(e).__name__}: {e}")

junk = os.path.join(TMP, "junk.db")
with open(junk, "wb") as handle:
    handle.write(b"this is not a database at all\n" * 3)
SQLITE_PATH = junk
print("\n=== junk-file: SELECT 1")
try:
    print("[out]")
    print(run_tool("SELECT 1"))
except Exception as e:  # noqa: BLE001
    print(f"[err] {type(e).__name__}: {e}")
print("\n=== junk-file: CREATE TABLE a(b)")
try:
    print("[out]")
    print(run_tool("CREATE TABLE a(b)"))
except Exception as e:  # noqa: BLE001
    print(f"[err] {type(e).__name__}: {e}")

shutil.rmtree(TMP, ignore_errors=True)
