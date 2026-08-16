# Backend

FastAPI API and server-side services for the hackathon project.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn src.main:app --reload
```

The API starts at `http://127.0.0.1:8000`.

## VSS Proxy Settings

The frontend calls this backend, and the backend forwards requests to VSS.

```bash
export VSS_BASE_URL=http://172.16.95.171:7777
export VSS_UPLOAD_PATH=/api/v1/videos
export VSS_SEARCH_PATH=/api/v1/search
```

If your VSS deployment exposes different upload or search paths, update the
environment variables before starting `uvicorn`.

## VSS-Compatible Processor Uploads

The processor also exposes the VSS upload contract used by the frontend:

- `POST /api/v1/videos`
- `POST /api/v1/videos/{processor_upload_id}/upload`
- `POST /api/v1/videos/{processor_upload_id}/complete`

Point the frontend upload API at the processor:

```bash
export VITE_VSS_UPLOAD_API_URL=http://localhost:8000/api/v1
```

The frontend still uploads chunks using the normal `nvstreamer-*` headers. On
`complete`, the processor assembles the video, runs the local clipping/filtering
pipeline, then uploads the processed clip(s) back to the configured VSS backend.
