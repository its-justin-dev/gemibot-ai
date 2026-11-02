"""Generate src/shared/constants/tool-definitions.ts from tests/fixtures/v1-tool-schemas.json.

The fixture was captured from `configs/tool_schemas.py` itself, so generating from
it removes any chance of a mistyped description, `required` list or property order.
Run after `dump-v1-fixtures.py`, then `npx prettier --write` on the output.
"""

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "v1-tool-schemas.json"
OUT = ROOT / "src" / "shared" / "constants" / "tool-definitions.ts"

GROUPS = [
    "READ_TOOLS",
    "WRITE_TOOLS",
    "IMAGE_READ_TOOLS",
    "IMAGE_WRITE_TOOLS",
    "DOCX_READ_TOOLS",
    "DOCX_WRITE_TOOLS",
    "EXCEL_READ_TOOLS",
    "EXCEL_WRITE_TOOLS",
    "PDF_PPTX_READ_TOOLS",
    "PDF_PPTX_WRITE_TOOLS",
    "VOICE_READ_TOOLS",
    "VOICE_WRITE_TOOLS",
    "VIDEO_READ_TOOLS",
    "VIDEO_WRITE_TOOLS",
    "DATA_UTIL_READ_TOOLS",
    "DATA_UTIL_WRITE_TOOLS",
    "GROUNDING_TOOLS",
]

TYPE_EXPR = {"STRING": "STR", "INTEGER": "INT", "BOOLEAN": "BOOL", "NUMBER": "NUM"}


def ts_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def ts_list(items) -> str:
    return "[" + ", ".join(ts_str(i) for i in items) + "]"


IDENTIFIER_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def key_expr(name: str) -> str:
    """Bare identifier when possible, quoted otherwise."""
    return name if IDENTIFIER_RE.match(name) else ts_str(name)


def emit_schema(node: dict) -> str:
    kind = node["type"]
    if kind == "OBJECT" and "properties" in node:
        # v1.0 builds these nested records with types.Schema(...) directly.
        props = ", ".join(f"{k}: {emit_schema(v)}" for k, v in node["properties"].items())
        parts = ["type: 'OBJECT'"]
        if props:
            parts.append(f"properties: {{ {props} }}")
        if node.get("required") is not None:
            parts.append(f"required: {ts_list(node['required'])}")
        return "{ " + ", ".join(parts) + " }"

    args = [TYPE_EXPR.get(kind, ts_str(kind))]
    has_desc = node.get("description") is not None
    if has_desc:
        args.append(ts_str(node["description"]))
    kw = []
    if "items" in node:
        kw.append(f"items: {emit_schema(node['items'])}")
    if "properties" in node:
        props = ", ".join(f"{k}: {emit_schema(v)}" for k, v in node["properties"].items())
        kw.append(f"properties: {{ {props} }}")
    if node.get("required") is not None:
        kw.append(f"required: {ts_list(node['required'])}")
    if kw:
        # S() takes the description positionally, so an omitted one must be
        # passed as `undefined` or the keyword dict lands in its place.
        if not has_desc:
            args.append("undefined")
        args.append("{ " + ", ".join(kw) + " }")
    return f"S({', '.join(args)})"


def emit_decl(node: dict) -> str:
    params = node["parameters"]
    props = ", ".join(f"{k}: {emit_schema(v)}" for k, v in params["properties"].items())
    required = ts_list(params.get("required") or [])
    return (
        f"decl({ts_str(node['name'])}, {ts_str(node['description'])}, "
        f"{{ {props} }}, {required})"
    )


def main() -> None:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))

    chunks = []
    for group in GROUPS:
        decls = ",\n    ".join(emit_decl(d) for d in data[group])
        chunks.append(f"export const {group}: ToolDecl[] = [\n    {decls},\n]")

    icons = "\n".join(f"  {key_expr(k)}: {ts_str(v)}," for k, v in data["TOOL_ICONS"])
    catalog = ",\n    ".join(f"[{ts_str(n)}, {ts_str(d)}]" for n, d in data["FUNCTION_CATALOG"])

    read_names = data["GROUPS"]["ALL_READ_DECLARATIONS"]
    write_names = data["GROUPS"]["ALL_WRITE_DECLARATIONS"]

    source = PRELUDE + "\n\n".join(chunks) + f"""

export const ALL_READ_DECLARATIONS: ToolDecl[] = [
  ...READ_TOOLS,
  ...IMAGE_READ_TOOLS,
  ...DOCX_READ_TOOLS,
  ...EXCEL_READ_TOOLS,
  ...PDF_PPTX_READ_TOOLS,
  ...VOICE_READ_TOOLS,
  ...VIDEO_READ_TOOLS,
  ...DATA_UTIL_READ_TOOLS,
  ...GROUNDING_TOOLS,
]

export const ALL_WRITE_DECLARATIONS: ToolDecl[] = [
  ...WRITE_TOOLS,
  ...IMAGE_WRITE_TOOLS,
  ...DOCX_WRITE_TOOLS,
  ...EXCEL_WRITE_TOOLS,
  ...PDF_PPTX_WRITE_TOOLS,
  ...VOICE_WRITE_TOOLS,
  ...VIDEO_WRITE_TOOLS,
  ...DATA_UTIL_WRITE_TOOLS,
]

export const ALL_DECLARATIONS: ToolDecl[] = [...ALL_READ_DECLARATIONS, ...ALL_WRITE_DECLARATIONS]

export const WRITE_NAMES: Set<string> = new Set(ALL_WRITE_DECLARATIONS.map((d) => d.name))

export const FUNCTION_CATALOG: [string, string][] = [
    {catalog},
]

export const FUNCTION_TOOL_MAP: Record<string, ToolDecl[]> = {{
  all: ALL_DECLARATIONS,
  build: ALL_DECLARATIONS,
  plan: ALL_READ_DECLARATIONS,
  read: ALL_READ_DECLARATIONS,
  image_reader: [...READ_TOOLS, ...IMAGE_READ_TOOLS],
  image_generator_uhd: [...READ_TOOLS, ...IMAGE_READ_TOOLS, ...IMAGE_WRITE_TOOLS],
  docx_management: [...READ_TOOLS, ...DOCX_READ_TOOLS, ...DOCX_WRITE_TOOLS],
  excel_management: [...READ_TOOLS, ...EXCEL_READ_TOOLS, ...EXCEL_WRITE_TOOLS],
  pdf_management: [...READ_TOOLS, ...PDF_PPTX_READ_TOOLS, ...PDF_PPTX_WRITE_TOOLS],
  pptx_management: [...READ_TOOLS, ...PDF_PPTX_READ_TOOLS, ...PDF_PPTX_WRITE_TOOLS],
  voice_analyzer: [...READ_TOOLS, ...VOICE_READ_TOOLS],
  voice_generator: [...READ_TOOLS, ...VOICE_READ_TOOLS, ...VOICE_WRITE_TOOLS],
  video_reader: [...READ_TOOLS, ...VIDEO_READ_TOOLS, ...VIDEO_WRITE_TOOLS],
  data_sql: [...READ_TOOLS, ...DATA_UTIL_READ_TOOLS, ...DATA_UTIL_WRITE_TOOLS],
  search_grounding: [...READ_TOOLS, ...GROUNDING_TOOLS],
  map_grounding: [...READ_TOOLS, ...GROUNDING_TOOLS],
}}

export const TOOL_ICONS: Record<string, string> = {{
{icons}
}}
"""
    OUT.write_text(source, encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")


PRELUDE = '''/**
 * Port of `src/configs/tool_schemas.py`.
 *
 * GENERATED by `tools/parity/generate-tool-definitions.py` from
 * `tests/fixtures/v1-tool-schemas.json`, which was dumped from v1.0 itself.
 * Regenerate that fixture and re-run the generator instead of editing the
 * declaration bodies by hand.
 *
 * v1.0 builds these with `types.Schema` / `types.FunctionDeclaration` from the
 * Python SDK. This file holds the data only, as plain objects, because
 * `src/shared/**` is compiled into the renderer bundle and must stay free of the
 * AI SDK; `src/main/configs/tool-schemas.ts` turns the specs into real
 * `FunctionDeclaration` objects when a request is built.
 *
 * Descriptions, parameter names, property order, `required` lists and icon
 * values are exact copies of v1.0 — they are part of what the model sees, so a
 * reworded description would break output parity.
 */

/** Mirrors the `types.Type` members v1.0 uses. */
export type SchemaTypeName = 'STRING' | 'INTEGER' | 'BOOLEAN' | 'NUMBER' | 'ARRAY' | 'OBJECT'

export const STR: SchemaTypeName = 'STRING'
export const INT: SchemaTypeName = 'INTEGER'
export const BOOL: SchemaTypeName = 'BOOLEAN'
export const NUM: SchemaTypeName = 'NUMBER'

export interface SchemaSpec {
  type: SchemaTypeName
  description?: string
  items?: SchemaSpec
  properties?: Record<string, SchemaSpec>
  required?: string[]
}

export interface ToolDecl {
  name: string
  description: string
  parameters: SchemaSpec
}

/** Port of `AppConstants.S(kind, desc, **kw)`. */
export function S(
  kind: SchemaTypeName,
  desc?: string,
  kw?: Pick<SchemaSpec, 'items' | 'properties' | 'required'>,
): SchemaSpec {
  return { type: kind, description: desc, ...kw }
}

/** Port of `AppConstants.decl(name, desc, props, required=())`. */
export function decl(
  name: string,
  description: string,
  props: Record<string, SchemaSpec>,
  required: string[] = [],
): ToolDecl {
  return {
    name,
    description,
    parameters: { type: 'OBJECT', properties: props, required: [...required] },
  }
}

'''

if __name__ == "__main__":
    main()
