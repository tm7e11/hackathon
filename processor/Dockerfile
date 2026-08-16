FROM python:3.13-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY pipeline.py /app/pipeline.py
COPY src /app/src

FROM base AS api
EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM base AS pipeline

# Everything is hard-coded: the pipeline reads videos from ./raw and writes
# clips to ./processed (relative to WORKDIR /app). Bind-mount both at run time.
# Surgical-scene classification needs an NVIDIA API key passed via -e.
#   docker build -t solder-clipper .
#   docker run --rm \
#       -e NVIDIA_API_KEY="$NVIDIA_API_KEY" \
#       -v "$PWD/raw:/app/raw" \
#       -v "$PWD/processed:/app/processed" \
#       solder-clipper
ENTRYPOINT ["python", "pipeline.py"]
