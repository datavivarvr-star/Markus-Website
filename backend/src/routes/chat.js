import { randomUUID } from 'node:crypto';
import { groq, SYSTEM_PROMPT } from '../groq.js';
import { config } from '../config.js';
import { appendTurn, getSession } from '../sessions.js';
import { createSentenceBuffer } from '../utils/sentence-buffer.js';

const MAX_MESSAGE_CHARS = 2000;

function send(socket, obj) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(obj));
  } catch {
    // swallow — client likely disconnected
  }
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
      const trimmed = message.trim();
      if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS) {
        send(socket, { type: 'error', message: 'invalid_message' });
        return;
      }

      if (!config.groq.apiKey) {
        send(socket, { type: 'error', message: 'llm_not_configured' });
        return;
      }

      inFlight = true;
      const session = getSession(sessionId);
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages,
        { role: 'user', content: trimmed },
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
          appendTurn(sessionId, 'user', trimmed);
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
            appendTurn(sessionId, 'user', trimmed);
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
          const code = status === 429 ? 'rate_limited' : status >= 500 ? 'llm_upstream_error' : 'llm_error';
          send(socket, { type: 'error', message: code });
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
