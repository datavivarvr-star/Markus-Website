export function setLoaderProgress(ratio, label) {
  const fill = document.getElementById('loader-fill');
  const lbl = document.getElementById('loader-label');
  if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
  if (lbl && label) lbl.textContent = label;
}

export function hideLoader() {
  const el = document.getElementById('loader');
  if (el) el.hidden = true;
}

export function showLoader(message) {
  const el = document.getElementById('loader');
  const lbl = document.getElementById('loader-label');
  if (el) el.hidden = false;
  if (lbl && message) lbl.textContent = message;
}

export function showHud() {
  const el = document.getElementById('hud');
  if (el) el.hidden = false;
}

export function appendTranscript(role, text) {
  const el = document.getElementById('transcript');
  if (!el) return null;
  const line = document.createElement('div');
  line.className = `line ${role}`;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  return line;
}

let _currentAssistantLine = null;
let _currentAssistantText = '';

export function startAssistantTurn() {
  _currentAssistantLine = appendTranscript('assistant', '');
  _currentAssistantText = '';
}

export function appendAssistantSentence(text) {
  if (!_currentAssistantLine) startAssistantTurn();
  _currentAssistantText = _currentAssistantText
    ? `${_currentAssistantText} ${text}`
    : text;
  _currentAssistantLine.textContent = _currentAssistantText;
  const el = document.getElementById('transcript');
  if (el) el.scrollTop = el.scrollHeight;
}

export function endAssistantTurn() {
  if (_currentAssistantLine && !_currentAssistantText) {
    // No sentences were ever appended — remove the empty placeholder line.
    _currentAssistantLine.remove();
  }
  _currentAssistantLine = null;
  _currentAssistantText = '';
}

export function appendSystemLine(text) {
  return appendTranscript('system', text);
}

export function setThinking(on, label) {
  const el = document.getElementById('status');
  if (!el) return;
  el.hidden = !on;
  if (label) {
    const txt = document.getElementById('status-text');
    if (txt) txt.textContent = label;
  }
}

export function getComposerElements() {
  return {
    form: document.getElementById('composer'),
    input: document.getElementById('text-input'),
    mic: document.getElementById('mic'),
    send: document.getElementById('send'),
  };
}

export function setComposerEnabled(enabled, { placeholder, micOverride } = {}) {
  const { input, send, mic } = getComposerElements();
  if (input) {
    input.disabled = !enabled;
    if (placeholder) input.placeholder = placeholder;
  }
  if (send) send.disabled = !enabled;
  if (mic) {
    // micOverride lets STT keep the mic clickable (as a "stop listening"
    // button) even when the rest of the composer is gated.
    const micEnabled = micOverride === undefined ? enabled : micOverride;
    mic.disabled = !micEnabled;
    if (!micEnabled) mic.setAttribute('aria-disabled', 'true');
    else mic.removeAttribute('aria-disabled');
  }
}

export function hideMic() {
  const { mic } = getComposerElements();
  if (mic) mic.hidden = true;
}

export function setMicPressed(pressed) {
  const { mic } = getComposerElements();
  if (!mic) return;
  if (pressed) mic.setAttribute('aria-pressed', 'true');
  else mic.removeAttribute('aria-pressed');
}

let _interimEl = null;
function ensureInterimEl() {
  if (_interimEl) return _interimEl;
  const hud = document.getElementById('hud');
  if (!hud) return null;
  const el = document.createElement('div');
  el.id = 'interim';
  el.className = 'interim';
  el.hidden = true;
  // Insert above the composer so it appears just above the input row.
  const composer = document.getElementById('composer');
  if (composer) hud.insertBefore(el, composer);
  else hud.appendChild(el);
  _interimEl = el;
  return el;
}

export function showInterim(text) {
  const el = ensureInterimEl();
  if (!el) return;
  el.hidden = false;
  el.textContent = text || '…';
}

export function hideInterim() {
  if (!_interimEl) return;
  _interimEl.hidden = true;
  _interimEl.textContent = '';
}
