"""Probe how google-genai pydantic models parse the JSON v1.0 writes into .gemibot/session.json.

Read-only. Run with the v1.0 interpreter:
  current.v1.0/.venv/Scripts/python.exe "Gemibot AI Bro/tools/parity/probe-genai-validate.py"
"""

import sys

from google.genai import types
import importlib.metadata

sys.stdout.reconfigure(encoding="utf-8")

print("sdk:", importlib.metadata.version("google-genai"))

cases = [
    '{"parts":[],"role":"user","extra_field":1}',
    "{}",
    '{"parts":[]}',
    '{"role":"user"}',
    '{"parts":[{"text":"a","unknown":9}],"role":"user"}',
    '{"parts":[{"text":5}],"role":"user"}',
    '{"parts":[{"text":"a"}],"role":"python"}',
    '{"parts":[{"text":"a"}],"role":"USER"}',
    '{"parts":[{"text":"a"}],"role":5}',
    '{"parts":[{"text":"a"}],"role":null}',
    '{"parts":[{"function_call":{"name":"f","args":{"n":1.0,"big":1e40}}}],"role":"model"}',
    '{"parts":[{"function_call":{"name":"f","args":null}}],"role":"model"}',
    '{"parts":[{"function_response":{"name":"f","response":{"a":null,"b":[1,2]}}}],"role":"user"}',
    '{"parts":[{"function_response":{"name":"f","response":"plain string"}}],"role":"user"}',
    '{"parts":[{"inline_data":{"data":"AAH_","mime_type":"image/png"}}],"role":"user"}',
    '{"parts":[{"inline_data":{"data":"a!b@","mime_type":null}}],"role":"user"}',
    '{"parts":[{"file_data":{"file_uri":"gs://x","mime_type":"text/plain"}}],"role":"user"}',
    '{"parts":[{"text":"a","thought":null}],"role":"model"}',
    '{"parts":[{"text":"a","thought":"yes"}],"role":"model"}',
    '{"parts":[{"text":"a","thought_signature":"sig"}],"role":"model"}',
    '{"parts":[{"text":"a","thought_signature":["s1","s2"]}],"role":"model"}',
    '{"parts":[{"text":"a"},"plain string"]}',
    '{"parts":[{"functionCall":{"name":"camel"}}]}',
    '{"parts":"not a list"}',
    '[{"parts":[]}]',
]

for raw in cases:
    try:
        obj = types.Content.model_validate_json(raw)
        back = obj.model_dump_json(exclude_none=True)
        stable = types.Content.model_validate_json(back).model_dump_json(exclude_none=True)
        print(f"IN  {raw}")
        print(f"OUT {back}")
        print(f"    stable={stable == back} role={obj.role!r} parts={len(obj.parts or [])}")
        if obj.parts:
            for p in obj.parts:
                known = [
                    name
                    for name in p.model_fields
                    if getattr(p, name) is not None and getattr(p, name) != []
                ]
                print(f"    part set-fields={known}")
    except Exception as exc:
        print(f"IN  {raw}")
        print(f"ERR {type(exc).__name__}: {str(exc)[:300]}")
    print()

b = types.Blob(data=b"\x00\x01\xff", display_name="x.png", mime_type="image/png")
print("blob dump:", b.model_dump_json(exclude_none=True))
nb = types.Blob.model_validate_json(b.model_dump_json(exclude_none=True))
print("blob bytes:", nb.data, type(nb.data))
weird = types.Blob.model_validate_json('{"data":"AA=="}')
print("blob minimal:", weird.model_dump_json(exclude_none=True))
try:
    pad = types.Blob.model_validate_json('{"data":"AAH"}')
    print("blob unpadded:", pad.model_dump_json(exclude_none=True), pad.data)
except Exception as exc:
    print("blob unpadded ERR", type(exc).__name__, str(exc)[:200])
try:
    alt = types.Blob.model_validate_json('{"data":"-_8="}')
    print("blob urlsafe:", alt.model_dump_json(exclude_none=True), alt.data)
except Exception as exc:
    print("blob urlsafe ERR", type(exc).__name__, str(exc)[:200])

print("Content.model_fields:", list(types.Content.model_fields))
print("Content config:", types.Content.model_config)
print("Part config:", types.Part.model_config)
print("FunctionCall config:", types.FunctionCall.model_config)
print("Blob config:", types.Blob.model_config)
print("role annotation:", types.Content.model_fields["role"])
print("parts annotation:", types.Content.model_fields["parts"])
print("thought annotation:", types.Part.model_fields["thought"])
print("thought_sig annotation:", types.Part.model_fields["thought_signature"])
print("fc args annotation:", types.FunctionCall.model_fields["args"])
print("fr response annotation:", types.FunctionResponse.model_fields["response"])
print("blob data annotation:", types.Blob.model_fields["data"])
