# Step-by-Step Checklist: vLLM → SGLang Model Gateway

Use this checklist to migrate from vLLM to SGLang in small, verifiable steps. Tick each box as you complete it. Ask questions if appropriate.

## Phase 0 — Decisions & Prereqs
- [ ] Choose SGLang version and topology. Target: Model Gateway with multiple Workers (multi-worker by default).
- [ ] Decide worker sizing: workers per GPU (recommend 1 worker = 1 GPU) and concurrency per worker.
- [ ] Confirm metrics availability and endpoints (Prometheus or JSON). Note any missing metrics and agree on fallbacks.
- [ ] Prepare environment variables: `LLM_PROVIDER`, `LLM_BASE_URL`, `SGLANG_API_KEY` (if required), model identifiers, and cache paths.
- [ ] Ensure SGLang Model Gateway responds to `GET /v1/models` (health probe) on your target URL.
- [ ] Schedule a canary window for a single project before full cutover.

## Versions (pinned)
- [ ] SGLang Model Gateway: v0.5.4 (GitHub release tag)
- [ ] sglang (Python package): 0.5.4.post1 (PyPI)
- [ ] Use official SGLang Gateway/Worker container images matching v0.5.4, or build from source pinned to that tag.

## Phase 1 — Bring Up SGLang (Docker) & Smoke Test
- [ ] Add an `sglang-gateway` service to `docker-compose.yml` with shared model/HF caches and port `8000` exposed (Gateway is typically CPU-only).
- [ ] Add an `sglang-worker` service definition that connects to the Gateway and mounts the same model/HF caches. Configure workers to use GPUs.
- [ ] Set `LLM_BASE_URL=http://sglang:8000/v1` (or appropriate host) in `.env.local`.
- [ ] If the Gateway needs auth, set `SGLANG_API_KEY` and wire it into the compose healthcheck (probe `/v1/models`).
- [ ] Start locally: `docker compose up -d sglang-gateway`.
- [ ] Scale workers: `docker compose up -d --scale sglang-worker=<NUM_GPUS>`.
- [ ] Verify health: `curl -sf ${LLM_BASE_URL%/}/models` (or `/v1/models`) returns models; check `docker compose logs -f sglang-gateway` for readiness.
- [ ] Verify workers registered with the Gateway: observe Gateway/Worker logs reporting <NUM_GPUS> workers connected.
- [ ] Verify GPU assignment per worker (one GPU per worker) and that workers see the correct CUDA device.
- [ ] Load test lightly: send concurrent requests to confirm Gateway balances across workers without errors.
- [ ] Keep vLLM services available for rollback while SGLang stabilizes.
- [ ] Remove vLLM from Docker immediately after SGLang is healthy: delete `vllm` and `vllm-hostnet` services from `docker-compose.yml`, drop `VLLM_*` env vars, and update dependent services to use `LLM_BASE_URL`/`SGLANG_API_KEY`. Re-run `docker compose up -d` to ensure only SGLang remains.

## Phase 2 — Minimal Functional Swap (OpenAI-compatible)
- [ ] Add `LLM_PROVIDER=sglang` and `LLM_BASE_URL` to `.env.local` (keep vLLM values available for rollback).
- [ ] In `src/agent/judge.ts`, point the OpenAI client `baseURL` to `LLM_BASE_URL` and remove or neutralize `normalizeVllmModelName()` if not needed by SGLang.
- [ ] Smoke test: run SGLang locally/remote and `curl -H "Authorization: Bearer $SGLANG_API_KEY" $LLM_BASE_URL/models` (or `/v1/models`).
- [ ] Start servers: `bun install`, `bun run dev:server`, `bun run dev:app`.
- [ ] Trigger a one-off judgment to verify responses and token usage are recorded.

## Phase 3 — Metrics Ingestion & Batch Control
- [ ] Create `src/server/cron/judgmentsJobs/judgmentsJobsAdjustBatchSize/getLlmMetrics.ts` mapping SGLang metrics (tokens, requests, queue sizes). Document name mapping inside the file.
- [ ] Create `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts` (copy/port of vLLM version) computing prefill/gen TPS, RPS, and safety flags using available metrics.
- [ ] Wire into cron in `src/server/cron/judgmentsJobs.ts` (replace `judgmentsJobsCheckVLLMStatus` with `judgmentsJobsCheckLLMStatus`).
- [ ] Update `src/server/cron/judgmentsJobs/judgmentsJobsAdjustBatchSize.ts` to read provider-agnostic fields; guard safety logic when metrics are missing.

## Phase 4 — Database Schema (Drizzle)
- [ ] Prefer additive changes: create a new `llm_status` table (do not rename or alter existing `vllm_status`).
- [ ] Add an `engine` column to `llm_status` (values like `'sglang' | 'vllm'`) to allow multi-engine reporting if needed.
- [ ] Update `src/db/schema.ts` to define the new `llm_status` table and indices; leave `vllm_status` untouched for historical data.
- [ ] Generate and apply migrations: `bun run db:gen` → `bun run db:mig`.
- [ ] Update ingestion code (`judgmentsJobsCheckLLMStatus.ts`) and readers to use `llm_status` going forward.
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
- [ ] Add SGLang Model Gateway startup on head node.
- [ ] Add SGLang Worker startup per GPU on all nodes:
  - [ ] Pass Gateway address/port to workers.
  - [ ] Launch one worker per GPU (or configured ratio) via `srun` across nodes.
  - [ ] Ensure each worker binds to a distinct GPU (e.g., via CUDA device mapping) and shares HF caches.
- [ ] Keep HF/XDG caches and model paths; drop vLLM-specific flags (distributed backend/tool/reasoning parsers).
- [ ] Update healthcheck loops and log messages to Gateway endpoints and ports.
- [ ] Submit job; verify logs and readiness within the expected window.
- [ ] Remove old vLLM batch scripts (e.g., `remote-hf-vllm.sbatch`) from the repo once SGLang jobs are stable.

## Phase 7 — Canary, Cutover, Cleanup
- [ ] Canary: point one model/project to SGLang; monitor throughput, error rate, queue sizes, and admin status trends.
- [ ] Cutover: switch remaining models to SGLang by updating `LLM_BASE_URL`/provider settings.
 - [ ] Cleanup: remove vLLM-only files (`getVllmMetrics.ts`, `VllmStatusRoutes.ts`, `judgmentsJobsCheckVLLMStatus.ts`), vLLM-specific docs, and compose/HPC stanzas. Ensure no references to `vllm` remain in code or configuration.
- [ ] Update `docs/README_RUN_REMOTE.md` and any other vLLM references to SGLang.

## Gaps (No 1:1 Replacements) — Verify or Degrade Gracefully
- [ ] GPU cache usage / swapped / preemptions may be missing in SGLang: gate safety logic or set conservative defaults.
- [ ] Usage tokens in responses: if missing, choose to (a) accept partial metrics, or (b) compute tokens server-side.
- [ ] Tool-call / JSON / reasoning features: confirm SGLang support and flags; disable or adapt if not present.

## Validation
- [ ] Lint/tests: `bun run lint`, `bun test`.
- [ ] Functional: run judgment jobs end-to-end; verify token accounting and admin status table.
- [ ] Observability: watch batch-size adjustments over time; ensure no starvation or runaway behavior.

## Rollback Plan
- [ ] We do not keep vLLM running after migration. To roll back, revert the specific commits that removed vLLM services/routes and reintroduce `vllm` compose/HPC stanzas from Git history, then restore `VLLM_*` env and base URL.

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
- `curl -sf ${LLM_BASE_URL%/}/models` (or `/v1/models`)
- `docker compose rm -f -s vllm vllm-hostnet` (after removal from compose)
