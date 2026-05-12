# Frontend: Vite build → Caddy static + reverse proxy.
# Two stages: the build stage produces frontend/dist; the runtime stage is a
# slim Caddy image that serves the dist and proxies /api/* to the backend.
# Build context: repo root.

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /build

# Cache deps separately from source.
COPY frontend/package.json frontend/package-lock.json* frontend/
RUN cd frontend && npm ci

# Sources that the bundler reaches into. vite.config.js resolves
# ../assets, and visemes.js imports ../../docs/blendshape-mapping.json.
COPY frontend/ frontend/
COPY assets/   assets/
COPY docs/     docs/

RUN cd frontend && npm run build

# ---------- Stage 2: runtime ----------
FROM caddy:2-alpine

# Built static site goes here; Caddyfile is volume-mounted by compose so it
# can be tweaked without rebuilding the image.
COPY --from=build /build/frontend/dist/ /usr/share/caddy/

EXPOSE 80 443 443/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
