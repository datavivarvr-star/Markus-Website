# Build context: repo root (needs assets/ and docs/ alongside frontend/)

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* frontend/
RUN cd frontend && npm ci

# vite.config.js resolves ../assets and visemes.js imports ../../docs/
COPY frontend/ frontend/
COPY assets/   assets/
COPY docs/     docs/

RUN cd frontend && npm run build

# ---------- Stage 2: runtime ----------
FROM caddy:2-alpine

COPY --from=build /build/frontend/dist/ /usr/share/caddy/

EXPOSE 80 443 443/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
