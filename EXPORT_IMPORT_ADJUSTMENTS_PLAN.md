# Export/Import Adjustments Plan

## Decisions Captured

1. Replace the hardcoded large raw article provenance omission behavior with an export setting.
2. Remove provider/model remapping onto existing target rows. Import planning should target imported source snapshots instead.
3. Keep the current source-review-row signature provenance warnings.
4. Investigate article omission warnings in more detail and reduce the cases that trigger them.
5. Treat dependent payload omission as fallout from an earlier parent omission, not as an acceptable steady-state outcome.
6. Keep credential-bearing, signed, query-string, and fragment URLs unmodified in package payloads.
7. Keep provider secret reference redaction.
8. Keep the missing/inactive target import route warning.
9. Reuse identical imported provider/model snapshots by a dedicated snapshot fingerprint, not by the current exported model signature alone.
10. Always disable imported provider/model snapshot rows after import, even if that can retroactively break older imports that share the same reused snapshot rows.
11. Resolve reusable imported snapshots during analysis; reserve virtual `new:provider:*` and `new:model:*` ids only for snapshots that do not already exist.
12. Mark imported snapshot rows explicitly so reuse only targets prior imported snapshots, not arbitrary local provider/model rows.

## Current Diagnosis

### 4. Why an article row was omitted

- The exporter only omits an article row when a field that participates in review input would need redaction.
- Today that field set is built from project settings:
  - `articleTitle` when `project.settings.useTitle` is `true`
  - `articleSummary` when `project.settings.useAbstract` is `true`
- A title or summary is currently treated as unsafe when it contains any value that matches the generic redaction rules:
  - a URL with credentials, a query string, or a fragment
  - a local/private URL or local filesystem path
  - a secret-like token string
- The exporter omits the whole article instead of mutating `articleTitle` or `articleSummary` because changing those fields would change the actual review input and invalidate the fidelity of imported judgments, human judgments, summaries, and review rows.
- In practice, the reported article omissions are most likely caused by the current URL rule, and even removing only the dedicated `urlRedacted` branch would not be enough because the generic `secretPattern` can still match URL query params like `token=` or `api_key=`.

### 5. Why dependent payload rows were omitted

- This is a direct consequence of a parent row being omitted earlier.
- Once an article is omitted, the exporter drops rows that reference that article so the package stays internally consistent.
- For omitted articles, the fan-out can include:
  - `projectArticles`
  - `articleImportRoutes`
  - `humanJudgments`
  - `humanJudgmentSummaries`
  - `reviews`
  - `judgments`
  - `judgmentAssessments` after omitted judgments
- The `x23` warning is therefore not a second independent bug. It is the cascade from the earlier omitted parent rows.
- The most likely reason this happened in the reported package is that one or more article titles or summaries matched the current URL redaction rule, which then forced article omission to preserve review-input fidelity.

### Provider/model snapshot reuse constraints

- The current exported model `signature` is too weak to safely drive snapshot reuse by itself.
- In current code, exported model `signature` includes display/model/provider identity fields, but it does not include `metadataJson`.
- Judgment fidelity does depend on metadata-derived request fields such as:
  - `contextLimit`
  - `promptTokenLimit`
  - `modelOptions`
- That means two exported models can look equivalent under the current model `signature` while still producing different judgment input signatures.
- Snapshot reuse therefore needs a stronger dedicated fingerprint over the imported provider/model snapshot payloads, including the provider runtime-signature inputs and the full model metadata needed for judgment request equivalence.
- Provider connections do not currently have a dedicated source column, so provider snapshot reuse also needs a durable imported-snapshot marker, likely in `config_json`.
- Model snapshot reuse should also key off an explicit imported-snapshot marker so exact local rows created manually or by discovery are not treated as reusable imported snapshots.
- Analysis also needs concrete target ids whenever a matching imported snapshot already exists. Judgment reuse/conflict detection is keyed on `targetModelId`, so analysis cannot defer all snapshot reuse decisions until commit.
- Always disabling reused imported snapshot rows can retroactively affect older imported projects that share those rows. That tradeoff is now accepted.

## Recommended Fixes

| # | Fix | What It Does Now | What It Should Do | Why It Helps |
| --- | --- | --- | --- | --- |
| 1 | Add an export-time raw provenance setting | Raw article provenance JSON is auto-omitted when the estimated size exceeds the hardcoded threshold | Add an export setting such as `rawArticleProvenanceMode: auto | include | omit`, with `auto` preserving the current heuristic | Makes omission user-controlled instead of surprising |
| 2 | Thread the export setting through API and UI | Export route accepts an empty body and the UI always uses the default behavior | Accept export options in `/api/projects/:id/export-project` and expose the choice in the export action UI | Lets users choose fidelity vs package size intentionally |
| 3 | Replace target remapping with imported-snapshot planning | Import analysis tries to map source providers/models onto existing enabled target rows | Resolve to concrete existing imported snapshot ids when an exact imported-snapshot match already exists; otherwise preserve analyze-time virtual ids like `new:provider:*` and `new:model:*` | Avoids silently changing benchmark-critical provider/model identity while keeping analyze and fidelity validation functional |
| 4 | Reuse identical imported snapshots by dedicated snapshot fingerprint | Imported provider/model rows are currently created through the dependency-resolution materialization path | Reuse an existing imported snapshot row only when a stronger provider/model snapshot fingerprint matches exactly; otherwise materialize a new imported snapshot row | Prevents duplicate source-snapshot rows across repeated imports without collapsing nonequivalent models |
| 5 | Mark imported snapshot rows explicitly | The current system does not clearly distinguish imported provider snapshots from arbitrary local rows | Add an explicit imported-snapshot marker so reuse lookup only considers prior imported snapshots | Prevents snapshot reuse from accidentally turning back into local remapping |
| 6 | Define snapshot reuse fingerprint stronger than current exported model signature | The current exported model `signature` can treat metadata-different models as equivalent | Build reuse matching from provider snapshot fields plus full model metadata needed for judgment request equivalence, not from the current exported model `signature` alone | Prevents unsafe reuse that would hide request-contract differences |
| 7 | Materialize imported provider/model rows in a safe inactive state | Imported provider/model rows can be materialized with source metadata, but the current flow is built around resolution/mapping | Insert imported provider connections with `secretRef = null`, reuse or create imported snapshot rows by fingerprint, and always disable imported provider/model rows until the user edits them later | Preserves source metadata without pretending the imported runtime is already usable |
| 8 | Stop mutating URLs during export | Any URL with credentials, query, or fragment is rewritten and warned | Keep recognized non-local URLs unchanged, and do not run the generic secret-pattern redaction against those URL strings | Prevents review-input article omissions caused by normal, signed, or credential-bearing URLs |
| 9 | Add a non-redacting visibility warning for credential-bearing URLs | URL mutation both sanitizes and signals the issue today | Emit a new warning when exported payloads contain credential-bearing or signed URLs, but leave the URL value unchanged | Preserves fidelity while making the risk explicit to the exporter |
| 10 | Keep only truly necessary article/prompt/judgment omission paths | Review-input rows are omitted whenever any decision-bearing field matches the current redaction rules | After URL handling changes, keep omission only for remaining local-path/private-host and explicit non-URL secret cases | Shrinks the number of surprising fidelity omissions |
| 11 | Make parent omission easier to debug | Omission warnings explain the category but not enough to quickly trace the exact row and field from the UI alone | Include `sourceArticleId` or `sourcePromptId`, the triggering field name, and the dependency reason in warning details and rendered UI | Makes future incidents explainable without reading server code |
| 12 | Treat unexpected decision-bearing omissions as a stronger export problem | Export continues with a warning-heavy partial payload | After the policy changes above, treat any remaining decision-bearing parent omission as an explicit export blocker or at minimum a high-visibility preflight warning | Avoids shipping partial review data unnoticed |

## Implementation Order

1. Add the export options contract and export UI control for raw article provenance mode.
2. Stop mutating recognized non-local URLs during export, and ensure generic secret-pattern redaction no longer re-catches those URL strings.
3. Add a non-redacting warning for exported credential-bearing or signed URLs.
4. Re-run the article/prompt/judgment omission paths and confirm the earlier `x4` and `x23` warnings disappear for URL-driven cases.
5. Remove provider/model matching onto existing target rows from dependency resolution and import analysis.
6. Add an explicit imported-snapshot marker for reusable provider/model snapshot rows so reuse lookup only considers prior imported snapshots.
7. Define dedicated provider and model snapshot reuse fingerprints. Do not reuse by the current exported model `signature` alone because it omits `metadataJson` and can collapse nonequivalent models.
8. During analysis, resolve source providers/models to concrete existing imported snapshot ids when the snapshot fingerprint matches exactly; otherwise preserve virtual imported ids so fidelity validation and target planning can still resolve judgments before commit.
9. During commit, reuse those exact-match imported snapshots and materialize new imported snapshots only for the remaining virtual ids.
10. Always disable imported provider/model rows on insert or reuse so the imported project keeps the historical metadata without implying a working secret-backed runtime, accepting that this can retroactively affect older imports that share those rows.
11. Improve warning details for any remaining omission cases.
12. Decide whether remaining decision-bearing omissions should hard-fail export or stay as prominent warnings.

## Scope Notes

- This plan intentionally keeps provider secret redaction.
- This plan intentionally keeps the current judgment and human/review signature provenance warnings.
- This plan intentionally keeps import-route missing/inactive warnings.
- This plan intentionally allows credential-bearing and signed URLs to leave the system unchanged in export packages. The package should warn, but not rewrite, those values.
- This plan intentionally accepts that reusing and then disabling shared imported snapshot rows can retroactively break older imported projects that share those rows.
- This plan intends snapshot reuse to apply only to rows previously created as imported snapshots, not to arbitrary manual or discovered local provider/model rows.
- The biggest behavioral change is item 3: imported judgments will stay tied to imported source-model metadata instead of being rebound to an existing local model during import.

## Quality Gates

- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- `bun test src/server/routes/projectTransferRoutes.test.ts`
- `bun test src/components/main/projectsGrid.vitest.tsx`
- `bun test src/app/routes/+projects/-+import.vitest.tsx`
- `bun run build`
- `bun run desktop:build` if the export UI or shared import flow is touched
- Browser verification: export a project with each raw provenance mode and inspect resulting warnings
- Browser verification: export a project containing signed or credential-bearing URLs and confirm the package warns but preserves the exact URL values
- Browser verification: import the same package twice and confirm exact-match imported provider/model snapshots are reused by fingerprint
- Browser verification: import a package with judgments/human review rows and confirm analysis resolves judgments against reused or virtual imported snapshots without remapping
- Browser verification: import a package with judgments/human review rows and confirm provider/model rows are imported as disabled snapshots without remapping

## Commands Run For This Investigation

- No shell commands were needed.
- Repository inspection was done through code search and file reads only.
