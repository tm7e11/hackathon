# Running the solder-clipper pipeline in Docker

The image splits every video in `raw/` into 20-second, 720p clips in `processed/`,
then calls the NVIDIA VLM to classify each clip as surgical / non-surgical. It
**keeps only surgical clips** and writes `processed/classifications.json`.

## Build

```bash
docker build -t solder-clipper .
```

## Run

Surgical-scene classification needs an NVIDIA API key passed at run time via `-e`.
Bind-mount an input folder to `/app/raw` and an output folder to `/app/processed`.

```bash
docker run --rm \
  -e NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  -v "$PWD/raw:/app/raw" \
  -v "$PWD/processed:/app/processed" \
  solder-clipper
```

### Loading the key from a local `.env`

If the key lives in a `.env` file (e.g. the repo root), source it first:

```bash
set -a; . ../../.env; set +a   # exports NVIDIA_API_KEY
docker run --rm \
  -e NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  -v "$PWD/raw:/app/raw" \
  -v "$PWD/processed:/app/processed" \
  solder-clipper
```

### Mounting a different input folder

The mount source can be any host directory with videos:

```bash
docker run --rm \
  -e NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  -v "/abs/path/to/videos:/app/raw" \
  -v "$PWD/processed:/app/processed" \
  solder-clipper
```

## Notes

- Without `NVIDIA_API_KEY`, classification is skipped with a warning and **all**
  clips are kept (still down-scaled to 720p).
- Output clip names: `<input-stem>_000.mp4`, `<input-stem>_001.mp4`, ...
- `processed/classifications.json` records `{clip, is_surgical, raw_answer}` for
  every clip (with an `error` field on soft failures).
