# Judgments: split prompt queue vs LLM requests (no mig)

- Goal: keep prompt queue state separate from real LLM request counts/caps.

## Plan

- [ ] Keep existing queue table and statuses; no mig
- [ ] Keep queue `status='sent'` as prompt claimed / in progress; not real request count
- [ ] Queue UI: rename `Sent` -> `Prompts in progress`
- [ ] Request UI: use `In flight` for live calls; `Attempts` for cumulative real sends
- [ ] `attemptedRequests` = actual LLM call attempts sent
- [ ] `inFlightRequests` = actual LLM calls running now
- [ ] Chunked prompt count = `evidence chunks + 1 final synthesis`
- [ ] Retries count as new attempts; pre-send skips count as 0

## Concurrency

- [ ] Apply cap at actual model-call wrapper, not queue-claim time
- [ ] One shared limiter for normal prompts + chunk evidence + final synthesis + retries
- [ ] Acquire right before send; release in `finally`; retries re-acquire
- [ ] Decide / enforce single judging server, or add shared cross-server limiter; per-process memory alone is unsafe if >1 server sends
- [ ] Do not parallelize chunks before limiter exists

## Chunking

- [ ] Today chunk evidence calls are sequential
- [ ] Change evidence chunk calls to bounded parallel under same limiter
- [ ] Final synthesis stays after all evidence chunks finish
- [ ] Add per-prompt chunk cap so one long article cannot take all slots

## Stats / tests

- [ ] Update token-use `requests` to mean real LLM attempts; recheck places assuming `requests == 1`
- [ ] Tests: no chunk => attempts 1
- [ ] Tests: 3 chunks => attempts 4; evidence parallel but bounded; final after evidence
- [ ] Tests: retry increments attempts and still respects cap
- [ ] Tests: skip before first send => attempts 0
