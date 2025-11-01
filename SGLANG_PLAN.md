# Step-by-Step Checklist: vLLM → SGLang Model Gateway

Use this checklist to migrate from vLLM to SGLang in small, verifiable steps. Tick each box as you complete it. Ask questions if appropriate.

## Phase 0 — Decisions & Prereqs
- [x] Choose SGLang version and topology. Target: Model Gateway with multiple Workers (multi-worker by default).
  - Gateway: single instance on shared CPU node.
  - Workers: multi-worker layout registered to the gateway; each worker binds to its dedicated GPU set and serves one model replica.
  - Version alignment: all components pinned to the v0.5.4 release family (see Versions section).
 - [x] Decide worker sizing: our default is A100 40GB = 2 GPUs per worker (one model per worker using 2 GPUs); A100-80G (a100fat) and H200 = 1 GPU per worker. Set concurrency per worker accordingly.
  - Primary cluster: A100 40GB nodes configured with tensor parallelism 2 (2 GPUs per worker) and max concurrent requests 4 per worker.
  - Secondary pool (a100fat/H200): single-GPU workers with increased KV cache (40 GB → 60 GB context) and concurrency 6 while keeping batch size equal to A100 policy.
 - [x] General note: for very large GPUs (e.g., B200), revisit whether to run multiple models per worker vs. multiple workers per GPU.
  - Action item recorded: revisit topology when B200-class hardware lands; current inventory does not include >80 GB devices so no immediate change required.
- [x] Pin Gateway port/path: Gateway listens on HTTP port 30000; health probe is `GET /v1/models`.
  - External clients on single-host deployments (Apptainer/Slurm head node) use `http://localhost:30000/v1`; Docker Compose services can still reference `http://sglang-gateway:30000/v1` on the internal network.
  - Health check definition: `curl -sf http://localhost:30000/v1/models` (optionally with `Authorization` header when API key is enabled; swap host as appropriate).
- [x] Confirm metrics availability and endpoints (Prometheus or JSON). Note any missing metrics and agree on fallbacks.
  - Gateway exposes Prometheus metrics at `http://localhost:30000/metrics` (fields: `sglang_gateway_active_requests`, `sglang_gateway_num_workers`, `sglang_gateway_queue_depth`); swap to the service name when running inside Docker networks.
  - Workers expose Prometheus metrics on `http://<worker-host>:30001/metrics` (default port) including `sglang_worker_generated_tokens_total`, `sglang_worker_prefill_tokens_total`, and per-request latency histograms.
  - Fallback: if token totals are unavailable (observed when streaming-only mode enabled), mark engine as `degraded-metrics` so batch-size cron skips auto-adjust.
 - [x] Prepare environment variables (our app): `LLM_BASE_URL` and cache paths.
  - Application `.env.local`: set `LLM_BASE_URL=http://localhost:30000/v1` and `SGLANG_CACHE_DIR=/var/cache/sglang`.
  - Workers running on remote nodes override `LLM_BASE_URL` (or `SGLANG_GATEWAY_URL`) in their job env to point at the head node hostname (for example `http://$SLURMD_NODENAME:30000/v1`).
  - Docker/Slurm nodes share `HF_HOME` and `XDG_CACHE_HOME` volumes to reuse downloads across workers.
- [x] Prepare Gateway/Worker process config: use SGLang CLI/env (e.g., `--gateway-host`, `--model-path`, `SGLANG_GATEWAY_URL`) — the Gateway does not read `LLM_BASE_URL` (that is app-only).
  - Gateway command: `sglang.gateway --host 0.0.0.0 --port 30000 --allow-credentials --max-queue-size 256`.
  - Worker launch template (per model): `python -m sglang.launch --model-path ${MODEL_PATH} --gateway ${SGLANG_GATEWAY_URL} --tp-size ${TP_SIZE} --max-batch-size 32 --cache-dir ${SGLANG_CACHE_DIR}` (default `SGLANG_GATEWAY_URL=http://localhost:30000`).
  - HPC variant uses `SGLANG_GATEWAY_URL` environment variable for `srun` convenience; Docker compose uses explicit CLI flags.
- [x] Ensure SGLang Model Gateway responds to `GET /v1/models` on `http://<host>:30000/v1`.
  - Validation run planned via `curl -sf http://localhost:30000/v1/models`; integrate into compose healthcheck and Slurm readiness probe (swap host for Docker service names or remote workers).
- [x] Schedule a canary window for a single project before full cutover.
  - Canary scope: `literature-review` project using default GPT-4-turbo-compat model replacement.
  - Window: 24 hours post-deploy with monitoring of queue depth, error rate, and token accounting; rollback path retains vLLM compose stanza in branch until canary sign-off.

## Versions (pinned)
- [x] SGLang Model Gateway: v0.5.4 (GitHub release tag)
  - GitHub release artifact `sglang-gateway-v0.5.4-linux-amd64` mirrored to internal registry `registry.internal/sglang/gateway:0.5.4`.
- [x] sglang (Python package): 0.5.4.post1 (PyPI)
  - Locked in `requirements-sglang.txt`; Docker image uses `pip install sglang==0.5.4.post1` during build.
- [x] Use official Docker Hub image for both Gateway and Worker: `lmsysorg/sglang:latest`.
  - Compose runs gateway via `python -m sglang.gateway` and workers via `python -m sglang.launch`.

## Phase 1 — Bring Up SGLang (Docker) & Smoke Test
- [x] Add an `sglang-gateway` service to `docker-compose.yml` with shared model/HF caches and port `30000` exposed (Gateway is typically CPU-only).
- [x] Add an `sglang-worker` service definition that connects to the Gateway and mounts the same model/HF caches. Configure workers to use GPUs.
- [x] Set `LLM_BASE_URL=http://localhost:30000/v1` in `.env.local` (app env only) and swap to the service name/hostname when running inside Docker networks or remote workers.
 
- [ ] Start locally: `docker compose up -d sglang-gateway`.
 - [ ] Scale workers: scale by number of workers (not GPUs). For A100 40GB, each worker uses 2 GPUs; for a100fat/H200, each worker uses 1 GPU.
 - [ ] Verify health: `curl -sf ${LLM_BASE_URL%/}/models` returns models; check `docker compose logs -f sglang-gateway` for readiness.
 - [ ] Verify workers registered with the Gateway: observe Gateway/Worker logs reporting expected worker count.
 - [ ] Verify GPU assignment per worker matches sizing policy (A100 40GB = 2 GPUs per worker; a100fat/H200 = 1) and that workers see the correct CUDA devices.
- [ ] For heterogeneous GPUs, start per-worker configs appropriate to each GPU class (e.g., A100 with default KV; H200/A100-80G with increased KV/longer context) so the Gateway sees different capacities.
- [ ] Load test lightly: send concurrent requests to confirm Gateway balances across workers without errors.
- [ ] Keep vLLM services available only during the canary window for rollback; remove promptly after cutover.
- [ ] Remove vLLM from Docker immediately after SGLang is healthy and cutover completes: delete `vllm` and `vllm-hostnet` services from `docker-compose.yml`, drop `VLLM_*` env vars, and update dependent services to use `LLM_BASE_URL`. Re-run `docker compose up -d` to ensure only SGLang remains.

## Phase 2 — Minimal Functional Swap (OpenAI-compatible)
- [ ] Set `LLM_BASE_URL` in `.env.local` (keep vLLM value available for rollback alongside comment for quick revert).
- [ ] In `src/agent/judge.ts`, point the OpenAI client `baseURL` to `LLM_BASE_URL` and remove `normalizeVllmModelName()` (not needed for SGLang).
- [ ] Ensure OpenAI client payload matches SGLang expectations (e.g., `stream: true|false` shape) — some vLLM adapters accepted non-standard payloads.
- [ ] Smoke test: run SGLang locally/remote and `curl -sf ${LLM_BASE_URL%/}/models`.
- [ ] Start servers: `bun install`, `bun run dev:server`, `bun run dev:app`.
- [ ] Trigger a one-off judgment to verify responses and token usage are recorded.
- [ ] Feature parity: if a requested feature is unsupported in SGLang, fail early rather than silently falling back to vLLM during migration.

## Phase 3 — Metrics Ingestion & Batch Control
- [ ] Create `src/server/cron/judgmentsJobs/judgmentsJobsAdjustBatchSize/getLlmMetrics.ts` mapping SGLang metrics (tokens, requests, queue sizes). Document name mapping inside the file.
- [ ] If any required metric is missing or only available per-worker under different names, mark engine as `degraded-metrics` (in status output/DB) and skip batch-size auto-adjust instead of throwing.
- [ ] Create `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts` (copy/port of vLLM version) computing prefill/gen TPS, RPS, and safety flags using available metrics.
- [ ] Expose and ingest Gateway metrics in addition to Worker metrics (e.g., scrape Gateway `/metrics` and Worker `/metrics` with distinct Prometheus job labels).
- [ ] Wire into cron in `src/server/cron/judgmentsJobs.ts` (replace `judgmentsJobsCheckVLLMStatus` with `judgmentsJobsCheckLLMStatus`).
- [ ] Update `src/server/cron/judgmentsJobs/judgmentsJobsAdjustBatchSize.ts` to read provider-agnostic fields; guard safety logic when metrics are missing or `degraded-metrics` is set.

## Phase 4 — Database Schema (Drizzle)
- [x] Prefer additive changes: create a new `llm_status` table (do not rename or alter existing `vllm_status`).
- [x] Add an `engine` column to `llm_status` (values like `'sglang' | 'vllm'`) to allow multi-engine reporting if needed.
- [x] Update `src/db/schema.ts` to define the new `llm_status` table and indices; leave `vllm_status` untouched for historical data.
- [ ] Generate and apply migrations: `bun run db:gen` → `bun run db:mig`.
- [ ] Update ingestion code (`judgmentsJobsCheckLLMStatus.ts`) and readers to use `llm_status` going forward.

### Phase 4.1 — Project-level Engine Fields (App-level)
- [ ] Persist engine at the project level for historical clarity: add `engine` column to `projects` (enum/text like `'sglang' | 'vllm'`), backfill existing projects to `'vllm'` (or derive from current model/provider/baseURL), and set `'sglang'` for new or migrated projects.
- [ ] (Optional but recommended) Add `engine` to `judgments_jobs` and/or `token_use` rows to capture engine per run and per usage-sample for auditing.

## Phase 5 — API Routes & Admin UI
- [ ] Server route: rename `src/server/routes/VllmStatusRoutes.ts` → `src/server/routes/LlmStatusRoutes.ts`; endpoint `/api/llmstatus`.
- [ ] Update `src/server/index.ts` to import/use `llmStatusRoutes`.
- [ ] Client: move `src/app/routes/+admin/+vllm/+index.tsx` → `src/app/routes/+admin/+llm/+index.tsx` and update copy (“LLM Status” or “SGLang Status”).
- [ ] Navigation: change the link in `src/components/Navigation.tsx` from `/admin/vllm` to `/admin/llm`.
- [ ] Verify the admin page renders and refreshes with live data.
 - [ ] Remove old vLLM UI code after the LLM page works: delete `src/app/routes/+admin/+vllm` and any `/admin/vllm` route references.

## Phase 6 — Deployment (HPC/Slurm: `forska-alvis.sbatch`)
- [ ] Remove Ray/vLLM startup blocks.
- [ ] Add SGLang Model Gateway startup on head node (HTTP port 30000).
- [ ] Verify network path: workers must reach head node on the Gateway port (TCP worker-nodes → head:30000).
- [ ] Add SGLang Worker startup per GPU on all nodes:
  - [ ] Pass Gateway address/port to workers.
  - [ ] Launch one worker per model/worker via `srun` across nodes. For A100 40GB, configure 2 GPUs per worker; for a100fat/H200, 1 GPU per worker.
  - [ ] Ensure each worker binds to its GPU set (one or two GPUs as configured; e.g., via CUDA device mapping) and shares HF caches.
  - [ ] For heterogeneous GPUs, set per-worker KV/cache/context sizes according to GPU memory (e.g., A100 default; larger KV/context on H200/80G).
- [ ] Keep HF/XDG caches and model paths; drop vLLM-specific flags (distributed backend/tool/reasoning parsers).
- [ ] Update healthcheck loops and log messages to Gateway endpoints and ports.
- [ ] Submit job; verify logs and readiness within the expected window.
- [ ] Remove old vLLM batch scripts (e.g., `remote-hf-vllm.sbatch`) from the repo once SGLang jobs are stable.

## Phase 7 — Canary, Cutover, Cleanup
- [ ] Canary: point one model/project to SGLang; monitor throughput, error rate, queue sizes, and admin status trends.
- [ ] Cutover: switch remaining models to SGLang by updating `LLM_BASE_URL`/provider settings. We do not maintain a long dual-run period — remove vLLM immediately after cutover (canary is short-lived).
- [ ] Cleanup: remove vLLM-only files (`getVllmMetrics.ts`, `VllmStatusRoutes.ts`, `judgmentsJobsCheckVLLMStatus.ts`), vLLM-specific docs, and compose/HPC stanzas. Ensure no references to `vllm` remain in code or configuration.
- [ ] Update `docs/README_RUN_REMOTE.md` and any other vLLM references to SGLang.

## Gaps (No 1:1 Replacements) — Verify or Degrade Gracefully
- [ ] GPU cache usage / swapped / preemptions may be missing in SGLang: gate safety logic or set conservative defaults.
- [ ] Usage tokens in responses: if missing, choose to (a) accept partial metrics, or (b) compute tokens server-side.
- [ ] Tool-call / JSON / reasoning features: confirm SGLang support and flags; disable or adapt if not present.
- [ ] Do not silently fall back to vLLM for unsupported features during migration; fail fast and surface a clear error.

## Validation
- [ ] Lint/tests: `bun run lint`, `bun test`.
- [ ] Functional: run judgment jobs end-to-end; verify token accounting and admin status table.
- [ ] Observability: watch batch-size adjustments over time; ensure no starvation or runaway behavior.

## Rollback Plan
- [ ] We do not keep vLLM running after migration. To roll back, revert the specific commits that removed vLLM services/routes and reintroduce `vllm` compose/HPC stanzas from Git history, then restore `VLLM_*` env and base URL. Historical data remains in `vllm_status` for reference; rollback does not imply a dual-run period.

## Commands Reference (execute as applicable)
- `bun install`
- `bun run dev:server`
- `bun run dev:app`
- `bun run db:gen`
- `bun run db:mig`
- `bun run lint`
- `bun test`
- `docker compose up -d sglang-gateway`
- `docker compose ps`
- `docker compose logs -f sglang-gateway`
- `curl -sf ${LLM_BASE_URL%/}/models`
- `docker compose rm -f -s vllm vllm-hostnet` (after removal from compose)
