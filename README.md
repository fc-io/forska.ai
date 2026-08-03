# forska.ai - AI Agents for research

Forska is a local-first very deep, deep research app.

Forska is currently designed as a standalone single-user app. It is not a hosted multi-tenant web app.

## Stack

- Bun and Elysia API
- SolidJS and Vite client
- DuckDB for local app/query data
- SQLite for local job/runtime state

## Quick Start

Install Bun if you do not already have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

Clone the repo and install dependencies:

```bash
git clone https://github.com/fc-io/forska.ai.git
cd forska.ai
bun install
```

Start the local API/server stack and web app together:

```bash
bun run dev:start
```

Then open the local URL printed by Vite, usually `http://127.0.0.1:3000`.

## Local Development

The easiest way to run Forska locally is:

```bash
bun run dev:start
```

That starts both the server stack and the Vite web app, and shuts both down when you press `Ctrl-C`.
The server applies database migrations automatically on startup.

If you prefer separate terminals, run:

```bash
bun run dev:server
bun run dev:app
```

The default local profile uses:

- Web app: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:3001`
- Runtime data:
  - macOS: `~/Library/Application Support/Forska/runtime/primary/`
  - Linux: `${XDG_DATA_HOME:-~/.local/share}/forska/runtime/primary/`
  - Windows: `%LOCALAPPDATA%\Forska\runtime\primary\`

If you ever need to run migrations without starting the app:

```bash
bun run db:mig
```

More local runtime notes: [Run Local](./docs/README_RUN_LOCAL.md)

## Configure Providers

Configure models and providers in the Forska UI:

1. Open `/providers`.
2. Click `Add Provider`.
3. Add a local or remote provider connection.
4. Open the provider, click `Test`, then `Sync Models` or `Add Model`.
5. Enable the models you want and click `Save Models`.

Provider credentials and model settings should be entered through the app, not committed into files.

## Optional Local llama.cpp

Forska can use a local OpenAI-compatible endpoint such as `llama-server`.

Install `llama.cpp` / `llama-server` from the upstream project:

- [Install guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md)
- [Releases](https://github.com/ggml-org/llama.cpp/releases)
- [Build from source](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)

Example model: [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF)

Run a local server:

```bash
llama-server -hf Qwen/Qwen3-4B-GGUF:Q4_K_M --jinja --reasoning-format deepseek -c 8192 --temp 0.6 --top-k 20 --top-p 0.95 --min-p 0
```

Default `llama-server` port is `8080`, so the provider base URL is usually:

```text
http://127.0.0.1:8080/v1
```

Optional check:

```bash
curl http://127.0.0.1:8080/v1/models
```

In the Forska UI, choose an OpenAI-compatible provider, set the base URL to `http://127.0.0.1:8080/v1`, then test and sync models.

## Resource Usage

Forska stores article metadata, imported records, generated review state, and optional cached PDFs locally. Disk usage depends on the size of imported datasets and whether full text or PDFs are stored. Large review projects can require substantial local storage.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
