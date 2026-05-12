# whisper — reserved slot for self-hosted STT (not deployed)

This directory exists to keep the future STT upgrade path documented and
ready to fill in. **Nothing here runs in the current stack.**

## Current state

The frontend uses the browser's Web Speech API
([frontend/src/stt.js](../../frontend/src/stt.js)). That works on Chrome,
Edge, and Safari (with platform quirks), but:

- Firefox has no `SpeechRecognition` at all — those users fall back to text.
- Chrome's implementation sends audio to Google's cloud service — privacy +
  network dependency.
- Some iOS versions are inconsistent.

## When to activate this service

Promote whisper to a real service when **any** of these happen:

- User complaints about transcription accuracy
- Firefox usage becomes non-trivial
- Need offline / on-prem / privacy
- Latency from Google's cloud STT becomes the limiting factor

## How to activate (estimated ~1 day of work)

1. Rename `Dockerfile.example` → `Dockerfile` and uncomment the body.
2. Download a model into `models/`:
   ```bash
   mkdir -p models
   curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
        -o models/ggml-base.en.bin
   ```
   `base.en` is ~150 MB and runs faster than real-time on a modest CPU.
   Bump to `small.en` (~500 MB) or `medium.en` (~1.5 GB) for accuracy.
3. Add a service entry to the project's top-level `docker-compose.yml`
   (created in Phase 9):
   ```yaml
   whisper:
     build: ./services/whisper
     volumes:
       - ./services/whisper/models:/models:ro
     environment:
       WHISPER_MODEL: /models/ggml-base.en.bin
     ports:
       - "8002:8002"
   ```
4. Add `WHISPER_URL=http://whisper:8002` to `backend/.env` and `.env.example`.
5. Add a backend route, e.g. `POST /api/stt` that proxies a small WAV /
   webm-opus blob to whisper's `/inference` endpoint and returns the
   transcript.
6. Update `frontend/src/stt.js` to record audio with `MediaRecorder` and
   POST it to `/api/stt` instead of using `SpeechRecognition`. Keep the same
   `createStt({ onInterim, onFinal, onError })` shape so `main.js` doesn't
   change.

## Why we kept the slot empty for the first launch

Web Speech API has zero ops cost, ships now, and covers the majority of
target users. Self-hosting whisper is a deploy/model-management commitment
that doesn't pay off until real usage signals demand it. See the
"Post-Demo Backlog" section in `IMPLEMENTATION_PLAN.md` for the wider
upgrade roadmap.
