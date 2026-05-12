import * as THREE from 'three';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  camera.position.set(0, 1.55, 0.9);
  camera.lookAt(0, 1.55, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(-1.2, 2.2, 1.6);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xc8d4ff, 0.35);
  fill.position.set(1.5, 1.0, 0.8);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffe0b2, 0.25);
  rim.position.set(0, 2, -2);
  scene.add(rim);

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  function frameToObject(object, opts = {}) {
    const { headFraction = 0.18, distanceMultiplier = 2.4, minDistance = 0.6 } = opts;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const focusY = box.max.y - size.y * headFraction;
    const dist = Math.max(minDistance, size.y * distanceMultiplier * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) ** -1 * 0.18);
    camera.position.set(center.x, focusY, center.z + dist);
    camera.lookAt(center.x, focusY, center.z);
  }

  const updaters = new Set();
  function onUpdate(fn) {
    updaters.add(fn);
    return () => updaters.delete(fn);
  }

  const clock = new THREE.Clock();
  function loop() {
    const dt = clock.getDelta();
    const t = clock.elapsedTime;
    for (const fn of updaters) fn(dt, t);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return { renderer, scene, camera, onUpdate, frameToObject, resize };
}
