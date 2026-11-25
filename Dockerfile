# syntax=docker/dockerfile:1
# One image for every role. ROLE=migrate runs the release step once per deploy; ROLE=web serves the app on PORT;
# ROLE=worker runs email, alerts and the scheduled jobs. See docs/self-hosting.md.

ARG NODE_IMAGE=node:24-bookworm-slim

# Dependencies, from the lockfile only (cached until package.json or package-lock.json changes).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The production build. The Inter font is a committed file, so nothing is downloaded here.
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# NODE_OPTIONS caps each process's heap; raise it (and the container's memory limit) for a large agency.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    ROLE=web \
    NODE_OPTIONS=--max-old-space-size=768
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --chown=node:node package.json next.config.mjs tsconfig.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
# The user manuals and their screenshots, read by the in-app Help pages.
COPY --chown=node:node docs/manuals ./docs/manuals
COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Local file storage (STORAGE_DRIVER=local) writes here; mount a volume if you use it.
RUN mkdir -p /app/var && chown node:node /app/var
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
