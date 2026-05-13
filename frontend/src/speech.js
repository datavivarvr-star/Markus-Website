// Phase 7 — shared speech controller.
//
// Owns the AudioContext + Speaker + Lipsync + idle pause/resume so both the
// chat client and the dev test-phrase button drive a single pipeline. The
// AudioContext is created lazily on first speakSentence() call because
// browsers require a user gesture for that — the caller is expected to invoke
// speakSentence() from inside a click/keypress handler.

import { ensureAudioContext, createSpeaker } from './audio.js';
import { createLipsync } from './lipsync.js';

export function createSpeechController({
  idle,
  visemeRig,
  expressiveRig,
  stage,
  onSpeechStart,
  onSpeechEnd,
  onError,
  onFallback,
} = {}) {
  if (!idle || !visemeRig || !stage) {
    throw new Error('createSpeechController requires { idle, visemeRig, stage }');
  }

  let audioCtx = null;
  let speaker = null;
  let lipsync = null;
  let unsubscribeLipsync = null;
  let initialized = false;

  function init() {
    if (initialized) return;
    audioCtx = ensureAudioContext();
    lipsync = createLipsync({ audioCtx, visemeRig, expressiveRig });
    unsubscribeLipsync = stage.onUpdate((dt) => lipsync.update(dt));

    speaker = createSpeaker({
      audioCtx,
      onSpeechStart: () => {
        idle.pause();
        onSpeechStart?.();
      },
      onSpeechEnd: () => {
        lipsync.reset();
        visemeRig.clear();
        idle.resume();
        onSpeechEnd?.();
      },
      onSentenceStart: (payload) => lipsync.startSentence(payload),
      onSentenceEnd: () => lipsync.endSentence(),
      onError,
      onFallback,
    });

    initialized = true;
  }

  function speakSentence(text) {
    init();
    speaker.speakSentence(text);
  }

  // Call this from inside a user gesture (form submit, mic click) to create
  // the AudioContext while iOS will still allow it. Without this, the first
  // TTS reply after a tap-to-talk turn may be silent on iOS Safari because
  // by the time the WebSocket sentence arrives, we are far outside the
  // gesture window.
  function warmup() {
    init();
  }

  function stop() {
    if (!speaker) return;
    speaker.stop();
    lipsync?.reset();
    visemeRig.clear();
    idle.resume();
  }

  function dispose() {
    stop();
    unsubscribeLipsync?.();
    unsubscribeLipsync = null;
  }

  return {
    speakSentence,
    warmup,
    stop,
    dispose,
    get isPlaying() { return speaker?.isPlaying ?? false; },
    get queueLength() { return speaker?.queueLength ?? 0; },
    get initialized() { return initialized; },
  };
}
