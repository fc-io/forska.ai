# Judgment-Job End-to-End Test Plan

Date: 2026-08-28

## Implementation Status

Rechecked on 2026-08-30. The named focused, component, recovery, topology,
browser, and opt-in real-Codex commands exist, but the plan is not ready for
final PR completion.

Current macOS execution is green for focused (225 tests), component (124
tests), recovery, fresh/migration-boundary/restart topology, the browser
lifecycle with exact displayed queue counts, the desktop build, repository-wide
lint, and the full Bun suite (3,287 passed, 3 skipped, 0 failed). The recheck also corrected
full-key component assertions, prompt abort and final-admission fencing,
real-Codex maximum-attempt accounting, topology startup teardown, drained
health projection publication, and the bounded judgment visibility
token-domain bridge. The topology recheck also replaced POSIX process suspension
with an opt-in cooperative lease-loss barrier at the post-provider,
pre-final-heartbeat boundary and now upgrades from the versioned
`0089_dropProjectJudgmentModelForeignKeys.sql` boundary while preserving a
non-empty sentinel row.

Remaining release gates are explicit: the macOS/Linux/Windows topology matrix
is implemented in `.github/workflows/judgment-workflow-topology.yml` but has not
yet executed on remote CI, and the packaged desktop lifecycle has not been
executed or recorded. The lint recheck repaired a stale review-detail type
discriminator and two formatter-only baseline findings; both repository-wide
and touched-file lint now pass. The operator-only paid real-Codex smoke was not
run. Do not finalize the PR until the required cross-platform and manual desktop
gates have their required evidence.

## Goal

Add a documented, deterministic test gate that proves the complete judgment-job
lifecycle across the server routes, per-job SQLite queue, configured judgment
runtime, DuckDB import/materialization, API read model, and admin UI.

Use two complementary architecture levels. A deterministic component-lifecycle
test may drive production services explicitly to assert every persistence
boundary. A separate process-topology smoke must launch Forska's production
composition root with distinct API, maintenance-worker, and judge-worker
processes and observe progress through public/runtime-private contracts. Do not
describe an in-process service sequence as proof of the deployed topology.

The gate must preserve benchmark-critical model, provider, thinking level, and
content configuration. Failures under that configuration must remain visible;
the test infrastructure must not silently retry with different settings,
downgrade, or fall back to another provider or model.

## Baseline Coverage And Gap At Planning Time

- `bun run test:bun` discovers the judgment-job unit and integration suites, but
  `TESTS.md` does not define a focused judgment-job regression gate.
- Existing suites cover route lifecycle, SQLite queueing and leases, dispatch,
  provider admission, request attempts, retries, completion replay, outbox
  import, repair/quarantine, DuckDB visibility, health, and telemetry.
- Playwright covers the admin jobs UI primarily with mocked job and telemetry
  responses.
- The network smoke visits `/admin/jobs` and `/admin/jobs/health`, but does not
  safely create and process a real synthetic judgment job.
- No single test proves create -> queue -> claim -> judge -> persist locally ->
  import canonical data -> project serving refresh -> pause/drain.

## Scope

### In Scope

- A fast focused backend regression command documented in `TESTS.md`.
- A deterministic synthetic full-lifecycle integration fixture.
- A deterministic isolated smoke of the production server-stack topology.
- Exact crash, replay, retry, lease, quarantine, and configuration boundaries.
- API/read-model lifecycle assertions.
- Browser and desktop lifecycle smoke coverage for the shared UI/runtime path.
- A separate opt-in real-provider smoke against isolated temporary data.

### Out Of Scope

- Running paid or nondeterministic provider calls in the normal PR gate.
- Using the primary DuckDB database or production job SQLite directory.
- Weakening configured provider/model/thinking admission to make a test pass.
- Replacing the existing mocked telemetry presentation tests.
- Adding authentication or multi-user behavior.

## Implementation Checklist

### 1. Define The Focused Backend Regression Gate

- [x] Inventory the smallest existing route, queue, dispatch, request-runtime,
      SQLite, outbox-import, repair, health, and status/read-model suites needed for
      the gate.
- [x] Add `bun run test:judgment-workflow` as the named package script for the
      selected focused suites.
- [x] Use deterministic stub-provider responses wherever judgment execution is
      required.
- [x] Ensure the gate preserves the requested model, provider, thinking level,
      and content flags in all assertions.
- [x] Document the command and its coverage in `TESTS.md`.
- [x] Keep the gate isolated from the primary database, normal job storage, and
      network providers.

Acceptance criteria:

- One documented command runs the focused backend regression suite.
- The command is deterministic, isolated, and suitable for normal PR checks.
- A configuration mismatch or provider failure is surfaced unchanged.

### 2. Build A Synthetic Full-Lifecycle Integration Fixture

- [x] Add `bun run test:judgment-workflow:e2e` as the named package script for
      the deterministic happy-path lifecycle test.
- [x] Create a unique temporary DuckDB path for each test run. Verify the
      production path resolver places the sibling `judgment-jobs/` SQLite directory
      beside that database; do not invent a separate, unsupported SQLite-root env
      variable.
- [x] Seed exactly one project, article, prompt, model, provider connection, and
      deterministic provider response.
- [x] Create the job through the production route/service boundary.
- [x] Start the job and run the production queue-fill path.
- [x] Claim exactly one prompt through the production claim/dispatch path.
- [x] Return one deterministic judgment using the configured request runtime.
- [x] Assert the completed judgment is durable in the per-job SQLite store and
      pending export before import.
- [x] Import the SQLite outbox and assert these independent boundaries in
      production order: the DuckDB transaction atomically inserts or resolves the
      canonical `app.judgment` row, import marker, review-serving delta, and dirty
      work; the SQLite outbox claim is acknowledged only after that commit; and the
      review-serving projector later completes the target dirty token.
- [x] Read and assert the canonical `app.judgment` row immediately after the
      DuckDB commit using the complete identity key:
      `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext,
useFulltextNoImages)`.
- [x] Assert the project review-serving read remains stale before its target
      dirty token is completed and exposes the judgment only after projector
      completion. Assert the SQLite visibility acknowledgement token separately
      where the production drain/retention path records it.
- [x] Pause and drain through the actual status/storage sequence:
      `running/active` -> `paused/draining` -> `paused/drained`; pausing must clear
      ready work and release the owned lease without inventing a `paused/active`
      intermediate state.
- [x] Assert the per-job SQLite file remains present while `draining`, and that
      the production drain/finalize action prunes only visibility-acknowledged
      retention and changes `storageState` to `drained` only when all drain
      preconditions are satisfied. Do not equate this state transition with file
      deletion.
- [x] If lifecycle coverage includes local artifact deletion, invoke the
      production drained-job SQLite cleanup separately after finalization and
      assert the SQLite file plus its WAL/SHM and lease sidecars are absent.
- [x] Assert zero queued, claimed, running, judged-but-unexported, and
      unacknowledged rows remain.
- [x] Make fixture cleanup unconditional and verify no background process or
      temporary runtime state survives the test. Keep this safety teardown distinct
      from assertions that exercise production drained-job cleanup behavior.
- [x] Name and document this as a component-lifecycle gate if it imports and
      invokes route/service, cron-stage, or projector functions in-process. Its
      assertions prove boundary semantics, not process wiring, scheduling, owner
      routing, or restart behavior.

Acceptance criteria:

- One test proves the entire lifecycle without network access or primary data.
- Every lifecycle and persistence transition is asserted at its authoritative
  storage boundary without treating commit, import acknowledgement,
  materialization, and visibility acknowledgement as one event.
- The canonical row is durable at DuckDB commit; the project-facing
  review-serving read changes only after projector completion.

### 3. Prove The Production Process Topology

- [x] Add `bun run test:judgment-workflow:topology` as a deterministic isolated
      smoke that launches `scripts/startServerStack.ts`, the non-watch server-stack
      composition root used by `bun run start:server`: distinct API,
      maintenance-worker, and judge-worker processes with the real DuckDB-owner and
      runtime-private routing contracts. `bun run dev:server` instead adds the
      `scripts/devServerWatch.ts` development watcher; cover its launcher/env
      contract in the focused tests, but do not use watch mode as the deterministic
      topology harness. Do not recreate the managed roles in a bespoke test
      orchestrator.
- [x] Give the stack a unique disposable DuckDB path under a test-owned,
      production-valid durable app-data root, plus a separate DuckDB spill/temp
      directory, job SQLite root derived by the production resolver, runtime-log
      directory, ports, worker identity, and owner lease artifacts. Do not place
      `DUCKDB_PATH` or the derived judge journal under the operating-system temp
      directory: production journal validation rejects `TMPDIR`, `TMP`, `TEMP`,
      `/tmp`, `/private/tmp`, and `/var/tmp` as non-durable. Allocate the disposable
      app-data root outside those locations, assert the production durability check
      accepts the derived journal before startup, and remove that root during
      unconditional teardown. The production background
      launcher deliberately clears `JUDGE_WORKER_JOURNAL_PATH`; therefore isolate
      the journal by setting that disposable durable-root `DUCKDB_PATH` and a unique
      `JUDGE_WORKER_ID`, then assert it resolves to
      `<duckdb-directory>/judge-worker-journals/<worker-id>.sqlite`. Do not depend on
      an explicit journal-path override that this composition root discards. Build
      child-process environments from an explicit test allowlist so normal profile
      paths, local app settings, and provider configuration cannot leak into the
      run. The synthetic topology gate must not inherit Codex/provider credentials.
      The separate real-Codex command may pass only the minimum environment needed
      for the already authenticated Codex CLI identity (for example its resolved
      auth-home location), while keeping Forska runtime/profile/database paths
      redirected to the test root; document that narrow exception and never copy
      credential material into the test root.
- [ ] Run the topology command on every operating system supported by the
      server release in CI. At minimum, add focused contract tests for macOS,
      Linux, and Windows runtime-root/journal/job-path resolution, supervisor-lock
      location, process-tree discovery, signal/exit handling, and path separators.
      If CI cannot execute a supported OS, document that topology gap explicitly;
      a pass on one host must not be reported as cross-platform production parity.
- [x] Initialize the isolated database through the same startup migration path
      as the deployed stack and wait for all three runtime-readiness contracts
      before creating data. In addition to a brand-new database, run the topology
      smoke from a declared supported pre-judgment-workflow migration boundary,
      then assert startup upgrades it and completes the same lifecycle. Build that
      fixture deterministically from the repository's migration prefix plus a
      small versioned seed/manifest; do not commit an opaque DuckDB binary whose
      engine compatibility or provenance cannot be reproduced. Record the chosen
      boundary and advance it deliberately when the supported-upgrade policy
      changes. A fresh-schema seed alone is not evidence that an upgraded
      installation works.
- [x] Configure a deterministic local network provider stub through the same
      provider connection/model records and request-runtime boundary as an ordinary
      supported provider. The stub may control the response, but must not replace
      claim, dispatch, request rendering, completion, import, or projection code.
- [x] Provision the topology fixture only through production HTTP boundaries or
      an owner-hosted, explicitly test-only seed boundary that uses the ordinary
      owner repositories and transactions. After the stack is ready, the harness
      must never open the DuckDB file or import an in-process DuckDB service to seed
      project, article, prompt, provider-connection, or model rows. Keep offline
      construction limited to the declared pre-start migration-boundary fixture;
      once startup begins, every DuckDB mutation must belong to the maintenance
      owner process. If the existing public APIs can provision the complete
      fixture, prefer them and do not add a test-only boundary.
- [x] Create and start the job through HTTP, then poll public job/read-model
      contracts. Let the maintenance and judge-worker loops fill, claim, dispatch,
      complete, import, and project the work; do not call those stages directly
      from the test harness.
- [x] Assert architectural evidence: only the DuckDB owner mutates DuckDB; the
      judge worker obtains owner-backed execution data and submits completion over
      the production contract; the maintenance worker advances import/projection;
      and one logical item produces one canonical judgment despite overlapping
      loop ticks.
- [x] Add a contention subcase with two active jobs sharing one provider limit
      and more than one ready prompt. Assert both jobs make bounded progress, the
      owner-backed provider-admission cap is never exceeded, each retry reacquires
      capacity through the ordinary admission path without overlapping a prior
      attempt or starving the other job, and each queue record has one terminal/
      canonical outcome. Add a separate multi-worker ownership subcase by
      starting a second judge-worker process against the same owner with a distinct
      durable `JUDGE_WORKER_ID`, derived journal, and unused listener port. Launch
      the same non-watch `src/server/index.ts` command used by the production
      supervisor; do not use the runtime-profile `judge-only-server` command,
      because that development/operator launcher adds `--watch` and can mask a
      worker exit by restarting it. Derive the child environment through
      `getBackgroundServerEnv` with the original stack's base `API_SERVER_PORT` and
      `BACKGROUND_MAINTENANCE_PORT` unchanged, set only a unique
      `BACKGROUND_JUDGE_PORT` before derivation, and then add the distinct
      `JUDGE_WORKER_ID`. Assert the derived `SERVER_DUCKDB_OWNER_URL` still names
      the original maintenance owner and the derived effective `API_SERVER_PORT`
      is the unused second-worker listener; do not override either derived value
      afterward. Reusing the supervised judge port would prevent the second server
      from starting, while changing the base API/maintenance ports would silently
      point the worker at a different owner. Assert both workers
      reach their own readiness endpoint, cannot share a journal/lock, cannot
      double-own a job claim, and can recover expired work without duplicate
      completion. Keep the ordinary supervisor topology at its deployed one-judge
      shape; the harness must not pretend the supervisor itself manages or
      watchdogs the extra worker.
- [x] Include one bounded restart boundary: terminate the judge worker only
      after a completion is durably journaled but before owner acknowledgement,
      allow the real supervisor to restart it with the same durable worker
      identity/journal, and assert replay produces one canonical judgment. Add a
      narrowly scoped, opt-in test barrier in the production completion-journal
      path that atomically consumes a one-shot, claim-scoped control file under the
      test root, emits an observable signal only after the journal transaction is
      durable, and blocks immediately before the owner request. The one-shot must
      already be consumed when the supervisor starts the replacement worker so
      replay can proceed under the otherwise identical environment. The topology
      harness must terminate the worker at that barrier with a bounded timeout;
      timing sleeps, polling an uncommitted row, intercepting owner RPC, or mocking
      the replay store do not prove this boundary. Verify the barrier is inert when
      its explicit test-only environment setting or matching control file is
      absent.
- [x] Stop the whole stack through its normal supervisor shutdown path and
      assert every child exits and all temporary data, journals, owner locks,
      sidecars, and logs are confined to and removed with the test root. The
      supervisor lock is intentionally stored under the platform temp directory
      and keyed by the three ports, so resolve that production path and assert it
      is released separately; never claim it lives beneath the test root.
      Require SIGTERM to reach a bounded clean exit before allowing a teardown-only
      SIGKILL fallback. Treat any unexpected child exit, watchdog restart, owner
      takeover, or readiness regression as a gate failure; the supervisor must not
      hide a crash loop merely because the lifecycle eventually completes. Exempt
      only the precisely synchronized judge restart required by the replay case.

Acceptance criteria:

- The gate fails if API/maintenance/judge role wiring, owner RPC, worker journal
  replay, or background-loop orchestration is broken even when in-process
  component tests still pass.
- The gate proves both fresh initialization and a supported deployed-schema
  upgrade, waits for authoritative readiness, and fails on unexpected process
  supervision events.
- The gate's platform claim is limited to the operating systems on which the
  process topology actually ran; resolver-only tests do not upgrade that claim.
- Concurrent jobs and distinct judge-worker identities preserve admission,
  ownership, progress, and exactly-once canonical outcomes.
- The provider response remains deterministic, while the real process and
  persistence topology is exercised without primary data or paid network use.
- Assertions observe contracts and durable outcomes; they do not depend on
  private function call counts, loop timing, or incidental SQL implementation.

### 4. Cover Exact Failure And Recovery Boundaries

- [x] Add `bun run test:judgment-workflow:recovery` as the named command for
      failure, replay, and recovery boundary tests; keep these out of the
      happy-path `test:judgment-workflow:e2e` command.

- [x] Replay an identical completion and assert idempotent canonical output.
- [x] Inject failure before the DuckDB import commit and assert the SQLite
      outbox remains retryable and unacknowledged.
- [x] Simulate a crash after DuckDB commit but before SQLite acknowledgement;
      rerun import and assert no duplicate canonical judgment.
- [x] Expire a worker claim and assert stale-claim recovery preserves the work.
- [x] Inject a transient SQLite lock and assert only the configured retry
      behavior occurs.
- [x] Corrupt a job SQLite store and assert explicit quarantine and diagnostic
      evidence.
- [x] Exhaust the configured retry budget and assert terminal failure without
      hidden re-admission.
- [x] Test model/runtime mismatch and assert dispatch is rejected with the
      configured values intact.
- [x] Test provider failure and assert the original failure is surfaced without
      downgrade, fallback, or alternate-provider execution.

Acceptance criteria:

- Each boundary has an exact before/after state assertion.
- Replay and recovery cannot duplicate a canonical judgment.
- Terminal and quarantined failures retain actionable evidence.
- No failure path changes benchmark-critical configuration.

### 5. Assert API And Read-Model State

- [x] Inventory and document the concrete job-detail and health response fields
      before writing assertions; map each field to its DuckDB, SQLite, or derived
      source and do not invent aggregate lifecycle labels.
- [x] Assert the job detail route's actual `status`, `storageState`, queue,
      claim/running, outbox/import, materialization/visibility, quarantine, and
      error fields or counters where those fields exist in the inventoried schema.
- [x] Assert the health route's actual counters and derived health badges at
      each boundary, using the field names and semantics found in the route
      contract rather than treating execution, storage, and health as one state.
- [x] Assert the canonical `app.judgment` row is absent before import commit and
      present after it; do not incorrectly delay canonical durability until serving
      projection completion.
- [x] Assert the project-facing review-serving route remains stale until its
      target dirty token completes, then exposes the imported judgment.
- [x] Assert another `modelId` cannot satisfy the lookup.
- [x] Assert each incompatible content configuration flag combination cannot
      satisfy the lookup.
- [x] Assert route payloads distinguish `status` from `storageState`. Derive
      health only from the route's real contract (`storageState`, recommended
      action, SQLite snapshot, import availability/leases, endpoint diagnostics,
      and serving freshness); do not require queue/materialization fields from a
      route that does not expose them.

Acceptance criteria:

- Inventoried API counters and badges agree with authoritative SQLite and
  DuckDB state at every tested boundary.
- Canonical reads require an exact model and content-configuration key match.

### 6. Add Browser And Desktop Lifecycle Smokes

- [x] Add a synthetic fixture that can be started by Playwright without using a
      real provider or the primary database.
- [x] Seed/create the synthetic job through the fixture/API production boundary
      before visiting `/admin/jobs`; do not treat `/admin/jobs` as a creation UI.
- [x] Exercise the real browser flow: create the job from the projects grid if
      creation is in scope, then open `/admin/jobs`, find the job, and use the job
      detail controls for start/pause/drain. If the fixture creates the job through
      `POST /api/judgmentsjobs`, limit the UI assertion to discovery and lifecycle;
      do not claim browser creation coverage.
- [x] Exercise `/admin/jobs/:id`: verify lifecycle state, queue/judged progress,
      storage health, and actions. This page is operational telemetry, not a
      judgment-result viewer; verify the resulting judgment through the relevant
      project review-serving UI if a user-visible result assertion is in scope.
- [x] Pause and drain the job through the UI and verify the terminal state.
- [x] Keep the existing mocked telemetry tests for loading, error, and
      presentation edge cases.
- [x] Run the lifecycle smoke in the normal browser/web flow.
- [x] Treat the existing Playwright `dev-single` composition as a UI/API
      contract gate, not evidence of the split production server topology. Keep the
      topology command above independently required whenever server role wiring,
      owner routing, worker orchestration, or journals change.
- [ ] For the current interim desktop gate, run `bun run desktop:build` and
      document a manual packaged-app lifecycle check covering navigation, job
      lookup/detail, progress, pause, and drain whenever desktop/shared runtime
      code changes. Run that check against an explicitly isolated temporary runtime
      profile/server stack; never let the packaged app discover or mutate the
      developer's primary profile as part of the test.
- [x] Separately scope a future automated desktop harness, fixture startup and
      teardown, packaged-app driver, CI support, and a named command such as
      `bun run test:desktop:judgment-workflow`; do not claim this gate exists until
      the harness is implemented.
- [x] Ensure the fixture stops all servers/workers and removes temporary state.

Acceptance criteria:

- The browser smoke proves the user-visible lifecycle against a deterministic
  backend fixture.
- Until automation exists, `desktop:build` plus the documented manual packaged
  app check is the executable desktop gate; the browser smoke remains
  independently automated.
- Neither smoke depends on paid provider calls or primary data.

### 7. Add An Opt-In Real-Provider Smoke

- [x] Add the exact operator-only command
      `bun run test:judgment-workflow:real-codex`. Require an explicit opt-in
      environment flag in addition to an authenticated Codex CLI session; absence
      of either must skip/fail before fixture or job creation without making a
      model request.
- [x] During implementation, verify against current official provider
      documentation which lowest-cost Codex model is supported by the production
      judgment request runtime and its required structured response. Pin that exact
      provider model slug as the documented smoke-test default; do not dynamically
      choose a different model at runtime when pricing or availability changes.
- [x] Provision the Codex provider connection and selectable model through the
      production ensure/repository boundary inside the isolated DuckDB, then assert
      the resulting contract: `provider_kind = 'codex'`,
      `auth_mode = 'codex-cli'`, no `secret_ref`, the pinned remote model slug and
      variant, and metadata options containing the exact thinking level. Do not
      insert a generic API-key connection or modify a model in the developer's
      normal database. Forska's production Codex path uses `codex://app-server` and
      the operator's existing Codex CLI authentication; the test must not copy CLI
      credentials into DuckDB, fixtures, logs, or result artifacts.
- [x] Before creating the job, validate only free/local prerequisites: explicit
      opt-in, Codex executable/app-server availability, authenticated CLI state if
      it can be checked without inference, pinned model slug and thinking variant,
      isolated resolved DuckDB/job paths, and temporary database records. Do not
      call the provider-connection test endpoint, model-list/discovery endpoint, or
      make a separate inference request as an access probe. Let the first real
      article judgment be the entitlement, model-availability, and structured-
      response check. Preserve its exact diagnostic on failure and do not fall back
      to another model, thinking level, provider, or synthetic response. Remove the
      temporary connection/model with the rest of the isolated fixture during
      unconditional teardown; never log authentication material.
- [x] Run a small, fixed corpus of versioned snapshots of real articles and one
      real prompt in isolated disposable DuckDB and SQLite storage under the same
      production-valid durable test root required by the topology gate. During
      implementation, extract and review the corpus once from existing imported
      articles, then commit the permitted title-and-abstract snapshots as test
      fixtures so a fresh clone needs no pre-existing article database or network
      access. Store only a stable fixture ID, title, abstract, minimal provenance
      needed to audit the fixture, redistribution/license evidence, and a SHA-256
      hash over a documented canonical UTF-8 encoding of the title and abstract.
      Recompute and require every hash before seeding or starting Codex, so fixture
      drift fails without a provider call. Do not read live production
      rows or fetch mutable article content during test execution. If the source
      terms do not permit committing a snapshot, replace that candidate with an
      article whose title and abstract may be redistributed; do not introduce an
      optional local-fixture dependency into the normal implementation.
- [x] Launch the real Codex smoke through the same isolated production
      server-stack composition root as the topology gate. Create/start through the
      HTTP boundary and let the production maintenance and judge-worker processes
      claim, request, complete, import, and project the work. The harness may bound
      admission and observe/stop the run, but must not claim or dispatch records or
      invoke cron stages itself.
- [x] Judge each article using title and abstract only. Assert
      `useTitle = true`, `useAbstract = true`, `useFulltext = false`, and
      `useFulltextNoImages = false` at job creation, dispatch, persistence, and
      canonical lookup. At test seeding time, give each temporary article a unique
      synthetic full-text sentinel and image URL that are not part of the committed
      real-article snapshot. Assert the production execution snapshot/rendered
      request input contains the exact fixture title and abstract and contains
      neither sentinel nor image URL. This proves exclusion rather than relying on
      absent full-text/image data. Do not persist or print the complete rendered
      provider prompt in normal test output.
- [x] Include representative title-and-abstract cases in the fixed corpus, such
      as a normal article, a long abstract, and an ambiguous or difficult article,
      while keeping the corpus small enough for an intentional operator-run smoke.
- [x] Bound spend and nondeterminism explicitly: pin the reviewed corpus and one
      prompt, admit no unrelated work, set a documented overall command timeout,
      and stop admission after the first observed failure. Do not have the harness
      claim/dispatch work, kill a request mid-flight merely to enforce a budget, or
      change production retry classification or configured retry policy. State the
      maximum possible provider attempts implied by the pinned corpus and that
      policy before opt-in. If Codex transport retries inside one production
      request, expose the available attempt/usage telemetry and count it in the
      recorded cost evidence; do not hide it. Record article count, logical
      dispatch count, observable request-attempt count, input/output token usage,
      elapsed time, pinned model, thinking level, and terminal state; never assert
      an exact natural-language answer.
- [x] Assert the dispatched provider, model, thinking level, and content flags
      exactly match the requested configuration.
- [x] Assert the response completes the same import/materialization/read path as
      the synthetic fixture. Assert schema-valid judgment output and durable
      identity/configuration, not a particular semantic verdict from a
      nondeterministic real model.
- [x] Surface provider admission and request failures unchanged.
- [x] Add a cost/network warning and keep the command out of normal PR and
      default local gates.
- [x] Document required environment variables and cleanup behavior in
      `TESTS.md`.

Acceptance criteria:

- The smoke runs only by explicit operator action.
- It cannot access the primary database or normal job SQLite storage.
- It never substitutes a provider, model, or thinking level.
- It creates the pinned low-cost Codex model configuration only in isolated
  test state, uses the existing Codex CLI/app-server authentication contract,
  performs no separate model-list, connection-test, or paid inference probe,
  and leaves no model, connection, credential, or app-server child process
  behind.
- It sends the versioned real-article title and abstract to the real configured
  model without sending full text or images, proves that synthetic full-text
  and image sentinels are excluded, and records the fixture content hash and
  exact runtime configuration with the result.
- A fresh developer checkout contains the reviewed article fixtures and can run
  the smoke without first populating an article database or fetching content;
  only an explicit opt-in and an already authenticated Codex CLI installation
  are external prerequisites.

### 8. Documentation And Gate Integration

- [x] Add the focused backend gate, happy-path lifecycle command, failure and
      recovery command, process-topology command, browser smoke, interim desktop
      build/manual check, future desktop automation command, and opt-in provider
      smoke to `TESTS.md`.
- [x] State which gates are required for PRs and which are operator-only.
- [x] Record fixture isolation, temporary storage, and cleanup guarantees.
- [x] Record the exact benchmark-critical settings asserted by each gate.
- [x] Note touched layers in the eventual commit/PR: server, client, database
      test fixtures, and docs.

## Suggested Delivery Order

1. Focused backend regression command and `TESTS.md` entry.
2. Shared deterministic lifecycle fixture and happy-path integration test.
3. Isolated production process-topology smoke.
4. Named failure/recovery boundary command and tests.
5. API/read-model assertions.
6. Browser smoke, then interim desktop build/manual gate; scope desktop
   automation separately.
7. Opt-in real-provider smoke and final documentation.

## Quality Gates

- [x] `bun run lint` passes without fixing unrelated lint issues.
- [x] `bun run test:judgment-workflow` passes over the targeted route, queue,
      dispatch, SQLite, request-runtime, outbox, repair, health, and read-model
      suites.
- [x] `bun run test:judgment-workflow:e2e` passes and leaves no unresolved
      queue, outbox, lease, import, or materialization acknowledgement state.
- [x] `bun run test:judgment-workflow:topology` launches the isolated production
      API/maintenance/judge stack from both fresh and supported upgrade-boundary
      schema state, proves owner-backed execution, concurrent-job admission,
      distinct-worker ownership, and one durable replay across judge-worker
      restart, fails on unexpected supervisor events, and leaves no process or
      runtime artifact.
- [x] `bun run test:judgment-workflow:recovery` passes the replay, crash,
      retry, lease, quarantine, and configuration-integrity boundaries without
      duplicating the happy-path command.
- [x] `bun run test:playwright tests/e2e/<judgment-job-lifecycle>.spec.ts`
      passes for the synthetic browser flow; `scripts/runPlaywright.ts` forwards
      the spec path directly and does not require `--`.
- [x] `bun run build` passes after shared admin UI or routing changes.
- [ ] When desktop/shared runtime code is touched, `bun run desktop:build`
      passes and the documented manual packaged-app lifecycle check records its
      result; after the desktop harness exists, its named automated command replaces
      the manual portion of this gate.
- [x] The opt-in real-provider smoke is documented but is not required for a PR;
      when intentionally run, its exact configuration, fixture hashes, request and
      token counts, elapsed time, and result are recorded without credentials or
      article text. It makes no connection-test/model-discovery request and stays
      within the documented maximum-attempt budget derived from production retry
      policy.
- [x] Test teardown leaves no server or worker processes, temporary DuckDB
      files/temp directory, sibling `judgment-jobs/` SQLite/lease files, or runtime
      log directory behind. Teardown may remove leftovers defensively, but only the
      explicit production cleanup step counts as evidence that drained-job artifact
      deletion works.
- [x] `TESTS.md` identifies the end-to-end chain and clearly distinguishes fast
      PR gates from browser/desktop and operator-only provider gates.
- [x] `bun run test:bun` passes as the full backend pre-merge gate.
