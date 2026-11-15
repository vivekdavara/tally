# syntax=docker/dockerfile:1
#
# Tally's container images: one Dockerfile, three targets, one per process (DESIGN.md, "Deployment").
#
#   docker build -t tally-web .                            the web server (the default target)
#   docker build --target worker -t tally-worker .         the background worker: overdue reminders (+ reconciliation)
#   docker build --target migrate -t tally-migrate .       the release step: prisma migrate deploy, as tally_owner
#
# The release order is migrate, then web and worker: the server refuses to start against a database without the
# row-level security policies, so a web container started before the migrations exits 1 instead of serving.
# Configuration is environment variables only (.env.example lists them); no secret is baked into an image, and
# .dockerignore keeps a local .env out of the build context, since Next.js's standalone output would copy it in.

# Node 24 LTS on Debian 12, pinned by digest (24.22.2, published 2026-11-05).
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# Node plus OpenSSL, which Prisma's engines need, and the files npm ci reads. npm ci's postinstall runs
# `prisma generate`, which needs only the schema.
FROM ${NODE_IMAGE} AS install
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

# Every dependency, development ones included: the build needs them.
FROM install AS deps
RUN npm ci

# `npm run build`: Next.js's standalone server (.next/standalone, with only the node_modules it traces) and the
# bundled worker (dist/). Neither needs a database or any secret to build.
FROM deps AS build
COPY . .
RUN npm run build

# The release step. Runs `prisma migrate deploy` with MIGRATE_DATABASE_URL (the owner role), then exits. It is the
# only image that holds the migrations and the only process that should ever get the owner's credentials. Its own
# install, production dependencies only (Prisma's CLI is one, for this image): built on `deps`, with the compilers
# and test tools the build needs, it was 1.3 GB. No optional packages either: among the production ones those are
# Next.js's compiler binary and sharp's image library, which a migration never loads.
FROM install AS migrate
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# What the web server and the worker share: Node, the standalone server, the worker bundles, nothing else. No
# compiler, no dependencies beyond what the server traces, no source, no migrations (the base image's own npm aside).
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/dist/worker.mjs /app/dist/reconcile.mjs ./dist/
# Read-only for the process: it runs as `node` (uid 1000) and the files stay root's, except Next.js's cache
# directory, where it may write rendered pages and fetch results.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node

# The worker: runs the jobs on an interval, stops cleanly on SIGTERM (exit 0). `--once` runs one pass, for cron.
# Several replicas are safe (reminders are claimed with SKIP LOCKED and a lease).
FROM runtime AS worker
CMD ["node", "dist/worker.mjs"]

# The web server, the default target. HOSTNAME: the standalone server binds to $HOSTNAME, which Docker sets to the
# container's id (one interface, not loopback); 0.0.0.0 listens on all of them. Next.js handles SIGTERM itself:
# it stops accepting, finishes requests in flight, then exits 143.
FROM runtime AS web
ENV PORT=8117 HOSTNAME=0.0.0.0
EXPOSE 8117
# /api/health answers 200 only when the database answers and the role is bound by row-level security. On the port
# the server listens on, which the container's PORT may change.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
