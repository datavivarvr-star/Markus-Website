import { randomUUID } from 'node:crypto';
import { groq, SYSTEM_PROMPT } from '../groq.js';
import { config } from '../config.js';
import { appendTurn, getSession, checkSessionRate, recordTurn } from '../sessions.js';
import { createSentenceBuffer } from '../utils/sentence-buffer.js';
import {
  sanitizeUserMessage,
  isLikelyPromptInjection,
  INJECTION_DEFLECTION,
  LLM_DOWN_REPLY,
} from '../utils/safety.js';

const MAX_MESSAGE_CHARS = 2000;

function send(socket, obj) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(obj));
  } catch {
    // swallow — client likely disconnected
  }
}

// Phase 13 — emit a canned reply through the normal sentence/done pipeline
// so it gets TTS + lipsync like any other turn. Used for prompt-injection
// deflection and the LLM-down fallback.
function sendCannedReply(socket, text) {
  send(socket, { type: 'sentence', text });
  send(socket, { type: 'done' });
}

function isAbortError(err) {
  if (!err) return false;
  const name = err.name || err.constructor?.name || '';
  return (
    name === 'AbortError' ||
    name === 'APIUserAbortError' ||
    err.code === 'ABORT_ERR' ||
    err.message === 'aborted'
  );
}

export async function chatRoute(app) {
  app.get('/api/chat', { websocket: true }, (socket, req) => {
    const connId = randomUUID();
    const log = req.log.child({ ws: connId });
    log.info('chat.connect');

    let inFlight = false;
    let currentAbort = null;

    socket.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'error', message: 'invalid_json' });
        return;
      }

      // Phase 10 — barge-in: client tapped mic during streaming reply.
      // Abort the Groq stream so it stops generating; the in-flight loop
      // catches the abort, persists whatever was streamed, and emits
      // {type:'cancelled'} for symmetry with done/error.
      if (payload?.type === 'cancel') {
        if (currentAbort) {
          try { currentAbort.abort(); } catch {}
        }
        return;
      }

      if (inFlight) {
        send(socket, { type: 'error', message: 'busy' });
        return;
      }

      const { message, sessionId } = payload ?? {};
      if (typeof message !== 'string' || typeof sessionId !== 'string') {
        send(socket, { type: 'error', message: 'missing_fields' });
        return;
      }
      // Phase 13 — strip control chars before length/empty checks so a
      // hostile client can't smuggle past validation with NULs.
      const sanitized = sanitizeUserMessage(message);
      if (!sanitized || sanitized.length > MAX_MESSAGE_CHARS) {
        send(socket, { type: 'error', message: 'invalid_message' });
        return;
      }

      // Phase 13 — per-session hourly rate limit. Layered on top of the
      // IP-level limit so one tab can't burn the whole NAT allowance.
      const rate = checkSessionRate(sessionId);
      if (!rate.allowed) {
        log.warn({ sessionId, retryAfterMs: rate.retryAfterMs }, 'chat.session_rate_limited');
        send(socket, { type: 'error', message: 'session_rate_limited' });
        return;
      }

      if (!config.groq.apiKey) {
        send(socket, { type: 'error', message: 'llm_not_configured' });
        return;
      }

      // Phase 13 — naive prompt-injection guard. Catches the most obvious
      // "ignore previous instructions" variants and short-circuits with a
      // canned deflection that flows through TTS like a normal turn.
      if (isLikelyPromptInjection(sanitized)) {
        log.info({ sessionId, len: sanitized.length }, 'chat.injection_blocked');
        recordTurn(sessionId);
        appendTurn(sessionId, 'user', sanitized);
        appendTurn(sessionId, 'assistant', INJECTION_DEFLECTION);
        sendCannedReply(socket, INJECTION_DEFLECTION);
        return;
      }

      inFlight = true;
      const session = getSession(sessionId);
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages,
        { role: 'user', content: sanitized },
      ];

      const t0 = performance.now();
      let firstTokenMs = null;
      let full = '';
      const buf = createSentenceBuffer((sentence) => send(socket, { type: 'sentence', text: sentence }));
      const abort = new AbortController();
      currentAbort = abort;

      try {
        const stream = await groq.chat.completions.create(
          {
            model: config.groq.model,
            messages,
            stream: true,
            temperature: config.groq.temperature,
            max_tokens: config.groq.maxTokens,
          },
          { signal: abort.signal },
        );

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (!delta) continue;
          if (firstTokenMs == null) firstTokenMs = performance.now() - t0;
          full += delta;
          buf.push(delta);
        }
        buf.flush();

        if (full.trim()) {
          recordTurn(sessionId);
          appendTurn(sessionId, 'user', sanitized);
          appendTurn(sessionId, 'assistant', full.trim());
        }

        send(socket, { type: 'done' });
        log.info(
          {
            sessionId,
            ttft_ms: firstTokenMs != null ? Math.round(firstTokenMs) : null,
            total_ms: Math.round(performance.now() - t0),
            reply_chars: full.length,
          },
          'chat.complete',
        );
      } catch (err) {
        if (isAbortError(err) || abort.signal.aborted) {
          // Persist whatever was actually streamed so session history stays
          // consistent with what the user heard. buf.flush is unsafe after
          // an abort (it might emit a half-finished sentence), so skip it.
          if (full.trim()) {
            recordTurn(sessionId);
            appendTurn(sessionId, 'user', sanitized);
            appendTurn(sessionId, 'assistant', full.trim());
          }
          send(socket, { type: 'cancelled' });
          log.info(
            {
              sessionId,
              ttft_ms: firstTokenMs != null ? Math.round(firstTokenMs) : null,
              total_ms: Math.round(performance.now() - t0),
              reply_chars: full.length,
            },
            'chat.cancelled',
          );
        } else {
          const status = err?.status ?? err?.response?.status;
          log.error({ err: err?.message, status }, 'chat.error');
          if (status === 429) {
            send(socket, { type: 'error', message: 'rate_limited' });
          } else {
            // Phase 13 — LLM unavailable: speak a canned reply instead of
            // going silent. Don't persist this fake reply in session
            // history; the next real turn should see the user's question
            // unanswered. The frontend treats this as a normal turn so
            // the avatar's mouth actually moves (TTS + lipsync run).
            log.warn({ sessionId }, 'chat.llm_down_canned_reply');
            sendCannedReply(socket, LLM_DOWN_REPLY);
          }
        }
      } finally {
        inFlight = false;
        currentAbort = null;
      }
    });

    socket.on('close', () => {
      if (currentAbort) {
        try { currentAbort.abort(); } catch {}
      }
      log.info('chat.disconnect');
    });
    socket.on('error', (err) => log.warn({ err: err?.message }, 'chat.socket_error'));
  });
}
