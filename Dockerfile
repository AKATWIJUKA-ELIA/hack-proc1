# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Quotebook — Next.js frontend container.
#
# This image runs ONLY the Next.js app. Convex is a hosted backend, not part of
# this image: the container talks to your Convex deployment over the network via
# NEXT_PUBLIC_CONVEX_URL.
#
# NEXT_PUBLIC_CONVEX_URL is a *build argument*, not just a runtime env var,
# because Next.js inlines NEXT_PUBLIC_* into the browser bundle at build time.
# Pass it with --build-arg (see README-DOCKER.md).
# ─────────────────────────────────────────────────────────────────────────────

# ---- Stage 1: install dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
# Only the manifests, so this layer is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

# ---- Stage 2: build the app ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Baked into the client bundle at build time — the Convex Cloud deployment URL.
# Defaults to the live deployment so `docker build` works with NO flags; override
# with --build-arg NEXT_PUBLIC_CONVEX_URL=... to point at a different deployment.
ARG NEXT_PUBLIC_CONVEX_URL=https://veracious-stork-385.convex.cloud
ENV NEXT_PUBLIC_CONVEX_URL=${NEXT_PUBLIC_CONVEX_URL}

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Stage 3: minimal runtime ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# The standalone output bundles a minimal server + only the deps it needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# server.js is emitted by Next.js standalone output.
CMD ["node", "server.js"]
