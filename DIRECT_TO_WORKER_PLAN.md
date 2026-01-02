# Direct-to-Worker Plan

**Goal**: Bypass SGLang router, connect directly to workers via separate SSH tunnels to avoid bandwidth throttling.

## Architecture

```
Current:  App → localhost:30000 → 1 tunnel → Router → Workers
Proposed: App → localhost:30001/30002 → 2 tunnels → Workers directly
```

## Checklist

### 1. sbatch: Disable Router
- [x] `forska-mn5-sglang.sbatch`: Set `SGLANG_ENABLE_ROUTER=0` default for multi-node
- [x] Each node starts independent sglang worker on port 30001
- [x] `WORKER_URLS` and `WORKER_URLS_LOCAL` output in config block

### 2. mn5DevServer.ts: Skip Router Tunnel
- [x] Don't create tunnel for port 30000 when router disabled
- [x] Only create tunnels for workers (30001, 30002)
- [x] Remove `VITE_LLM_SERVER_URL` (legacy, unused)
- [x] Pass `SGLANG_ENABLE_ROUTER` to app env

### 3. App: Use Worker URLs from Env
- [x] Modified `getAndUpdateReadyPrompts.ts`
- [x] Override with `WORKER_URLS` env var if set
- [x] Random worker selection per request

### 4. Request Distribution
- [x] `SGLANG_MAX_RUNNING_REQUESTS` is per-worker; `getMaxNumberOfInflightRequests()` already multiplies by worker count
- [x] Random worker selection per request
- [x] Circuit breaker per worker URL (already works - separate URLs)

### 5. Test
- [ ] Run 2-node job on MN5 (resubmit with new config)
- [ ] Verify both tunnels stay alive under load
- [ ] Compare throughput stats: 1 tunnel vs 2 tunnels

## Key Files
- `forska-mn5-sglang.sbatch` - router config
- `scripts/mn5DevServer.ts` - tunnel setup
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts` - worker URL resolution
- `src/agent/judge.ts` - OpenAI client instantiation

## Rollback
Set `SGLANG_ENABLE_ROUTER=1` when launching sbatch to restore router behavior.
