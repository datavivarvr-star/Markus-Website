# Markus — Real-Time 3D Avatar Chatbot

Self-hosted, low-latency talking 3D avatar. User speaks or types, the avatar replies with lip-synced speech.

- **Implementation plan:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — phase-by-phase build plan.
- **Ops / deployment:** [DEPLOYMENT.md](DEPLOYMENT.md) — single source of truth for production operations.

## Status

Phases 0–10, 12, 13 complete. Phase 11 (latency tuning) deferred — local
latency is well within budget; revisit if real-user feedback flags it.
Phase 14 (user testing + soft launch) is the next step and runs primarily
on the user's side (recruit testers, observe, send issues back).

## Stack

- **Frontend** — Vanilla JS + Three.js + Vite (`/frontend`)
- **Backend** — Node 20 + Fastify + WebSocket (`/backend`)
- **LLM** — Groq cloud API (`openai/gpt-oss-20b`) via the OpenAI SDK
- **TTS** — Self-hosted Piper (`/services/piper-tts`) with phoneme timing → visemes
- **STT** — Web Speech API (Chrome / Edge / Safari) + text fallback; self-hosted Whisper reserved at `/services/whisper/`
- **Avatar** — `assets/Markus_Basic.glb` (currently a mock; rigged GLB will drop in per DEPLOYMENT.md §7.4)

## Layout

```
/assets            Markus_Basic.glb (avatar)
/backend           Fastify + WS + Groq + Piper proxy + warmup + safety guards
/frontend          Vite + Three.js app (scene, idle, visemes, audio, lipsync, chat WS, STT)
/services
  /piper-tts       Python FastAPI wrapper around Piper TTS + espeak-ng phoneme timing
  /whisper         Reserved slot for self-hosted STT (not deployed)
/docker            Backend + frontend Dockerfiles
/docs              Blendshape mapping JSON + notes
docker-compose.yml + docker-compose.override.yml + Caddyfile
DEPLOYMENT.md      Single canonical ops doc
```

## Local dev

You need:
- Node 20+
- Docker (for the Piper TTS service)
- A Groq API key from console.groq.com

### 1. Configure env

```sh
cp .env.example backend/.env
# Edit backend/.env and paste your GROQ_API_KEY. Defaults are fine otherwise.
```

### 2. Start Piper TTS (one-time per session)

```sh
cd services/piper-tts
# First time only: download the voice (en_US-ryan-medium, ~63 MB)
bash scripts/download-voice.sh en_US-ryan-medium
# Windows: .\scripts\download-voice.ps1 -Voice en_US-ryan-medium

docker compose up -d
# Verify:
curl http://localhost:8001/health
```

### 3. Start the backend

```sh
cd backend
npm install   # first time only
npm run dev
```

Backend listens on `http://localhost:3000`. Endpoints:
- `GET  /api/health`  — service health (Groq configured? Piper reachable? session count)
- `GET  /api/warmup`  — pre-warm Groq + Piper; idempotent; rate-limit exempt
- `WS   /api/chat`    — JSON `{ message, sessionId }` → streamed `{ type:'sentence', text }` → `{ type:'done' }` (or `cancelled`)
- `POST /api/tts`     — `{ text }` → `{ audio_b64, phonemes, sample_rate, ... }`

### 4. Start the frontend

```sh
cd frontend
npm install   # first time only
npm run dev
```

Open `http://localhost:5173/`. The page should load the avatar, mic button, text input, and a small privacy footer.

### Useful URL flags

- `?test=visemes` — cycles through the 15 Oculus visemes for visual verification (Phase 4).
- `?dev=1` — floating panel that plays a canned phrase through `/api/tts` (no LLM) for lipsync iteration.

### Browser support

| Browser | STT mic | Reply audio | Notes |
|---|---|---|---|
| Chrome desktop / Android | ✅ | ✅ | Primary target |
| Edge desktop | ✅ | ✅ | Uses Microsoft cloud STT |
| Safari macOS / iOS | ✅ | ✅ | iOS gesture-unlocks the AudioContext on first tap |
| Firefox | ❌ mic hidden | ✅ | Text input only; `SpeechRecognition` doesn't exist |
| Brave / Arc / ungoogled Chromium | ⚠ network error | ✅ | API exists but cloud key stripped; UI surfaces the right message |

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md). The short version: `docker compose up -d --build` after setting `DOMAIN` and `GROQ_API_KEY` in `.env`. Caddy auto-provisions a Let's Encrypt cert on first HTTPS request.

## What's next

Phase 14 — recruit ~5 friends, watch them use it for 5 min each unaided, log top usability issues, then soft-launch to 50 users with 48 h of log monitoring. Whisper self-host activation (cross-browser STT) sits in the post-launch backlog at `services/whisper/`.
