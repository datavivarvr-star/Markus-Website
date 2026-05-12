// Phase 7 — chat WebSocket client.
// Phase 10 — adds cancelTurn() (barge-in) and handles {type:'cancelled'} ack.
//
// Connects to /api/chat (vite proxy → backend), sends {message, sessionId},
// and dispatches sentence/done/error events to callbacks. Basic exponential
// backoff reconnect so a backend restart during dev recovers without a page
// reload.

const SESSION_STORAGE_KEY = 'markus.sessionId';
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];

export function getOrCreateSessionId() {
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const id = (crypto.randomUUID?.() ?? fallbackUuid());
    localStorage.setItem(SESSION_STORAGE_KEY, id);
    return id;
  } catch {
    // Private mode / storage disabled — generate a per-page session id.
    return fallbackUuid();
  }
}

function fallbackUuid() {
  return 'sid-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function buildChatUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/chat`;
}

export function createChatClient({
  url,
  sessionId,
  onSentence,
  onDone,
  onError,
  onStateChange,
} = {}) {
  if (!url) throw new Error('createChatClient requires url');
  if (!sessionId) throw new Error('createChatClient requires sessionId');

  let ws = null;
  let state = 'connecting'; // 'connecting' | 'open' | 'closed'
  let attempt = 0;
  let reconnectTimer = null;
  let closedByUser = false;
  let inFlight = false;
  // Phase 10 — barge-in: when the user interrupts, we send {type:'cancel'}
  // and flip this flag so any in-transit sentence/done/error events from
  // the aborted turn get dropped instead of bleeding into the next turn.
  let cancelled = false;

  function setState(next) {
    if (state === next) return;
    state = next;
    try { onStateChange?.(state); } catch (err) { console.error('[chat] onStateChange threw', err); }
  }

  function connect() {
    if (closedByUser) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setState('connecting');
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[chat] WebSocket constructor threw:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      attempt = 0;
      setState('open');
      console.info('[chat] ws connected');
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        console.warn('[chat] non-JSON message ignored');
        return;
      }
      switch (msg?.type) {
        case 'sentence':
          if (cancelled) return;
          if (typeof msg.text === 'string' && msg.text.length > 0) {
            try { onSentence?.(msg.text); } catch (err) { console.error('[chat] onSentence threw', err); }
          }
          break;
        case 'done':
          inFlight = false;
          if (cancelled) { cancelled = false; return; }
          try { onDone?.(); } catch (err) { console.error('[chat] onDone threw', err); }
          break;
        case 'cancelled':
          // Server acknowledged a cancel; UI already cleaned up locally.
          inFlight = false;
          cancelled = false;
          break;
        case 'error':
          inFlight = false;
          if (cancelled) { cancelled = false; return; }
          try { onError?.(msg.message || 'unknown_error'); } catch (err) { console.error('[chat] onError threw', err); }
          break;
        default:
          console.warn('[chat] unknown message type:', msg?.type);
      }
    };

    ws.onerror = () => {
      // The browser logs this; rely on onclose for state transitions.
    };

    ws.onclose = (ev) => {
      console.info('[chat] ws closed code=%d reason=%s', ev.code, ev.reason || '');
      ws = null;
      if (inFlight) {
        inFlight = false;
        try { onError?.('disconnected'); } catch {}
      }
      if (closedByUser) {
        setState('closed');
        return;
      }
      setState('connecting');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt++;
    console.info('[chat] reconnect in %dms (attempt %d)', delay, attempt);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendMessage(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (state !== 'open' || !ws || ws.readyState !== WebSocket.OPEN) {
      try { onError?.('not_connected'); } catch {}
      return false;
    }
    if (inFlight) {
      try { onError?.('busy'); } catch {}
      return false;
    }
    inFlight = true;
    cancelled = false;
    try {
      ws.send(JSON.stringify({ message: trimmed, sessionId }));
      return true;
    } catch (err) {
      console.error('[chat] send failed:', err);
      inFlight = false;
      try { onError?.('send_failed'); } catch {}
      return false;
    }
  }

  // Phase 10 — barge-in. Tells the backend to abort the in-flight stream
  // and silently drops any sentence/done/error messages that arrive for the
  // cancelled turn. Returns true if there was a turn to cancel.
  function cancelTurn() {
    if (!inFlight) return false;
    cancelled = true;
    inFlight = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'cancel' })); } catch (err) {
        console.warn('[chat] cancel send failed:', err);
      }
    }
    return true;
  }

  function close() {
    closedByUser = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    setState('closed');
  }

  connect();

  return {
    sendMessage,
    cancelTurn,
    close,
    get state() { return state; },
    get inFlight() { return inFlight; },
    get sessionId() { return sessionId; },
  };
}

// Human-readable strings for the error codes the backend may emit.
export const CHAT_ERROR_MESSAGES = {
  busy: 'Avatar is still replying — please wait a moment.',
  invalid_json: 'Something went wrong with your message.',
  missing_fields: 'Something went wrong with your message.',
  invalid_message: 'Your message could not be sent.',
  llm_not_configured: 'The assistant is not configured yet. (Server is missing its API key.)',
  rate_limited: 'Rate limited — please slow down.',
  // Phase 13 — per-session 200/hour cap. Separate from rate_limited so the
  // user knows it's the session, not the IP.
  session_rate_limited: "You've sent a lot of messages this hour. Take a short break and try again.",
  llm_upstream_error: "I'm having trouble reaching the assistant. Please try again.",
  llm_error: "Something went wrong on the assistant side. Please try again.",
  not_connected: 'Not connected to the server. Reconnecting…',
  send_failed: 'Could not send your message. Please try again.',
  disconnected: 'Disconnected before the reply finished. Reconnecting…',
  unknown_error: 'Unexpected error. Please try again.',
};

export function chatErrorToMessage(code) {
  return CHAT_ERROR_MESSAGES[code] || CHAT_ERROR_MESSAGES.unknown_error;
}
