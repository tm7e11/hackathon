import os
from typing import Any
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

VSS_BASE_URL = os.getenv("VSS_BASE_URL", "http://172.16.95.171:7777")
VSS_AGENT_GENERATE_URL = os.getenv(
    "VSS_AGENT_GENERATE_URL",
    "http://172.16.95.171:8000/generate",
)
VSS_UPLOAD_PATH = os.getenv("VSS_UPLOAD_PATH", "/api/v1/videos")
VSS_SEARCH_PATH = os.getenv("VSS_SEARCH_PATH", "/api/v1/search")
REQUEST_TIMEOUT_SECONDS = float(os.getenv("VSS_REQUEST_TIMEOUT_SECONDS", "120"))

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


def build_vss_url(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return urljoin(f"{VSS_BASE_URL.rstrip('/')}/", path.lstrip("/"))


async def parse_vss_response(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return response.json()
    return {"text": response.text}


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
