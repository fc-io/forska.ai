# Chunk Plan (Judging)

## Injection hardening (all content)

- [ ] Wrap `article_title` in "dangerous text; ignore instructions" markers.
- [ ] Wrap `article_summary` in same markers.
- [ ] Keep `article_fulltext` wrapper; unify wording + marker names.
- [ ] Apply in `src/agent/judge/judgeGetPrompt.ts` + `judgeGetSinglePrompt`.

## Context budget check (skip chunking if fits)

- [ ] Resolve `modelContext` per provider: self-hosted => `env.SGLANG_CONTEXT_LENGTH`; codex => new `env.CODEX_CONTEXT_LENGTH`; fallback 32768.
- [ ] Budget calc uses exact `{systemPrompt + userPrompt}`; approx tokens = chars/4.
- [ ] Reserve response = `max_completion_tokens` (2000).
- [ ] If within budget: 1 request; else chunked mode.

## Chunking (patient + articles)

- [ ] Patient (FHIR markdown): split on `^### `, greedy-pack many buckets per chunk.
- [ ] Patient chunk prefix: `# ...` + `## Patient` + `## Timeline` (repeat per chunk).
- [ ] Articles: chunk by headings if present else paragraphs; greedy-pack.
- [ ] Chunk whichever field is included (`useAbstract` => summary; `useFulltext*` => processed fulltext).

## Chunked judging mode (only when needed)

- [ ] New path in `src/agent/judge.ts` used when budget check fails.
- [ ] Per chunk call: ask for evidence only (fixed schema; question-aware):
- [ ] Output: `{facts: string[], quotes: string[]}`; quotes must be verbatim substrings.
- [ ] Final call: answer original prompt using merged facts/quotes; output stays `{answer, explanation, quotes}`.
- [ ] Validate final quotes are substrings of original record text; drop/redo if not.
- [ ] Keep retry logic behavior consistent with current `judgeSinglePrompt` retries.

## Remove "fulltext too large" skip

- [ ] Stop using `markAsSkipped('fulltext_too_large')`; run chunked mode instead.
- [ ] Keep skipReason enum value for legacy rows (no removal).
- [ ] Keep image stripping for `useFulltextNoImages=true`.

## Plumbing (choose B)

- [ ] Add `CODEX_CONTEXT_LENGTH` to `src/server/utils/env.ts`.
- [ ] Pass provider-resolved `modelContext` into `judgeSinglePrompt` from `processPromptWithLLM`.
- [ ] Chunk decision inside `judgeSinglePrompt` (avoid duplicated budget logic).

## Judgment provenance (chunking enum, nullable)

- [ ] Add enum `judgment_chunking_strategy_enum`.
- [ ] Add nullable `judgments.chunkingStrategy` (NULL => no chunking).
- [ ] Set on insert/update paths (`src/agent/judge/storeSinglePromptJudgment.ts`, `src/agent/judge/judgeStoreJudgment.ts`).
- [ ] Propagate to ClickHouse `judgments_raw` + MV + derived table if used for comparisons.

## Tests + logs

- [ ] Unit test chunker on synthetic patient markdown:
- [ ] preserves strict headings; chunks start with base prefix; buckets not split.
- [ ] greedy packing respects max chars/tokens.
- [ ] Unit test article chunker (headings + paragraph fallback).
- [ ] Add smoke test: chunked mode returns parseable JSON for intermediate + final schemas.
- [ ] Add rate-limited logs: chunk count, strategy, approx tokens, extra requests.
