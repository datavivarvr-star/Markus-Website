import { findBone, resolveMorphIndices } from './avatar.js';

const HEAD_BONE_CANDIDATES = [
  'Head', 'head', 'mixamorigHead', 'J_Bip_C_Head',
  'CC_Base_Head', 'Head_M', 'head_M', 'DEF-head',
];
const LEFT_EYE_CANDIDATES = [
  'LeftEye', 'left_eye', 'eye_L', 'eye.L',
  'mixamorigLeftEye', 'J_Adj_L_FaceEye', 'CC_Base_L_Eye', 'Eye_L',
];
const RIGHT_EYE_CANDIDATES = [
  'RightEye', 'right_eye', 'eye_R', 'eye.R',
  'mixamorigRightEye', 'J_Adj_R_FaceEye', 'CC_Base_R_Eye', 'Eye_R',
];
const LEFT_EYELID_CANDIDATES = [
  'LeftEyelid', 'eyelid_L', 'eyelidUpper_L', 'upper_eyelid_L',
  'J_Adj_L_FaceEyelidUpper', 'CC_Base_L_Eyelid_Upper',
];
const RIGHT_EYELID_CANDIDATES = [
  'RightEyelid', 'eyelid_R', 'eyelidUpper_R', 'upper_eyelid_R',
  'J_Adj_R_FaceEyelidUpper', 'CC_Base_R_Eyelid_Upper',
];
const CHEST_BONE_CANDIDATES = [
  'Spine2', 'Chest', 'UpperChest', 'spine.002', 'spine.003',
  'mixamorigSpine2', 'mixamorigSpine1', 'CC_Base_Spine02', 'chest',
];

const BLINK_MORPHS = [
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeBlink_L', 'eyeBlink_R',
  'blinkLeft', 'blinkRight',
  'Eye_Blink_L', 'Eye_Blink_R',
  'Blink_L', 'Blink_R',
];
const BREATHE_MORPHS = ['breathe', 'Breathe', 'breathing', 'Breath'];

const BLINK_DURATION_S = 0.15;
const BREATHE_PERIOD_S = 4.0;
const BREATHE_AMP_SCALE = 0.012;
const BREATHE_AMP_MORPH = 0.6;
const HEAD_SWAY_AMP_Y = 0.02;
const HEAD_SWAY_AMP_X = 0.01;
const SACCADE_RANGE_X = 0.06;
const SACCADE_RANGE_Y = 0.08;
const SACCADE_LERP = 8;

function randBetween(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function captureRotation(b) {
  return b ? { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z } : null;
}

function captureScale(b) {
  return b ? { x: b.scale.x, y: b.scale.y, z: b.scale.z } : null;
}

export function createIdle(avatar) {
  const { bones, morphMeshes, hasBlendshapes } = avatar;

  const head = findBone(bones, HEAD_BONE_CANDIDATES);
  const leftEye = findBone(bones, LEFT_EYE_CANDIDATES);
  const rightEye = findBone(bones, RIGHT_EYE_CANDIDATES);
  const leftEyelid = findBone(bones, LEFT_EYELID_CANDIDATES);
  const rightEyelid = findBone(bones, RIGHT_EYELID_CANDIDATES);
  const chest = findBone(bones, CHEST_BONE_CANDIDATES);

  const blinkMorphs = hasBlendshapes
    ? resolveMorphIndices(morphMeshes, BLINK_MORPHS)
    : new Map();
  const breatheMorph = hasBlendshapes
    ? resolveMorphIndices(morphMeshes, BREATHE_MORPHS)
    : new Map();

  const hasMorphBlink = [...blinkMorphs.values()].some((v) => v);
  const hasMorphBreathe = [...breatheMorph.values()].some((v) => v);
  const hasEyelidBones = !!(leftEyelid || rightEyelid);

  const blinkMode = hasMorphBlink ? 'morph' : hasEyelidBones ? 'eyelid' : 'off';
  const breatheMode = hasMorphBreathe ? 'morph' : chest ? 'chest' : 'off';
  const swayMode = head ? 'head' : 'off';
  const saccadeMode = leftEye || rightEye ? 'eye' : 'off';

  const headRest = captureRotation(head);
  const leftEyeRest = captureRotation(leftEye);
  const rightEyeRest = captureRotation(rightEye);
  const leftEyelidRest = captureRotation(leftEyelid);
  const rightEyelidRest = captureRotation(rightEyelid);
  const chestRestScale = captureScale(chest);

  console.info('[idle] capabilities:', {
    blink: blinkMode,
    breathing: breatheMode,
    sway: swayMode,
    saccades: saccadeMode,
  });

  if (blinkMode === 'off' && breatheMode === 'off' && swayMode === 'off' && saccadeMode === 'off') {
    console.warn('[idle] no rig features detected — avatar will remain static');
  }

  let nextBlinkAt = randBetween(3, 6);
  let blinkActive = false;
  let blinkStart = 0;

  let nextSaccadeAt = randBetween(1, 2);
  const saccadeTarget = { x: 0, y: 0 };
  const saccadeCurrent = { x: 0, y: 0 };

  let paused = false;
  let t = 0;

  function setMorph(map, value) {
    for (const ref of map.values()) {
      if (!ref) continue;
      ref.mesh.morphTargetInfluences[ref.index] = value;
    }
  }

  function resetSway() {
    if (head && headRest) {
      head.rotation.x = headRest.x;
      head.rotation.y = headRest.y;
      head.rotation.z = headRest.z;
    }
  }

  function resetBreathing() {
    if (breatheMode === 'morph') setMorph(breatheMorph, 0);
    else if (breatheMode === 'chest' && chest && chestRestScale) {
      chest.scale.set(chestRestScale.x, chestRestScale.y, chestRestScale.z);
    }
  }

  function resetBlink() {
    if (blinkMode === 'morph') setMorph(blinkMorphs, 0);
    else if (blinkMode === 'eyelid') {
      if (leftEyelid && leftEyelidRest) leftEyelid.rotation.x = leftEyelidRest.x;
      if (rightEyelid && rightEyelidRest) rightEyelid.rotation.x = rightEyelidRest.x;
    }
    blinkActive = false;
  }

  function updateSway() {
    if (swayMode !== 'head' || !headRest) return;
    head.rotation.y = headRest.y + Math.sin(t * 0.5) * HEAD_SWAY_AMP_Y;
    head.rotation.x = headRest.x + Math.cos(t * 0.3) * HEAD_SWAY_AMP_X;
  }

  function updateBreathing() {
    const phase = Math.sin((t * 2 * Math.PI) / BREATHE_PERIOD_S) * 0.5 + 0.5;
    if (breatheMode === 'morph') {
      setMorph(breatheMorph, phase * BREATHE_AMP_MORPH);
    } else if (breatheMode === 'chest') {
      const k = 1 + (phase - 0.5) * 2 * BREATHE_AMP_SCALE;
      chest.scale.set(chestRestScale.x * k, chestRestScale.y * k, chestRestScale.z * k);
    }
  }

  function updateBlink(dt) {
    if (blinkMode === 'off') return;
    if (!blinkActive) {
      nextBlinkAt -= dt;
      if (nextBlinkAt <= 0) {
        blinkActive = true;
        blinkStart = t;
        nextBlinkAt = randBetween(3, 6);
      }
      return;
    }
    const elapsed = t - blinkStart;
    const p = Math.min(elapsed / BLINK_DURATION_S, 1);
    const v = p < 0.5 ? p * 2 : (1 - p) * 2;

    if (blinkMode === 'morph') {
      setMorph(blinkMorphs, v);
    } else if (blinkMode === 'eyelid') {
      const close = v * 0.6;
      if (leftEyelid && leftEyelidRest) leftEyelid.rotation.x = leftEyelidRest.x + close;
      if (rightEyelid && rightEyelidRest) rightEyelid.rotation.x = rightEyelidRest.x + close;
    }

    if (p >= 1) resetBlink();
  }

  function updateSaccades(dt) {
    if (saccadeMode !== 'eye') return;
    nextSaccadeAt -= dt;
    if (nextSaccadeAt <= 0) {
      saccadeTarget.x = (Math.random() - 0.5) * SACCADE_RANGE_X;
      saccadeTarget.y = (Math.random() - 0.5) * SACCADE_RANGE_Y;
      nextSaccadeAt = randBetween(1, 2);
    }
    const k = Math.min(1, dt * SACCADE_LERP);
    saccadeCurrent.x += (saccadeTarget.x - saccadeCurrent.x) * k;
    saccadeCurrent.y += (saccadeTarget.y - saccadeCurrent.y) * k;

    if (leftEye && leftEyeRest) {
      leftEye.rotation.x = leftEyeRest.x + saccadeCurrent.x;
      leftEye.rotation.y = leftEyeRest.y + saccadeCurrent.y;
    }
    if (rightEye && rightEyeRest) {
      rightEye.rotation.x = rightEyeRest.x + saccadeCurrent.x;
      rightEye.rotation.y = rightEyeRest.y + saccadeCurrent.y;
    }
  }

  function update(dt) {
    if (paused) return;
    t += dt;
    updateSway();
    updateBreathing();
    updateBlink(dt);
    updateSaccades(dt);
  }

  function pause() {
    if (paused) return;
    paused = true;
    resetSway();
    resetBreathing();
    resetBlink();
  }

  function resume() {
    if (!paused) return;
    paused = false;
    nextBlinkAt = randBetween(3, 6);
    nextSaccadeAt = randBetween(1, 2);
  }

  return {
    update,
    pause,
    resume,
    capabilities: { blinkMode, breatheMode, swayMode, saccadeMode },
  };
}
