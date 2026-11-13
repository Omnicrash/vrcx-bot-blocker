# The shared blocklist API (vapi.omnicrash.net), after Vibenator's image.
# Built from the repo root by server/deploy/deploy.sh (on xdisk, from git archive HEAD).
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server/ ./

FROM oven/bun:1.4-slim
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app

ARG APP_VERSION=dev
ENV VAPI_DB=/data/vapi.db \
    VAPI_COOKIE_FILE=/data/vrchat-cookie.json \
    VAPI_REVIEW_TOKEN_FILE=/data/review.token \
    VAPI_PORT=3060 \
    VAPI_VERSION=${APP_VERSION} \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3060 3061
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3060/healthz || exit 1
CMD ["bun", "src/index.ts"]
