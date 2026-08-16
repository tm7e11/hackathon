#!/usr/bin/env python3
"""Split every video in raw/ into fixed-length clips (audio stripped) in processed/.

Self-contained deploy pipeline with everything hard-coded: it scans the RAW_DIR
folder, measures each video's total length, and cuts it into back-to-back
CLIP_DURATION-second clips written to PROCESSED_DIR. No arguments, no database,
no caption metadata -- boundaries come purely from the clip duration.

    python pipeline.py          # raw/ -> processed/, 20s clips, audio stripped

Output name: ``<input-stem>_000.mp4``, ``<input-stem>_001.mp4``, ...

The default re-encodes (libx264) and forces a keyframe every CLIP_DURATION
seconds so clip boundaries are exact. Set COPY = True for a fast, lossless
stream-copy instead (boundaries then snap to keyframes and can drift by a GOP).
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
from pathlib import Path

# --- hard-coded configuration -------------------------------------------------
RAW_DIR = Path("raw")            # input folder scanned for videos
PROCESSED_DIR = Path("processed")  # output folder for clips
CLIP_DURATION = 20               # clip length in seconds
COPY = False                     # True = fast stream-copy; False = exact re-encode
KEEP_AUDIO = False               # True = keep audio track in clips
# -----------------------------------------------------------------------------

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv", ".mpg", ".mpeg"}


def probe_duration(path: Path) -> float:
    """Return the total duration of a video in seconds via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path}:\n{proc.stderr.strip()}")
    out = proc.stdout.strip()
    try:
        return float(out)
    except ValueError as exc:  # e.g. "N/A" for streams without a known duration
        raise RuntimeError(f"could not parse duration {out!r} for {path}") from exc


def split_video(src: Path, out_dir: Path) -> int:
    """Cut ``src`` into CLIP_DURATION-second clips under ``out_dir``. Returns clip count."""
    pattern = str(out_dir / f"{src.stem}_%03d.mp4")

    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src)]
    if not KEEP_AUDIO:
        cmd += ["-an"]  # drop audio
    if COPY:
        # Stream copy: fast and lossless, but boundaries snap to keyframes.
        cmd += ["-c", "copy"]
    else:
        # Re-encode for exact clip boundaries. The segment muxer only cuts at
        # keyframes, so force one exactly every CLIP_DURATION seconds; otherwise
        # cuts snap to libx264's default GOP and clip lengths drift.
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-force_key_frames", f"expr:gte(t,n_forced*{CLIP_DURATION})"]
    cmd += [
        "-f", "segment",
        "-segment_time", str(CLIP_DURATION),
        "-reset_timestamps", "1",
        "-movflags", "+faststart",
        pattern,
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {src}:\n{proc.stderr.strip()}")

    return len(sorted(out_dir.glob(f"{src.stem}_*.mp4")))


def main() -> int:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        sys.stderr.write("ffmpeg/ffprobe not found on PATH.\n")
        return 1

    if not RAW_DIR.is_dir():
        sys.stderr.write(f"Input folder not found: {RAW_DIR}/\n")
        return 1

    videos = sorted(
        p for p in RAW_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    )
    if not videos:
        print(f"No videos found under {RAW_DIR}/")
        return 0

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Found {len(videos)} video(s) under {RAW_DIR}/ -> {PROCESSED_DIR}/ "
          f"({'copy' if COPY else 're-encode'}, {CLIP_DURATION}s clips)")

    total_clips = ok = failed = 0
    for i, src in enumerate(videos, 1):
        try:
            duration = probe_duration(src)
            expected = max(1, math.ceil(duration / CLIP_DURATION))
            print(f"[{i}/{len(videos)}] {src.name}: {duration:.1f}s -> ~{expected} clips")
            n = split_video(src, PROCESSED_DIR)
            total_clips += n
            ok += 1
        except RuntimeError as exc:
            sys.stderr.write(f"[{i}/{len(videos)}] FAILED {src.name}: {exc}\n")
            failed += 1

    print(f"\nDone. {ok} video(s) -> {total_clips} clip(s) in {PROCESSED_DIR}/, failed: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
