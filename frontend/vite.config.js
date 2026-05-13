import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, normalize } from 'node:path';
import { existsSync, statSync, createReadStream, cpSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '../assets');

const MIME = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
};

function externalAssets() {
  return {
    name: 'markus-external-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const url = (req.url || '/').split('?')[0];
        const target = normalize(join(ASSETS_DIR, url));
        if (!target.startsWith(ASSETS_DIR)) return next();
        if (!existsSync(target) || !statSync(target).isFile()) return next();
        const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
        if (MIME[ext]) res.setHeader('Content-Type', MIME[ext]);
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(target).pipe(res);
      });
    },
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/assets');
      if (existsSync(ASSETS_DIR)) {
        cpSync(ASSETS_DIR, outDir, { recursive: true });
      }
    },
  };
}

const BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  plugins: [externalAssets()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
