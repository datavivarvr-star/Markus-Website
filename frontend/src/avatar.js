import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

export async function loadAvatar(url, { onProgress } = {}) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
  loader.setDRACOLoader(draco);

  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      url,
      resolve,
      (evt) => {
        if (!onProgress) return;
        const ratio = evt.total ? evt.loaded / evt.total : 0;
        onProgress(ratio, evt);
      },
      reject,
    );
  });

  const root = gltf.scene;
  root.traverse((o) => {
    if (o.isMesh) {
      o.frustumCulled = false;
      if (o.material && 'envMapIntensity' in o.material) {
        o.material.envMapIntensity = 1.0;
      }
    }
  });

  // Snap bones to frame 0 of the rest/idle animation so the character
  // starts in its authored pose rather than the geometric T-pose.
  // 3D viewers do this automatically; we must do it explicitly.
  if (gltf.animations && gltf.animations.length > 0) {
    const restClip =
      gltf.animations.find((c) => /idle|rest|a[\s_-]?pose|stand/i.test(c.name)) ??
      gltf.animations[0];
    console.info(`[avatar] snapping to rest pose from clip: "${restClip.name}"`);
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(restClip).play();
    mixer.update(0);
    // Mixer goes out of scope here; bones retain the applied pose.
  } else {
    console.warn('[avatar] no animation clips found — character may appear in T-pose');
  }

  const morphMeshes = findMorphMeshes(root);
  const bones = collectNamedBones(root);
  const hasBlendshapes = morphMeshes.length > 0;

  if (hasBlendshapes) {
    console.info('[avatar] blendshapes found:');
    morphMeshes.forEach((m) => {
      const names = Object.keys(m.morphTargetDictionary);
      console.info(`  mesh "${m.name || '(unnamed)'}" — ${names.length} morphs:`, names);
    });
  } else {
    console.warn(
      '[avatar] No morph targets / blendshapes found on this GLB. ' +
        'Visemes and blink will be disabled until a rigged GLB is provided.',
    );
  }

  return {
    gltf,
    root,
    morphMeshes,
    bones,
    hasBlendshapes,
  };
}

function findMorphMeshes(root) {
  const out = [];
  root.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.morphTargetDictionary && o.morphTargetInfluences) {
      const dict = o.morphTargetDictionary;
      if (dict && Object.keys(dict).length > 0) out.push(o);
    }
  });
  return out;
}

function collectNamedBones(root) {
  const bones = new Map();
  root.traverse((o) => {
    if (o.isBone || o.type === 'Bone') {
      if (o.name) bones.set(o.name, o);
    }
  });
  return bones;
}

export function resolveMorphIndices(morphMeshes, names) {
  const result = new Map();
  for (const name of names) {
    let found = null;
    for (const mesh of morphMeshes) {
      const idx = mesh.morphTargetDictionary?.[name];
      if (idx != null) {
        found = { mesh, index: idx };
        break;
      }
    }
    result.set(name, found);
  }
  return result;
}

export function findBone(bones, candidates) {
  for (const name of candidates) {
    if (bones.has(name)) return bones.get(name);
  }
  const lower = new Map();
  for (const [k, v] of bones) lower.set(k.toLowerCase(), v);
  for (const name of candidates) {
    const hit = lower.get(name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
