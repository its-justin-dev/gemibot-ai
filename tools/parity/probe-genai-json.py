"""Probe how v1.0's google-genai pydantic models serialize the session.json contents field."""

import json
import sys
from google import genai
from google.genai import types

sys.stdout.reconfigure(encoding="utf-8")

print("sdk version:", getattr(genai, "__version__", "unknown"))

print("Content fields:", list(types.Content.model_fields))
print("Part fields:", list(types.Part.model_fields))
print("FunctionCall fields:", list(types.FunctionCall.model_fields))
print("FunctionResponse fields:", list(types.FunctionResponse.model_fields))
print("Blob fields:", list(types.Blob.model_fields))

samples = [
    types.Content(role="user", parts=[types.Part(text="hello\nworld")]),
    types.Content(role="user", parts=[types.Part(text='quotes " back\\slash üñî 😀')]),
    types.Content(
        role="model",
        parts=[
            types.Part(text="thinking ", thought=True),
            types.Part(text="answer"),
        ],
    ),
    types.Content(
        role="model",
        parts=[types.Part(function_call=types.FunctionCall(id="abc", name="read_file", args={"path": "a.txt", "n": 3}))],
    ),
    types.Content(
        role="model",
        parts=[types.Part(function_call=types.FunctionCall(name="list_files", args={}))],
    ),
    types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(
                    id="abc", name="read_file", response={"error": "boom", "n": 1.5, "flag": True, "nil": None}
                )
            )
        ],
    ),
    types.Content(role="user", parts=[types.Part(inline_data=types.Blob(display_name="x.png", mime_type="image/png", data=b"\x00\x01\xff"))]),
    types.Content(role="model", parts=[]),
    types.Content(parts=[types.Part(text="no role")]),
]

for i, sample in enumerate(samples):
    dumped = sample.model_dump_json(exclude_none=True)
    print(f"--- sample {i}: {dumped}")
    round_tripped = types.Content.model_validate_json(dumped)
    print(f"    re-dump identical: {round_tripped.model_dump_json(exclude_none=True) == dumped}")
    print(f"    default dump too : {sample.model_dump_json()}")

whole = json.dumps({"contents": [s.model_dump_json(exclude_none=True) for s in samples[:2]], "todos": [{"content": "ü", "status": "pending"}]})
print("--- json.dumps wrapper:", whole)
print("--- separators default:", json.dumps({"a": 1, "b": [1, 2]}))
print("--- floats:", json.dumps({"x": 1.0, "y": 0.125, "z": 1e40, "w": -0.0, "i": 3}))
