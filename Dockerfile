# syntax=docker/dockerfile:1
FROM node:24.14.0-bookworm-slim AS build
WORKDIR /build
RUN npm install --global pnpm@12.14.0
COPY . .
RUN pnpm --filter @paws/web... --filter @paws/server... install --frozen-lockfile
RUN pnpm build && pnpm build:server

FROM docker:29.2.1-cli AS docker-cli

FROM node:24.14.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 ripgrep procps util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /build/dist/server ./server
COPY --from=build /build/apps/web/dist ./web
COPY LICENSE ./LICENSE
ENV NODE_ENV=production \
    PAWS_HOME=/home/node/.paws \
    PAWS_WEB_ROOT=/app/web \
    PAWS_HOST=0.0.0.0 \
    PAWS_COMPANION_HOST=0.0.0.0
USER node
EXPOSE 4310 4311
STOPSIGNAL SIGTERM
CMD ["node", "/app/server/src/main.js"]
