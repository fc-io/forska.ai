FROM oven/bun:1 AS build
WORKDIR /app

# Install deps with good cache behavior
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

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
