import { createScene } from './scene.js';
import { loadAvatar } from './avatar.js';
import { createIdle } from './idle.js';
import { createVisemeRig } from './visemes.js';
import { runVisemeDiagnostic } from './viseme-diagnostic.js';
import { createSpeechController } from './speech.js';
import {
  createChatClient,
  buildChatUrl,
  getOrCreateSessionId,
  chatErrorToMessage,
} from './chat.js';
import { isSttSupported, createStt, sttErrorToMessage } from './stt.js';
import {
  hideLoader,
  setLoaderProgress,
  showHud,
  getComposerElements,
  appendTranscript,
  startAssistantTurn,
  appendAssistantSentence,
  endAssistantTurn,
  appendSystemLine,
  setThinking,
  setComposerEnabled,
  hideMic,
  setMicPressed,
  showInterim,
  hideInterim,
} from './ui.js';

const AVATAR_URL = '/assets/Markus_final.glb';
const TEST_PHRASE = 'Hello, my name is Markus. How can I help you today?';

async function bootstrap() {
  const canvas = document.getElementById('stage');
  const stage = createScene(canvas);

  // Phase 10 — pre-warm Groq + Piper in parallel with the GLB download so
  // the first user turn doesn't pay cold-start latency. Fire-and-forget;
  // the endpoint returns immediately with current status and the actual
  // warm-up runs in the background on the backend.
  prewarmBackend();

  try {
    setLoaderProgress(0, 'Loading avatar…');
    const avatar = await loadAvatar(AVATAR_URL, {
      onProgress: (ratio) => setLoaderProgress(ratio || 0),
    });

    stage.scene.add(avatar.root);
    stage.frameToObject(avatar.root);

    const idle = createIdle(avatar);
    stage.onUpdate((dt) => idle.update(dt));

    const visemeRig = createVisemeRig(avatar.morphMeshes);

    const composerState = {
      llmInFlight: false,
      speaking: false,
      wsState: 'connecting',
      listening: false,
    };
    function refreshComposer() {
      const baseEnabled =
        composerState.wsState === 'open' &&
        !composerState.llmInFlight &&
        !composerState.speaking;
      // Phase 10 — the mic stays clickable while the assistant is speaking
      // or thinking, so the user can barge-in. The text input stays gated.
      const interruptible =
        composerState.wsState === 'open' &&
        (composerState.llmInFlight || composerState.speaking) &&
        !composerState.listening;
      const placeholder = composerState.listening
        ? 'Listening…'
        : composerState.wsState !== 'open'
          ? 'Connecting…'
          : composerState.llmInFlight
            ? 'Waiting for reply… (tap mic to interrupt)'
            : composerState.speaking
              ? 'Avatar is speaking… (tap mic to interrupt)'
              : 'Type or tap the mic…';
      // While listening: text input + send disabled, mic stays clickable as stop.
      const inputEnabled = baseEnabled && !composerState.listening;
      const micEnabled = composerState.listening || baseEnabled || interruptible;
      const micMode = composerState.listening
        ? undefined // aria-pressed already covers the listening visual.
        : interruptible
          ? 'interrupt'
          : undefined;
      setComposerEnabled(inputEnabled, {
        placeholder,
        micOverride: micEnabled,
        micMode,
      });
    }

    let fallbackNoticed = false;
    const speech = createSpeechController({
      idle,
      visemeRig,
      stage,
      onSpeechStart: () => {
        composerState.speaking = true;
        refreshComposer();
      },
      onSpeechEnd: () => {
        composerState.speaking = false;
        refreshComposer();
      },
      onError: (err) => {
        console.error('[speech] error:', err);
      },
      onFallback: () => {
        // Phase 10 — Piper unreachable; we degraded to the browser's built-in
        // SpeechSynthesisUtterance for this sentence. Surface once per page
        // load so the user isn't peppered with the same notice every reply.
        if (fallbackNoticed) return;
        fallbackNoticed = true;
        appendSystemLine(
          "Voice synthesis is offline — using the browser's built-in voice (no lip-sync).",
        );
      },
    });

    const sessionId = getOrCreateSessionId();
    const turn = { firstSentence: true };

    const chat = createChatClient({
      url: buildChatUrl(),
      sessionId,
      onSentence: (text) => {
        if (turn.firstSentence) {
          turn.firstSentence = false;
          setThinking(false);
          startAssistantTurn();
        }
        appendAssistantSentence(text);
        speech.speakSentence(text);
      },
      onDone: () => {
        composerState.llmInFlight = false;
        setThinking(false);
        endAssistantTurn();
        refreshComposer();
      },
      onError: (code) => {
        composerState.llmInFlight = false;
        setThinking(false);
        endAssistantTurn();
        appendSystemLine(chatErrorToMessage(code));
        refreshComposer();
      },
      onStateChange: (s) => {
        composerState.wsState = s;
        console.info('[chat] state →', s);
        refreshComposer();
      },
    });

    function submitMessage(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return false;
      if (composerState.llmInFlight || composerState.speaking) {
        appendSystemLine(chatErrorToMessage('busy'));
        return false;
      }
      if (composerState.wsState !== 'open') {
        appendTranscript('user', trimmed);
        appendSystemLine(chatErrorToMessage('not_connected'));
        return false;
      }
      appendTranscript('user', trimmed);
      composerState.llmInFlight = true;
      turn.firstSentence = true;
      setThinking(true, 'Thinking…');
      refreshComposer();

      const sent = chat.sendMessage(trimmed);
      if (!sent) {
        composerState.llmInFlight = false;
        setThinking(false);
        refreshComposer();
      }
      return sent;
    }

    // Phase 10 — barge-in: stop the current spoken reply (audio + lipsync)
    // and cancel the in-flight LLM stream so further sentences don't bleed
    // through. Returns true if anything was actually cancelled.
    function bargeIn() {
      let didSomething = false;
      if (composerState.speaking) {
        speech.stop();
        didSomething = true;
      }
      if (chat.cancelTurn()) {
        composerState.llmInFlight = false;
        setThinking(false);
        endAssistantTurn();
        didSomething = true;
      }
      if (didSomething) refreshComposer();
      return didSomething;
    }

    const stt = wireStt({ composerState, refreshComposer, speech, submitMessage });
    wireComposer({ composerState, refreshComposer, speech, submitMessage, stt, bargeIn });

    window.__markus = { stage, avatar, idle, visemeRig, speech, chat, stt, sessionId, bargeIn };

    hideLoader();
    showHud();
    refreshComposer();

    const params = new URLSearchParams(window.location.search);
    if (params.get('test') === 'visemes') {
      idle.pause();
      runVisemeDiagnostic(visemeRig, { onStop: () => idle.resume() });
    }

    if (params.get('dev') === '1') {
      installDevControls({ speech });
    }
  } catch (err) {
    console.error('[markus] avatar load failed:', err);
    setLoaderProgress(0, 'Failed to load avatar. Check console.');
  }
}

function wireComposer({ composerState, refreshComposer, speech, submitMessage, stt, bargeIn }) {
  const { form, input, mic, send } = getComposerElements();
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // The submit IS a user gesture — use it to lock in the AudioContext so
    // the eventual TTS playback isn't blocked by iOS autoplay rules.
    try { speech.warmup(); } catch (err) { console.warn('[main] speech.warmup failed:', err); }
    if (submitMessage(text)) {
      input.value = '';
    }
  });

  mic?.addEventListener('click', () => {
    if (!stt) return;
    // Warm up audio playback inside the gesture even though STT doesn't need it.
    try { speech.warmup(); } catch (err) { console.warn('[main] speech.warmup failed:', err); }

    // Phase 10 — barge-in: tapping the mic while the avatar is speaking or
    // the LLM is still streaming aborts that turn before we start listening.
    if (stt.state === 'idle') {
      if (composerState.speaking || composerState.llmInFlight) {
        bargeIn?.();
      }
      stt.start();
    } else {
      stt.stop();
    }
  });

  send?.addEventListener('click', (e) => {
    if (!input.value.trim()) e.preventDefault();
  });
}

function wireStt({ composerState, refreshComposer, speech, submitMessage }) {
  if (!isSttSupported()) {
    hideMic();
    console.info('[stt] SpeechRecognition unsupported in this browser — mic hidden, text-only.');
    return null;
  }

  const stt = createStt({
    onInterim: (text) => {
      showInterim(text);
    },
    onFinal: (text) => {
      hideInterim();
      submitMessage(text);
    },
    onStateChange: (state) => {
      const listening = state === 'listening' || state === 'starting';
      composerState.listening = listening;
      setMicPressed(listening);
      if (!listening) hideInterim();
      else showInterim('…');
      refreshComposer();
    },
    onError: (code) => {
      // 'no-speech' is common (mic timeout with no input) — show a brief hint
      // but don't treat it as a hard failure.
      appendSystemLine(sttErrorToMessage(code));
      hideInterim();
      composerState.listening = false;
      setMicPressed(false);
      refreshComposer();
    },
  });

  return stt;
}

// ?dev=1 — floating panel: feeds the canned test phrase straight into the
// speech controller, bypassing the LLM. Useful for iterating lipsync without
// burning Groq tokens.
function installDevControls({ speech }) {
  const panel = document.createElement('div');
  panel.className = 'dev-panel';
  panel.innerHTML = `
    <div class="dev-row">
      <span class="dev-label">dev</span>
      <span class="dev-state" id="dev-state">idle</span>
    </div>
    <button type="button" class="dev-btn" id="dev-test">Test phrase</button>
    <button type="button" class="dev-btn dev-btn-stop" id="dev-stop" disabled>Stop</button>
    <div class="dev-hint">Plays the canned phrase through /api/tts (no LLM).</div>
  `;
  document.body.appendChild(panel);

  const stateEl = panel.querySelector('#dev-state');
  const testBtn = panel.querySelector('#dev-test');
  const stopBtn = panel.querySelector('#dev-stop');

  function syncState() {
    const playing = speech.isPlaying;
    stateEl.textContent = playing ? 'speaking' : 'idle';
    stateEl.dataset.state = playing ? 'speaking' : 'idle';
    testBtn.disabled = playing;
    stopBtn.disabled = !playing;
  }

  testBtn.addEventListener('click', () => {
    speech.speakSentence(TEST_PHRASE);
    syncState();
    const poll = setInterval(() => {
      syncState();
      if (!speech.isPlaying && speech.queueLength === 0) clearInterval(poll);
    }, 200);
  });

  stopBtn.addEventListener('click', () => {
    speech.stop();
    syncState();
  });

  window.__markusDev = {
    speak: (text) => speech.speakSentence(text || TEST_PHRASE),
    stop: () => speech.stop(),
  };

  console.info('[dev] dev panel enabled (?dev=1). Click "Test phrase" to test the TTS pipeline.');
}

function prewarmBackend() {
  // Fire-and-forget. The endpoint returns immediately with the current
  // warmup status; the actual warmup work runs in the background on the
  // server. Safe to call multiple times — it's idempotent. A short timeout
  // keeps a slow backend from leaving a hanging fetch in the page.
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    fetch('/api/warmup', { method: 'GET', signal: ac.signal })
      .then(async (res) => {
        clearTimeout(t);
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        if (body) console.info('[markus] warmup:', body);
      })
      .catch((err) => {
        clearTimeout(t);
        // Quietly ignore — the WS will still surface chat errors if Groq is
        // actually broken. Warmup is a latency optimization, not a gate.
        console.info('[markus] warmup ping failed (will retry on first turn):', err?.message ?? err);
      });
  } catch (err) {
    console.info('[markus] warmup skipped:', err?.message ?? err);
  }
}

bootstrap();
