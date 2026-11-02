"""Generate the voice oracle: what v1.0 prints for audio it measures and for speech it synthesizes.

`tool_voice_analyze()` answers with up to three lines before the AI reply — a byte/mime header, a
`wave` block it only reaches for a readable `.wav`, and a librosa profile it only reaches when the
whole DSP chain runs — and both optional blocks swallow their exceptions, so which fixture prints
which line is the rule the port has to reproduce.  `tool_voice_generate()` walks an engine ladder
(edge-tts, then gTTS, then pyttsx3) and names whichever engine answered.

The AI call is a fake that records the request, because the part it builds is itself parity output:
the prompt text, the mime type and the raw bytes travel to the model verbatim.

The audio fixtures are written into `tests/fixtures` as `voice-*` so the parity tests keep being
measured against the same bytes after current.v1.0 is shut down.

    # GEMI_ROOT is optional and points at the folder holding current.v1.0; it defaults to this
    # project's parent (C:/Users/ACER/Desktop/Project).
    PYTHONIOENCODING=utf-8 GEMI_ROOT="C:/Users/ACER/Desktop/Project" \
      ../current.v1.0/.venv/Scripts/python.exe tools/parity/make-voice.py
    # prints the path of the script it generated, then run that with the venv python and redirect
    # the output to ../../.recovered/oracle-voice.txt
"""

import os
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
root = os.environ.get('GEMI_ROOT', str(HERE.parent))
fx = str(HERE / 'tests' / 'fixtures')
work = os.path.join(os.environ['TEMP'], 'oracle-voice-root')

shutil.rmtree(work, ignore_errors=True)
os.makedirs(work, exist_ok=True)

src = open(os.path.join(root, 'current.v1.0', 'src', 'views', 'window_app.py'), encoding='utf-8').read()


def extract(name):
    return re.search(rf"(    def {name}\(.*?)(?=\n    def )", src, re.S).group(1)


lines = [
    "import asyncio, math, mimetypes, os, re, shutil, struct, sys, wave",
    "from pathlib import Path",
    "sys.path.insert(0, r'%s')" % os.path.join(root, 'current.v1.0', 'src'),
    "",
    "fx = r'%s'" % fx,
    "work = r'%s'" % work,
    "",
    "class ToolError(Exception):\n    pass",
    "",
    "# The request is the part that has to match, so the fake only answers and records.",
    "class FakeResponse:",
    "    def __init__(self, text):",
    "        self.text = text",
    "",
    "class FakeModels:",
    "    def __init__(self):",
    "        self.calls = []",
    "        self.reply = '  spoken words  '",
    "    def generate_content(self, model=None, contents=None):",
    "        shape = []",
    "        # `contents=[audio_part, prompt]` reaches the SDK as the list the tool built.",
    "        for part in contents:",
    "            if isinstance(part, str):",
    "                shape.append(('text', part))",
    "            elif getattr(part, 'inline_data', None) is not None:",
    "                blob = part.inline_data",
    "                shape.append(('inline', blob.mime_type, len(blob.data)))",
    "            else:",
    "                shape.append(('other', type(part).__name__))",
    "        self.calls.append((model, shape))",
    "        if isinstance(self.reply, Exception):",
    "            raise self.reply",
    "        return FakeResponse(self.reply)",
    "",
    "# `self.client.models.generate_content(...)`, the shape the tool reaches through.",
    "class FakeClient:",
    "    def __init__(self):",
    "        self.models = FakeModels()",
    "",
    "class Shim:",
    "    root = Path(r'%s')" % work,
    "    model = 'gemini-3.5-flash-lite'",
    "    def __init__(self):",
    "        self.client = FakeClient()",
    "        self.artifacts = []",
    "        self.usage = 0",
    "    def count_usage(self, resp):",
    "        self.usage += 1",
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
for name in ['tool_voice_analyze', 'tool_voice_transcribe', 'tool_voice_generate']:
    lines.append(extract(name))

lines += [
    "from google.genai import types",
    "",
    "s = Shim()",
    "",
    "def attempt(label, fn):",
    "    try:",
    "        print(label, repr(fn()))",
    "    except Exception as e:",
    "        n = type(e).__name__",
    "        print(label, ('Bad arguments: ' if n == 'TypeError' else n + ': ') + str(e))",
    "",
    "# --- the fixtures ---------------------------------------------------------------------------",
    "def wav(name, rate, width, channels, frames):",
    "    with wave.open(str(Path(work, name)), 'wb') as wf:",
    "        wf.setnchannels(channels)",
    "        wf.setsampwidth(width)",
    "        wf.setframerate(rate)",
    "        wf.writeframes(frames)",
    "",
    "def pcm(count, rate, freq, amp=0.2, width=2):",
    "    fmt = {1: 'b', 2: '<%dh', 4: '<%df'}[width]",
    "    if width == 1:",
    "        return bytes(bytearray(int(128 + 100 * math.sin(2 * math.pi * freq * i / rate))",
    "                              for i in range(count)))",
    "    if width == 4:",
    "        return struct.pack('<%df' % count, *[amp * math.sin(2 * math.pi * freq * i / rate)",
    "                                            for i in range(count)])",
    "    return struct.pack(fmt % count, *[int(32767 * amp * math.sin(2 * math.pi * freq * i / rate))",
    "                                      for i in range(count)])",
    "",
    "# One second of A440 at the default 44100 Hz: the header and every librosa number for a plain",
    "# tone, with no beat to find.",
    "wav('voice-tone.wav', 44100, 2, 1, pcm(44100, 44100, 440))",
    "",
    "# A click every half second, i.e. a 120 BPM track, so the tempo estimate has a right answer.",
    "clicks = bytearray(4 * 22050 * 2)",
    "for beat in range(8):",
    "    start = int(beat * 0.5 * 22050) * 2",
    "    for k in range(220):",
    "        val = int(30000 * math.exp(-k / 40.0) * math.sin(2 * math.pi * 1000 * k / 22050))",
    "        struct.pack_into('<h', clicks, start + k * 2, val)",
    "wav('voice-clicks.wav', 22050, 2, 1, bytes(clicks))",
    "",
    "# 8-bit stereo at another rate, because the header line prints channels and sample width.",
    "one = pcm(8000, 8000, 220, width=1)",
    "wav('voice-8bit-stereo.wav', 8000, 1, 2, one + one)",
    "wav('voice-float32.wav', 16000, 4, 1, pcm(16000, 16000, 660, width=4))",
    "wav('voice-empty.wav', 8000, 2, 1, b'')",
    "",
    "def write_bytes(name, blob):",
    "    Path(work, name).write_bytes(blob if isinstance(blob, bytes) else blob.encode())",
    "",
    "write_bytes('voice-broken.wav', 'not a wav at all')",
    "for suffix in ['.mp3', '.ogg', '.flac', '.m4a', '.aac', '.webm', '.opus']:",
    "    write_bytes('voice-fake' + suffix, 'not audio at all')",
    "write_bytes('voice-noext', 'no suffix, no mime')",
    "write_bytes('voice-note.txt', 'a text file handed to the audio tool')",
    "",
    "# Copied before the cases run: `tool_voice_generate()` writes over whatever path it is handed.",
    "KEEP = ['voice-tone.wav', 'voice-clicks.wav', 'voice-8bit-stereo.wav', 'voice-float32.wav',",
    "        'voice-empty.wav', 'voice-broken.wav', 'voice-noext', 'voice-note.txt',",
    "        'voice-fake.mp3', 'voice-fake.ogg', 'voice-fake.flac', 'voice-fake.m4a',",
    "        'voice-fake.aac', 'voice-fake.webm', 'voice-fake.opus']",
    "for n in KEEP:",
    "    shutil.copy(str(Path(work, n)), os.path.join(fx, n))",
    "",
    "AUDIO = KEEP",
    "for name in AUDIO:",
    "    attempt(name, lambda name=name: s.tool_voice_analyze(name))",
    "    print(name, 'request', s.client.models.calls[-1])",
    "print('=====8<=====')",
    "# The default prompt is part of the request; a transcribe is the same tool with another one.",
    "s.tool_voice_transcribe('voice-tone.wav')",
    "print('transcribe default request', s.client.models.calls[-1])",
    "s.tool_voice_transcribe('voice-tone.wav', language='fr')",
    "print('transcribe fr request', s.client.models.calls[-1])",
    "s.tool_voice_analyze('voice-tone.wav', prompt='  spaced  ')",
    "print('prompt kept verbatim', s.client.models.calls[-1][1][1])",
    "print('=====8<=====')",
    "# An empty reply and a failing client, since both become user-visible text.",
    "s.client.models.reply = None",
    "attempt('reply None', lambda: s.tool_voice_analyze('voice-tone.wav'))",
    "s.client.models.reply = RuntimeError('boom')",
    "attempt('reply raises', lambda: s.tool_voice_analyze('voice-tone.wav'))",
    "s.client.models.reply = '  spoken words  '",
    "print('=====8<=====')",
    "# The engine ladder.  A module set to None in `sys.modules` makes its import raise the same",
    "# ImportError the engine would raise when it is not installed, which is how rungs two and",
    "# three are reached without uninstalling anything.  Each rung's file is copied straight away,",
    "# because the next rung writes over the same name only if it is given the same one.",
    "attempt('generate edge', lambda: s.tool_voice_generate('hello parity', 'voice-edge.mp3'))",
    "shutil.copy(str(Path(work, 'voice-edge.mp3')), os.path.join(fx, 'voice-edge.mp3'))",
    "sys.modules['edge_tts'] = None",
    "attempt('generate gtts', lambda: s.tool_voice_generate('hello parity', 'voice-gtts.mp3'))",
    "if Path(work, 'voice-gtts.mp3').exists():",
    "    shutil.copy(str(Path(work, 'voice-gtts.mp3')), os.path.join(fx, 'voice-gtts.mp3'))",
    "sys.modules['gtts'] = None",
    "sys.modules['pyttsx3'] = None",
    "attempt('generate none', lambda: s.tool_voice_generate('hello parity', 'voice-none.mp3'))",
    "print('none rung left a file:', Path(work, 'voice-none.mp3').exists())",
    "print('=====8<=====')",
    "attempt('nope.wav', lambda: s.tool_voice_analyze('nope.wav'))",
    "s.allowed = lambda *a: False",
    "attempt('generate denied', lambda: s.tool_voice_generate('x', 'voice-denied.mp3'))",
    "print('denied left a file:', Path(work, 'voice-denied.mp3').exists())",
    "",
    "# `voice-edge.mp3` is what a real edge-tts run leaves behind, and whether librosa can read it",
    "# is an answer the port cannot invent.",
    "attempt('analyze voice-edge.mp3', lambda: s.tool_voice_analyze('voice-edge.mp3'))",
    "print('WROTE FIXTURES')",
]

out = os.path.join(os.environ['TEMP'], 'oracle_voice_run.py')
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(out)
