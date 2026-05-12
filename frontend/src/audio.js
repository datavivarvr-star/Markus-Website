// Phase 6 — audio playback + TTS sentence queue.
//
// Lazily creates a single AudioContext on first user gesture (iOS rule).
// `createSpeaker` exposes speakSentence(text) which fetches /api/tts, decodes
// the WAV, and plays sentences serially. Sentence N+1 starts fetching as soon
// as it is enqueued, so by the time sentence N finishes playing, N+1 is
// usually already decoded — hides backend latency.

const TTS_ENDPOINT = '/api/tts';
const TTS_TIMEOUT_MS = 15000;

let _ctx = null;
let _gestureHookInstalled = false;

export function ensureAudioContext() {
  if (!_ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext not supported in this browser');
    _ctx = new Ctor();
  }
  if (_ctx.state === 'suspended') {
    _ctx.resume().catch((err) => console.warn('[audio] resume failed:', err));
  }
  if (!_gestureHookInstalled) {
    _gestureHookInstalled = true;
    const resume = () => {
      if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume, { capture: true });
    window.addEventListener('keydown', resume, { capture: true });
    window.addEventListener('touchstart', resume, { capture: true, passive: true });
  }
  return _ctx;
}

export function getAudioContext() {
  return _ctx;
}

async function fetchTts(text, signal) {
  const timer = setTimeout(() => signal?.abort?.(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body?.error || detail;
      } catch {}
      throw new Error(`tts_${res.status}: ${detail}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function createSpeaker({
  audioCtx,
  onSpeechStart,
  onSpeechEnd,
  onSentenceStart,
  onSentenceEnd,
  onError,
} = {}) {
  if (!audioCtx) throw new Error('createSpeaker requires an audioCtx');

  // Items: { text, fetchPromise, abort, decodedPromise }
  const queue = [];
  let isPlaying = false;
  let stopRequested = false;
  let currentSource = null;

  function speakSentence(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const ac = new AbortController();
    const fetchPromise = fetchTts(trimmed, ac.signal).catch((err) => {
      console.error('[audio] tts fetch failed:', err);
      onError?.(err);
      return null;
    });
    queue.push({ text: trimmed, fetchPromise, abort: () => ac.abort() });
    _drain();
  }

  async function _drain() {
    if (isPlaying) return;
    isPlaying = true;
    stopRequested = false;
    onSpeechStart?.();
    while (queue.length > 0 && !stopRequested) {
      const item = queue.shift();
      let data;
      try {
        data = await item.fetchPromise;
      } catch (err) {
        console.error('[audio] await fetch failed:', err);
        continue;
      }
      if (stopRequested) break;
      if (!data) continue;
      try {
        await _playOne(data);
      } catch (err) {
        console.error('[audio] playback failed:', err);
        onError?.(err);
      }
    }
    currentSource = null;
    isPlaying = false;
    onSpeechEnd?.();
  }

  async function _playOne(data) {
    const arr = base64ToArrayBuffer(data.audio_b64);
    // decodeAudioData accepts a transferable ArrayBuffer; clone to avoid issues on Safari.
    const audioBuffer = await audioCtx.decodeAudioData(arr.slice(0));

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    // Tiny lead-in so scheduled start is in the future relative to currentTime.
    const startAt = audioCtx.currentTime + 0.03;
    const durationMs =
      typeof data.audio_ms === 'number' ? data.audio_ms : Math.round(audioBuffer.duration * 1000);

    onSentenceStart?.({
      phonemes: Array.isArray(data.phonemes) ? data.phonemes : [],
      audioStartTime: startAt,
      durationMs,
      sampleRate: data.sample_rate,
      timingSource: data.timing_source,
    });

    source.start(startAt);
    currentSource = source;

    await new Promise((resolve) => {
      source.onended = () => resolve();
    });

    if (currentSource === source) currentSource = null;
    onSentenceEnd?.();
  }

  function stop() {
    stopRequested = true;
    for (const item of queue) {
      try { item.abort?.(); } catch {}
    }
    queue.length = 0;
    if (currentSource) {
      try {
        currentSource.onended = null;
        currentSource.stop();
      } catch {}
      currentSource = null;
    }
  }

  return {
    speakSentence,
    stop,
    get isPlaying() { return isPlaying; },
    get queueLength() { return queue.length; },
  };
}
