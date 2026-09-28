# The bib backend as ONE image that three different processes run out of.
#
# server, worker and migrate are three deployables — tsup builds all three from
# a single invocation into a single dist/ — but they are deliberately not three
# images. The cost argument is real and small: Artifact Registry bills $0.10 per
# GB per month past a half-gigabyte free tier, and three tags per release that
# differ by zero bytes of payload is waste. That is not the reason.
#
# The reason is that migrate applies the schema that server's queries assume.
# Those two MUST be the same commit. One image referenced by one digest makes
# "we deployed the API but ran migrate from last week's build" structurally
# impossible; three independently tagged images make it a Tuesday, and the
# symptom is a query against a column that does not exist yet, in production,
# under load. Cloud Run overrides the entrypoint per service and per job
# (--command/--args), so one image costs nothing to use three ways:
#
#   server   node dist/cmd/server.js    (the default CMD, at the bottom)
#   worker   node dist/cmd/worker.js
#   migrate  node dist/cmd/migrate.js
#
# The default is the server so that `docker run` with no arguments does the
# obvious thing locally.

# Pinned to the exact version in .nvmrc (22.22.1) rather than floated on
# `node:22`. A floating tag means the image that passed CI and the image that
# ships can be built from different Node minors, and the failure that exposes
# it is never the one you were looking at. Declared once as a global ARG so the
# three stages below cannot drift apart.
#
# Debian slim rather than Alpine. Every production dependency here is pure
# JavaScript, so musl is not itself a blocker — but the PDF renderer leans on
# ICU/Intl-adjacent behaviour (src/infrastructure/render/font-set.ts), and glibc
# is the substrate Cloud Build and Cloud Run are exercised on every day. Roughly
# 40 MB is not worth spending the risk budget on.
ARG NODE_IMAGE=node:22.22.1-bookworm-slim

# ── ON PLATFORM, BEFORE ANY OF THE STAGES ────────────────────────────────────
#
# Cloud Run runs linux/amd64 and nothing else, while this repo is developed on
# arm64 Macs, so a build started here must pass --platform=linux/amd64 or it
# produces an image that pushes fine and then fails to start with no useful
# message. Cloud Build already runs on amd64, so the flag is a no-op there.
#
# Every stage below therefore builds for the TARGET platform, which on a Mac
# means the dependency install and the esbuild compile run under emulation and
# are slow. There is a faster shape — pin the two builder stages to
# --platform=$BUILDPLATFORM so they run natively and copy the results into an
# amd64 runtime — and it would be correct here, because every package under
# `dependencies` was checked for install scripts, binding.gyp and platform
# optionalDependencies and has none of the three, so the installed tree is
# byte-identical across architectures.
#
# It is not used, for an unglamorous reason: $BUILDPLATFORM is a BuildKit
# feature, the pipeline builds with `gcr.io/cloud-builders/docker` without
# DOCKER_BUILDKIT set, and a Dockerfile that builds on a laptop and fails in the
# pipeline is worse than one that is slow on a laptop. Slowness is visible and
# local; the other failure is visible only to whoever is deploying.

# ── deps: the production dependency tree, and nothing else ───────────────────
#
# Separate from the build stage on purpose: the runtime must never inherit a
# node_modules that devDependencies were ever installed into. Pruning after the
# fact leaves what npm decided to leave; installing into a clean tree leaves
# what the lockfile says.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts because nothing here needs a script to run, and the one
# lifecycle hook npm ci would otherwise reach is `prepare: husky || true`.
# husky is a devDependency, so --omit=dev already leaves it absent and the
# `|| true` already swallows the failure — but relying on two accidents to
# cancel out is not the same as the hook never running.
RUN npm ci --omit=dev --ignore-scripts

# ── build: the dist/ bundle, via tsup ────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Plain `npm ci` — NOT --ignore-scripts. esbuild installs its platform binary
# from a postinstall script; skip it and tsup has no compiler to call.
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# The build must produce dist/cmd/*.js, not a flat dist/*.js, and that is not a
# preference. migrate finds its SQL relative to its own file — `join(here, "..",
# "..", "migrations")` in src/cmd/migrate.ts — so from /app/dist/cmd it resolves
# to /app/migrations, and from a flat /app/dist it resolves to /migrations,
# above the app root. The failure mode there is the bad one: migrate finds an
# empty directory, reports nothing pending, exits 0, and the service starts
# against an unmigrated database. package.json's start scripts assume the same
# layout. So the layout is asserted here, where it fails the build, rather than
# discovered at 3am. tsup produces it only when its `entry` is an object map
# keyed "cmd/server" and friends; a bare array of paths under src/cmd makes
# src/cmd the common ancestor and flattens the output.
RUN for f in dist/cmd/server.js dist/cmd/worker.js dist/cmd/migrate.js; do \
      [ -f "$f" ] || { \
        echo "FATAL: the build did not produce $f"; \
        echo "expected: dist/cmd/server.js, dist/cmd/worker.js, dist/cmd/migrate.js"; \
        echo "tsup emitted instead:"; \
        ls -R dist; \
        echo "fix: tsup.config.ts 'entry' must be an object map ({ \"cmd/server\": \"src/cmd/server.ts\", ... }),"; \
        echo "     not an array — an array flattens the output to dist/server.js."; \
        exit 1; \
      }; \
    done

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production
# The app reads BIB_PORT. Cloud Run injects PORT. They are not the same variable
# and nothing aliases them — they agree only because both default to 8080, which
# is why this is set explicitly here instead of left to the schema's default and
# why the Cloud Run container port must be left at 8080. Setting --port to
# anything else gives you a service that listens on 8080 while the load balancer
# talks to something else, and the symptom is a startup probe that never passes.
ENV BIB_PORT=8080
# Sourcemaps are in dist/ either way (tsup emits them), so the only question is
# whether a production stack trace points at TypeScript or at bundled output.
# The cost is paid only when something already threw.
ENV NODE_OPTIONS=--enable-source-maps

# dist/ is bundled but its dependencies are NOT bundled in — tsup marks
# package.json dependencies external. A real node_modules is therefore load
# bearing at runtime, not an optimisation: src/infrastructure/render/font-set.ts
# does a require.resolve() into @fontsource/noto-sans while rendering a PDF, so
# a missing tree is a runtime failure on a customer document, not a boot error.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# migrations/ ships in the image because migrate reads the .up.sql files at
# runtime; they are not compiled into anything. 1.1 MB, and the only large
# directory in the build context that has to survive .dockerignore.
COPY --chown=node:node migrations ./migrations
# package.json, for exactly one field: "type": "module". Without it Node reads
# dist/**/*.js as CommonJS and every entrypoint dies on its first import.
COPY --chown=node:node package.json ./package.json

# Stamped by the pipeline, which passes --build-arg=COMMIT_SHA and
# --build-arg=BUILD_TIME (cloudbuild.yaml). Twice over, for two readers:
#
# - the LABEL answers "which commit is this revision running" from `docker
#   inspect`, or from the digest alone, without starting the container, which
#   is the form the question takes during an incident;
# - the ENV is read by src/config (BIB_BUILD_COMMIT, BIB_BUILD_TIME) and
#   reported by GET /health, so a tester or a staff screen can ask the running
#   API which build it is (V0.2) without access to the cloud console.
#
# An image built without the args (`gcloud builds submit --tag`, a bare
# `docker build`) gets empty values, which /health reports as null rather than
# as a guess.
ARG COMMIT_SHA=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.revision="$COMMIT_SHA"
LABEL org.opencontainers.image.created="$BUILD_TIME"
ENV BIB_BUILD_COMMIT=$COMMIT_SHA
ENV BIB_BUILD_TIME=$BUILD_TIME
LABEL org.opencontainers.image.title="bib-backend"
LABEL org.opencontainers.image.description="bib backend — one image, three entrypoints: dist/cmd/server.js, dist/cmd/worker.js, dist/cmd/migrate.js"

EXPOSE 8080

# uid 1000, which the official Node images already define. Worth stating why the
# name matters: Cloud Run does not fail on a user it cannot resolve, it silently
# runs the container as root. A typo here would not announce itself.
USER node

# EXEC FORM, and this is the line most worth reading twice.
#
# Shell form (`CMD node dist/cmd/server.js`) makes /bin/sh PID 1 with node as
# its child. Under Cloud Run's second-generation execution environment the
# container process IS the init process, which by design has no default signal
# dispositions — so that shell ignores SIGTERM itself AND forwards nothing. Node
# never hears it.
#
# For the worker that is data loss, not untidiness. src/cmd/worker.ts registers
# SIGTERM explicitly and drains pg-boss for BIB_WORKER_SHUTDOWN_GRACE_MS before
# closing the pools; behind a shell PID 1 that drain never begins, the sweep is
# SIGKILLed wherever it happened to be, and a firm's jobs are left half-written.
# Exec form makes node itself PID 1, which is safe here precisely because worker
# and server both install their own handlers rather than relying on defaults.
#
# No tini, no dumb-init. They exist to forward signals on behalf of a process
# that does not handle them; these processes do, and adding an init would add a
# second program that has to get forwarding right to solve a problem that no
# longer exists.
#
# One thing the image cannot fix, stated here because this is where someone will
# look for it: Cloud Run's SIGTERM-to-SIGKILL window is a fixed 10 seconds, for
# services, jobs and worker pools alike, with no field to extend it. The default
# BIB_WORKER_SHUTDOWN_GRACE_MS of 45000 is six times that, so the worker pool
# must set it to roughly 7000 for stop() to return inside the window. That is a
# deployment setting, not a build one.
CMD ["node", "dist/cmd/server.js"]
