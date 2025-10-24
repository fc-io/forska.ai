FROM oven/bun:1 AS build
WORKDIR /app

# Install build tools required for native modules (node-gyp)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 python-is-python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install deps with good cache behavior
ENV NODE_ENV=production
COPY bun.lock package.json ./
# Cache Bun's package store across builds for speed
RUN --mount=type=cache,target=/root/.bun \
    --mount=type=cache,target=/root/.cache \
    bun install --frozen-lockfile --production

# Install only the build-time tools in an isolated folder to avoid full devDeps
WORKDIR /tools
RUN printf '{\n  "name": "tools",\n  "private": true,\n  "devDependencies": {\n    "vite": "^7.1.0",\n    "vite-plugin-solid": "^2.11.8",\n    "@tanstack/router-plugin": "^1.132.56",\n    "@tailwindcss/vite": "^4.1.11"\n  }\n}\n' > package.json
RUN --mount=type=cache,target=/root/.bun \
    --mount=type=cache,target=/root/.cache \
    bun install --frozen-lockfile
WORKDIR /app

# Include project files needed for build
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY auth-schema.ts ./
COPY src ./src

# Make Vite and the plugin visible to the project without installing all devDeps
RUN ln -sf /tools/node_modules/vite-plugin-solid /app/node_modules/vite-plugin-solid \
  && ln -sf /tools/node_modules/vite /app/node_modules/vite \
  && ln -sf /tools/node_modules/@tanstack /app/node_modules/@tanstack \
  && ln -sf /tools/node_modules/@tailwindcss /app/node_modules/@tailwindcss \
  && mkdir -p /app/node_modules/.bin \
  && ln -sf /tools/node_modules/.bin/vite /app/node_modules/.bin/vite

# Accept build-time environment variables
ARG DATABASE_URL
ARG BETTER_AUTH_SECRET
ARG BETTER_AUTH_URL
ARG VITE_PORT
ARG API_SERVER_PORT
ARG VITE_LLM_SERVER_URL
ARG VITE_SERVER_API

# Set environment variables for build
ENV NODE_ENV=production
ENV DATABASE_URL=${DATABASE_URL}
ENV BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
ENV BETTER_AUTH_URL=${BETTER_AUTH_URL}
ENV VITE_PORT=${VITE_PORT}
ENV API_SERVER_PORT=${API_SERVER_PORT}
ENV VITE_LLM_SERVER_URL=${VITE_LLM_SERVER_URL}
ENV VITE_SERVER_API=${VITE_SERVER_API}

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
CMD ["/app/app-server"]
