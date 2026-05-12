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

const AVATAR_URL = '/assets/Markus_Basic.glb';
const TEST_PHRASE = 'Hello, my name is Markus. How can I help you today?';

async function bootstrap() {
  const canvas = document.getElementById('stage');
  const stage = createScene(canvas);

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
      const placeholder = composerState.listening
        ? 'Listening…'
        : composerState.wsState !== 'open'
          ? 'Connecting…'
          : composerState.llmInFlight
            ? 'Waiting for reply…'
            : composerState.speaking
              ? 'Avatar is speaking…'
              : 'Type or tap the mic…';
      // While listening: text input + send disabled, but mic stays clickable as stop.
      const inputEnabled = baseEnabled && !composerState.listening;
      const micEnabled = composerState.listening || baseEnabled;
      setComposerEnabled(inputEnabled, {
        placeholder,
        micOverride: micEnabled,
      });
    }

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

    const stt = wireStt({ composerState, refreshComposer, speech, submitMessage });
    wireComposer({ composerState, refreshComposer, speech, submitMessage, stt });

    window.__markus = { stage, avatar, idle, visemeRig, speech, chat, stt, sessionId };

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

function wireComposer({ composerState, refreshComposer, speech, submitMessage, stt }) {
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
    if (stt.state === 'idle') {
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

bootstrap();
