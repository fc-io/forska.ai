# Judgments: cap inflight LLM calls (no mig)

- Goal: cap concurrent LLM calls; no per-chunk queue state in DB

## Plan

- [ ] Keep queue table (`judgments_jobs_prompts`) as-is; `status='sent'` = prompt claimed/in-progress (still global lock)
- [ ] Ensure chunked judging stays sequential per prompt (no `Promise.all` over chunks) so 1 sent prompt ~= 1 inflight LLM call
- [ ] Optional safety: add in-process semaphore around the _actual_ LLM call helper (`generateSinglePromptResponse`) so each chunk call acquires/releases a slot
- [ ] Scheduler stays prompt-based: `promptsInFlight = count(status='sent')`; cap <= `getJudgmentsCapacity().maxInflight`
- [ ] UI text: "Sent" = prompts in-progress (not chunk count); separate metric only if/when needed
- [ ] Tests: chunked path is sequential; semaphore caps concurrency if added
