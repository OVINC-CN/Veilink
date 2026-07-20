# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:22.20.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN --mount=type=cache,id=veilink-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json eslint.config.js ./
COPY apps ./apps
COPY assets ./assets
COPY packages ./packages

RUN pnpm --filter @veilink/protocol build \
    && pnpm --filter @veilink/web build \
    && pnpm --filter @veilink/server build

FROM node:22.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV WEB_DIST_DIR=/app/apps/web/dist
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN --mount=type=cache,id=veilink-pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @veilink/server...

COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist

USER node

EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
