# Llama Plan

## Goal

- Let `llamacpp` connections marked `cli` run judgments through local `llama-cli`.
- Keep `llama.cpp Server` on the current HTTP path.
- Avoid regressions for existing provider, model sync, and judgment flows.

## Gap Now

- `llamacpp` always goes through the OpenAI-compatible HTTP adapter.
- Judgment execution assumes HTTP runtime credentials.
- The new UI mode flag is stored, but runtime does not use it yet.

## Implementation Order

1. Keep one provider kind, split by config.
   - Use `connection.config.llamaCppMode` inside the llama.cpp adapter.
   - Default missing mode to `server` for old rows.
2. Add a `llama-cli` transport.
   - Spawn local `llama-cli`.
   - Build prompt/system/output-schema args.
   - Parse stdout/stderr, exit code, usage if present.
3. Separate server vs cli capabilities.
   - `server`: keep current health, `/models`, sync, test.
   - `cli`: manual-model only first; no HTTP discovery requirement.
4. Wire judgment invocation.
   - Branch in `src/server/providers/adapters/llamacppAdapter.ts`.
   - Keep `src/server/providers/providerInvocationService.ts` contract stable.
   - Ensure job/judgment code can invoke stored llama CLI models without `baseURL`.
5. Add regression coverage before/with implementation.
   - Unit: config parsing, mode branching, CLI arg builder, CLI output parser.
   - Service: adapter invoke/health behavior for `cli` and `server`.
   - Integration: provider invocation with mocked CLI runner.
   - Regression: existing llama server flow, provider route tests, judgment/provider tests for non-llama providers.

## Done When

- CLI-mode llama judgments run without an HTTP server.
- Server-mode llama behavior stays unchanged.
- New tests cover both modes and existing provider paths stay green.
