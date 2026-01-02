# Direct-to-Worker Plan

**Goal**: Bypass SGLang router, connect directly to workers via separate SSH tunnels to avoid bandwidth throttling.

## Architecture

```
Current:  App → localhost:30000 → 1 tunnel → Router → Workers
Proposed: App → localhost:30001/30002 → 2 tunnels → Workers directly
```

## Checklist

### 1. sbatch: Disable Router
- [ ] `forska-mn5-sglang.sbatch`: Set `SGLANG_ENABLE_ROUTER=0`
- [ ] Verify each node starts independent sglang worker on port 30001
- [ ] Keep `WORKER_URLS` and `WORKER_URLS_LOCAL` output in config block

### 2. mn5DevServer.ts: Skip Router Tunnel
- [ ] Don't create tunnel for port 30000 (router)
- [ ] Only create tunnels for workers (30001, 30002)
- [ ] Update `VITE_LLM_SERVER_URL` to first worker (or remove if using WORKER_URLS)

### 3. App: Use Worker URLs from Env
- [ ] Find where `modelBaseUrl` is resolved in `getAndUpdateReadyPrompts.ts`
- [ ] Override with `WORKER_URLS` env var if set
- [ ] Implement random worker selection (round-robin or random)

### 4. Request Distribution
- [ ] Split `SGLANG_MAX_RUNNING_REQUESTS` across workers (256 each if 512 total)
- [ ] Random worker selection per request
- [ ] Circuit breaker per worker URL (already works - separate URLs)

### 5. Test
- [ ] Run 2-node job on MN5
- [ ] Verify both tunnels stay alive under load
- [ ] Compare throughput stats: 1 tunnel vs 2 tunnels

## Key Files
- `forska-mn5-sglang.sbatch` - router config
- `scripts/mn5DevServer.ts` - tunnel setup
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts` - worker URL resolution
- `src/agent/judge.ts` - OpenAI client instantiation

## Rollback
Set `SGLANG_ENABLE_ROUTER=1` in sbatch to restore original behavior.
