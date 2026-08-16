# Hackathon Project

This repository is organized into three main components:

- `backend`: FastAPI API, server-side services, and data access.
- `frontend`: React user interface and client-side application code.
- `inference`: Model inference, computer vision, and AI pipeline code.

## Quick Start

Docker Compose:

```bash
cp .env.example .env
docker compose up --build
```

Podman Compose:

```bash
cp .env.example .env
podman compose up --build
```

The frontend starts at `http://localhost:5173` and the processor API starts at
`http://localhost:8000`.

VSS endpoints and the frontend system prompt are configured in `.env`.

Backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export VSS_BASE_URL=http://172.16.95.171:7777
uvicorn src.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```
