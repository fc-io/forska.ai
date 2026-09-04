# Comparison Export PDF Plan

Status: historical implementation plan. The PDF export exists; keep this file as background notes only.

## Goal

Add an `Export to PDF` option on the Export comparison data page. The PDF export should use the same comparison row filters as CSV export, including row filter, difference filter, and article category filter. The output should be optimized for human reading rather than spreadsheet compactness.

The PDF should feel close to the article review page: article context first, then side-by-side or stacked human/LLM judgment information, with enough whitespace to scan prompts, answers, explanations, and quotes.

## Proposed PDF Shape

Default paper: A4 portrait.

One article starts on a new page unless the article is very short and the user later asks for a more compact mode. Long article summaries, explanations, and quote blocks can continue over multiple pages.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Project: GPT 5.5 xhigh comparison                                            │
│ Filters: Fully answered | Human vs LLM differences | Non-Chinese articles    │
│ Exported: 2026-08-31 21:05                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Article 12 of 184 · Article ID: cov-123456                                   │
│                                                                              │
│ Title                                                                        │
│ Long article title wraps naturally over one or more lines, with enough       │
│ leading that it reads like the article detail page rather than a table cell.  │
│                                                                              │
│ Abstract / Summary                                                           │
│ This is the article abstract or summary. It uses paragraph spacing, not       │
│ CSV-like wrapping. Very long abstracts continue on the next page.             │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ Conflict resolution                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Current resolution: Not set                                                  │
│ Choose resolution                                                            │
│ ( ) Not set                                                                  │
│ ( ) Include / Yes                                                            │
│ ( ) Exclude / No                                                             │
│ ( ) Maybe / Unsure                                                           │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ LLM assessment                                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ Prompt                                                                       │
│ Comparator / Context Criteria                                                │
│                                                                              │
│ Human judgment                                                               │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Answer: Yes                                                             │ │
│ │ Comment: Optional human judgment comment when present.                   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ LLM judgment: GPT-5.5 xhigh                                                  │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Answer: No                                                              │ │
│ │ Content used: Title + Abstract + Full text                              │ │
│ │ Explanation                                                             │ │
│ │ The model explanation is shown as prose, with paragraph spacing and      │ │
│ │ readable line length.                                                    │ │
│ │                                                                          │ │
│ │ Quotes                                                                   │ │
│ │ 1. "Relevant quoted evidence from the title, abstract, or full text."    │ │
│ │ 2. "Additional quote if available."                                     │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ LLM judgment: Other model / run                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Answer: Yes                                                             │ │
│ │ Explanation                                                             │ │
│ │ ...                                                                      │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘

Footer on every page:
Page 3
```

The header metadata and `Article N of M · Article ID` line should be rendered in a small, quiet font. They are present for orientation, but should not compete visually with the article title and judgment content.

## Summary-Mode Variant

For comparison projects that use summary human judgments, add the same compact decision summary the article page shows, before prompt-level cards.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Summary Decision                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Include this study?                                                          │
│                                                                              │
│ ┌─────────────────────────────┐        ┌─────────────────────────────┐       │
│ │ AI                          │        │ Human                       │       │
│ │ No                          │        │ Yes                         │       │
│ └─────────────────────────────┘        └─────────────────────────────┘       │
│                                                                              │
│ Result: Human vs LLM difference                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Multi-Model / Wide Comparison Variant

If there are many comparison columns, do not render a dense horizontal table. Use one card per judgment source under each prompt. That keeps A4 portrait readable and avoids tiny type.

```text
Prompt: Primary endpoint

Human
  Answer: Yes
  Comment: ...

GPT-5.5 xhigh
  Answer: Yes
  Explanation: ...
  Quotes:
    1. "..."

Claude / other model
  Answer: No
  Explanation: ...
```

## Reviewer Tracking

Conflict-resolution rows should store who set the resolution.

- Add a nullable local-user reference on `app.comparison_project_conflict_resolution`, for example `reviewer_user_id VARCHAR`, populated when a conflict resolution is created or changed.
- The reviewer should be the current local user id, not a display-name copy. Resolve the display name at read/export time from `app.user_config`.
- The PDF conflict-resolution section should not expose reviewer IDs or repeat per-row reviewer labels. Import reviewer identity is collected on the PDF front page as `Your name:`, and the import commit creates an internal reviewer instance ID.
- First-run local user setup should generate a unique stable user id rather than relying on a shared/default constant across installations.
- First-run local user setup should also create a human-readable display name. A good default is something like the OS account full name when available, then OS username, then `Local reviewer`.
- Existing installs need a migration/backfill path: preserve the existing local user if present, but ensure it has a unique id and non-empty display name before new reviewer references are written.

## Export Page UI

The export page should show two actions in the existing filter panel:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Export filters                                                               │
│                                                                              │
│ Row filter        [ Fully answered                 v ]                       │
│ Article category  [ Non-Chinese articles           v ]                       │
│ Difference filter [ Human vs LLM differences       v ]                       │
│                                                                              │
│ [ Export CSV ]   [ Export PDF ]                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

`Export PDF` should use exactly the same active filters as `Export CSV`.

## Fast Implementation Shape

- Reuse the existing comparison serving iterator so PDF export reads rows from `mart.comparison_article_serving` and hydrated cells from comparison serving marts.
- Keep CSV and PDF filters identical by sharing the existing export request body shape, plus an explicit `format: 'csv' | 'pdf'` or separate `/export.pdf` endpoint.
- Generate a streamed or file-backed PDF server-side, not in the browser. The result can be an attachment with `application/pdf`.
- Render article sections from comparison export row data rather than calling the per-article review-detail route for every row. Per-row article detail fetching would be much slower and would duplicate permission/readiness behavior.
- Add a PDF-specific row renderer that maps the comparison export row into article-page-like blocks:
  - article title
  - article summary/abstract
  - conflict resolution when enabled
  - summary decision when applicable
  - prompt sections
  - judgment source cards with answer, content-used flags, explanation, quotes, and human comments where available
- Cap pathological text blocks with clear continuation behavior only if PDF generation becomes too large. The first version should prefer completeness over compactness.

## Open Questions

- Should each article always start on a new page, or should short articles be allowed to share pages?
- Should PDF export include full text excerpts when quotes refer to full text, or only the quotes/explanations already present in judgments?
- Should conflict-resolution transfer metadata be included when present, or only the current resolved label?
- Should the button be disabled above a row-count threshold and route the job to a background export task, or is synchronous generation acceptable for the current expected row counts?
