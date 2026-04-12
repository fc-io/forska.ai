# Covidence import edit-route crash and real-browser E2E plan

> For Hermes: plan only. Do not implement from this file without a separate execution step.

Goal

Stop the recurring `Cannot read properties of undefined (reading 'defaultQueryOptions')` crash after Covidence title/abstract import, and add a modern, fast, AI-friendly real-browser regression suite that catches this class of route/query-client failures before they reach you again.

Architecture

Use a layered test strategy:
1. Keep fast route-level Vitest coverage for inner-loop feedback.
2. Add a very small Playwright layer for true browser navigation, file upload, console/pageerror capture, and trace artifacts.
3. Make the Playwright suite deterministic by splitting it into a fast seeded-navigation test and a smaller full-import upload test.

Tech stack

- Bun
- SolidJS
- TanStack Router
- TanStack Solid Query
- Vitest
- Playwright

---

## Current context and evidence

- Real browser reproduction exists now on `http://localhost:3000`.
- Navigating to a Covidence-created project edit page reproduces:
  - `Cannot read properties of undefined (reading 'defaultQueryOptions')`
  - router warning that no root `errorComponent` caught it
  - several Solid warnings about computations created outside `createRoot`/`render`
- Existing route test already passes:
  - `src/app/routes/+projects/+$id/-+edit.vitest.tsx`
- That means current happy-dom/router coverage is not exercising the real browser/code-split/navigation path that fails in production-like usage.
- Strong root-cause candidate:
  - `src/app/routes/+projects/projectAccessGuard.ts` no longer carries the explicit shared query-client path that earlier existed in commit `ea2cf9fe` (`fix: stabilize project edit query client`).
  - Treat this as a hypothesis to verify, not yet a confirmed fix.

---

## Testing angles to consider

### Angle 1: Direct seeded browser navigation

What it tests
- Open a pre-seeded Covidence-created project edit route in a real browser.
- Assert no crash page, no route error, and no `defaultQueryOptions` console failure.

Why it matters
- Fastest real-browser regression for this exact bug.
- Avoids paying full import cost on every run.
- Best first E2E guardrail for CI and local AI-assisted debugging.

Tradeoffs
- Does not prove the upload/import form itself works.
- Needs deterministic seed setup through API or a local test-seed helper.

Recommendation
- Make this the required Playwright smoke test.

### Angle 2: Full UI import flow with real CSV upload

What it tests
- Start at `/admin/datasources/covidence-import`
- Upload the three title/abstract fixture CSVs
- Run analyze/create
- Follow the redirect into `/projects/$id/edit`
- Assert edit page renders and the browser console stays clean

Why it matters
- Closest to the user’s actual workflow.
- Verifies file inputs, multipart upload, create flow, redirect, and final route render together.

Tradeoffs
- Slower than seeded navigation.
- More moving parts, so failures can be less localized.

Recommendation
- Keep exactly one of these as the higher-level regression.

### Angle 3: Console/trace-first failure capture

What it tests
- Not a separate user flow; this is instrumentation attached to the Playwright flows.
- Fail on `pageerror`, `console.error`, and the known `defaultQueryOptions` warning/error text.
- Save Playwright traces, screenshots, and video on failure.

Why it matters
- Very AI-friendly.
- Makes recurring UI regressions easy to diagnose from artifacts instead of guesswork.
- Turns silent route crashes into actionable evidence.

Recommendation
- Mandatory on every Playwright test for this area.

### Angle 4: Vitest Browser Mode as a complement, not the primary guard

What it tests
- Faster browser-ish route/component behavior than Playwright.
- Good for focused route rendering and query-client contract tests.

Why it is not enough alone
- The current route Vitest coverage already passes while the real browser still fails.
- This bug class clearly needs one true browser/navigation layer.

Recommendation
- Optional follow-up optimization after Playwright is in place.
- Do not rely on it as the only fix for this recurring issue.

---

## Recommended target state

Use a two-tier browser strategy:

1. Playwright smoke: seeded direct navigation to `/projects/$id/edit`
2. Playwright workflow: full Covidence title/abstract import with fixture upload
3. Existing Vitest route test stays in place for fast feedback and can be tightened once the root cause is confirmed

This gives:
- real-browser confidence
- fast local iteration
- strong debugging artifacts
- low enough suite cost to run often

---

## Proposed implementation plan

### Phase 1: Lock down reproduction and observability

1. Add a root router error surface for test/debug visibility.
   - Likely files:
     - `src/app/routes/+__root.tsx`
     - or `src/app/router.tsx`
2. Make route failures visible to tests with a stable error marker.
3. Define a shared browser assertion helper:
   - fail on `pageerror`
   - fail on `console.error`
   - fail on console text matching `defaultQueryOptions`

Deliverable
- A browser test can reliably tell the difference between a successful edit route render and a route crash.

### Phase 2: Fix the crash at the source

1. Re-verify the real failing path in the browser.
2. Compare current project-edit/query-client code with the earlier `ea2cf9fe` fix.
3. Confirm whether `projectAccessGuard.ts` needs the explicit shared query client again or whether the failure now comes from a different route/query boundary.
4. Implement the smallest durable fix.
5. Keep the fix architecture-level, not a symptom patch.

Likely files
- `src/app/routes/+projects/projectAccessGuard.ts`
- `src/app/routes/+projects/+$id/+edit.tsx`
- possibly `src/app/queryClient.ts`
- possibly `src/app/router.tsx`

Deliverable
- Real browser navigation from a Covidence-created project into edit no longer crashes.

### Phase 3: Add the fast Playwright smoke path

1. Add Playwright with Bun-friendly scripts.
2. Create a small test fixture strategy for a pre-seeded Covidence project.
   - Preferred: seed via API/helper script, not fragile DB mutation from the test itself.
3. Write one spec that:
   - opens the app
   - navigates directly to a seeded `/projects/$id/edit`
   - asserts the page renders expected edit controls
   - asserts no console/pageerror failure
4. Configure trace-on-failure and screenshot-on-failure.

Likely files
- `playwright.config.ts`
- `package.json`
- `tests/e2e/helpers/browserErrors.ts`
- `tests/e2e/helpers/covidenceFixtures.ts`
- `tests/e2e/projectEditFromCovidence.spec.ts`
- optional: `scripts/testSeedCovidenceProject.ts`

Deliverable
- One fast, deterministic browser smoke test for this bug class.

### Phase 4: Add one full import workflow regression

1. Reuse the existing CSV fixtures under `assets/covidence_imports/...` or move a minimal fixture set into a test-owned directory.
2. Write one end-to-end spec that:
   - opens `/admin/datasources/covidence-import`
   - fills the minimum required fields
   - uploads the three title/abstract CSVs
   - runs analyze/create
   - waits for navigation to `/projects/$id/edit`
   - verifies the edit page renders without route/query-client errors
3. Keep the fixture package intentionally small to preserve speed.

Likely files
- `tests/e2e/covidenceImportCreateAndEdit.spec.ts`
- `tests/e2e/fixtures/covidence/title-abstract/*`

Deliverable
- One true user-journey browser regression test.

### Phase 5: Tighten the fast route-level suite

1. Keep `src/app/routes/+projects/+$id/-+edit.vitest.tsx`.
2. Update it to reflect the confirmed root-cause contract.
3. Add an assertion that mirrors the production-sensitive boundary as closely as possible.
4. If worthwhile later, evaluate Vitest Browser Mode only as a speed layer between unit tests and Playwright.

Deliverable
- Fast local feedback without pretending it replaces browser E2E.

---

## Files likely to change

Existing
- `src/app/routes/+projects/projectAccessGuard.ts`
- `src/app/routes/+projects/+$id/+edit.tsx`
- `src/app/routes/+projects/+$id/-+edit.vitest.tsx`
- `src/app/routes/+__root.tsx`
- `src/app/router.tsx`
- `package.json`

New
- `playwright.config.ts`
- `tests/e2e/projectEditFromCovidence.spec.ts`
- `tests/e2e/covidenceImportCreateAndEdit.spec.ts`
- `tests/e2e/helpers/browserErrors.ts`
- `tests/e2e/helpers/covidenceFixtures.ts`
- optional `tests/e2e/fixtures/covidence/title-abstract/*`
- optional `scripts/testSeedCovidenceProject.ts`

---

## Quality gates

Keep these concrete and repo-native.

Required for the bug fix
- `bunx vitest run 'src/app/routes/+projects/+$id/-+edit.vitest.tsx'`
- `bun run lint`
- `bun run build`

Required for real-browser coverage
- `bunx playwright test tests/e2e/projectEditFromCovidence.spec.ts`
- `bunx playwright test tests/e2e/covidenceImportCreateAndEdit.spec.ts`

Manual verification
- In a real browser on local dev, reproduce the current failing route once, apply the fix, then verify the same path renders the edit page without console/query-client crash.

---

## Risks and tradeoffs

- Full-import E2E can become slow if fixtures are too large or if it depends on incidental app state.
- Direct DB seeding from Playwright would be fast but too coupled; prefer API or a tiny local seed helper.
- Console assertions can be noisy if the app already emits benign warnings. If so, filter only the known failure signatures and true errors.
- If the root cause is router code-splitting or preloading behavior, the fix may belong in shared router/query integration rather than only in the project edit route.

---

## Open questions to resolve during execution

1. Is `projectAccessGuard.ts` drift from commit `ea2cf9fe` the actual root cause, or just a nearby regression marker?
2. Should the seeded Playwright smoke create its own project through API each run, or reuse a stable fixture project created by a helper script?
3. Do we want Playwright to boot against `bun run dev:app` + `bun run dev:server`, or against a production-style `bun run build` + preview/app-server pair for stricter realism?
4. Should a root route `errorComponent` remain in production for better operator visibility, or only exist as a debug-friendly improvement if it is user-safe?

---

## Recommendation summary

Best fit for “modern, fast, AI-friendly” here:
- Use Playwright for the real browser layer.
- Keep the Playwright layer very small and high-value.
- Split it into one fast seeded-navigation smoke and one full import/upload journey.
- Keep Vitest for fast route logic, but do not trust it alone for this crash class.

This is the minimum durable setup that should stop this issue from recurring silently.
