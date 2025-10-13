FROM oven/bun:1 AS build
WORKDIR /app

# Install build tools required for native modules (node-gyp)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 python-is-python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install deps with good cache behavior
# Install only production deps to avoid slow native/optional dev installs
ENV NODE_ENV=production
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile --production

# Include project files needed for build
COPY tsconfig.json ./
COPY auth-schema.ts ./
COPY src ./src

ENV NODE_ENV=production

# Compile API server to a single binary
RUN bun build \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --outfile /app/server \
    src/server/index.ts

# Minimal runtime image
FROM gcr.io/distroless/cc-debian12
WORKDIR /app
COPY --from=build /app/server /app/server
ENV NODE_ENV=production
EXPOSE 3000
# Run as non-root
USER 65532:65532
CMD ["./server"]
