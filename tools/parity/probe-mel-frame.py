"""Dump the mel-dB matrix and raw power around one click frame so the pure-TS STFT can be
compared band by band.

Read-only: nothing is written, no file is modified, the v1.0 tree is never touched.

    PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe tools/parity/probe-mel-frame.py
"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import librosa  # noqa: E402

np.set_printoptions(precision=6, suppress=True, linewidth=200)

NAME = os.environ.get("PROBE_WAV", "voice-clicks.wav")
FRAMES = [int(x) for x in os.environ.get("PROBE_FRAMES", "20,21,22,23,24").split(",")]

path = os.path.join(FIXTURES, NAME)
y, sr = librosa.load(path, sr=None, mono=True)
print("%s: n=%d sr=%d dur=%.4f" % (NAME, len(y), sr, len(y) / sr))

P = np.abs(librosa.stft(y, n_fft=2048, hop_length=512)) ** 2
print("power shape", P.shape, "dtype", P.dtype)
for t in FRAMES:
    row = P[:, t]
    print("t=%d power: max=%.6g argmax=%d" % (t, row.max(), int(np.argmax(row))))
    print("      head=%s mid=%s tail=%s" % (row[:6].tolist(), row[85:91].tolist(), row[-4:].tolist()))

S = librosa.feature.melspectrogram(y=y, sr=sr, n_fft=2048, hop_length=512)
Sd = librosa.power_to_db(S)
floor = float(Sd.max() - 80.0)
print("mel shape", S.shape, "db max=%.6f floor=%.6f" % (Sd.max(), floor))
for t in FRAMES:
    above = int(np.sum(Sd[:, t] > floor + 1e-9))
    print("t=%d db: min=%.4f aboveFloor=%d" % (t, Sd[:, t].min(), above))
    print("      bands0-11=%s" % (Sd[:12, t].tolist(),))
    print("      bands12-47=%s" % (Sd[12:48, t].tolist(),))
    print("      bands96-127=%s" % (Sd[96:128, t].tolist(),))

o = librosa.onset.onset_strength(y=y, sr=sr)
print("env shape", o.shape, "dtype", o.dtype)
print("env=%s" % (o.tolist(),))
