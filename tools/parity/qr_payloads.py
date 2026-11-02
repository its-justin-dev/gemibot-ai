"""The payloads both QR probes walk, so the frozen fixture's chunk data and its penalties line up."""

PAYLOADS = [
    "",
    "a",
    "hello world",
    "12345",
    "HELLO WORLD",
    "https://example.com/",
    "x" * 20,
    "h\u00e9llo w\u00f6rld \u65e5\u672c\u8a9e",
    "01234567890123456789",
    "AB12 $%*+-./:",
    "MiXeD CaSe 42!",
    "\n\t",
    "emoji \U0001f600",
    "a\x00b",
    "x" * 80,
    "0123456789" * 40,
    "https://example.com/" + "y" * 200,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" * 4,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ" * 6,
    "0123456789" * 6,
    "HELLO WORLD 12345",
    "aB3" * 30,
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor "
    "incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud "
    "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
    # Chunk-boundary cases: with 20 bytes or fewer the patterns are anchored, and Python's `$`
    # also matches before a single trailing newline, so the split lands on the newline.
    "1234567890123456789\n",
    "\n1234567890123456789",
    "1" * 21,
    "1" * 20 + "a" + "1" * 20,
    "12345678901234567890\n\n",
    "ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789",
    "\U0001f600" * 8,
    "0" * 20 + "\U0001f600",
    "https://example.com/012345678901234567890123456789",
    "HELLO12345678901234567890123456789" + "world",
]
