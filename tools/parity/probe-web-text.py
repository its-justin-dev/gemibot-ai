"""Oracle for the text pipeline behind `tool_web_fetch` and `tool_search_grounding`.

The four `re.sub` lines are copied verbatim from `views/window_app.py:1610-1616` and the soup
walk from 1378-1390, so what prints here is what v1.0 answers — nothing from v2.0 is imported.
Run with v1.0's own interpreter:

    PYTHONIOENCODING=utf-8 ./current.v1.0/.venv/Scripts/python.exe "Gemibot AI Bro/tools/parity/probe-web-text.py"
"""

import html
import re

from bs4 import BeautifulSoup

WEB_FETCH_HTML = (
    "<html>\n<head><script>var a = 1;</script>\n<style>p { color: red }</style></head>\n"
    "<body>\n  <h1>Title&nbsp;&amp; more</h1>\n\n\n  <p>Two   spaces</p>\n</body>\n</html>"
)

DDG_HTML = (
    '<div class="result"><div class="result__title"><a>First  hit</a></div>'
    '<div class="result__snippet">Snippet  one</div>'
    '<div class="result__url">example.com</div></div>'
    '<div class="result"><div class="result__title"><a>Second hit</a></div>'
    '<div class="result__snippet">Snippet  two</div></div>'
    '<div class="result"><div class="result__url">no-title.example</div></div>'
)

# `<div class="result__snippet"></div>` — bs4 says an empty Tag is falsy, so the row is dropped.
DDG_EMPTY = (
    '<div class="result"><div class="result__title">Has title</div>'
    '<div class="result__snippet"></div></div>'
)

CRLF_BODY = f"{'a' * 200}\r\n" * 20_000


def web_fetch_text(raw: str) -> str:
    text = raw
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", html.unescape(text))
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def grounding_rows(markup: str):
    soup = BeautifulSoup(markup, "html.parser")
    rows = []
    for r in soup.select(".result")[:5]:
        t_elem = r.select_one(".result__title")
        s_elem = r.select_one(".result__snippet")
        u_elem = r.select_one(".result__url")
        if t_elem and s_elem:
            title = t_elem.get_text(strip=True)
            snip = s_elem.get_text(strip=True)
            link = u_elem.get_text(strip=True) if u_elem else ""
            rows.append((title, snip, link))
    return rows


print("web_fetch   =", repr(web_fetch_text(WEB_FETCH_HTML)))
print("grounding   =", grounding_rows(DDG_HTML))
print("empty tag   =", grounding_rows(DDG_EMPTY))
crlf = web_fetch_text(CRLF_BODY)
print("crlf len    =", len(crlf), "has_cr =", "\r" in crlf, "head =", repr(crlf[:8]), repr(crlf[-8:]))
print("crlf raw2m  =", len(CRLF_BODY[:2_000_000]), repr(CRLF_BODY[:2_000_000][-6:]))
