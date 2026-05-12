# Deployment & Operations — Markus Avatar

**This is the single source of truth for everything the DevOps team does.**
Initial deploy, routine updates, swapping the avatar model, swapping the
voice, activating optional services — it's all here. As new features land
in the codebase, the relevant ops should be added or amended in this file.

This is a handoff document. It assumes Docker Engine + Docker Compose v2
on the target host, shell access, and basic familiarity with reverse
proxies and TLS. Service-internal reference docs live alongside the code:
- [`services/piper-tts/README.md`](services/piper-tts/README.md) — Piper TTS internals + voice catalogue.
- [`services/whisper/README.md`](services/whisper/README.md) — future self-hosted STT (not deployed).

---

## 1. Architecture

```
   Internet
      │
      ▼
┌─────────────────────┐
│ caddy (markus-caddy)│  ← TLS terminator + static host + reverse proxy
│ :80, :443, :443/udp │
└─────────┬───────────┘
          │ /api/*  (HTTP + WS)
          ▼
┌─────────────────────┐
│ backend             │  ← Fastify, sessions, sentence streaming
│ :3000 (internal)    │
└─────────┬───────────┘
          │ POST /synthesize
          ▼
┌─────────────────────┐
│ piper-tts           │  ← Self-hosted TTS, returns WAV + phoneme timing
│ :8001 (internal)    │
└─────────────────────┘
                              external: Groq cloud API (no service here)
```

Compose handles the service network — names (`backend`, `piper-tts`)
resolve inside the network; no port mapping is required between services.
The LLM is a cloud dependency (Groq), so there is no model server to host
or warm up.

The backend self-warms at startup (one tiny Groq call + one tiny Piper
synthesis in parallel) so the first user turn pays only steady-state
latency. The frontend also pings `/api/warmup` on page load to re-warm
after long idles. See §9 for the endpoint contract.

---

## 2. Prerequisites

- Docker Engine + Docker Compose v2 (`docker compose ...`, not `docker-compose`)
- ~1.5 GB free disk for images + voice models
- Public DNS A record pointing at the host (for HTTPS only)
- Ports 80 + 443 open inbound (HTTPS only — Caddy needs both for ACME)
- Outbound HTTPS to `api.groq.com` and `acme-v02.api.letsencrypt.org`

---

## 3. One-time setup

Run on the target host.

```sh
# 1. Clone
git clone <repo-url> markus-website
cd markus-website

# 2. Env file
cp .env.example .env
# Edit .env and fill in at minimum:
#   DOMAIN          → "markus.example.com" (or ":80" if you front it with another proxy)
#   GROQ_API_KEY    → a valid Groq key from console.groq.com
#   ALLOWED_ORIGIN  → "https://markus.example.com" recommended for prod
# Optional:
#   LETSENCRYPT_EMAIL → uncomment the email line in Caddyfile if you set this

# 3. Voice files — required, not in git
#    The default voice is en_US-ryan-medium. Place both files into
#    services/piper-tts/voices/:
#      en_US-ryan-medium.onnx       (~63 MB, the model)
#      en_US-ryan-medium.onnx.json  (a few KB, the config)
#
#    Easiest path: use the script in the piper service.
bash services/piper-tts/scripts/download-voice.sh en_US-ryan-medium
# Windows PowerShell equivalent:
# .\services\piper-tts\scripts\download-voice.ps1 -Voice en_US-ryan-medium

# 4. Bring it up
docker compose -f docker-compose.yml up -d --build
```

First start takes ~3–5 minutes (image builds + Caddy ACME on first HTTPS
request). After that, `docker compose up -d` is near-instant.

---

## 4. Bring it up — variations

**Production** (skips the dev override):
```sh
docker compose -f docker-compose.yml up -d --build
```

**Local dev** (auto-loads `docker-compose.override.yml` → plain HTTP on
host port `:8080`, backend `:3000` and piper `:8001` exposed for ad-hoc
debugging):
```sh
docker compose up -d --build
```

---

## 5. Verify

```sh
# All three services should report healthy:
docker compose ps

# End-to-end smoke (production hostname):
curl -fsS https://markus.example.com/api/health
# → {"ok":true,"services":{"groq":{...},"piper":{"ok":true,...}}, ...}

# In dev (override active):
curl -fsS http://localhost:8080/api/health
# or hit the services directly:
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:8001/health
```

Open `https://markus.example.com/` in Chrome → avatar should load, mic
button visible, text input ready. Type "hello" and submit → avatar should
reply within ~1–2 s.

---

## 6. Logs

```sh
docker compose logs -f                 # all services
docker compose logs -f backend         # one service
docker compose logs --tail=200 caddy   # last 200 lines
```

- **Backend** emits structured JSON logs (pino). Each chat turn has a
  `ttft_ms` and `total_ms` field — useful for latency tuning. Phase 13 added
  three security-relevant log lines: `chat.injection_blocked`,
  `chat.session_rate_limited`, and `chat.llm_down_canned_reply`. Grep for
  those if you need to audit user-side incidents.
- **Caddy** logs to stdout in console format.
- **Piper** uses Python `logging`; each `/synthesize` call logs `audio_ms`,
  `phonemes`, `took_ms`.

All three services use the Docker `json-file` log driver capped at
**3 × 10 MB per service** (configured in `docker-compose.yml` under each
service's `logging:` block). Old segments are rotated and discarded
automatically — no `logrotate` needed. If you need longer retention, point
a log shipper (Loki / Vector / Fluent Bit) at the engine instead of
raising the on-disk cap.

---

## 7. Operational tasks

### 7.1 Routine update (any change)

```sh
git pull
docker compose -f docker-compose.yml up -d --build
```

Compose recreates only containers whose image actually changed. If you
suspect a stale cache, force everything:
```sh
docker compose -f docker-compose.yml up -d --build --force-recreate
```

### 7.2 Frontend-only changes (UI tweaks, blendshape mapping update)

The frontend is baked into the **caddy** image at build time. After any
change in `frontend/`, `assets/`, or `docs/blendshape-mapping.json`:
```sh
docker compose -f docker-compose.yml up -d --build caddy
```

Users will need a hard refresh (`Ctrl+F5` / `Cmd+Shift+R`) if the GLB or
unhashed assets changed; the rest is cache-busted by Vite's hashed
filenames automatically.

### 7.3 Backend-only changes

```sh
docker compose -f docker-compose.yml up -d --build backend
```

### 7.4 Swap in a new avatar GLB

The live avatar is `assets/Markus_final.glb` — the rigged model delivered
by the 3D modeller, with the 15 Oculus visemes + `eyeBlinkLeft` /
`eyeBlinkRight` morph targets and a standard humanoid skeleton (Head,
spine2, arms, legs). Two morphs in this export use a double-underscore
prefix (`viseme__I`, `viseme__O`) and are mapped in
`docs/blendshape-mapping.json`.

If the modeller delivers a new revision, follow this exact flow:

1. **Drop the new file** at `assets/Markus_final.glb` (overwrite — code
   references this exact path via `frontend/src/main.js` and
   `frontend/scripts/dump-blendshapes.js`). If you want to ship under a
   different filename, update those two references too.
2. The frontend dev / Claude runs `npm run dump-blendshapes` in `frontend/`
   to enumerate the morph target names, then reconciles them against
   `docs/blendshape-mapping.json` — adding any new spellings to the
   candidate arrays for the affected visemes.
3. The frontend dev opens `http(s)://<domain>/?test=visemes` and visually
   verifies each of the 15 visemes; any that look wrong get fixed in the
   mapping JSON.
4. **DevOps step** — rebuild the caddy image so the new GLB and mapping
   are baked in:
   ```sh
   docker compose -f docker-compose.yml up -d --build caddy
   ```
5. Tell users to hard-refresh (or wait up to 1 hour for the GLB cache
   header to expire).

No backend / piper restart is needed.

### 7.5 Swap the Piper voice

To switch from the default `en_US-ryan-medium` to another voice (e.g. a
female voice or a non-English voice):

1. Download the new voice files into `services/piper-tts/voices/`. Both
   files (`<name>.onnx` and `<name>.onnx.json`) must be present.
   ```sh
   bash services/piper-tts/scripts/download-voice.sh en_GB-alan-medium
   ```
   See [`services/piper-tts/README.md`](services/piper-tts/README.md) for
   the voice catalogue.
2. Update `PIPER_VOICE` (and `PIPER_ESPEAK_VOICE` if the language differs)
   in `.env`:
   ```
   PIPER_VOICE=en_GB-alan-medium
   PIPER_ESPEAK_VOICE=en-gb
   ```
3. Restart only Piper:
   ```sh
   docker compose -f docker-compose.yml up -d piper-tts
   ```
4. Verify:
   ```sh
   curl http://localhost:8001/health
   # → "voice": "en_GB-alan-medium", "voice_loaded": true
   ```

Voices are bind-mounted, so no rebuild is required. The mount masks the
`COPY voices/` line in the Piper Dockerfile — you don't need to rebuild
the Piper image to add voices.

### 7.6 Activate self-hosted Whisper STT (post-launch upgrade)

The site currently uses the browser's Web Speech API for STT. There is a
reserved slot at [`services/whisper/`](services/whisper/) for a future
swap to a self-hosted whisper.cpp server. The full activation steps
(rename `Dockerfile.example` → `Dockerfile`, download a model, add a
compose service, add a backend route, swap the frontend STT module) are
documented in [`services/whisper/README.md`](services/whisper/README.md).

Trigger this when any of these become true:
- User complaints about transcription accuracy
- Firefox usage becomes non-trivial (browser Web Speech API doesn't exist there)
- Privacy / offline requirement
- Latency from Google's cloud STT becomes the limiting factor

### 7.7 Update the Groq API key (rotation, vendor change)

1. Generate a fresh key at console.groq.com.
2. Update `GROQ_API_KEY` in `.env` on the host.
3. Restart only the backend (no rebuild needed — it reads env at boot):
   ```sh
   docker compose -f docker-compose.yml up -d backend
   ```

### 7.8 Switch Groq model

Set `GROQ_MODEL` in `.env` to a different model that your account has
access to. Options:
- `openai/gpt-oss-20b` (current default — good quality, mid-latency)
- `llama-3.1-8b-instant` (fastest TTFT on Groq, slightly lower quality)
- `llama-3.3-70b-versatile` (higher quality, higher TTFT)

Then restart the backend:
```sh
docker compose -f docker-compose.yml up -d backend
```

### 7.9 Roll back

```sh
git checkout <previous-tag-or-commit>
docker compose -f docker-compose.yml up -d --build
```

Caddy's TLS certs live in the `caddy-data` named volume, so HTTPS keeps
working through rollbacks without re-issuing certs.

---

## 8. Configuration reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DOMAIN` | yes | — | `your.domain.com` (HTTPS) or `:80` (plain HTTP). |
| `LETSENCRYPT_EMAIL` | no | — | Optional. To use, uncomment the `email` line in `Caddyfile` and set this. |
| `GROQ_API_KEY` | yes | — | From console.groq.com. |
| `GROQ_BASE_URL` | no | `https://api.groq.com/openai/v1` | |
| `GROQ_MODEL` | no | `openai/gpt-oss-20b` | See §7.8 for alternates. |
| `PIPER_URL` | no | `http://piper-tts:8001` | Internal compose URL. |
| `PIPER_VOICE` | no | `en_US-ryan-medium` | Must match a `<name>.onnx` pair in `services/piper-tts/voices/`. |
| `PIPER_ESPEAK_VOICE` | no | `en-us` | espeak-ng voice for phonemization; only affects lipsync timing, not audio. |
| `ALLOWED_ORIGIN` | no | `*` | Lock to your domain in prod if you want strict CORS. |
| `PORT` | no | `3000` | Backend port (inside the network). |
| `HOST` | no | `0.0.0.0` | Backend bind. |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error`. |

Phase 13 also fixes two transport limits in code (not env-tunable):
- **WS frame cap: 10 KB.** Real chat messages are ~600 B; this caps the abuse surface. If a future feature legitimately needs larger inbound messages, raise `wsMaxPayloadBytes` in `backend/src/config.js`.
- **Session rate limit: 200 turns / hour.** Per `sessionId`, sliding window. Layered on top of the IP-level 60/min limit so a single tab can't burn one IP's whole allowance.

Missing required vars cause `docker compose up` to exit immediately with a
readable error.

---

## 9. Health endpoints

| Service | Endpoint | What it reports |
|---|---|---|
| caddy | `http://127.0.0.1/` | Returns the SPA index.html (sanity). |
| backend | `http://127.0.0.1:3000/api/health` | Groq configured? Piper reachable? Session count. |
| backend | `http://127.0.0.1:3000/api/warmup` | Current warmup status (`cold` / `warming` / `warm` / `error` / `disabled`) for Groq + Piper. GET also re-triggers warmup if cold or in `error` state — idempotent and rate-limit exempt. The frontend calls this on page load. |
| piper-tts | `http://127.0.0.1:8001/health` | Loaded voice, sample rate, espeak voice. |

For external monitoring, point UptimeRobot / equivalent at
`https://{DOMAIN}/api/health`. Do not point uptime checks at
`/api/warmup` — it will fire a real Groq + Piper call every probe.

---

## 10. Common issues

**Caddy can't get a certificate.** DNS hasn't propagated, port 80 is
blocked, or `DOMAIN` doesn't match the live A record. Caddy logs the ACME
error verbatim — read `docker compose logs caddy`.

**Backend logs `GROQ_API_KEY is not set`.** `.env` not read, or the
variable is empty. Verify with `docker compose config` — it shows what
Compose actually parsed.

**Piper logs `voice files missing`.** The `.onnx` + `.onnx.json` pair
isn't in `services/piper-tts/voices/`. The container starts but `/health`
returns `{"ok": false, "voice_loaded": false}` and `/api/tts` returns 503.

**`/api/tts` returns 503 even though Piper is healthy.** Usually a
mismatched `PIPER_VOICE` — the env names a voice that isn't on disk.
Check `docker compose logs piper-tts` for the exact filename it expected.

**WebSocket disconnects every minute.** Some load balancers in front of
Caddy idle-time out long-lived connections. The frontend reconnects with
exponential backoff so users mostly don't notice, but if you see it, raise
the LB's idle timeout to ≥120 s.

**Update changed nothing.** Use `--build --force-recreate` to force a
rebuild and redeploy of all containers, not just the ones with new images.

**Hard-refresh isn't picking up the new GLB.** Caddy serves the GLB with
`Cache-Control: max-age=3600`. Either wait an hour, change the GLB file
hash, or temporarily lower the cache header in `Caddyfile` and reload
Caddy.

**Avatar speaks but mouth doesn't move.** The runtime resolver couldn't
match the rigged GLB's morph target names to the Oculus visemes. Check
the browser console for `[visemes] resolved N/15` — anything under 15/15
means specific visemes failed to bind. Run `npm run dump-blendshapes` in
`frontend/` to inspect the actual morph names and add the missing
spellings to `docs/blendshape-mapping.json` (§7.4 step 2). Reload after
rebuilding the caddy image.

**Avatar replies but no audio on iPhone Safari.** Confirm the user tapped
a UI element (mic or send) before the first reply — iOS requires a user
gesture to unlock the AudioContext. The frontend warms the context on
every gesture; if this is still broken, capture the device + iOS version
and check console for `AudioContext` errors.

**Avatar speaks with a generic robotic voice and no lipsync.** Piper is
unreachable from the backend. The frontend has fallen back to the
browser's built-in `SpeechSynthesisUtterance`, which carries no phoneme
timing so the mouth stays at rest. The transcript shows a one-time
notice ("Voice synthesis is offline…"). Check `docker compose ps`
piper-tts health and `docker compose logs piper-tts` — once Piper is
healthy, the next reply uses Piper again (no client reload required).

**Avatar replies "I'm having a bit of trouble thinking right now…"
repeatedly.** Phase 13's canned LLM-down reply (the backend speaks this
through the normal TTS + lipsync path so the avatar doesn't go silent).
Means Groq returned a 5xx or otherwise non-429 error. Grep
`chat.llm_down_canned_reply` in backend logs for the exact upstream
status. Common causes: expired `GROQ_API_KEY`, account suspension, or
Groq incident — `status.groq.com`.

**A user sees "You've sent a lot of messages this hour…".** Phase 13's
per-session 200/hour cap kicked in. Grep `chat.session_rate_limited` in
backend logs to confirm. Legitimate during stress tests; if it trips on
real users frequently, raise `sessionRateLimit.maxTurnsPerHour` in
`backend/src/config.js` after auditing why.

**Mic button is hidden on a user's browser.** Either Firefox (no
`SpeechRecognition` at all — text-only is the documented fallback) or
the feature-detect failed for some other reason. Have the user try
Chrome / Edge / Safari. The Whisper escape hatch at
[services/whisper/](services/whisper/) is the long-term fix.

---

## 11. What this stack does NOT include (deferred)

By design, not in scope for the first launch:

- Persistent log shipping (logs are stdout, captured by the Docker engine).
- Metrics / Prometheus exporters.
- Backup of `caddy-data` (cert renewals are automatic; loss = re-issue).
- Self-hosted STT (see §7.6).
- Self-hosted LLM (Groq cloud handles this).
- Direct speech-to-speech model (post-launch backlog — see
  `IMPLEMENTATION_PLAN.md` "Post-Demo Backlog").

---

## 12. Maintenance

When a new phase lands in the codebase, **update this document** for any
of the following:
- New service added or removed → §1 architecture, §8 config reference.
- New required / optional env var → §8 config reference.
- New operational workflow (swap, rotate, activate) → §7.
- New common failure mode → §10.
- Service contract changes (new health endpoint, new port) → §9.

Keep entries terse and action-oriented — DevOps reads this when something
is broken or a deploy is overdue, not for leisure.
