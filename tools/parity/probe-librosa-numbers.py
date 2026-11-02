"""Dump librosa's intermediates for the four voice fixtures so the pure-TS port can be checked
stage by stage instead of only at the final printed line.

Read-only: nothing is written, no file is modified, the v1.0 tree is never touched.

    PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe tools/parity/probe-librosa-numbers.py

Output is promoted to ``.recovered/oracle-librosa.txt`` and the numbers that matter are frozen
into ``tests/unit/parity-voice.test.ts`` as literals, so the suite keeps its bite after v1.0 is
shut down.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import librosa  # noqa: E402
import librosa.onset as onset  # noqa: E402
import scipy.stats  # noqa: E402

NAMES = ["voice-tone.wav", "voice-clicks.wav", "voice-8bit-stereo.wav", "voice-float32.wav"]


def report(name):
    path = os.path.join(FIXTURES, name)
    print("=== " + name)

    with sf.SoundFile(path) as handle:
        native_sr = handle.samplerate
        channels = handle.channels
        encoding = handle.subtype
        raw2d = handle.read(-1, dtype=np.float32, always_2d=True)
    print("sf: sr=%d channels=%d subtype=%s read_dtype=%s shape=%s" %
          (native_sr, channels, encoding, raw2d.dtype, raw2d.shape))
    print("sf head: " + repr(raw2d[:4].tolist()))

    y, sr = librosa.load(path, sr=None)
    print("load: dtype=%s shape=%s head=%s" % (y.dtype, y.shape, repr(y[:4].tolist())))
    dur = librosa.get_duration(y=y, sr=sr)
    rms = float(np.sqrt(np.mean(y ** 2)))
    zcrate = librosa.feature.zero_crossing_rate(y)
    zcr = float(np.mean(zcrate))
    print("dur=%r rms=%r zcr=%r" % (dur, rms, zcr))

    env = onset.onset_strength(y=y, sr=sr, hop_length=512, aggregate=np.median)
    print("env: dtype=%s shape=%s any=%s max=%r sum=%r" %
          (env.dtype, env.shape, bool(env.any()), float(env.max()), float(env.sum())))

    win_length = librosa.time_to_frames(8.0, sr=sr, hop_length=512).item()
    print("win_length=%r type=%s" % (win_length, type(win_length).__name__))
    tg = librosa.feature.tempogram(onset_envelope=env, sr=sr, hop_length=512, win_length=win_length)
    print("tg: dtype=%s shape=%s" % (tg.dtype, tg.shape))
    tg_mean = np.mean(tg, axis=-1, keepdims=True)
    bpms = librosa.tempo_frequencies(win_length, hop_length=512, sr=sr)
    logprior = -0.5 * ((np.log2(bpms) - np.log2(120)) / 1.0) ** 2
    max_idx = int(np.argmax(bpms < 320.0))
    logprior[:max_idx] = -np.inf
    score = np.log1p(1e6 * tg_mean) + logprior[:, np.newaxis]
    best = int(np.argmax(score, axis=-2).item())
    print("max_idx=%d best_lag=%d bpm=%r" % (max_idx, best, float(bpms[best])))
    top = np.argsort(score[:, 0], kind="stable")[::-1][:4]
    print("top lags=%s scores=%s" % (repr(top.tolist()), repr([float(score[k, 0]) for k in top.tolist()])))

    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    print("beat_track: tempo=%r beats=%r" % (float(np.asarray(tempo).flat[0]), beats[:6].tolist()))


for fixture_name in NAMES:
    report(fixture_name)

print("=== soundfile subformat table")
for name in NAMES:
    info = sf.info(os.path.join(FIXTURES, name))
    print(name, info.format, info.subtype, info.samplerate, info.channels, info.frames, info.encoding)

print("PROBE DONE")
