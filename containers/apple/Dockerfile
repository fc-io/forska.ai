FROM oven/bun:1.3.13
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor/duckdb/manifest.json ./vendor/duckdb/manifest.json
COPY scripts/verifyDuckdbDistribution/pruneDuckdbPlatformPackages.ts ./scripts/verifyDuckdbDistribution/pruneDuckdbPlatformPackages.ts
RUN --mount=type=cache,id=forska-bun-install,target=/var/cache/forska-bun,sharing=locked BUN_INSTALL_CACHE_DIR=/var/cache/forska-bun bun install --frozen-lockfile \
    && bun -e "import {pruneDuckdbPlatformPackages} from './scripts/verifyDuckdbDistribution/pruneDuckdbPlatformPackages.ts'; console.log(pruneDuckdbPlatformPackages('/app/node_modules', process.platform, process.arch))"
COPY --parents vendor/duckdb/**/* src/**/* scripts/**/* ./
RUN test -f scripts/verifyDuckdbDistribution.ts && test -f src/server/index.ts && test -f scripts/devStart.ts \
    && bun scripts/verifyDuckdbDistribution.ts
RUN bun -e "const path = 'node_modules/@duckdb/node-bindings-' + process.platform + '-' + process.arch + '/FORSKA_DUCKDB_PROVENANCE.json'; await Bun.write('/usr/local/share/forska-duckdb-provenance.json', Bun.file(path))"
COPY index.html tsconfig.json vite.config.ts ./
COPY containers/apple/start.sh /usr/local/bin/forska-container-start
ENV XDG_DATA_HOME=/data/share LOG_DIR=/data/logs VITE_HOST=0.0.0.0
RUN ln -s /data/assets /app/assets && ln -s /data/local /app/data
EXPOSE 3000
ENTRYPOINT ["sh", "/usr/local/bin/forska-container-start"]
CMD ["bun", "run", "dev:start"]
