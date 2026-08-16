FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pipeline.py /app/pipeline.py

# Everything is hard-coded: the pipeline reads videos from ./raw and writes
# clips to ./processed (relative to WORKDIR /app). Bind-mount both at run time.
#   docker build -t solder-clipper .
#   docker run --rm \
#       -v "$PWD/raw:/app/raw" \
#       -v "$PWD/processed:/app/processed" \
#       solder-clipper
ENTRYPOINT ["python", "pipeline.py"]
