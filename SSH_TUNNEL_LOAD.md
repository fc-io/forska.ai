# SSH Tunnel Load / Flapping

## Conclusions

- Tunnel “goes down” because `scripts/mn5Launch.ts` kills + recreates it after local health-check failures; `exit (code=0): Normal exit` matches this managed restart (not an SSH crash).
- Health check is strict: `curl --connect-timeout 2 --max-time 3 http://localhost:<port>/v1/models`; under load/jitter this can timeout, triggering restart loops.
- `SGLANG_MAX_RUNNING_REQUESTS=20` in `forska-mn5-sglang.sbatch` is only a default. `scripts/mn5Launch.ts` submits with `sbatch --export=ALL,...`, so any locally-exported `SGLANG_*` overrides the sbatch defaults.
- The sender side uses Forska capacity (`getJudgmentsCapacity()` from env `SGLANG_MAX_RUNNING_REQUESTS`, `SGLANG_API_MAX_INFLIGHT_REQUESTS`, `SGLANG_API_MAX_BURST_REQUESTS`). If these are high (e.g. 256), Forska will enqueue/burst far more than “20”, producing big `Waiting`/`In-flight`.
- Seeing `Running > 20` strongly implies the actual SGLang `--max-running-requests` is >20 (likely via env override at submit time).

## Quick Checks

- Before launch: `env | rg '^SGLANG_'`
- In the MN5 job log: verify the `[mn5:config:start]` block shows the intended `SGLANG_*` values.

## Fixes

- Force caps at submit time: `SGLANG_MAX_RUNNING_REQUESTS=20 SGLANG_API_MAX_INFLIGHT_REQUESTS=20 SGLANG_API_MAX_BURST_REQUESTS=20 bun run mn5:launch`
- Or strip local overrides: `env -u SGLANG_MAX_RUNNING_REQUESTS -u SGLANG_API_MAX_INFLIGHT_REQUESTS -u SGLANG_API_MAX_BURST_REQUESTS bun run mn5:launch`
- Reduce restart churn: increase `--max-time` (and/or require N consecutive failures) in `scripts/mn5Launch.ts` health check (`isLocalSGLangResponding`).
