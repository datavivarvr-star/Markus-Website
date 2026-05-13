const EYEBROW_MAX = 0.3;
const ADAMS_MAX = 0.4;

function findMorph(morphMeshes, name) {
  for (const mesh of morphMeshes) {
    const idx = mesh.morphTargetDictionary?.[name];
    if (idx != null) return { mesh, index: idx };
  }
  return null;
}

function setMorph(ref, value) {
  if (!ref) return;
  ref.mesh.morphTargetInfluences[ref.index] = Math.max(0, Math.min(1, value));
}

export function createExpressiveRig(morphMeshes) {
  const eyebrowRef = findMorph(morphMeshes, 'EyeBrowsUp');
  const adamsRef   = findMorph(morphMeshes, 'AdamsApple');

  console.info('[expressive]', {
    EyeBrowsUp:  eyebrowRef ? 'found' : 'missing',
    AdamsApple:  adamsRef   ? 'found' : 'missing',
  });

  let speaking = false;

  let eyebrowCurrent = 0;
  let eyebrowTarget  = 0;
  let eyebrowTimer   = 0; // ms until next random target

  let adamsCurrent = 0;

  function update(audioTimeMs, dt) {
    const s = dt || 0;

    if (!speaking) {
      eyebrowCurrent += (0 - eyebrowCurrent) * Math.min(1, s * 5);
      adamsCurrent   += (0 - adamsCurrent)   * Math.min(1, s * 6);
      setMorph(eyebrowRef, eyebrowCurrent);
      setMorph(adamsRef,   adamsCurrent);
      return;
    }

    // Eyebrow: drift to a new random target every 400–900 ms
    eyebrowTimer -= s * 1000;
    if (eyebrowTimer <= 0) {
      eyebrowTarget = Math.random() * EYEBROW_MAX;
      eyebrowTimer  = 400 + Math.random() * 500;
    }
    eyebrowCurrent += (eyebrowTarget - eyebrowCurrent) * Math.min(1, s * 3.5);
    setMorph(eyebrowRef, eyebrowCurrent);

    // Adams apple: primary ~2.5 Hz + slower secondary wobble for naturalness
    const primary   = (Math.sin(audioTimeMs * Math.PI * 0.005) + 1) * 0.5;
    const secondary =  Math.sin(audioTimeMs * Math.PI * 0.0031) * 0.15;
    const adamsTarget = Math.max(0, primary * ADAMS_MAX + secondary * ADAMS_MAX);
    adamsCurrent += (adamsTarget - adamsCurrent) * Math.min(1, s * 7);
    setMorph(adamsRef, adamsCurrent);
  }

  function start() {
    speaking = true;
    eyebrowTimer = 0;
  }

  function reset() {
    speaking = false;
    eyebrowCurrent = 0;
    eyebrowTarget  = 0;
    adamsCurrent   = 0;
    setMorph(eyebrowRef, 0);
    setMorph(adamsRef,   0);
  }

  return { update, start, reset, ready: !!(eyebrowRef || adamsRef) };
}
