FROM oven/bun:1.3.13 AS duckdb-source
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake ninja-build python3 git curl ca-certificates
WORKDIR /opt/duckdb-source
RUN curl --fail --location --retry 3 https://codeload.github.com/duckdb/duckdb/tar.gz/d8cdaa33fda8df955cc76ef58a280f68f4cd43fa -o /tmp/duckdb-source.tar.gz \
    && echo '8eb72543d047018df3f5cd82f2fee5846d0682823b4860d699cdbf3f8459035a  /tmp/duckdb-source.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/duckdb-source.tar.gz --strip-components=1

FROM duckdb-source AS duckdb-build
ENV CCACHE_DIR=/var/cache/forska-duckdb-ccache CCACHE_MAXSIZE=2G
RUN apt-get update && apt-get install -y --no-install-recommends lld ccache
COPY containers/apple/buildDuckdb.sh containers/apple/duckdb-checkpoint-backport.patch containers/apple/duckdb-nonunity-includes.patch /opt/forska-build/
RUN --mount=type=cache,id=forska-duckdb-155-linux-arm64-ccache,target=/var/cache/forska-duckdb-ccache,sharing=locked --mount=type=cache,id=forska-duckdb-155-linux-arm64-build,target=/opt/duckdb-source/build/release,sharing=locked sh /opt/forska-build/buildDuckdb.sh

FROM oven/bun:1.3.13
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=duckdb-build /opt/forska-duckdb/libduckdb.so /app/node_modules/@duckdb/node-bindings-linux-arm64/libduckdb.so
COPY --from=duckdb-build /opt/forska-duckdb/upstream-tests.xml /usr/local/share/forska-duckdb-upstream-tests.xml
RUN bun -e "const xml = await Bun.file('/usr/local/share/forska-duckdb-upstream-tests.xml').text(); if (/<skipped(?:[\\s/>])/.test(xml)) throw new Error('DuckDB upstream regression tests were skipped')"
COPY --from=duckdb-build /opt/forska-duckdb/provenance.json /usr/local/share/forska-duckdb-provenance.json
RUN bun -e "const d = require('@duckdb/node-bindings'); if (d.library_version() !== 'v1.5.5') throw new Error('Unexpected DuckDB engine'); console.log(d.library_version())"
COPY src ./src
COPY scripts ./scripts
RUN bun scripts/duckdbCheckpointMemoryRegression.ts
COPY index.html tsconfig.json vite.config.ts ./
COPY containers/apple/start.sh /usr/local/bin/forska-container-start
ENV XDG_DATA_HOME=/data/share LOG_DIR=/data/logs VITE_HOST=0.0.0.0
RUN ln -s /data/assets /app/assets && ln -s /data/local /app/data
EXPOSE 3000
ENTRYPOINT ["sh", "/usr/local/bin/forska-container-start"]
CMD ["bun", "run", "dev:start"]
