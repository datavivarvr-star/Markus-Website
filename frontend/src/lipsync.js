// Phase 6 — lipsync renderer.
//
// Builds a viseme queue from Piper's per-phoneme timing and drives the
// VisemeRig from the render loop, using the AudioContext clock for sync.

import { phonemeToViseme } from './visemes.js';

// Word separator emitted by the piper-tts service between words.
const WORD_BREAK_TOKEN = '_';
// If the first phoneme starts later than this, prepend an explicit `sil`
// anchor at t=0 so the mouth begins closed.
const LEADING_SIL_THRESHOLD_MS = 30;
// Fallback segment length when there is no `next` viseme (last segment).
const TRAILING_SEGMENT_MS = 80;

export function buildVisemeQueue(phonemes, durationMs) {
  const dur = Math.max(0, Number(durationMs) || 0);

  if (!Array.isArray(phonemes) || phonemes.length === 0) {
    return [
      { id: 'sil', t: 0 },
      { id: 'sil', t: dur },
    ];
  }

  const out = [];
  let lastId = null;
  for (const ph of phonemes) {
    const token = ph?.p ?? '';
    const id = token === WORD_BREAK_TOKEN ? 'sil' : phonemeToViseme(token);
    const t = Math.max(0, Number(ph?.t0_ms) || 0);
    if (id !== lastId) {
      out.push({ id, t });
      lastId = id;
    }
  }

  if (out.length === 0) out.push({ id: 'sil', t: 0 });
  if (out[0].t > LEADING_SIL_THRESHOLD_MS) out.unshift({ id: 'sil', t: 0 });
  // Bookend with sil so the mouth closes at the end of the utterance.
  const last = out[out.length - 1];
  if (last.id !== 'sil' || last.t < dur) {
    out.push({ id: 'sil', t: dur });
  }
  return out;
}

export function createLipsync({ audioCtx, visemeRig, expressiveRig }) {
  if (!audioCtx) throw new Error('createLipsync requires an audioCtx');
  if (!visemeRig) throw new Error('createLipsync requires a visemeRig');

  let queue = null;
  let startAt = 0; // audioCtx.currentTime in seconds
  let durationMs = 0;
  let active = false;
  let cachedIdx = 0; // monotonic cursor for the linear scan

  function startSentence({ phonemes, audioStartTime, durationMs: dMs }) {
    queue = buildVisemeQueue(phonemes, dMs);
    startAt = Number(audioStartTime) || audioCtx.currentTime;
    durationMs = Math.max(0, Number(dMs) || 0);
    cachedIdx = 0;
    active = true;
    expressiveRig?.start();
  }

  function endSentence() {
    active = false;
    queue = null;
    durationMs = 0;
    // Park the mouth at silence. setRaw is a no-op if `sil` isn't mapped.
    visemeRig.clear();
    visemeRig.setRaw('sil', 1);
  }

  function reset() {
    active = false;
    queue = null;
    expressiveRig?.reset();
    visemeRig.clear();
  }

  function update(dt = 0) {
    if (!active || !queue || queue.length === 0) {
      expressiveRig?.update(0, dt);
      return;
    }
    const audioTimeMs = (audioCtx.currentTime - startAt) * 1000;
    if (audioTimeMs < 0) {
      expressiveRig?.update(0, dt);
      return;
    }

    // Advance the monotonic cursor while the next entry has already started.
    while (
      cachedIdx < queue.length - 1 &&
      queue[cachedIdx + 1].t <= audioTimeMs
    ) {
      cachedIdx++;
    }

    const cur = queue[cachedIdx];
    const next = queue[cachedIdx + 1];
    const segEnd = next ? next.t : cur.t + TRAILING_SEGMENT_MS;
    const segDur = Math.max(1, segEnd - cur.t);
    const local = audioTimeMs - cur.t;
    const blend = Math.min(1, Math.max(0, local / segDur));

    expressiveRig?.update(audioTimeMs, dt);
    visemeRig.applyViseme(cur.id, next?.id ?? 'sil', blend);
  }

  return {
    startSentence,
    endSentence,
    reset,
    update,
    get active() { return active; },
  };
}
