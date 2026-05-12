import { NodeIO } from '@gltf-transform/core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GLB = resolve(__dirname, '../../assets/Markus_final.glb');

const glbPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_GLB;

if (!existsSync(glbPath)) {
  console.error(`GLB not found: ${glbPath}`);
  process.exit(1);
}

const io = new NodeIO();
const doc = await io.read(glbPath);
const root = doc.getRoot();

console.log('');
console.log(`GLB:    ${glbPath}`);
console.log(`Meshes: ${root.listMeshes().length}`);
console.log('');

let total = 0;
for (const mesh of root.listMeshes()) {
  const meshName = mesh.getName() || '(unnamed)';
  const primitives = mesh.listPrimitives();
  const meshTargetNames = mesh.getExtras()?.targetNames;

  for (let i = 0; i < primitives.length; i++) {
    const prim = primitives[i];
    const targets = prim.listTargets();
    if (!targets.length) continue;

    const primTargetNames = prim.getExtras()?.targetNames;
    const names =
      primTargetNames ?? meshTargetNames ?? targets.map((_, idx) => `target_${idx}`);

    console.log(`Mesh "${meshName}" primitive ${i} — ${targets.length} morph target(s):`);
    names.forEach((n, idx) => console.log(`  [${idx}] ${n}`));
    console.log('');
    total += targets.length;
  }
}

if (total === 0) {
  console.log('No morph targets found in this GLB.');
  console.log('(Expected for the current mock model — rerun once the rigged GLB is in place.)');
} else {
  console.log(`Total morph targets across all primitives: ${total}`);
}
