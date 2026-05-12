# Implementation Plan — Self-Hosted Real-Time 3D Avatar Chatbot

> **Build status (2026-05-12):** Phases 0–10, 12, 13 complete. Phase 11
> (latency tuning) **deferred** — local end-to-end latency is well within
> the p50 ≤ 1.2 s / p95 ≤ 2.0 s target; revisit if Phase 14 user-testing
> surfaces "feels slow" complaints. Phase 14 (user testing + soft launch)
> is the active phase; primarily user-side work. See
> [README.md](README.md) for a one-pager and
> [DEPLOYMENT.md](DEPLOYMENT.md) for ops. The phase descriptions below
> are kept verbatim as the historical reference, including Phase 11's
> tuning playbook for when it's needed.

**Goal:** A low-latency talking 3D human avatar on a website. User speaks → avatar replies with lip-synced speech.

**Locked stack:**
- Frontend: Vanilla JS + Three.js + Vite
- STT: Web Speech API (browser, free) + text-input fallback
- LLM: **Groq cloud API** (OpenAI-compatible) — model `openai/gpt-oss-20b`, free tier, very low latency
- TTS: **Piper TTS** (self-hosted, ONNX, runs fast on CPU — no paid TTS API)
- Visemes: **espeak-ng phoneme timing** → Oculus viseme set → custom blendshape names
- Avatar: `/assets/Markus_final.glb` (rigged Blender GLB; Oculus viseme blendshapes + `eyeBlinkLeft`/`eyeBlinkRight` + standard humanoid skeleton)
- Backend: Node.js + Fastify + WebSocket
- Deployment: you handle manually (Docker Compose stack provided as reference)
- Reverse proxy + HTTPS: your call — Compose includes Caddy as a default option

**Latency target:** p50 ≤ 1.2s, p95 ≤ 2.0s end-to-end (user-stop-speaking → avatar-first-audio). Groq's TTFT is typically <300ms, which is the main reason this number is tighter than the Ollama version.

**Working model:** I write all code in this directory across multiple chats. After each phase I'll list the manual ops you need to do (git, deploy, model files, etc.). You confirm phase is "live" before we move on.

---

## Architecture Overview

```
Browser (your domain, HTTPS)
   ├── Three.js scene + viseme renderer
   ├── Web Speech API (STT)
   └── WebSocket  ─────────┐
                            │
              ┌─────────────▼──────────────┐
              │  reverse proxy (Caddy)     │
              └─────────────┬──────────────┘
                            │
              ┌─────────────▼──────────────┐
              │  node-backend (Fastify)    │
              │  - /api/chat  (WS, LLM)    │────► Groq Cloud API
              │  - /api/tts   (HTTP)       │      (gpt-oss-20b, OpenAI-compatible)
              │  - session memory          │
              └─────────────┬──────────────┘
                            │
                  ┌─────────▼─────────┐
                  │  piper-tts        │
                  │  HTTP wrapper     │
                  │  WAV + phonemes   │
                  └───────────────────┘
```

**Phoneme timing trick** (still critical): Piper uses espeak-ng for text→phonemes. We hook into Piper's pipeline to capture per-phoneme durations from the ONNX synth, getting `[{phoneme, t_start_ms, t_end_ms}]` aligned to the WAV. Map phonemes → Oculus visemes → your custom blendshapes.

**Why Groq for LLM**: free tier, sub-300ms TTFT, OpenAI SDK works as-is (just point `baseURL` at Groq). One backend call, no model hosting, no warm-up time. The only cost is a managed dependency (Groq could rate-limit or change pricing).

---

## Phase 0 — Repo Scaffolding & Local Dev (Chat 1, part 1)

**I will:**
- Create the directory layout:
  ```
  /assets            # Markus_Basic.glb already here
  /frontend          # Vite + Three.js app
  /backend           # Node + Fastify
  /services
    /piper-tts       # Python wrapper around piper + espeak-ng → HTTP
  /docker            # Dockerfiles + docker-compose.yml (reference)
  /docs              # blendshape mapping JSON, notes
  .env.example
  .gitignore
  README.md
  ```
- Write `package.json` stubs for frontend + backend
- `.env.example` with all needed vars (no secrets):
  ```
  GROQ_API_KEY=
  GROQ_BASE_URL=https://api.groq.com/openai/v1
  GROQ_MODEL=openai/gpt-oss-20b
  PIPER_URL=http://piper-tts:8001
  PORT=3000
  ALLOWED_ORIGIN=http://localhost:5173
  ```
- `.gitignore` excludes `node_modules`, `dist`, `.env`, `*.onnx` (Piper voices).
- Top-level `README.md` with local-run instructions.

**You will (manual ops):**
- ⚠️ **Rotate the Groq API key** you screenshotted — generate a fresh one in the Groq console.
- `git init` + first commit (you've said you handle git).
- Install Node 20+ and Docker locally for testing.

---

## Phase 1 — Backend Skeleton (Chat 1, part 2)

The backend is dumb glue: WebSocket for chat, HTTP for TTS proxy, in-memory session store.

**I will:**
- Initialize `/backend` with Fastify, `@fastify/cors`, `@fastify/websocket`, `@fastify/rate-limit`, `pino` logging, `openai` SDK (used for Groq via custom `baseURL`).
- `GET /api/health` — returns `{ ok: true, services: {...} }` (pings Groq + Piper)
- `WS /api/chat` — accepts `{ message, sessionId }`, calls Groq via OpenAI SDK with `baseURL=https://api.groq.com/openai/v1`, model `openai/gpt-oss-20b`, `stream: true`, sentence-buffers tokens (split on `.?!` followed by space/EOS), emits `{type: 'sentence', text}` events, ends with `{type: 'done'}`
- `POST /api/tts` — accepts `{ text }`, forwards to piper-tts service, returns `{ audio: base64Wav, visemes: [{id, t_ms}] }` (single response, not streamed — Phase 5 may optimize)
- System prompt baked in, kept under 200 tokens:
  > You are a friendly avatar assistant. Reply in 1–2 short, natural sentences. No markdown, no lists, no special characters. Plain conversational English.
- In-memory `Map<sessionId, messages[]>`, keep last 10 turns, evict sessions idle >30 min
- Rate limit: 60 req/min/IP
- CORS locked to env-configured origin
- Structured logs with stage timings (we'll need these for Phase 11 latency tuning)

**You will (manual ops):**
- Nothing yet — runs locally with `npm run dev`. We'll deploy after Phase 8.

---

## Phase 2 — Three.js Scene & Avatar Loading (Chat 2, part 1)

**I will:**
- `/frontend` Vite project, three.js installed. Vite configured to serve `/assets/Markus_Basic.glb` at `/assets/Markus_Basic.glb` (publicDir or symlink).
- `index.html` with `<canvas>`, mic button, text input, transcript area, "thinking" indicator. Mobile viewport meta set.
- `scene.js`: PerspectiveCamera framed on face/upper torso, AmbientLight + DirectionalLight (key from front-upper-left), transparent background, `requestAnimationFrame` loop, pixel-ratio capped at 2.
- `avatar.js`: GLTFLoader + DRACOLoader, loads `Markus_Basic.glb`, traverses to find SkinnedMesh with populated `morphTargetDictionary`, logs it to console on load.
- **Blendshape dumper script**: `npm run dump-blendshapes` — Node script that loads `Markus_Basic.glb` with `@gltf-transform/core` and prints every morph target name. You run it once, paste output back.
- Loading progress bar via `GLTFLoader.onProgress`.
- Mobile-safe: `body { overscroll-behavior: none; touch-action: none; }`, 44×44px tap zones.

**You will (manual ops):**
- Run `npm run dump-blendshapes`, paste the output in our next chat (so I can build the viseme mapping in Phase 4).
- Confirm Markus renders correctly in browser.

---

## Phase 3 — Idle Animation Layer (Chat 2, part 2)

Makes the avatar feel alive before lipsync is wired.

**I will:**
- `idle.js` module:
  - **Blink** every 3–6s (randomized), `eyeBlinkLeft`/`eyeBlinkRight` morph 0→1→0 over 150ms. Bone fallback if blendshapes absent.
  - **Head sway**: `head.rotation.y = sin(t*0.5)*0.02`, `head.rotation.x = cos(t*0.3)*0.01`
  - **Breathing**: chest bone scale or `breathe` blendshape, ~4s period
  - **Saccades**: small eye-bone rotations every 1–2s
- All idle motion runs from the main render loop; pauses while lipsync is active so it doesn't fight the visemes.

**You will:** Watch it in the browser, tell me if blink/sway feel right or need tuning.

---

## Phase 4 — Viseme Mapping Layer (Chat 3, part 1)

The critical bridge: **espeak phoneme → Oculus viseme → your custom blendshape name → morph target index**.

**I will:**
- `visemes.js`:
  - **Layer A** — espeak IPA phoneme → Oculus viseme (15 visemes). Comprehensive table covering all English phonemes piper/espeak emits.
  - **Layer B** — Oculus viseme → your blendshape name (built from the spreadsheet you provide). I'll write this as JSON so you can edit without touching code.
  - **Layer C** — resolve to morph target indices at avatar-load time. Log warnings for missing blendshapes.
- `applyViseme(currentVisemeId, nextVisemeId, blend)`:
  - Reset all 15 morph influences to 0
  - current = `1 - blend*0.5`, next = `blend*0.5`
  - Cosine easing on `blend`
- **Diagnostic mode**: `?test=visemes` URL param cycles through all 15 visemes (300ms each) so you can visually verify every shape. Catches naming typos and bad mappings before integration.

**You will:**
- Provide the **Oculus viseme → custom blendshape name** mapping (a JSON or spreadsheet — I gave the format in `/docs/blendshape-mapping-template.json`).
- Run the diagnostic mode, screenshot any visemes that look wrong, send to me.

---

## Phase 5 — Self-Hosted TTS Service (Chat 3, part 2 + Chat 4, part 1)

This is the meatiest phase. We're replacing Azure with our own micro-service.

**I will build `/services/piper-tts/`:**
- Python 3.11 FastAPI app, single endpoint: `POST /synthesize { text }` → `{ audio_b64: <wav>, sample_rate: 22050, phonemes: [{p: "aɪ", t0_ms: 0, t1_ms: 80}, ...] }`
- Uses `piper-tts` Python package, voice model `en_US-amy-medium` (or `en_US-lessac-medium` — we'll A/B). Both are ONNX, CPU-fast (~50-150ms first audio on a modest VPS).
- **Phoneme timing trick**: Piper internally calls espeak-ng for phonemization and the ONNX synthesizer outputs per-phoneme duration predictions. We patch into Piper's pipeline (it's open Python) to capture: `(phoneme_str, duration_frames)` for each phoneme. Convert frames → ms using the sample rate and frame hop. Net result: timing aligned with the WAV output.
- Fallback path if Piper's internals shift between versions: run espeak-ng separately with `--ipa -q -x` for phoneme list, distribute total audio duration proportionally to phoneme weights. Less accurate but always works.
- Dockerfile: `python:3.11-slim`, installs piper-tts + espeak-ng (`apt-get install espeak-ng`), copies voice model in. Image ~400MB.
- Health check: `GET /health` returns `{ok: true, voice: "en_US-amy-medium"}`.

**I will also:**
- Update `/backend` to call `piper-tts:8001/synthesize` for the `/api/tts` route.
- Add `PIPER_URL=http://piper-tts:8001` to `.env.example`.

**You will (manual ops):**
- Download a Piper voice (e.g. `en_US-amy-medium.onnx` + `.onnx.json`) from the piper-tts releases page and drop into `/services/piper-tts/voices/`. I'll give exact URLs in chat.
- A male voice probably fits "Markus" better — `en_US-ryan-medium` or `en_GB-alan-medium` are good candidates. Tell me which you prefer after listening to samples.

---

## Phase 6 — Frontend TTS Integration & Viseme Renderer (Chat 4, part 2)

**I will:**
- `audio.js`:
  - `AudioContext` created lazily inside first user gesture (mic-button click or text-send). Single context, never closed, `resume()` on every gesture.
  - `speakSentence(text)`:
    1. Fetch `/api/tts` → get `{audio_b64, phonemes}`
    2. Decode base64 → ArrayBuffer → `audioContext.decodeAudioData`
    3. Convert `phonemes` (espeak IPA) → viseme queue `[{visemeId, t_ms}]` via Layer A mapping
    4. Schedule playback via `AudioBufferSourceNode`, capture `audioStartTime = audioContext.currentTime`
    5. Set `isSpeaking = true`, pause idle animation
  - Queue multiple sentences, play serially (avatar speaks sentence 1 while sentence 2 is being synthesized → hides backend latency).
- `lipsync.js` integrated into the render loop:
  ```js
  function updateLipSync() {
    if (!isSpeaking) return;
    const audioTime = (audioCtx.currentTime - audioStartTime) * 1000;
    const current = visemeQueue.findLast(v => v.t <= audioTime);
    const next = visemeQueue.find(v => v.t > audioTime);
    if (!current) return;
    const dur = next ? next.t - current.t : 80;
    const blend = smoothstep((audioTime - current.t) / dur);
    applyViseme(current.visemeId, next?.visemeId ?? 'sil', blend);
  }
  ```
- On audio end: reset all visemes to 0, set `sil` to 1, resume idle.
- **Isolation test**: a dev button "Test phrase" hardcodes "Hello, my name is Aria. How can I help you today?" through the full TTS pipeline. We iterate here until lips look right.

**You will:** Watch the test phrase, tell me what looks off (vowels too closed, plosives missed, etc.). We adjust the phoneme→viseme table.

---

## Phase 7 — Groq LLM Integration (Chat 5, part 1)

**I will:**
- Wire backend `/api/chat` WebSocket to Groq via the OpenAI SDK:
  ```js
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });
  const stream = await client.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages,
    stream: true,
    temperature: 0.6,
    max_tokens: 120,
  });
  ```
- Sentence-buffer the streamed tokens, emit each completed sentence as a WebSocket message → frontend immediately queues TTS. Time-to-first-spoken-word drops below ~700ms in practice with Groq.
- Save assistant reply to session memory on stream completion.
- Graceful 429 handling: surface "Rate limited, please slow down" to client; backoff.
- Connection retry with exponential backoff on transient Groq errors.

**You will (manual ops):**
- Put a freshly-rotated `GROQ_API_KEY` in your deployment `.env` (and local `.env` for testing).
- Verify your Groq account has access to `openai/gpt-oss-20b` (if not, we'll swap to `llama-3.1-8b-instant` or `llama-3.3-70b-versatile` — both very fast on Groq).

---

## Phase 8 — Web Speech API (STT) + Text Fallback (Chat 5, part 2)

**I will:**
- `stt.js` wrapping `webkitSpeechRecognition || SpeechRecognition`.
- Config: `continuous=false`, `interimResults=true`, `lang='en-US'`.
- UI: single mic button (tap to start, tap to stop), live interim transcript overlay.
- `onresult` → on final result, push transcript through `sendMessage()`.
- `onerror` graceful handling of `no-speech`, `audio-capture`, `not-allowed`.
- **Feature detection at page load**: if SpeechRecognition undefined (Firefox, some iOS), hide mic, show text input only. Never crash.
- Permission prompt copy: "Allow microphone to talk to the avatar."
- **Documented upgrade path**: a `/services/whisper/` stub (commented Dockerfile for whisper.cpp server) so we can swap to self-hosted STT later without re-architecting.

**You will:** Test on iPhone Safari, Android Chrome, Desktop Chrome, Desktop Firefox.

---

## Phase 9 — Docker Compose Reference Stack (Chat 6, part 1)

You said you'll handle deployment manually — so I'll ship a working Compose file as a reference, but won't try to be prescriptive about your infra.

**I will:**
- `docker-compose.yml` with services:
  - `caddy` (reverse proxy, auto-HTTPS via Let's Encrypt, serves `/frontend/dist` static + proxies `/api/*` to backend + WebSocket upgrade) — feel free to swap for Nginx/ALB
  - `backend` (Node + Fastify)
  - `piper-tts` (Python FastAPI)
  - (No Ollama — LLM is Groq cloud)
- `Caddyfile` template for your domain + websocket upgrade.
- Multi-stage Dockerfile for frontend (Vite build → Caddy static files).
- `.env` template (`DOMAIN`, `GROQ_API_KEY`, `GROQ_MODEL`, `PIPER_VOICE`, `ALLOWED_ORIGIN`).
- `docker-compose.override.yml` for local dev (no HTTPS, exposed ports).
- Health checks on every service.
- A short `DEPLOYMENT.md` covering: env vars, build commands, ports, healthcheck endpoints — anything you'd want to know when wiring it into your existing infra.

**You will (manual ops):** deploy however your AWS setup expects it.

---

## Phase 10 — End-to-End Pipeline Wire-Up & Pre-Warming (Chat 6, part 2)

**I will:**
- `chat.js` orchestrator: opens WS on page load, generates session UUID stored in `localStorage`.
- Full flow integration:
  1. User taps mic / submits text → `sendMessage(text)`
  2. WS sends `{message, sessionId}`
  3. Backend streams sentences from Ollama → `{type:'sentence', text}` messages
  4. Frontend queues each sentence for TTS, plays serially, lipsyncs
  5. On `{type:'done'}` → idle resumes
- **Pre-warming on page load**:
  - Open WS immediately (don't wait for first message)
  - Send a `{ping}` to Ollama via backend to load the model into RAM
  - Send a tiny synthesis request to Piper to warm the ONNX runtime
  - All three happen in parallel during avatar load
- **Barge-in**: if user taps mic while avatar is speaking, cancel current audio source, clear TTS queue, reset visemes to `sil`, start listening.
- Visual feedback: dim mic while assistant speaks (prevents mobile mis-tap).
- WS auto-reconnect with exponential backoff.
- TTS failure → fallback to browser `SpeechSynthesisUtterance` (no visemes, but still talks).

**You will:** Live-test with a friend. Send me a screen recording of any janky moments.

---

## Phase 11 — Latency Tuning (Chat 7, part 1)

**I will:**
- Instrument every stage with `performance.now()` markers, log to console and to backend:
  ```
  T+0       User stopped speaking
  T+120     STT final
  T+135     WS message sent
  T+150     Groq TTFT (first token)
  T+380     First sentence buffered
  T+400     TTS request sent
  T+520     TTS audio + visemes received
  T+540     Playback started ← TARGET
  ```
- A `?debug=1` URL param overlays this in the corner.
- Tune based on the worst stage:
  - **Groq TTFT > 400ms**: shorten system prompt, lower `max_tokens`, switch model to `llama-3.1-8b-instant` (Groq's fastest), check that backend is geographically close-ish to Groq's PoPs
  - **TTS > 300ms**: switch to `low` quality Piper voice, pre-warm with a `ping` synthesis at backend start, consider chunking long sentences
  - **Network browser→backend > 100ms**: backend region matters
- Target: **p50 ≤ 1.2s, p95 ≤ 2.0s** end-to-end on desktop; **p50 ≤ 1.6s** on mobile.

**You will:** Send me debug-overlay screenshots from a few real sessions on different networks (home WiFi, mobile data).

---

## Phase 12 — Mobile Polish & Cross-Browser (Chat 7, part 2)

**I will:**
- Test matrix audit + fixes:
  - iPhone Safari (iOS 17+)
  - Android Chrome
  - Desktop Chrome / Safari / Firefox (text-only fallback)
- `AudioContext.resume()` on every gesture (iOS suspends aggressively).
- iOS speaker routing: document the setSinkId limitation; add a UI hint if audio is suspiciously quiet.
- Three.js mobile perf: cap pixelRatio at 2, disable shadows on small viewports, target ≥30fps on mid-tier Android.
- Tap zones ≥44×44px, prevent canvas rubber-band scroll.
- GLB loading progress bar.

**You will:** Test on your actual devices, send me video of any failures.

---

## Phase 13 — Production Hardening (Chat 8, part 1)

**I will:**
- Structured pino logs in backend, session events written to a rotating log file mounted in `/data/logs`.
- `/api/health` aggregates `ollama` and `piper-tts` health.
- Helmet headers, WS message size cap (10KB), input sanitization before LLM, prompt-injection guard ("ignore previous instructions" gets a canned safe response).
- Rate limits: 60/min/IP, 200/hour/session.
- Privacy footer: "Voice is processed in your browser (Google) and on our server. Conversations are not stored after your session."
- Graceful degradation documented and tested:
  - STT unavailable → text input
  - TTS unavailable → browser SpeechSynthesisUtterance, no visemes
  - LLM unavailable → "I'm having trouble, please try again" canned reply

**You will (manual ops):**
- Set up UptimeRobot on `https://your-domain.com/api/health` (free).
- Monitor your Groq usage dashboard — free tier has daily token/request caps.

---

## Phase 14 — User Testing & Launch (Chat 8, part 2)

**I will:** Be on call for any bugs you find.

**You will:**
- Recruit 5 friends. Watch them use it for 5 min each. Don't help. Note every confusion.
- Send me top 3 usability issues; I fix.
- Soft-launch to your 50 users. Monitor logs for 48 hours.

---

## Post-Demo Backlog — "Real Conversation" Upgrades

The current plan ships a polished **turn-taking** avatar chatbot (tap-to-talk → 1.2–2 s pause → lipsynced reply). It will not feel like ChatGPT advanced-voice or Sesame CSM out of the box. After the soft-launch in Phase 14, these are the upgrades that close the gap, in rough cost/impact order.

### Cheap, high impact (~1–2 days each)

- **Self-hosted Whisper STT** — replace Web Speech API with a `whisper.cpp` server (the Phase 8 stub at `/services/whisper/` is already reserved). `base.en` model (~150 MB) runs real-time on CPU. Better accuracy, works offline, no Google dependency.
- **Silero VAD in the browser** — tiny ONNX model (~2 MB), runs client-side, auto-ends the user's turn instead of requiring a second mic tap. Closes most of the "walkie-talkie feel" gap.
- **Real Piper duration capture (plan-A path)** — replace the Phase 5 proportional timing with the ONNX model's actual per-phoneme frame predictions. Sharper lipsync, especially on long words and final consonants.

### Medium effort, big experience shift (~1 week each)

- **Voice barge-in** — run VAD on the mic continuously while the avatar is speaking; user speech → cancel audio, reset visemes, start listening. Needs the next item to work in speaker mode.
- **Echo cancellation** — `getUserMedia({ audio: { echoCancellation: true } })` works for headset users; speaker-mode needs a stronger AEC (WebRTC AEC3 via a tiny worklet, or off-the-shelf RNN-based suppressor).
- **Streaming TTS** — emit 100 ms audio chunks from Piper as soon as they're synthesized rather than buffering the full WAV. Cuts time-to-first-spoken-word by ~300 ms. Or swap to a streaming-native engine (Kokoro, Orpheus).

### Big swing — stack rewrite (~weeks)

- **Direct speech-to-speech model** — skip the STT→LLM→TTS pipeline entirely. Options: OpenAI Realtime API (paid, managed), Sesame CSM (open weights, self-host, GPU), Moshi (full-duplex, GPU). Single model hears tone/pauses/laughter and produces emotionally apt speech. Where the field is going; closes the remaining gap to "feels alive". Drops Groq free tier, likely needs GPU infra.

### Avatar-side polish (parallel to all above)

- **Sentiment-driven facial expressions** — parse LLM output for affect, drive `smile` / `frown` / `browInner` morphs (would need the modeller to rig these alongside the visemes).
- **Eye contact / gaze tracking** — default look-at-camera instead of saccades; gaze toward the implicit conversational subject when relevant.
- **Hand/torso gestures** — Mixamo library gated on stressed syllables; subtle, not distracting.

Flag any of these for promotion into the main phases if user-testing in Phase 14 surfaces specific pain points. Default plan stays single-track through Phase 14 → soft launch → backlog triage based on real feedback.

---

## Critical Pitfalls — Re-Check Before Each Phase

- **Audio clock**: always `AudioContext.currentTime`, never `performance.now()`, for viseme timing.
- **Morph influences accumulate**: reset all 15 to 0 every frame before setting current+next.
- **Blendshape name truth**: trust `mesh.morphTargetDictionary` at runtime over any spreadsheet.
- **Mobile autoplay**: AudioContext must be created/resumed inside a user gesture.
- **HTTPS required**: mic + Web Speech API silently fail on HTTP. Caddy gives you this automatically.
- **Web Speech API on iOS**: no `continuous=true`. Tap-to-talk only.
- **GLB size**: target <5MB. >10MB ruins first-load on mobile. If yours is bigger, ask your colleague to Draco-compress and reduce textures to 2k.
- **Groq rate limits**: free tier has per-minute and daily caps. Handle 429s gracefully; log usage.
- **Groq key in browser**: never. Key lives in backend `.env` only. Frontend talks to your backend, backend talks to Groq.
- **Piper voice license**: most voices are MIT/CC-licensed but confirm the specific voice file you choose.

---

## Locked Decisions (ready to start Phase 0)

| Decision | Value |
|---|---|
| Avatar GLB | `assets/Markus_final.glb` ✅ rigged model in place (visemes + bones) |
| LLM provider | Groq cloud (`https://api.groq.com/openai/v1`) |
| LLM model | `openai/gpt-oss-20b` ✅ access confirmed |
| Groq API key | Use the existing dev key for now; user will rotate at production |
| TTS engine | Piper (self-hosted) |
| Piper voice | `en_US-ryan-medium` ✅ |
| STT | Web Speech API + text-input fallback |
| Deployment | User handles manually (Docker Compose provided as reference) |
| Repo / git | User handles |

## Kickoff Prompt for Next Chat

When you open the next chat, paste this to start Phase 0 + Phase 1:

> Start Phase 0 and Phase 1 from `IMPLEMENTATION_PLAN.md`. Scaffold the repo (directories, `package.json` stubs, `.env.example`, `.gitignore`, top-level `README.md`) and build the backend skeleton (Fastify + WebSocket + Groq integration via OpenAI SDK + Piper proxy route + health check). Don't deploy anything — just get it runnable locally with `npm run dev`. The Groq API key, voice choice, and GLB path are all locked in the plan.

I'll do everything else from there. You'll only need to:
- `npm install` in `/backend` and `/frontend` when I tell you
- Drop your dev Groq key into `/backend/.env` (I'll create `.env.example` so you know the format)
- Run `npm run dev` and tell me if it starts cleanly
