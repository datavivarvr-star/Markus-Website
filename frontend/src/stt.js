// Phase 8 — Web Speech API wrapper.
//
// Tap-to-talk model: caller invokes start() inside a user gesture; the
// browser handles the mic permission prompt. We collect interim transcripts
// for live display and emit one onFinal(text) when the utterance ends.
//
// Phase 8 also reserves /services/whisper/ as the future self-hosted STT
// upgrade path (see services/whisper/README.md). When that lands, the chat
// glue stays the same — only this module gets swapped.

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

export function isSttSupported() {
  return !!SpeechRecognitionImpl;
}

export function createStt({
  onInterim,
  onFinal,
  onStateChange,
  onError,
  lang = 'en-US',
} = {}) {
  if (!SpeechRecognitionImpl) {
    throw new Error('SpeechRecognition not supported in this browser');
  }

  let recognition = null;
  let state = 'idle'; // 'idle' | 'starting' | 'listening'
  let finalBuf = '';
  let lastInterim = '';
  // Tracks an explicit user-initiated stop so we don't try to interpret the
  // browser's onend as a "no speech" silent failure.
  let userStopped = false;

  function setState(next) {
    if (state === next) return;
    state = next;
    try { onStateChange?.(state); } catch (err) { console.error('[stt] onStateChange threw', err); }
  }

  function emitFinal() {
    const text = finalBuf.trim();
    finalBuf = '';
    lastInterim = '';
    if (text) {
      try { onFinal?.(text); } catch (err) { console.error('[stt] onFinal threw', err); }
    }
  }

  function buildRecognition() {
    const rec = new SpeechRecognitionImpl();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = lang;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setState('listening');
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalBuf = finalBuf
            ? `${finalBuf} ${transcript.trim()}`
            : transcript.trim();
        } else {
          interim += transcript;
        }
      }
      const live = (finalBuf + ' ' + interim).trim();
      if (live !== lastInterim) {
        lastInterim = live;
        try { onInterim?.(live); } catch (err) { console.error('[stt] onInterim threw', err); }
      }
    };

    rec.onerror = (event) => {
      const code = event?.error || 'unknown';
      // Always log the raw event for diagnostics — the user-facing message
      // collapses several codes into the same text, so console is the only
      // place the actual failure code lives.
      if (code !== 'aborted') {
        console.warn(
          '[stt] error: code=%s message=%s (browser-side; see Web Speech API spec for codes)',
          code,
          event?.message ?? '',
        );
      }
      // `aborted` happens on stop() — not an error from the user's perspective.
      // `no-speech` is the silent-timeout case; surface separately so callers
      // can choose to ignore it.
      if (code !== 'aborted') {
        try { onError?.(code); } catch (err) { console.error('[stt] onError threw', err); }
      }
    };

    rec.onend = () => {
      const wasListening = state === 'listening' || state === 'starting';
      setState('idle');
      recognition = null;
      if (wasListening) emitFinal();
      userStopped = false;
    };

    return rec;
  }

  function start() {
    if (state !== 'idle') return false;
    finalBuf = '';
    lastInterim = '';
    userStopped = false;
    setState('starting');
    try {
      recognition = buildRecognition();
      recognition.start();
      return true;
    } catch (err) {
      console.error('[stt] start failed:', err);
      setState('idle');
      recognition = null;
      try { onError?.('start_failed'); } catch {}
      return false;
    }
  }

  function stop() {
    if (state === 'idle' || !recognition) return;
    userStopped = true;
    try {
      recognition.stop();
    } catch (err) {
      console.warn('[stt] stop failed:', err);
    }
  }

  function abort() {
    if (!recognition) {
      setState('idle');
      return;
    }
    userStopped = true;
    finalBuf = '';
    lastInterim = '';
    try {
      recognition.abort();
    } catch {}
    setState('idle');
    recognition = null;
  }

  return {
    start,
    stop,
    abort,
    get state() { return state; },
  };
}

export const STT_ERROR_MESSAGES = {
  'not-allowed': 'Microphone access was blocked. Allow microphone permission to talk to the avatar.',
  'service-not-allowed': 'Microphone access was blocked by the browser or system.',
  'audio-capture': 'No microphone detected. Plug one in and try again.',
  // The Web Speech API routes audio to a vendor cloud (Google for Chrome,
  // Microsoft for Edge, Apple for Safari). `network` means that cloud is
  // unreachable — typical on Brave / Arc / ungoogled Chromium variants
  // that strip the Google API key. The user's actual internet is fine.
  'network': "Your browser's speech recognition is unavailable. Try Chrome, Edge, or Safari — or use the text box.",
  'language-not-supported': 'This browser does not support English speech recognition.',
  'no-speech': "I didn't catch that. Tap the mic and try again.",
  'start_failed': 'Could not start the microphone. Try again.',
  unknown: 'Speech recognition error. Please try again.',
};

export function sttErrorToMessage(code) {
  return STT_ERROR_MESSAGES[code] || STT_ERROR_MESSAGES.unknown;
}
