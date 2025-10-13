FROM oven/bun:1 AS build
WORKDIR /app

# Install deps with good cache behavior
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

# Include project files needed for build
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY auth-schema.ts ./
COPY src ./src

ENV NODE_ENV=production

# Build client assets (SolidJS via Vite) into /app/dist
RUN bun run build

# Compile app static server to a single binary
RUN bun build \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --outfile /app/app-server \
    src/appServer.ts

# Minimal runtime image
FROM gcr.io/distroless/cc-debian12
WORKDIR /app
COPY --from=build /app/app-server /app/app-server
COPY --from=build /app/dist /app/dist
ENV NODE_ENV=production
EXPOSE 8080
# Run as non-root
USER 65532:65532
CMD ["./app-server"]
