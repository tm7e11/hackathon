import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.parse import urljoin

import httpx
from fastapi import Body, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pipeline import (
    CLASSIFY_SURGICAL,
    CLIP_DURATION,
    NVIDIA_API_KEY,
    is_surgical_clip,
    probe_duration,
    split_video,
)

VSS_BASE_URL = os.getenv("VSS_BASE_URL", "http://172.16.95.171:7777")
VSS_AGENT_GENERATE_URL = os.getenv(
    "VSS_AGENT_GENERATE_URL",
    "http://172.16.95.171:8000/generate",
)
VSS_UPLOAD_PATH = os.getenv("VSS_UPLOAD_PATH", "/api/v1/videos")
VSS_SEARCH_PATH = os.getenv("VSS_SEARCH_PATH", "/api/v1/search")
REQUEST_TIMEOUT_SECONDS = float(os.getenv("VSS_REQUEST_TIMEOUT_SECONDS", "120"))
UPLOAD_ROOT = Path(os.getenv("PROCESSOR_UPLOAD_ROOT", tempfile.gettempdir())) / "vss-processor-uploads"
UPSTREAM_CHUNK_SIZE_BYTES = int(os.getenv("VSS_CHUNK_SIZE_BYTES", str(10 * 1024 * 1024)))
UPLOAD_TIMESTAMP = os.getenv("VSS_UPLOAD_TIMESTAMP", "2025-01-01T00:00:00")

app = FastAPI(title="Hackathon API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "Hackathon API is running"}


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


class SearchRequest(BaseModel):
    prompt: str
    top_k: int = 5


class GenerateRequest(BaseModel):
    input_message: str


class VssCreateVideoRequest(BaseModel):
    filename: str


def build_vss_url(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return urljoin(f"{VSS_BASE_URL.rstrip('/')}/", path.lstrip("/"))


async def parse_vss_response(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return response.json()
    return {"text": response.text}


def clean_filename(filename: str | None) -> str:
    name = Path(filename or "upload.mp4").name
    return name or "upload.mp4"


def session_dir(upload_id: str) -> Path:
    return UPLOAD_ROOT / upload_id


def session_metadata_path(upload_id: str) -> Path:
    return session_dir(upload_id) / "metadata.json"


def load_session(upload_id: str) -> dict[str, Any]:
    metadata_path = session_metadata_path(upload_id)
    if not metadata_path.exists():
        raise HTTPException(status_code=404, detail=f"Upload session not found: {upload_id}")
    return json.loads(metadata_path.read_text())


def save_session(upload_id: str, data: dict[str, Any]) -> None:
    directory = session_dir(upload_id)
    directory.mkdir(parents=True, exist_ok=True)
    session_metadata_path(upload_id).write_text(json.dumps(data, indent=2))


def extract_sensor_id(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    for key in ("sensor_id", "sensorId", "sensorID", "id", "video_id", "videoId"):
        value = data.get(key)
        if value:
            return str(value)
    return None


def extract_sensor_id_from_url(url: str | None) -> str | None:
    if not url:
        return None
    parts = [part for part in str(url).split("/") if part]
    return parts[-2] if len(parts) >= 2 and parts[-1] in {"upload", "url"} else parts[-1] if parts else None


async def process_video(source_path: Path, upload_id: str) -> tuple[list[Path], dict[str, Any]]:
    output_dir = session_dir(upload_id) / "processed"
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        duration = probe_duration(source_path)
        clip_count = split_video(source_path, output_dir)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not process video: {exc}") from exc

    clips = sorted(output_dir.glob(f"{source_path.stem}_*.mp4"))
    classifications: list[dict[str, Any]] = []
    if CLASSIFY_SURGICAL and NVIDIA_API_KEY:
        kept_clips: list[Path] = []
        for clip in clips:
            try:
                is_surgical, raw_answer = is_surgical_clip(clip)
            except Exception as exc:
                classifications.append(
                    {
                        "clip": clip.name,
                        "is_surgical": None,
                        "raw_answer": None,
                        "error": str(exc),
                    }
                )
                kept_clips.append(clip)
                continue

            classifications.append(
                {
                    "clip": clip.name,
                    "is_surgical": is_surgical,
                    "raw_answer": raw_answer,
                }
            )
            if is_surgical:
                kept_clips.append(clip)
            else:
                clip.unlink(missing_ok=True)
        clips = kept_clips

    if not clips:
        # VSS still needs a media object. If classification removed every clip,
        # upload the processed clips directory fallback by preserving the source.
        fallback = output_dir / source_path.name
        shutil.copy2(source_path, fallback)
        clips = [fallback]

    manifest = {
        "source": source_path.name,
        "duration_seconds": duration,
        "clip_duration_seconds": CLIP_DURATION,
        "clip_count": clip_count,
        "uploaded_clip_count": len(clips),
        "classification_enabled": bool(CLASSIFY_SURGICAL and NVIDIA_API_KEY),
        "classifications": classifications,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return clips, manifest


async def upload_processed_video_to_vss(
    client: httpx.AsyncClient,
    video_path: Path,
    custom_params: dict[str, Any] | None,
) -> dict[str, Any]:
    create_url = build_vss_url(VSS_UPLOAD_PATH)
    create_response = await client.post(create_url, json={"filename": video_path.name})
    if create_response.is_error:
        raise HTTPException(
            status_code=create_response.status_code,
            detail=await parse_vss_response(create_response),
        )

    create_data = await parse_vss_response(create_response)
    upload_url = create_data.get("url") if isinstance(create_data, dict) else None
    if not upload_url:
        raise HTTPException(status_code=502, detail=f"VSS did not return an upload URL: {create_data}")

    upload_url = build_vss_url(upload_url)
    upload_id = str(uuid4())
    file_size = video_path.stat().st_size
    total_chunks = max(1, (file_size + UPSTREAM_CHUNK_SIZE_BYTES - 1) // UPSTREAM_CHUNK_SIZE_BYTES)
    last_chunk_data: Any = None

    with video_path.open("rb") as source:
        for index in range(total_chunks):
            chunk = source.read(UPSTREAM_CHUNK_SIZE_BYTES)
            files = {
                "mediaFile": (
                    video_path.name,
                    chunk,
                    "video/mp4",
                )
            }
            data = {
                "filename": video_path.name,
                "metadata": json.dumps({"timestamp": UPLOAD_TIMESTAMP}),
            }
            headers = {
                "nvstreamer-chunk-number": str(index + 1),
                "nvstreamer-total-chunks": str(total_chunks),
                "nvstreamer-is-last-chunk": str(index + 1 == total_chunks),
                "nvstreamer-identifier": upload_id,
                "nvstreamer-file-name": video_path.name,
            }
            chunk_response = await client.post(upload_url, data=data, files=files, headers=headers)
            if chunk_response.is_error:
                raise HTTPException(
                    status_code=chunk_response.status_code,
                    detail=await parse_vss_response(chunk_response),
                )
            last_chunk_data = await parse_vss_response(chunk_response)

    sensor_id = (
        extract_sensor_id(last_chunk_data)
        or extract_sensor_id(create_data)
        or extract_sensor_id_from_url(upload_url)
    )
    if not sensor_id:
        raise HTTPException(
            status_code=502,
            detail=f"VSS upload succeeded but no sensor id was returned: {last_chunk_data}",
        )

    complete_url = build_vss_url(f"{VSS_UPLOAD_PATH.rstrip('/')}/{sensor_id}/complete")
    complete_payload = {
        **(last_chunk_data if isinstance(last_chunk_data, dict) else {}),
        "filename": video_path.name,
    }
    if custom_params:
        complete_payload["custom_params"] = custom_params

    complete_response = await client.post(complete_url, json=complete_payload)
    if complete_response.is_error:
        raise HTTPException(
            status_code=complete_response.status_code,
            detail=await parse_vss_response(complete_response),
        )

    return {
        "sensor_id": sensor_id,
        "filename": video_path.name,
        "upload_url": upload_url,
        "chunk_response": last_chunk_data,
        "complete_response": await parse_vss_response(complete_response),
    }


@app.post("/api/v1/videos")
async def create_processor_video_upload(
    request: Request,
    payload: VssCreateVideoRequest,
) -> dict[str, Any]:
    upload_id = str(uuid4())
    filename = clean_filename(payload.filename)
    save_session(
        upload_id,
        {
            "id": upload_id,
            "filename": filename,
            "chunks": [],
            "assembled": False,
        },
    )
    upload_url = str(request.url_for("upload_processor_video_chunk", upload_id=upload_id))
    return {
        "sensor_id": upload_id,
        "id": upload_id,
        "url": upload_url,
        "processor": True,
    }


@app.post("/api/v1/videos/{upload_id}/upload")
async def upload_processor_video_chunk(
    upload_id: str,
    media_file: UploadFile = File(..., alias="mediaFile"),
    filename: str = Form(default="upload.mp4"),
    metadata: str | None = Form(default=None),
    nvstreamer_chunk_number: int = Header(...),
    nvstreamer_total_chunks: int = Header(...),
    nvstreamer_is_last_chunk: bool = Header(False),
    nvstreamer_identifier: str | None = Header(default=None),
    nvstreamer_file_name: str | None = Header(default=None),
) -> dict[str, Any]:
    session = load_session(upload_id)
    safe_name = clean_filename(nvstreamer_file_name or filename or session.get("filename"))
    directory = session_dir(upload_id)
    chunks_dir = directory / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    chunk_path = chunks_dir / f"{nvstreamer_chunk_number:08d}.part"
    with chunk_path.open("wb") as output:
        shutil.copyfileobj(media_file.file, output)

    chunk_numbers = set(session.get("chunks", []))
    chunk_numbers.add(nvstreamer_chunk_number)
    session.update(
        {
            "filename": safe_name,
            "metadata": metadata,
            "nvstreamer_identifier": nvstreamer_identifier,
            "total_chunks": nvstreamer_total_chunks,
            "chunks": sorted(chunk_numbers),
        }
    )

    if nvstreamer_is_last_chunk or len(chunk_numbers) == nvstreamer_total_chunks:
        missing = [
            number
            for number in range(1, nvstreamer_total_chunks + 1)
            if number not in chunk_numbers
        ]
        if missing:
            save_session(upload_id, session)
            raise HTTPException(
                status_code=400,
                detail=f"Missing upload chunks before assembly: {missing}",
            )

        raw_path = directory / safe_name
        with raw_path.open("wb") as output:
            for number in range(1, nvstreamer_total_chunks + 1):
                output.write((chunks_dir / f"{number:08d}.part").read_bytes())
        session["assembled"] = True
        session["source_path"] = str(raw_path)

    save_session(upload_id, session)
    return {
        "sensor_id": upload_id,
        "id": upload_id,
        "filename": safe_name,
        "chunk_number": nvstreamer_chunk_number,
        "total_chunks": nvstreamer_total_chunks,
        "complete": bool(session.get("assembled")),
        "processor": True,
    }


@app.post("/api/v1/videos/{upload_id}/complete")
async def complete_processor_video_upload(
    upload_id: str,
    payload: dict[str, Any] | None = Body(default=None),
) -> dict[str, Any]:
    payload = payload or {}
    session = load_session(upload_id)
    source_path = Path(session.get("source_path", ""))
    if not session.get("assembled") or not source_path.exists():
        raise HTTPException(status_code=400, detail="Upload has not finished assembling yet")

    custom_params = payload.get("custom_params")
    if custom_params is not None and not isinstance(custom_params, dict):
        raise HTTPException(status_code=400, detail="custom_params must be an object")

    clips, manifest = await process_video(source_path, upload_id)
    uploads = []
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        for index, clip in enumerate(clips, start=1):
            clip_params = {
                **(custom_params or {}),
                "processor_source_filename": session.get("filename"),
                "processor_clip_index": index,
                "processor_clip_count": len(clips),
            }
            uploads.append(await upload_processed_video_to_vss(client, clip, clip_params))

    upstream_sensor_id = uploads[0]["sensor_id"] if uploads else None
    session.update(
        {
            "status": "uploaded",
            "processed_manifest": manifest,
            "upstream_uploads": uploads,
            "upstream_sensor_id": upstream_sensor_id,
        }
    )
    save_session(upload_id, session)

    return {
        "status": "uploaded",
        "sensor_id": upstream_sensor_id or upload_id,
        "processor_sensor_id": upload_id,
        "filename": session.get("filename"),
        "processed": manifest,
        "uploads": uploads,
        "response": uploads[0]["complete_response"] if uploads else None,
        "processor": True,
    }


@app.post("/vss/upload")
async def upload_video_to_vss(
    video: UploadFile = File(...),
    collection: str | None = Form(default=None),
) -> dict[str, Any]:
    upload_url = build_vss_url(VSS_UPLOAD_PATH)
    form_data = {}
    if collection:
        form_data["collection"] = collection

    try:
        video_bytes = await video.read()
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                upload_url,
                data=form_data,
                files={
                    "file": (
                        video.filename,
                        video_bytes,
                        video.content_type or "application/octet-stream",
                    )
                },
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not upload video to VSS: {exc}",
        ) from exc

    if response.is_error:
        raise HTTPException(
            status_code=response.status_code,
            detail=await parse_vss_response(response),
        )

    return {
        "status": "uploaded",
        "vss_url": upload_url,
        "response": await parse_vss_response(response),
    }


@app.post("/vss/search")
async def search_vss(request: SearchRequest) -> dict[str, Any]:
    search_url = build_vss_url(VSS_SEARCH_PATH)
    payload = {
        "query": request.prompt,
        "prompt": request.prompt,
        "top_k": request.top_k,
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(search_url, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not query VSS search: {exc}",
        ) from exc

    if response.is_error:
        raise HTTPException(
            status_code=response.status_code,
            detail=await parse_vss_response(response),
        )

    return {
        "status": "ok",
        "vss_url": search_url,
        "response": await parse_vss_response(response),
    }


@app.post("/generate")
async def generate_from_vss_agent(request: GenerateRequest) -> Any:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                VSS_AGENT_GENERATE_URL,
                json={"input_message": request.input_message},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not query VSS agent: {exc}",
        ) from exc

    if response.is_error:
        raise HTTPException(
            status_code=response.status_code,
            detail=await parse_vss_response(response),
        )

    return await parse_vss_response(response)
