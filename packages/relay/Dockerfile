# syntax=docker/dockerfile:1.7
#
# Minimal container image for herdr-remote-relay.
#
# Build context is the repository root (the build needs the root lockfile and
# the web workspace):
#
#   docker build -f packages/relay/Dockerfile -t herdr-relay .
#
# The final image is assembled from scratch: Alpine's Node.js and only the
# shared libraries it links, compressed with UPX, plus busybox for a shell and
# the health check. The relay itself is the single bundled file the release
# ships (scripts/bundle-release.mjs), so there is no node_modules at all. The
# web fonts (~16 MB of woff2) are most of what remains, and do not compress.
#
# Where apk downloads from. Empty keeps Alpine's own CDN, which is what CI
# uses; in mainland China that CDN can take many minutes per package, so a
# local build there passes a domestic mirror's host name:
#
#   docker build -f packages/relay/Dockerfile \
#     --build-arg ALPINE_MIRROR=mirrors.aliyun.com -t herdr-relay .
ARG ALPINE_MIRROR=

# ---------------------------------------------------------------------------
# Stage 1: compile the relay, build the browser bundle, bundle the release.
#
# Pinned to BUILDPLATFORM: the output is plain JS/CSS, identical for every
# target architecture, so there is no reason to run tsc or vite under QEMU
# emulation during the linux/arm64 leg of a multi-arch build.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

# Copy only manifests first so dependency installation stays cached when
# application source changes. All workspace manifests are required because
# `npm ci` validates the root lockfile against every declared workspace.
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/relay/package.json packages/relay/
COPY packages/relay/web/package.json packages/relay/web/

# Scoping the install to the relay and web workspaces means the CLI
# workspace's native `node-pty` dependency is never fetched or compiled.
RUN npm ci -w herdr-remote-relay -w herdr-remote-web --include-workspace-root --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/relay/tsconfig.json packages/relay/
COPY packages/relay/src packages/relay/src
RUN npm run build:server -w herdr-remote-relay

COPY packages/relay/web packages/relay/web
RUN npm run build -w herdr-remote-web

COPY scripts/bundle-release.mjs scripts/
COPY packages/relay/bin packages/relay/bin
COPY packages/relay/LICENSE packages/relay/
RUN node scripts/bundle-release.mjs relay /out --runtime

# ---------------------------------------------------------------------------
# Stage 2: the runtime file system, for the *target* platform.
#
# Alpine's `nodejs` links against the distro's OpenSSL, ICU, brotli, c-ares…
# rather than carrying its own copies like the official binary, so it plus
# exactly the libraries `ldd` names is far smaller than any Node base image.
# ---------------------------------------------------------------------------
FROM alpine:3.21 AS rootfs
ARG ALPINE_MIRROR
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s#dl-cdn.alpinelinux.org#$ALPINE_MIRROR#" /etc/apk/repositories; fi \
    && apk add --no-cache nodejs \
    && mkdir -p /rootfs/usr/bin /rootfs/bin /rootfs/etc /rootfs/tmp /rootfs/data /rootfs/app \
    && chmod 1777 /rootfs/tmp \
    && libs="$( (ldd /usr/bin/node; ldd /bin/busybox) | awk '$2 == "=>" { print $3 } $1 ~ /^\// { print $1 }' | sort -u)" \
    # -h follows symlinks, so each library lands as a real file under its soname.
    && tar -ch $libs /usr/share/icu /bin/busybox | tar -x -C /rootfs \
    # Every applet as a link, so `docker exec … ls` works like on any Alpine.
    && for applet in $(/bin/busybox --list); do ln -s busybox "/rootfs/bin/$applet"; done \
    && printf 'root:x:0:0:root:/root:/bin/sh\nrelay:x:10001:10001:relay:/app:/bin/sh\n' > /rootfs/etc/passwd \
    && printf 'root:x:0:\nrelay:x:10001:\n' > /rootfs/etc/group \
    && cp /usr/bin/node /node

# ---------------------------------------------------------------------------
# Stage 3: compress the Node binary.
#
# UPX packs the target-architecture binary from the build platform: it is a
# file format conversion, not something that has to run under emulation.
# 52 MB becomes about 12 MB; the cost is well under a second at start-up and
# the unpacked binary living in anonymous memory instead of the page cache.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM alpine:3.21 AS upx
ARG ALPINE_MIRROR
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s#dl-cdn.alpinelinux.org#$ALPINE_MIRROR#" /etc/apk/repositories; fi \
    && apk add --no-cache upx
COPY --from=rootfs /node /node
RUN upx --lzma --best -q /node

# ---------------------------------------------------------------------------
# Stage 4: runtime.
# ---------------------------------------------------------------------------
FROM scratch AS runtime

COPY --from=rootfs /rootfs/ /
COPY --from=upx /node /usr/bin/node
# `PACKAGE_ROOT` resolves to /app: the bundle is /app/bin/herdr-remote-relay.js,
# the web assets /app/web/dist and the version comes from /app/package.json.
COPY --from=build /out/ /app/

# The relay runs as 10001 and keeps its device records in /data. (Done here:
# COPY copies a directory's contents, never the ownership of the directory.)
# Then fail the build, for every architecture, if the packed binary cannot run.
RUN ["/bin/sh", "-c", "chown 10001:10001 /data && /usr/bin/node -e \"require('node:crypto').randomBytes(8); new Intl.DateTimeFormat('en').format(0)\""]

# Container-appropriate defaults. Every one of these stays overridable with
# `docker run -e`.
ENV NODE_ENV=production \
    RELAY_BIND=0.0.0.0 \
    RELAY_PORT=8787 \
    RELAY_AUTH_STATE_FILE=/data/relay-auth.json

WORKDIR /app
USER 10001:10001
EXPOSE 8787
VOLUME ["/data"]

# busybox wget rather than a second Node process: the packed binary costs a
# fresh unpack every time it starts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/bin/sh", "-c", "wget -q -O /dev/null \"http://127.0.0.1:${RELAY_PORT:-8787}/healthz\""]

ENTRYPOINT ["/usr/bin/node", "/app/bin/herdr-remote-relay.js"]
