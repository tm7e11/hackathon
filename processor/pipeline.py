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

import base64
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()  # pick up NVIDIA_API_KEY from a local .env (Docker uses -e instead)

# --- hard-coded configuration -------------------------------------------------
RAW_DIR = Path("raw")            # input folder scanned for videos
PROCESSED_DIR = Path("processed")  # output folder for clips
CLIP_DURATION = 20               # clip length in seconds
COPY = False                     # True = fast stream-copy; False = exact re-encode
KEEP_AUDIO = False               # True = keep audio track in clips
TARGET_HEIGHT = 720              # down-scale source to this height (720p / HD)

# --- surgical-scene classification (NVIDIA VLM) -------------------------------
CLASSIFY_SURGICAL = True         # classify each clip and keep only surgical ones
FRAMES_PER_CLIP = 3              # frames sampled per clip and sent to the model
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY")
NVIDIA_INVOKE_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
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
        # Note: stream-copy cannot rescale, so TARGET_HEIGHT is ignored here.
        cmd += ["-c", "copy"]
    else:
        # Re-encode for exact clip boundaries. The segment muxer only cuts at
        # keyframes, so force one exactly every CLIP_DURATION seconds; otherwise
        # cuts snap to libx264's default GOP and clip lengths drift.
        # Down-scale to TARGET_HEIGHT (720p/HD). "-2" keeps the aspect ratio with
        # an even width; min(...,ih) prevents upscaling smaller sources.
        cmd += ["-vf", f"scale=-2:'min({TARGET_HEIGHT},ih)'",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
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


def extract_frames(clip: Path, n: int = FRAMES_PER_CLIP) -> list[bytes]:
    """Grab ``n`` JPEG frames evenly spaced across ``clip`` and return their bytes."""
    duration = probe_duration(clip)
    # Evenly spaced timestamps that avoid the exact start/end (e.g. n=3 -> 1/6, 3/6, 5/6).
    timestamps = [duration * (2 * i + 1) / (2 * n) for i in range(n)]

    frames: list[bytes] = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, t in enumerate(timestamps):
            out = Path(tmp) / f"frame_{i:02d}.jpg"
            cmd = [
                "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                "-ss", f"{t:.3f}", "-i", str(clip),
                "-frames:v", "1", "-q:v", "2", "-f", "image2", str(out),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0 or not out.exists():
                raise RuntimeError(
                    f"ffmpeg frame extraction failed for {clip} @ {t:.3f}s:\n{proc.stderr.strip()}"
                )
            frames.append(out.read_bytes())
    return frames


def frame_data_url(jpg: bytes) -> str:
    """Encode raw JPEG bytes as a base64 data URL (matches zero_shot.py)."""
    return f"data:image/jpeg;base64,{base64.b64encode(jpg).decode()}"


def is_surgical_clip(clip: Path) -> tuple[bool, str]:
    """Ask the NVIDIA VLM whether ``clip`` shows a surgical scene.

    Returns ``(is_surgical, raw_answer)``. Samples FRAMES_PER_CLIP frames and sends
    them as image_url content in a single non-streaming chat completion.
    """
    frames = extract_frames(clip)

    content: list[dict] = [
        {
            "type": "text",
            "text": (
                "These are frames sampled from one 20-second video clip. Does this "
                "clip show a surgical scene (an operation / procedure on a patient, "
                "surgical field, instruments, endoscopic/laparoscopic view)? "
                "Answer with only YES or NO."
            ),
        }
    ]
    content += [
        {"type": "image_url", "image_url": {"url": frame_data_url(f)}} for f in frames
    ]

    payload = {
        "messages": [{"role": "user", "content": content}],
        "model": NVIDIA_MODEL,
        "max_tokens": 8,
        "temperature": 0,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Accept": "application/json",
    }

    resp = requests.post(NVIDIA_INVOKE_URL, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    answer = (resp.json()["choices"][0]["message"]["content"] or "").strip()
    return ("yes" in answer.lower(), answer)


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

    classify = CLASSIFY_SURGICAL and bool(NVIDIA_API_KEY)
    if CLASSIFY_SURGICAL and not NVIDIA_API_KEY:
        sys.stderr.write(
            "NVIDIA_API_KEY not set; skipping surgical classification (keeping all clips).\n"
        )

    total_clips = ok = failed = 0
    surgical = nonsurgical = 0
    records: list[dict] = []
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
            continue

        if not classify:
            continue

        for clip in sorted(PROCESSED_DIR.glob(f"{src.stem}_*.mp4")):
            try:
                is_surgical, answer = is_surgical_clip(clip)
            except (RuntimeError, requests.RequestException, KeyError, ValueError) as exc:
                # Soft failure: keep the clip and record the error so nothing is
                # silently discarded on a transient API/ffmpeg problem.
                sys.stderr.write(f"    classify FAILED {clip.name}: {exc}\n")
                records.append({"clip": clip.name, "is_surgical": None, "raw_answer": None,
                                "error": str(exc)})
                continue

            records.append({"clip": clip.name, "is_surgical": is_surgical, "raw_answer": answer})
            if is_surgical:
                surgical += 1
                print(f"    surgical     {clip.name}  ({answer!r})")
            else:
                nonsurgical += 1
                clip.unlink()  # keep only surgical clips
                print(f"    non-surgical {clip.name}  ({answer!r}) -> removed")

    if classify:
        manifest = PROCESSED_DIR / "classifications.json"
        manifest.write_text(json.dumps(records, indent=2))
        print(f"\nDone. {ok} video(s) -> {total_clips} clip(s), "
              f"surgical: {surgical}, non-surgical removed: {nonsurgical}, "
              f"failed: {failed}. Manifest: {manifest}")
    else:
        print(f"\nDone. {ok} video(s) -> {total_clips} clip(s) in {PROCESSED_DIR}/, failed: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
