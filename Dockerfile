# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:22.20.0-bookworm-slim AS web-build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN --mount=type=cache,id=veilink-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json eslint.config.js ./
COPY apps/web ./apps/web
COPY packages/protocol ./packages/protocol

RUN pnpm --filter @veilink/protocol build \
    && pnpm --filter @veilink/web build

FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm AS go-build

ARG TARGETOS
ARG TARGETARCH
WORKDIR /app/apps/server

COPY apps/server/go.mod apps/server/go.sum ./
RUN --mount=type=cache,id=veilink-go-mod,target=/go/pkg/mod \
    GOTOOLCHAIN=local go mod download

COPY apps/server/cmd ./cmd
COPY apps/server/internal ./internal
RUN --mount=type=cache,id=veilink-go-build,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local \
    go build -trimpath -ldflags='-s -w -buildid=' -o /out/veilink ./cmd/veilink \
    && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local \
    go build -trimpath -ldflags='-s -w -buildid=' -o /out/healthcheck ./cmd/healthcheck

FROM gcr.io/distroless/static-debian12:nonroot AS runtime

ENV HOST=0.0.0.0
ENV PORT=3000
ENV WEB_DIST_DIR=/app/web
WORKDIR /app

COPY --from=go-build --chown=65532:65532 /out/veilink /app/veilink
COPY --from=go-build --chown=65532:65532 /out/healthcheck /app/healthcheck
COPY --from=web-build --chown=65532:65532 /app/apps/web/dist /app/web

USER 65532:65532
EXPOSE 3000

ENTRYPOINT ["/app/veilink"]
