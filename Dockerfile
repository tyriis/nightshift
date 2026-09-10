# Plan F — the single Docker image (spec §9). ONE base tag across the three stages:
# one glibc, one native ABI (operators pin @sha256 digests in home-ops).
FROM node:24-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
# python3/make/g++ = better-sqlite3@13's node-gyp arm — deterministic either way (P6);
# they NEVER ship in the runtime layer.
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY adapters/sveltekit/package.json adapters/sveltekit/
RUN pnpm install --frozen-lockfile
COPY . .
# the D-ddd BUILD GATE: tsc + the SvelteKit static SPA + the offline guard as an image
# gate — a shell that suddenly phones a CDN REDS the image exactly as it REDS the repo.
RUN pnpm build && pnpm ui:build && pnpm ui:offline-check

FROM node:24-bookworm-slim AS proddeps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY adapters/sveltekit/package.json adapters/sveltekit/
# nightshift-ui has ZERO runtime deps — this tree is exactly the root's eight prod deps,
# with better-sqlite3's native build landing HERE (preflight P4 verified this resolves)
RUN pnpm install --prod --frozen-lockfile

# ---- the D-ccc layout ruling, as code: WORKDIR /app makes the repo-root-relative
# asset story (openapi/openapi.yaml + adapters/sveltekit/build from process.cwd())
# an absolute, provable image contract. No backend code moves; the app tree is
# root-owned 755 — the only writable path for the node user is the /data volume.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=proddeps /app/adapters/sveltekit ./adapters/sveltekit
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY openapi ./openapi
COPY --from=build /app/adapters/sveltekit/build ./adapters/sveltekit/build
COPY bin ./bin
RUN mkdir -p /data && chown node:node /data
USER node
ENV NS_DB_PATH=/data/nightshift.db \
    NS_DATA_DIR=/data
EXPOSE 3123
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --start-interval=1s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NS_PORT??3123)+'/ping').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
