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

Run `bun install` again after every `git pull` (or branch switch) that changes `package.json` or `bun.lock`. The dev watcher restarts the server on code changes but does not install packages. On startup the server checks that every dependency in `package.json` is installed in a matching version and that the lazily loaded full-text modules (`fflate`, `pngjs`, `gpt-tokenizer`) resolve; if not, it exits with one line naming the packages and `bun install`. After installing, start the server again (a running `bun run dev:server` watcher restarts it on the next file change).

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

## Operator DB Scripts

The `bun run db:*` scripts (snapshot queries, studio, backups, checkpoints, index rebuilds, review-serving repair tools) run through `scripts/runWithRuntimeProfile.ts --profile primary --mode script`, so they open the same DuckDB file as `bun run dev:server`. Snapshot query, studio, backup, checkpoint and index rebuild also have a `:secondary` variant; for other scripts call the wrapper with `--profile secondary`:

```bash
bun run db:query:snapshot -- --sql="SELECT COUNT(*) FROM app.article"
bun run db:query:snapshot:secondary -- --sql="SELECT COUNT(*) FROM app.article"
bun scripts/runWithRuntimeProfile.ts --profile secondary --mode script -- bun scripts/inspectReviewServingProjectState.ts --project-id=<id>
```

Every operator script prints the DB it opens as its first line (on stderr), for example `[dbQuerySnapshot] duckdb path: ~/Library/Application Support/Forska/runtime/primary/forska.duckdb profile: primary`.

Running a script directly (`bun scripts/<name>.ts`) without `FORSKA_RUNTIME_PROFILE` refuses to open DuckDB: the fallback would be the old local default (`.../Forska/forska.duckdb`), not the dev server's DB. Choose the DB explicitly:

```bash
FORSKA_RUNTIME_PROFILE=primary bun scripts/duckdbCheckpoint.ts
FORSKA_RUNTIME_PROFILE=local bun scripts/duckdbCheckpoint.ts
DUCKDB_PATH=/path/to/copy.duckdb bun scripts/duckdbRebuildSecondaryIndexes.ts
```

`FORSKA_RUNTIME_PROFILE=primary` or `secondary` alone opens that profile's DB file; `local` opens the local default. The wrapper refuses a shell `DUCKDB_PATH`, `DUCKDB_PATH_FILE` or `FORSKA_RUNTIME_PROFILE` that disagrees with its `--profile` instead of overriding it, so to work on a copy run the script directly, as in the last line above.

`db:query:snapshot` also compares the DB's applied migrations (`app_schema_migration`) with `src/db/duckdbMigrations`. If the DB is behind, it lists the missing migrations and exits 1; pass `--allow-schema-behind` to query it anyway. Applied migrations this checkout does not have only produce a warning.

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

## Full-text judging

Full-text judging needs, in order: a PDF for the article (fetched or uploaded), a PDF-to-text conversion into canonical judgment text, figure images when the project includes figures as images, and a judge model whose context window fits the project's chunk policy. Every choice is explicit. Nothing falls back to another converter, another figure mode or a default context window: a missing piece is refused with a named error, never worked around.

### Install and start a converter

#### MinerU 4 (local parsing API)

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

In `/providers`, add a **MinerU** provider, click `Test`, then sync models. This creates one model, `mineru-standard`, which carries the server version.

Request forska sends: `POST /v1/file_parse` with `tier=standard`, `ocr_mode=auto`, `page_range=` (all pages), `output_formats=markdown,middle_json,zip` and `response_format=zip`. It reads `markdown.md`, `middle_json.json` and the `images/` crops from the zip. A request that does not finish within the 10-minute conversion timeout is canceled on the server and retried later.

#### Docling Serve

```bash
mkdir -p ~/Developer/forska-tools/docling && cd ~/Developer/forska-tools/docling
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python docling-serve
.venv/bin/docling-serve run --host 127.0.0.1 --port 5001
```

Then add a **Docling Serve** provider in `/providers` and add the model.

Forska sends `POST /v1/convert/source` with a zip target. It does not rely on any server default for these options:

- `to_formats: ['md','json','html']`
- `image_export_mode: 'referenced'`, `include_images: true`, `include_page_images: false`, `images_scale: 2`
- `do_ocr: true`, `force_ocr: false`
- `do_table_structure: true`, `table_mode: 'accurate'`
- `pdf_backend: 'docling_parse'`, `pipeline: 'standard'`
- picture description, picture classification, chart extraction, code and formula enrichment all off
- `do_pdf_heading_hierarchy: false`, `md_compact_tables: false`, `md_page_break_placeholder: ''`

`converterVersion` is the list of `docling*` package versions reported by `GET /version`.

### Settings (`/settings`)

- **PDF conversion model**: exactly one model from a MinerU or Docling provider. If its server is down, conversion fails and retries later; forska never switches converters. The model must report a server version (sync the provider's models), because the version is part of the strategy id.

### Project settings (create and edit pages)

With full text on, a project must choose:

- **Figure mode**, one of two:
  - **Text only (figures reduced to their captions)** (`none`): each figure stays in the text as its `Figure N: <caption>` line; the `[figure:N]` marker is dropped and no image is sent. Works with every model.
  - **Include figures as images** (`native_images`): the `[figure:N]` marker stays and the judge receives one image per marker, in marker order. Only models whose capability record accepts image input on a transport that can send images (OpenAI-compatible chat, OpenAI Responses, Anthropic Messages, Gemini, Codex app-server, Claude Code CLI) can use it. A local vision model through Ollama works, for example `ollama pull qwen3-vl:2b-instruct`, then sync the Ollama provider's models so the model shows image input.

  When the selected model cannot receive images, the create and edit pages show an amber warning next to the figure mode, "Model X cannot receive images. Figures will be reduced to their captions (text only).", and only Text only can be selected. A project saved with Include figures as images whose model is changed to one that cannot receive images is not switched for you: the page shows the error `Model X cannot receive images. Choose Text only (figures reduced to their captions), or another model.` and blocks saving until Text only is picked. The server refuses the same combination on save (400) and on job start or resume (409). The warning reads `modelAcceptsImages` and `modelLabel` from `POST /api/projects/full-text-validation`, the same capability check the server uses. A request body with any other figure mode value (for example the removed `descriptions`) is refused with 422.
- **Chunk policy**: `maxPromptTokens` 24k, 48k or 96k, and `single only` or `chunked`. An article is judged in one call when `tokens(system + user prompt) + 4000 ≤ min(maxPromptTokens, context window)` with the `o200k_base` tokenizer. Otherwise `single only` skips the prompt as `fulltext_too_large`, and `chunked` judges the cached chunk plan part by part (heading-aligned, tables kept whole, abstract and heading path repeated) and merges the parts in one more call. A judge model whose context window is below `maxPromptTokens` cannot be selected.

The old "Full Text (without images)" option (`use_fulltext_no_images`) is frozen: figure mode Text only replaces it. Project create, edit, clone, subproject and comparison create/create-from-project/edit requests answer 400 if they still send `useFulltextNoImages`, even as `false`, so update scripts that post the old field. The column stays as an identity dimension of `app.judgment` (and of projects, jobs, snapshots, deltas and transfer) because other installations may hold legacy rows that differ only in that flag. Such projects and judgments map to strategy `fts-legacy-v0` and show as "full text (legacy, no images)"; a legacy project cannot start new judgment jobs until a figure mode and chunk policy are chosen on its edit page. See `DB_TERMS.md`.

### Full-text strategy id

Every full-text project, job and judgment records `full_text_strategy_id = 'fts-' + sha256(inputs).slice(0, 16)`, where the inputs are: converter kind, converter version, converter options hash, canonical text version (`canonical-v1`), figure mode, image transport version (`img-v1`, Include figures as images only), tokenizer (`o200k_base`), chunk policy and prompt layout version (`layout-v2`). The id is in the judgment UNIQUE key, so judgments made under different strategies never overwrite each other, and compare pages refuse to mix strategies. Labels read like `mineru 4.0.12 / native images / chunked 48k`.

The id changes when the converter server version or options change, when forska bumps one of the version constants (any change to the canonical text builder, image mapping, chunk planning or prompt layout), or when the project's figure mode or chunk policy changes. Projects record the id when they are saved on the edit page with the job stopped. Starting or resuming a job whose recorded id no longer matches the current settings is refused with a 409 that names the differing inputs; save the project's edit page to record the current strategy, then start again. At job start, articles whose stored conversion was made with another converter version, options hash or canonical version are cleared for reconversion (the PDF stays) and the start is refused with a 409 until the conversion cron has converted them. `fts-none` marks title/abstract judgments, `fts-legacy-v0` full-text judgments made before strategy tracking.

### What each conversion stores

- `full_text`: the canonical judgment text (`canonical-v1`, figure markers form), with `full_text_canonical_hash`, `full_text_canonical_version` and `full_text_figure_mode_built`.
- `full_text_html`: Docling's HTML. MinerU produces no HTML, so this stays empty for MinerU.
- `full_text_assets`: the figure list `[{index, page, bbox, caption, imagePath}]`. `bbox` is in page fractions with the origin at the top left.
- `full_text_conversion_metadata`: `converterKind`, `converterVersion`, `optionsHash` (sha256 of the exact request options), `baseURL`, `modelId`, `layoutPath` and `converterMarkdownPath`.

Figure crops, `layout.json` (layout-v2 blocks) and `converter.md` (the converter's raw markdown) are written to `assets/full-text-assets/<articleId>/` under the runtime root, next to `assets/article_pdfs/`. That directory is replaced on every reconversion. `POST /api/articles/:id/canonical-fulltext/rebuild` rebuilds the canonical text from `layout.json` without reconverting. Chunk plans are cached per article and strategy in `app.article_full_text_chunk_plan`; a conversion or rebuild that changes the canonical hash drops the article's plans, and the cleanup run deletes plans whose strategy no project or job uses.

### Background crons and kill switches

The maintenance server runs two full-text crons. They run when their dependencies are configured; the environment flags only switch them off:

| Cron | Runs when | Kill switch |
| --- | --- | --- |
| `full-text-jobs-fetch-articles` (every minute, up to 69 articles: Unpaywall's 100k/day) | a PDF conversion model is set and at least one non-archived project has full text on | `RUN_SERVER_FULL_TEXT_FETCHING=false` |
| `full-text-jobs-convert-pdfs` (every 2 minutes, batch 5, concurrency 2) | same | `RUN_SERVER_FULL_TEXT_CONVERSION_CRON=false` |

Fetch and conversion only pick articles of non-archived full-text projects (import routes and directly added articles, within the project's date range): projects with a running job first, then the others. Articles outside full-text projects are never fetched or converted by the crons. When a gate blocks, each cron logs one rate-limited line per wake, for example `[fullTextConversionJobs] Skipped: no PDF-to-text model is configured (Settings)`. Unpaywall requests carry the email set in Settings.

Optional knobs, passed inline:

```bash
FULL_TEXT_CONVERSION_BATCH_SIZE=5 FULL_TEXT_CONVERSION_CONCURRENCY=2 bun run dev:server
```

Judging does not wait for the crons: a prompt whose article has a PDF but no text converts it on demand with the same converter and canonical builder.

### Images sent to judges

Include figures as images sends the canonical text plus one image per `[figure:N]` marker, in marker order. Every transport (OpenAI-compatible chat, OpenAI Responses, Anthropic, Gemini, Codex app-server, Claude Code) sends the same bytes: transparent PNG crops are flattened onto white first (Codex renders transparency black), JPEG and opaque PNG crops are sent unchanged. An image whose base64 encoding exceeds 5 MiB after flattening is refused (`provider_image_too_large`, the judge closes the prompt as `native_figure_image_too_large`); nothing is downscaled. Codex app-server gets `{type: 'image', url: 'data:…', detail: 'high'}` input items after the text; Claude Code switches to `--input-format stream-json --output-format stream-json --verbose` with one user message holding the text block and base64 image blocks. Both CLI adapters refuse an image prompt when the model's capability record does not accept image input.

### Admin pages

- `/admin/pdf-conversions` (Failed PDF conversions): failed rows with converter kind, options hash, converter version (only when the server answered) and canonical text version, and a Reconvert button (`POST /api/articles/conversion-reconvert {articleId}`). Reconvert clears the conversion status, error, attempts and metadata and any text or canonical columns left from an earlier success, keeps the PDF, and lets the conversion cron pick the article up again; it answers 404 for an unknown article and 409 when the article has no PDF or its conversion has not failed. The cron only takes articles that belong to a non-archived full-text project.
- `/admin/pdf-reset`: clears fetched PDFs so the fetch cron tries again.
- Article admin info (`GET /api/articles/:id/admin-info`) shows an article's PDF, conversion state and assets; `POST /api/articles/:id/convert-pdf` converts one article now.

### Project transfer

Project export carries the canonical text state (`full_text_canonical_hash`, `full_text_canonical_version`, `full_text_figure_mode_built`, as one unit) and the `layout.json` and `converter.md` files named in the conversion metadata, through the same runtime-asset collection as the figure crops; export fails with a named asset error if one of them is missing. Import analysis rebuilds each canonical article from the packaged `layout.json` and blocks the import when the rebuilt hash differs from the exported one; commit rewrites both paths to the target article. An imported article can therefore be rebuilt and judged without reconversion.

### Troubleshooting

| Message | Meaning and fix |
| --- | --- |
| `Full text needs a PDF-to-text model. Set it in Settings → PDF conversion.` | No conversion model is set, or its provider or model is disabled. |
| `PDF-to-text model … has not reported a server version …` | Sync the MinerU or Docling provider's models and select the discovered model in Settings. |
| `Full text needs a figure mode …` / `… a chunk policy …` | Choose them on the project's edit page. |
| `Model … cannot receive images. Choose Text only (figures reduced to their captions), or another model.` | The project includes figures as images but the model or its transport cannot send images. Pick Text only on the edit page, or choose a vision model. |
| Context window missing (409 on job start or resume, link to the provider) | The judge model has no known context window. Set it on the Models page (capability override) or sync a provider that reports it. |
| `Model … accepts N prompt tokens, fewer than the chunk policy's N-token prompt size …` | Choose a smaller chunk policy or another model, or correct the model's context window on the Models page. |
| `Model … has no verified image input …` | Including figures as images needs a model whose capability record accepts images. Set it on the Models page, or choose Text only or another model. |
| `Full-text settings changed since the project was saved: it records … current settings resolve to …; differing inputs: …` | A converter version, forska version constant or setting changed. Save the project's edit page with the job stopped to record the new strategy, then start. |
| `N articles are being reconverted for strategy …; start again when conversion has finished.` | The conversion cron reconverts them (check that it is not switched off and the converter server runs), then start again. |
| `This project uses full text without a full-text strategy (fts-legacy-v0) …` | A legacy full-text project. Choose a figure mode and a chunk policy on the edit page. |
| Prompt skipped `fulltext_too_large` | Chunk policy `single only` and the article does not fit `maxPromptTokens`. Use `chunked` or a larger policy (a new strategy). |
| `provider_image_too_large` / `native_figure_image_too_large` | A figure crop is above the 5 MB base64 image limit after flattening. |

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
