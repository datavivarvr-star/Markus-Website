// Phase 10 — pre-warming.
//
// Pokes Groq + Piper once at boot so the first real user turn doesn't pay
// cold-start latency (DNS/TLS to api.groq.com, ONNX runtime JIT in Piper).
// Idempotent: callable from the /api/warmup route to re-warm after a long
// idle without restarting the backend.

import { groq } from './groq.js';
import { config } from './config.js';

const TIMEOUT_MS = 8000;

let state = {
  groq: config.groq.apiKey ? 'cold' : 'disabled',
  piper: 'cold',
  startedAt: null,
  finishedAt: null,
};

let groqPromise = null;
let piperPromise = null;

async function warmGroq(log) {
  if (state.groq === 'disabled' || state.groq === 'warm' || state.groq === 'warming') {
    return groqPromise ?? Promise.resolve();
  }
  state.groq = 'warming';
  const t0 = Date.now();
  groqPromise = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        await groq.chat.completions.create(
          {
            model: config.groq.model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
            temperature: 0,
            stream: false,
          },
          { signal: ctrl.signal },
        );
      } finally {
        clearTimeout(timer);
      }
      state.groq = 'warm';
      log?.info({ took_ms: Date.now() - t0 }, 'warmup.groq.ok');
    } catch (err) {
      state.groq = 'error';
      log?.warn({ err: err?.message, took_ms: Date.now() - t0 }, 'warmup.groq.fail');
    } finally {
      groqPromise = null;
    }
  })();
  return groqPromise;
}

async function warmPiper(log) {
  if (state.piper === 'warm' || state.piper === 'warming') {
    return piperPromise ?? Promise.resolve();
  }
  state.piper = 'warming';
  const t0 = Date.now();
  piperPromise = (async () => {
    try {
      const res = await fetch(`${config.piperUrl}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'a' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`piper_${res.status}`);
      // Drain the body so the socket can close cleanly.
      await res.arrayBuffer().catch(() => {});
      state.piper = 'warm';
      log?.info({ took_ms: Date.now() - t0 }, 'warmup.piper.ok');
    } catch (err) {
      state.piper = 'error';
      log?.warn({ err: err?.message, took_ms: Date.now() - t0 }, 'warmup.piper.fail');
    } finally {
      piperPromise = null;
    }
  })();
  return piperPromise;
}

export function warmupAll(log) {
  if (!state.startedAt) state.startedAt = Date.now();
  const tasks = [];
  if (state.groq === 'cold' || state.groq === 'error') tasks.push(warmGroq(log));
  if (state.piper === 'cold' || state.piper === 'error') tasks.push(warmPiper(log));
  if (tasks.length === 0) return Promise.resolve();
  return Promise.allSettled(tasks).then(() => {
    state.finishedAt = Date.now();
  });
}

export function getWarmupStatus() {
  return {
    groq: state.groq,
    piper: state.piper,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}
