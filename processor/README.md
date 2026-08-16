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
