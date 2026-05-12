# Markus — Real-Time 3D Avatar Chatbot

Self-hosted, low-latency talking 3D avatar. User speaks or types, the avatar replies with lip-synced speech.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full phase-by-phase build plan.

## Stack

- **Frontend** — Vanilla JS + Three.js + Vite (`/frontend`)
- **Backend** — Node 20 + Fastify + WebSocket (`/backend`)
- **LLM** — Groq cloud API (`openai/gpt-oss-20b`) via the OpenAI SDK
- **TTS** — Self-hosted Piper (`/services/piper-tts`) with phoneme timing
- **STT** — Web Speech API (browser, free) + text fallback
- **Avatar** — `assets/Markus_Basic.glb`

## Layout

```
/assets            Markus_Basic.glb (avatar)
/backend           Fastify + WS + Groq + Piper proxy
/frontend          Vite + Three.js app (filled in Phase 2)
/services
  /piper-tts       Python FastAPI wrapper around Piper (Phase 5)
/docker            Compose + Caddyfile reference (Phase 9)
/docs              Blendshape mapping templates, notes
```

## Local Dev (Phase 0 + Phase 1)

Only the backend is wired up so far. The frontend and Piper service come in later phases.

### 1. Configure env

```bash
cp .env.example backend/.env
```

Open `backend/.env` and paste your Groq API key. The other defaults are fine for local dev.

### 2. Run the backend

```bash
cd backend
npm install
npm run dev
```

The server listens on `http://localhost:3000`.

- `GET  /api/health` — service health (Groq configured? Piper reachable?)
- `WS   /api/chat`   — JSON `{ message, sessionId }` → streamed `{ type:'sentence', text }` events
- `POST /api/tts`    — `{ text }` → forwarded to Piper (returns 503 until Phase 5 wires Piper up)

Until the Piper service is built (Phase 5), `/api/tts` and the `piper` branch of `/api/health` will report unavailable. That is expected.

### 3. Smoke-test

```bash
curl http://localhost:3000/api/health
```

WS quick test from a Node REPL or any WS client:

```js
const ws = new WebSocket('ws://localhost:3000/api/chat');
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () => ws.send(JSON.stringify({ message: 'hello', sessionId: 'dev-1' }));
```

You should see one or more `{"type":"sentence","text":"..."}` frames followed by `{"type":"done"}`.

## What's next

Phase 2 — Three.js scene + GLB loading + blendshape dumper script. See the plan.
