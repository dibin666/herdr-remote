# syntax=docker/dockerfile:1.7
#
# Minimal container image for herdr-remote-relay.
#
# Build context is the repository root (the build needs the root lockfile and
# the web workspace):
#
#   docker build -f packages/relay/Dockerfile -t herdr-relay .
#
# The final stage is a bare alpine image plus the Node binary — no npm, no
# package manager, no toolchain. The relay's only runtime dependency is `ws`.

# ---------------------------------------------------------------------------
# Stage 1: install the web workspace and build the browser bundle.
#
# Pinned to BUILDPLATFORM: the output is static JS/CSS, identical for every
# target architecture, so there is no reason to run vite under QEMU emulation
# during the linux/arm64 leg of a multi-arch build.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS web-build
WORKDIR /app

# Copy only manifests first so dependency installation stays cached when
# application source changes. All workspace manifests are required because
# `npm ci` validates the root lockfile against every declared workspace.
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/relay/package.json packages/relay/
COPY packages/relay/web/package.json packages/relay/web/

# `-w herdr-remote-web` keeps the install scoped to the web workspace, so the
# CLI workspace's native `node-pty` dependency is never fetched or compiled.
RUN npm ci -w herdr-remote-web --ignore-scripts

COPY packages/relay/web packages/relay/web
RUN npm run build -w herdr-remote-web

# ---------------------------------------------------------------------------
# Stage 2: resolve the relay's production dependencies (`ws` only).
#
# Also BUILDPLATFORM-pinned: `ws` is pure JavaScript with no native addon, so
# the resolved tree is architecture independent.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/relay/package.json packages/relay/
COPY packages/relay/web/package.json packages/relay/web/

RUN npm ci -w herdr-remote-relay --omit=dev --ignore-scripts \
    # The workspace install symlinks sibling packages into node_modules; drop
    # them so the runtime stage carries real files only.
    && rm -rf node_modules/herdr-remote-relay node_modules/herdr-remote-web node_modules/herdr-remote \
    && rm -rf node_modules/.package-lock.json

# ---------------------------------------------------------------------------
# Stage 3: runtime. Alpine + the Node binary, nothing else.
# ---------------------------------------------------------------------------
FROM alpine:3.21 AS runtime

# libstdc++ is the only shared library the Node binary needs beyond musl.
RUN apk add --no-cache libstdc++ \
    && addgroup -g 10001 -S relay \
    && adduser -u 10001 -S -G relay -h /app relay \
    && mkdir -p /data \
    && chown relay:relay /data

# Resolved for the *target* platform, unlike the builder stages above, so an
# arm64 image gets the arm64 Node binary. Stripping it saves under 2 MB (the
# official build is already stripped), so it is not worth the extra stage.
COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Runtime dependency tree (`ws`).
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
# Relay sources. `PACKAGE_ROOT` resolves to /app, so web assets must live at
# /app/web/dist and package.json must sit at /app/package.json.
COPY --chown=root:root packages/relay/package.json ./package.json
COPY --chown=root:root packages/relay/bin ./bin
COPY --chown=root:root packages/relay/src ./src
COPY --from=web-build --chown=root:root /app/packages/relay/web/dist ./web/dist

# Container-appropriate defaults. Every one of these stays overridable with
# `docker run -e`.
ENV NODE_ENV=production \
    RELAY_BIND=0.0.0.0 \
    RELAY_PORT=8787 \
    RELAY_AUTH_STATE_FILE=/data/relay-auth.json

USER relay
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.RELAY_PORT||8787}/healthz`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/node", "/app/bin/herdr-remote-relay.js"]
