import { VISEME_IDS } from './visemes.js';

const STEP_MS = 300;

export function runVisemeDiagnostic(visemeRig, { onStop } = {}) {
  const overlay = createOverlay();
  document.body.appendChild(overlay);

  let i = 0;
  let stopped = false;

  function tick() {
    if (stopped) return;
    const id = VISEME_IDS[i];
    const ok = visemeRig.setRaw(id, 1);
    overlay.querySelector('.vd-id').textContent = id;
    overlay.querySelector('.vd-step').textContent = `${i + 1} / ${VISEME_IDS.length}`;
    overlay.querySelector('.vd-state').textContent = ok ? 'applied' : 'missing morph';
    overlay.querySelector('.vd-state').dataset.ok = ok ? '1' : '0';
    i = (i + 1) % VISEME_IDS.length;
    setTimeout(tick, STEP_MS);
  }

  function stop() {
    stopped = true;
    visemeRig.clear();
    overlay.remove();
    onStop?.();
  }

  overlay.querySelector('.vd-stop').addEventListener('click', stop);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') stop();
    },
    { once: true },
  );

  console.info(
    `[viseme-diagnostic] cycling ${VISEME_IDS.length} visemes @ ${STEP_MS}ms each. Press Esc or click Stop to exit.`,
  );
  tick();

  return { stop };
}

function createOverlay() {
  const root = document.createElement('div');
  root.className = 'viseme-diagnostic';
  root.innerHTML = `
    <div class="vd-panel">
      <div class="vd-row">
        <span class="vd-label">viseme</span>
        <span class="vd-id">—</span>
      </div>
      <div class="vd-row">
        <span class="vd-label">step</span>
        <span class="vd-step">—</span>
      </div>
      <div class="vd-row">
        <span class="vd-label">state</span>
        <span class="vd-state" data-ok="0">—</span>
      </div>
      <button type="button" class="vd-stop">Stop (Esc)</button>
    </div>
  `;
  Object.assign(root.style, {
    position: 'fixed',
    top: '12px',
    left: '12px',
    zIndex: '10',
    background: 'rgba(20, 24, 32, 0.85)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '12px',
    padding: '10px 12px',
    color: '#e7eaf0',
    font: '12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
    backdropFilter: 'blur(8px)',
    pointerEvents: 'auto',
    minWidth: '160px',
  });
  const style = document.createElement('style');
  style.textContent = `
    .viseme-diagnostic .vd-row { display:flex; justify-content:space-between; gap:12px; margin:2px 0; }
    .viseme-diagnostic .vd-label { color:#8a93a3; }
    .viseme-diagnostic .vd-id { font-weight:600; }
    .viseme-diagnostic .vd-state[data-ok="1"] { color:#4ade80; }
    .viseme-diagnostic .vd-state[data-ok="0"] { color:#f87171; }
    .viseme-diagnostic .vd-stop {
      margin-top:8px; width:100%; height:30px; border-radius:8px;
      border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.06);
      color:#e7eaf0; font:inherit; cursor:pointer;
    }
    .viseme-diagnostic .vd-stop:hover { background:rgba(255,255,255,0.1); }
  `;
  root.appendChild(style);
  return root;
}
