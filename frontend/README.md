# Frontend — Vite + Three.js

Phase 2 of `IMPLEMENTATION_PLAN.md`. Renders the Markus avatar and lays out the chat UI shell. The mic and text input are not wired to the backend yet — that comes in Phase 7/8.

## Install + run

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. You should see Markus loaded into the canvas with a progress bar that hides once the GLB is ready.

## GLB serving

`vite.config.js` includes a small plugin (`markus-external-assets`) that serves files from `../assets` under the `/assets/*` URL prefix in dev and copies them into `dist/assets` on build. No symlinks needed.

## Dump blendshapes

When the rigged GLB is in place, dump its morph target names with:

```bash
npm run dump-blendshapes
```

Optional: pass a different GLB path: `npm run dump-blendshapes -- ../assets/Other.glb`.

The current mock GLB has no morph targets — the script reports this and the runtime logs a warning. Lipsync / blink stay dormant until a rigged GLB is dropped in.

## File layout

```
frontend/
  index.html                Canvas + UI shell
  vite.config.js            Dev server + GLB serving plugin
  src/
    main.js                 Bootstrap (scene + avatar + UI placeholders)
    scene.js                Renderer, camera, lights, render loop
    avatar.js               GLTFLoader + morph mesh detection helpers
    ui.js                   Loader, transcript, status helpers
    style.css               Layout + mobile-safe styling
  scripts/
    dump-blendshapes.js     Offline morph-target inspector
```
