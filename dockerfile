# ./bun/Dockerfile
FROM oven/bun:1 AS deps
WORKDIR /forska
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

FROM oven/bun:1
WORKDIR /forska
ENV NODE_ENV=production \
    PORT=3000
COPY --from=deps /forska/node_modules ./node_modules
COPY . .
EXPOSE 3000
# Healthcheck endpoint is optional – expose /healthz in your app if you like
# HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:3000/healthz || exit 1
CMD ["bun", "run", "start"]
