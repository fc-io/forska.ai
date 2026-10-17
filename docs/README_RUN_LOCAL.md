# Run Local

This is the supported local development flow for Forska. Core product configuration lives in the app UI and local databases.

## Prerequisites

- Bun
- Optional local or remote model provider
- Optional local OpenAI-compatible inference endpoint

Install Bun if needed:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

```bash
git clone https://github.com/fc-io/forska.ai.git
cd forska.ai
bun install
```

## Start The App

The easiest local development flow starts the API/server stack and Vite app together:

```bash
bun run dev:start
```

Press `Ctrl-C` in that terminal to stop both processes.
The server applies database migrations automatically on startup.

If you prefer separate terminals, start the local API/server stack:

```bash
bun run dev:server
```

Start the web app:

```bash
bun run dev:app
```

Default local endpoints:

- Web app: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:3001`
- Runtime data:
  - macOS: `~/Library/Application Support/Forska/runtime/primary/`
  - Linux: `${XDG_DATA_HOME:-~/.local/share}/forska/runtime/primary/`
  - Windows: `%LOCALAPPDATA%\Forska\runtime\primary\`

Open the local URL printed by Vite, usually `http://127.0.0.1:3000`.

## Optional Manual Migration

Normal local startup does not require this. If you ever need to run migrations without starting the app:

```bash
bun run db:mig
```

## Configure Providers

1. Open `/providers`.
2. Add a provider connection.
3. Open the provider and click `Test`.
4. Click `Sync Models` or `Add Model`.
5. Enable the models you want and click `Save Models`.
6. Set user-facing app settings in Forska Settings.

Do not create or edit `.env` files for normal local development.

## Optional Local Overrides

Most local users should not need environment variables. If you need a machine-local override, pass it inline with the command:

```bash
DUCKDB_PATH=~/forska/forska.duckdb bun run dev:server
```

Port overrides can be exported once per shell:

```bash
export VITE_PORT=3100
export API_SERVER_PORT=3101
export APP_SERVER_PORT=8180
```

Optional direct-origin frontend override:

```bash
VITE_SERVER_API=http://127.0.0.1:3001 bun run dev:app
```

## Optional Local Inference Endpoint

Forska can use a local OpenAI-compatible endpoint such as `llama-server`, LM Studio, Ollama, or another local provider.

For a local OpenAI-compatible endpoint, add a provider in `/providers` and set the base URL to the endpoint's `/v1` URL, for example:

```text
http://127.0.0.1:8080/v1
```

Then click `Test`, sync or manually add models, and enable the models you want.

## Optional PDF Conversion (MinerU or Docling)

PDF-to-text conversion uses exactly one model, chosen in `/settings` as the PDF conversion model. It can come from a MinerU provider or a Docling provider. Forska never switches between them on its own: if the chosen server is down, conversion fails and retries later.

Every conversion stores:

- `full_text`: the converter's markdown.
- `full_text_html`: Docling's HTML. MinerU produces no HTML, so this stays empty for MinerU.
- `full_text_assets`: the figure list `[{index, page, bbox, caption, imagePath}]`. `bbox` is in page fractions with the origin at the top left.
- `full_text_conversion_metadata`: `converterKind`, `converterVersion`, `optionsHash` (sha256 of the exact request options), `baseURL`, `modelId` and `layoutPath`.

Figure crops and the layout blocks are written to `assets/full-text-assets/<articleId>/` (`fig-N.<ext>`, `layout.json`) under the runtime root, next to `assets/article_pdfs/`. That directory is replaced on every reconversion.

### MinerU 4 (local parsing API)

Install MinerU into its own virtualenv, not the system Python. Tested with MinerU 4.0.12 on an M4 Pro. On macOS arm64 the install pulls in PyTorch (MPS).

```bash
mkdir -p ~/Developer/forska-tools/mineru && cd ~/Developer/forska-tools/mineru
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python 'mineru==4.0.12'
```

Start the parsing API. Forska's default MinerU base URL is `http://127.0.0.1:8000`:

```bash
~/Developer/forska-tools/mineru/.venv/bin/mineru-api --host 127.0.0.1 --port 8000 --tier standard --concurrency 2
```

- The first parse downloads about 2 GB of weights to `~/.mineru/models`:
  - `MinerU-4_models_torch` (layout and OCR)
  - `MinerU2.5-Pro-2605-1.2B-GGUF` (the VLM, run through llama.cpp)
- Check that it is up: `curl http://127.0.0.1:8000/v1/health` should return `{"status":"ok","version":"4.0.12",...}`.
- Stop it with Ctrl-C, or `pkill -f mineru-api`.
- Use `mineru-api`, not `mineru server start`. The latter starts MinerU's document-library server, which has a different API.
- Port 8000 is also vLLM's default. If both run, start MinerU on another port and set that base URL on the provider.

Then:

1. In `/providers`, add a **MinerU** provider, click `Test`, then sync models. This creates one model, `mineru-standard`, which carries the server version.
2. Select that model in `/settings`.

Request forska sends: `POST /v1/file_parse` with `tier=standard`, `ocr_mode=auto`, `page_range=` (all pages), `output_formats=markdown,middle_json,zip` and `response_format=zip`. It reads `markdown.md`, `middle_json.json` and the `images/` crops from the zip. A request that does not finish within the 10-minute conversion timeout is canceled on the server and retried later.

### Docling Serve

```bash
mkdir -p ~/Developer/forska-tools/docling && cd ~/Developer/forska-tools/docling
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python docling-serve
.venv/bin/docling-serve run --host 127.0.0.1 --port 5001
```

Then add a **Docling Serve** provider in `/providers`, add the model, and select it in `/settings`.

Forska sends `POST /v1/convert/source` with a zip target. It does not rely on any server default for these options:

- `to_formats: ['md','json','html']`
- `image_export_mode: 'referenced'`, `include_images: true`, `include_page_images: false`, `images_scale: 2`
- `do_ocr: true`, `force_ocr: false`
- `do_table_structure: true`, `table_mode: 'accurate'`
- `pdf_backend: 'docling_parse'`, `pipeline: 'standard'`
- picture description, picture classification, chart extraction, code and formula enrichment all off
- `do_pdf_heading_hierarchy: false`, `md_compact_tables: false`, `md_page_break_placeholder: ''`

`converterVersion` is the list of `docling*` package versions reported by `GET /version`.

### Conversion worker knobs

Optional conversion worker knobs can be passed inline when starting the server. The default concurrency is 2:

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true FULL_TEXT_CONVERSION_BATCH_SIZE=5 FULL_TEXT_CONVERSION_CONCURRENCY=2 bun run dev:server
```

### Figure descriptions

Projects with figure mode Descriptions need an installation-wide figure-description model (Settings → Figure-description model). The selector lists only enabled models whose capability record accepts image input and whose transport can send images (OpenAI-compatible chat, OpenAI Responses, Anthropic Messages, Gemini). Codex and Claude Code cannot send images yet. None is an explicit choice and makes figure mode Descriptions unavailable.

The cron `full-text-jobs-describe-figures` runs every minute when `RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true` and a figure-description model is set. It describes figures of converted articles that belong to at least one project with figure mode Descriptions, one model call per figure with prompt `fig-desc-v1`, and writes `description`, `descriptionModelId`, `descriptionPromptVersion` and `describedAt` into the article's `full_text_assets` entry. Changing the model or the prompt version re-describes. A failed figure records `descriptionError` and `descriptionAttempts` and is given up after 3 attempts, or at once when the crop is missing or not JPEG/PNG. `POST /api/articles/:id/figure-descriptions/rebuild` clears one article's descriptions and describes it again.

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true FIGURE_DESCRIPTION_BATCH_SIZE=8 FIGURE_DESCRIPTION_CONCURRENCY=2 bun run dev:server
```

A local vision model through Ollama works, for example `ollama pull qwen3-vl:2b-instruct`, then refresh the Ollama provider's models so the model shows image input.

## Build

Create a production build:

```bash
bun run build
```

Run the built app server stack:

```bash
bun run start
```

## Test And Lint

```bash
bun test
bun run lint
```
