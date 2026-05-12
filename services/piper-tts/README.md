# piper-tts service

Self-hosted text-to-speech micro-service for the Markus avatar project. Wraps [Piper TTS](https://github.com/rhasspy/piper) (ONNX, CPU-only) and adds per-phoneme timing produced by espeak-ng. One HTTP endpoint, JSON in / JSON out, designed to live behind the Node backend and never exposed to the public internet directly.

This directory is **self-contained** — everything needed to build, run, and deploy is here. Hand the whole folder to the person doing the deployment.

---

## Endpoints

### `GET /health`

```json
{
  "ok": true,
  "voice": "en_US-ryan-medium",
  "voice_loaded": true,
  "sample_rate": 22050,
  "espeak_voice": "en-us"
}
```

`ok=false` means the voice files aren't where the service expects them. Service still starts (so health probes get a response), but `/synthesize` will return 503 until the voice is in place.

### `POST /synthesize`

Request:
```json
{ "text": "Hello there." }
```

Response:
```json
{
  "audio_b64": "<base64 wav>",
  "format": "wav",
  "sample_rate": 22050,
  "audio_ms": 1240,
  "phonemes": [
    { "p": "h",  "t0_ms":   0, "t1_ms":  60 },
    { "p": "ə",  "t0_ms":  60, "t1_ms": 180 },
    { "p": "l",  "t0_ms": 180, "t1_ms": 220 },
    { "p": "oʊ", "t0_ms": 220, "t1_ms": 440 }
  ],
  "timing_source": "espeak_proportional"
}
```

`phonemes[].p` is the IPA token from espeak-ng (underscore `_` marks word/pause boundaries). `t0_ms` / `t1_ms` are millisecond offsets from the start of the audio. The frontend converts these to Oculus visemes for lipsync.

Bounded inputs: text length capped at `MAX_CHARS` (default 2000). Empty text → 400. Voice missing → 503.

---

## Voice files

The service needs **two files** to load a voice:

- `<voice-name>.onnx`        — the model (~63 MB for `medium` quality)
- `<voice-name>.onnx.json`   — the model config (a few KB)

Both must sit in the directory pointed to by `VOICE_DIR` (default `/voices` inside the container). Voice is locked to **`en_US-ryan-medium`** for this project.

### Fetch the locked voice

```bash
# Linux / macOS / WSL / Git Bash
bash scripts/download-voice.sh en_US-ryan-medium

# Windows PowerShell (5.1 or 7+)
.\scripts\download-voice.ps1 -Voice en_US-ryan-medium
# if execution policy blocks it:
powershell -ExecutionPolicy Bypass -File .\scripts\download-voice.ps1 -Voice en_US-ryan-medium
```

This drops the two files into `./voices/`. They are `.gitignore`d — never commit them.

If you'd rather fetch manually, the canonical source is the Rhasspy mirror on HuggingFace:
<https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/medium>

---

## Build & run with Docker

The Dockerfile bakes `voices/` into the image, so make sure the voice files are present in `./voices/` **before** running `docker build`.

```bash
# 1. Place voice files in ./voices/ (see above)
ls voices/
# en_US-ryan-medium.onnx
# en_US-ryan-medium.onnx.json

# 2. Build
docker build -t markus-piper-tts:0.1.0 .

# 3. Run
docker run --rm -p 8001:8001 --name piper-tts markus-piper-tts:0.1.0

# 4. Test
curl http://localhost:8001/health
curl -X POST http://localhost:8001/synthesize \
  -H 'content-type: application/json' \
  -d '{"text":"Hello, my name is Markus."}' | jq '.audio_ms, .phonemes | length'
```

### Or with docker-compose (recommended for dev)

```bash
docker compose up --build
# voices/ is mounted as a read-only volume — change voice files without rebuilding
```

The compose file mounts `./voices` as a volume, so it overrides whatever was baked into the image — handy for swapping voices in development.

---

## Run without Docker (for quick local testing)

Requires Python 3.11 and `espeak-ng` installed on the host.

```bash
# Debian/Ubuntu
sudo apt-get install -y espeak-ng libsndfile1

# macOS
brew install espeak-ng

# Python deps
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Put voice in ./voices/
bash scripts/download-voice.sh

# Run
VOICE_DIR="$PWD/voices" uvicorn main:app --host 0.0.0.0 --port 8001
```

---

## Environment variables

| Var | Default | What |
|---|---|---|
| `VOICE_DIR`    | `/voices`            | Where the `.onnx` + `.onnx.json` live |
| `VOICE_NAME`   | `en_US-ryan-medium`  | Base name of the voice files (without extension) |
| `ESPEAK_VOICE` | `en-us`              | espeak-ng voice for phonemization (only affects timing, not audio) |
| `LOG_LEVEL`    | `info`               | `debug` / `info` / `warning` / `error` |
| `MAX_CHARS`    | `2000`               | Hard cap on `/synthesize` text length |
| `PORT`         | `8001`               | Service port (also exposed by Dockerfile) |

---

## Deployment notes

- **CPU-only.** No GPU required. `medium` quality voices synthesize ~3–5× realtime on a modest 2-core VPS; expect ~100–250 ms first-audio latency for short sentences.
- **Memory.** ~250–400 MB resident with one voice loaded. Fits in any small container.
- **Image size.** ~400–500 MB with voice baked in, ~340 MB without.
- **Volume vs bake.** For production, baking the voice into the image keeps deploys atomic. For dev or when iterating on voices, mount `./voices` as a volume (see compose file).
- **Workers.** Single uvicorn worker is correct here — the ONNX session is loaded once at startup and isn't designed for forked parallelism. Scale horizontally (more containers) if you need throughput.
- **Networking.** This service is for **internal use by the Node backend only**. Don't expose port 8001 publicly. In the project's full stack (Phase 9 compose), the Node backend reaches it as `http://piper-tts:8001`.
- **Healthcheck.** Both the Dockerfile and compose file include `GET /health` checks with a 15 s start period to allow voice load.

---

## Phoneme timing — how it works

The plan calls for two paths:

**Path A** (preferred, more accurate): patch into Piper's ONNX inference to capture per-phoneme duration predictions (`w_ceil` output). This is version-fragile — Piper's internal API has changed between minor releases — so it's deferred until visemes feel out of sync in real use.

**Path B** (shipping now, robust): synthesize audio with Piper, then call espeak-ng separately (`espeak-ng -v en-us -q --ipa=3`) to get an IPA phoneme list, then distribute the audio duration across phonemes using simple phonetic-class weights (vowels ~2×, stops ~0.5×, fricatives ~1.3×, nasals ~1×, word boundaries ~0.4×). The `timing_source` field in the response says `"espeak_proportional"` so the frontend knows which path produced the timing.

If `espeak-ng` is unavailable for some reason, the service still returns audio — just with `phonemes: []` and `timing_source: "none"`. The frontend gracefully falls back to playing audio without lipsync.

---

## License notes

- `piper-tts` is MIT-licensed.
- `espeak-ng` is GPLv3 — fine to use as a runtime dependency, but be aware of redistribution rules if you ship modified versions.
- The Rhasspy voices are individually licensed (most MIT/CC); `en_US-ryan-medium` is MIT. Confirm any voice you swap in.
