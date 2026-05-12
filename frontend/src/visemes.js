import mappingDoc from '../../docs/blendshape-mapping.json';

export const VISEME_IDS = Object.freeze([
  'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U',
]);

const STRIP_MARKS = /[ˈˌːˑ‿̩̯̥̃̆\s]/g;

const PHONEME_MAP = {
  'p': 'PP', 'b': 'PP', 'm': 'PP',
  'f': 'FF', 'v': 'FF',
  'θ': 'TH', 'ð': 'TH',
  't': 'DD', 'd': 'DD', 'l': 'DD', 'ɾ': 'DD',
  'n': 'nn', 'ŋ': 'nn', 'ɲ': 'nn',
  'k': 'kk', 'g': 'kk', 'ɡ': 'kk', 'x': 'kk',
  'ʃ': 'CH', 'ʒ': 'CH', 'tʃ': 'CH', 'dʒ': 'CH', 'ʧ': 'CH', 'ʤ': 'CH',
  's': 'SS', 'z': 'SS',
  'r': 'RR', 'ɹ': 'RR', 'ɻ': 'RR', 'ɚ': 'RR', 'ɝ': 'RR',
  'w': 'U', 'ʍ': 'U',
  'j': 'I',
  'h': 'sil', 'ɦ': 'sil', 'ʔ': 'sil',
  'a': 'aa', 'ɑ': 'aa', 'æ': 'aa', 'ʌ': 'aa', 'ɐ': 'aa', 'ɑ̃': 'aa',
  'ə': 'aa',
  'ɛ': 'E', 'e': 'E', 'ɜ': 'E',
  'i': 'I', 'ɪ': 'I', 'y': 'I',
  'ɔ': 'O', 'o': 'O', 'ɒ': 'O', 'ɔ̃': 'O',
  'u': 'U', 'ʊ': 'U',
  'eɪ': 'E', 'aɪ': 'aa', 'ɔɪ': 'O', 'aʊ': 'aa', 'oʊ': 'O',
  'ɪə': 'I', 'eə': 'E', 'ʊə': 'U', 'juː': 'U', 'ju': 'U',
};

export function phonemeToViseme(raw) {
  if (!raw) return 'sil';
  const clean = String(raw).replace(STRIP_MARKS, '');
  if (!clean) return 'sil';
  if (PHONEME_MAP[clean]) return PHONEME_MAP[clean];
  for (let n = Math.min(clean.length, 3); n >= 1; n--) {
    const slice = clean.slice(0, n);
    if (PHONEME_MAP[slice]) return PHONEME_MAP[slice];
  }
  return 'sil';
}

const LAYER_B = mappingDoc.visemes ?? {};

export function createVisemeRig(morphMeshes) {
  const resolved = new Map();
  for (const id of VISEME_IDS) {
    const candidates = LAYER_B[id] ?? [];
    let hit = null;
    outer: for (const name of candidates) {
      for (const mesh of morphMeshes) {
        const idx = mesh.morphTargetDictionary?.[name];
        if (idx != null) {
          hit = { mesh, index: idx, name };
          break outer;
        }
      }
    }
    resolved.set(id, hit);
  }

  const foundEntries = [...resolved].filter(([, v]) => v);
  const missingEntries = [...resolved].filter(([, v]) => !v);

  console.info(
    `[visemes] resolved ${foundEntries.length}/${VISEME_IDS.length}`,
    Object.fromEntries(foundEntries.map(([k, v]) => [k, v.name])),
  );
  if (missingEntries.length) {
    console.warn(
      `[visemes] missing morphs for ${missingEntries.length} viseme(s):`,
      missingEntries.map(([k]) => k),
    );
  }

  const touchedByMesh = new Map();
  for (const ref of resolved.values()) {
    if (!ref) continue;
    if (!touchedByMesh.has(ref.mesh)) touchedByMesh.set(ref.mesh, new Set());
    touchedByMesh.get(ref.mesh).add(ref.index);
  }

  function clear() {
    for (const [mesh, indices] of touchedByMesh) {
      for (const idx of indices) mesh.morphTargetInfluences[idx] = 0;
    }
  }

  function applyViseme(currentId, nextId, blendRaw = 0) {
    const raw = Math.max(0, Math.min(1, blendRaw));
    const b = 0.5 - 0.5 * Math.cos(raw * Math.PI);

    for (const [mesh, indices] of touchedByMesh) {
      for (const idx of indices) mesh.morphTargetInfluences[idx] = 0;
    }

    const cur = resolved.get(currentId);
    if (cur) cur.mesh.morphTargetInfluences[cur.index] = 1 - b * 0.5;

    if (nextId && nextId !== currentId) {
      const nx = resolved.get(nextId);
      if (nx) nx.mesh.morphTargetInfluences[nx.index] = b * 0.5;
    }
  }

  function setRaw(id, value) {
    const ref = resolved.get(id);
    if (!ref) return false;
    for (const [mesh, indices] of touchedByMesh) {
      for (const idx of indices) mesh.morphTargetInfluences[idx] = 0;
    }
    ref.mesh.morphTargetInfluences[ref.index] = Math.max(0, Math.min(1, value));
    return true;
  }

  return {
    resolved,
    ready: foundEntries.length > 0,
    foundCount: foundEntries.length,
    missing: missingEntries.map(([k]) => k),
    applyViseme,
    clear,
    setRaw,
  };
}
