FROM oven/bun:1.3.13
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY index.html tsconfig.json vite.config.ts ./
COPY containers/apple/start.sh /usr/local/bin/forska-container-start
ENV XDG_DATA_HOME=/data/share LOG_DIR=/data/logs VITE_HOST=0.0.0.0
RUN ln -s /data/assets /app/assets && ln -s /data/local /app/data
EXPOSE 3000
ENTRYPOINT ["sh", "/usr/local/bin/forska-container-start"]
CMD ["bun", "run", "dev:start"]
