"""
Read-only oracle for the video tools: prints exactly what v1.0's `cv2.VideoCapture` reports for
every fixture in `tests/fixtures/video-*`, plus the string `tool_video_read()` (2344) builds from
those numbers.  Nothing here is shipped; it exists so the numbers in `py-cv2.ts` and in
`tests/unit/parity-tools.test.ts` can be frozen against the real OpenCV build v1.0 used.

Fixture recipe (bundled ffmpeg, kept here so the bytes can be re-made after v1.0 is retired):

    ffmpeg -f lavfi -i testsrc=size=320x240:rate=30:duration=2 -c:v libx264 -pix_fmt yuv420p video-h264-30fps.mp4
    ffmpeg -f lavfi -i testsrc=size=640x360:rate=25:duration=1 -c:v libx264 -pix_fmt yuv420p video-h264-25fps-640x360.mp4
    ffmpeg -f lavfi -i testsrc=size=176x144:rate=30000/1001:duration=1 -c:v libx264 -pix_fmt yuv420p video-h264-2997fps.mp4
    ffmpeg -f lavfi -i testsrc=size=320x240:rate=30:duration=1 -c:v libx264 -pix_fmt yuv420p video-h264.mov
    ffmpeg -f lavfi -i testsrc=size=320x240:rate=24:duration=1 -c:v libx264 -pix_fmt yuv420p video-h264.mkv
    ffmpeg -f lavfi -i testsrc=size=320x240:rate=30:duration=1 -c:v libvpx -b:v 200k video-vp8.webm
    ffmpeg -f lavfi -i testsrc=size=160x120:rate=10:duration=1 -c:v bmp -pix_fmt bgr24 video-bmp.avi
    ffmpeg -f lavfi -i testsrc=size=160x120:rate=15:duration=1 -c:v mjpeg -q:v 8 video-mjpeg.avi
    ffmpeg -f lavfi -i testsrc=size=320x240:rate=30 -frames:v 1 -c:v libx264 -pix_fmt yuv420p video-single.mp4
    head -c 3000 video-h264-30fps.mp4 > video-trunc.mp4        # mdat present, moov cut
    printf 'this is not a video...' > video-broken.mp4

Run from the project root with:
    PYTHONIOENCODING=utf-8 ../current.v1.0/.venv/Scripts/python.exe tools/parity/probe-video-numbers.py
"""  # noqa: E501

import glob
import os
import sys

import cv2
import numpy as np

FIXTURES = os.path.join("tests", "fixtures")

print("cv2", cv2.__version__)
# An audio-only MP4 opens as `0x0 px / 1.00 FPS / -1 frames`, and its read loop then never
# returns, so the metadata is printed and the frame work is skipped.
HANGS = {"video-audio-only.mp4"}
for name in sorted(glob.glob(os.path.join(FIXTURES, "video-*"))):
    cap = cv2.VideoCapture(name)
    opened = bool(cap.isOpened())
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    dur = (frames / fps) if fps > 0 else 0.0
    size = os.path.getsize(name)
    print(f"\n### {os.path.basename(name)} ({size:,} bytes) opened={opened}")
    print(f"fps={fps!r} frames={frames!r} w={w!r} h={h!r}")
    print(f"duration={dur!r} minutes={dur / 60!r}")
    print(f"line1=Video File: {os.path.basename(name)} ({size:,} bytes)")
    print(f"line2=- Resolution: {w}x{h} px")
    print(f"line3=- Frame Rate: {fps:.2f} FPS")
    print(f"line4=- Total Frames: {frames:,}")
    print(f"line5=- Duration: {dur:.2f} seconds ({dur / 60:.2f} minutes)")

    # Each stage gets its own capture because each v1.0 tool opens its own; a reused capture has
    # already walked past the last frame and reports a shorter list than the tool would.
    if os.path.basename(name) in HANGS:
        print("frames skipped: cv2 read loop does not return for this file")
        cap.release()
        continue
    total = max(1, frames)

    frame_cap = cv2.VideoCapture(name)
    n = max(2, min(6, 12))
    idxs = [int(i * (total - 1) / max(1, n - 1)) for i in range(n)]
    ok_idx = []
    jpg = []
    for i in idxs:
        frame_cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ret, frame = frame_cap.read()
        if not ret:
            continue
        enc, buf = cv2.imencode(".jpg", frame)
        if enc:
            ok_idx.append(i)
            jpg.append(len(buf.tobytes()))
    frame_cap.release()
    print(f"sample idxs={idxs} decoded={ok_idx} jpeg_sizes={jpg}")
    stamps = [f"{(i / fps if fps > 0 else 0.0):.1f}s" for i in ok_idx]
    print(f"stamps={', '.join(stamps)}")

    # tool_video_extract_frames sampling: count=8 over max(1, frames), PNG write
    m = max(1, min(8, 30))
    names = []
    frame_cap = cv2.VideoCapture(name)
    for i in range(m):
        f_idx = int(i * (total - 1) / max(1, m - 1))
        frame_cap.set(cv2.CAP_PROP_POS_FRAMES, f_idx)
        ret, _ = frame_cap.read()
        if ret:
            names.append(f"frame_{i + 1:02d}_f{f_idx}.png")
    frame_cap.release()
    print(f"extract n={m} names={names}")

    # raw frame identity for the first frame: shape, dtype and a checksum of its bytes
    frame_cap = cv2.VideoCapture(name)
    frame_cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    ret, frame = frame_cap.read()
    frame_cap.release()
    if ret:
        print(
            f"frame0 shape={frame.shape} dtype={frame.dtype} "
            f"sum={int(np.sum(frame.astype(np.int64)))} head={frame[:1, :4].tolist()}"
        )
    cap.release()
sys.stdout.flush()
