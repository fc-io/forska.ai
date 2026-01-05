# PDF Processing with Docling

## Goal

Convert article PDFs → Markdown text → include in LLM judgment prompts

## Architecture

```
PDF fetch (existing) → Docling Serve (Docker) → fullText column → judgeGetSinglePrompt()
         ↓                    ↓
   fullTextPDF         http://localhost:5001
```

## When to convert

Convert at **prompt preparation time** (`processPromptWithLLM.ts`), not at fetch time:
- Only for projects/jobs with `useFulltext=true`
- Only converts PDFs for articles actually being judged
- Avoids wasted conversions for irrelevant articles
- Cache result in `fullText` column after first conversion

## Components

### 1. Docling Serve (Docker)

```bash
docker run -d --name docling-serve -p 5001:5001 ghcr.io/docling-project/docling-serve
```

Add to `docker-compose.yml`:
```yaml
docling:
  image: ghcr.io/docling-project/docling-serve
  ports:
    - "5001:5001"
```

### 2. Docling Client

New file: `src/server/utils/doclingClient.ts`
- POST to `/v1/convert/source`
- Input: PDF URL or base64
- Output: Markdown text
- Retry on failure
- Log conversion time

### 3. Prompt Structure

Modify: `src/agent/judge/judgeGetSinglePrompt.ts`

Current prompt:
```ts
## article_title
${article.articleTitle}

## article_summary
${article.articleSummary}

## Question
${prompt.originalText}
```

With fulltext:
```ts
## article_title
${article.articleTitle}

## article_summary
${article.articleSummary}

## article_fulltext
${article.fullText ?? '[No fulltext available]'}

## Question
${prompt.originalText}
```

### Considerations

- **Token limit**: fulltext can be large (10k+ tokens)
  - Truncate if exceeds `MAX_FULLTEXT_TOKENS` (e.g., 16000)
  - Prefer truncating end (conclusions) over beginning (abstract/intro)
- **Skip if missing**: if `useFulltext=true` and no fulltext → skip article, don't send for judgment
- **Section marker**: use `## article_fulltext` to clearly separate from summary

### 4. Conversion Logic

Modify: `processPromptWithLLM.ts`

```ts
// Before sending to LLM:
if (project.useFulltext && article.fullTextPDF && !article.fullText) {
  article.fullText = await convertPdfToText(article.fullTextPDF)
  await db.update(articles).set({fullText}).where(...)
}
```

## DB Schema

Existing columns (already in schema):
- `fullTextPDF: text` — PDF URL from Unpaywall/arXiv
- `fullText: text` — converted Markdown (to cache)
- `fullTextFetchedAt: timestamp` — when PDF was fetched

## Error Handling

### How Docling can fail

| Failure | Cause | Frequency |
|---------|-------|-----------|
| **Service unavailable** | Container not running, crashed | Rare |
| **Timeout** | Large PDF, complex layout, OCR | Occasional |
| **PDF fetch fail** | URL expired, 403/404, network | Common |
| **Corrupt/encrypted PDF** | Bad file, password-protected | Rare |
| **Empty output** | Scanned image w/o OCR, blank pages | Occasional |
| **Partial output** | Truncated due to memory/timeout | Rare |

### Strategy

1. **Transient failures** (service down, timeout) → retry later
2. **Permanent failures** (corrupt PDF, 404) → mark as failed, skip

### DB columns for tracking

```sql
fullTextConversionStatus: 'pending' | 'success' | 'failed' | 'skipped'
fullTextConversionError: text  -- error message if failed
fullTextConversionAttempts: int  -- retry count
```

### Conversion flow

```ts
if (conversionStatus === 'failed' && attempts >= MAX_ATTEMPTS) {
  // Skip permanently failed PDFs
  return
}
try {
  fullText = await convertPdfToText(fullTextPDF, {timeout: 60000})
  await db.update(articles).set({fullText, conversionStatus: 'success'})
} catch (error) {
  if (isPermanentError(error)) {
    await db.update(articles).set({conversionStatus: 'failed', conversionError: error.message})
  } else {
    await db.update(articles).set({conversionAttempts: attempts + 1})
    // Will retry on next run
  }
}
```

### Permanent vs Transient errors

**Permanent** (don't retry):
- HTTP 404/403/410 (PDF gone)
- "Encrypted PDF" / "Password required"
- "Unsupported format"

**Transient** (retry):
- HTTP 5xx from Docling
- ECONNREFUSED / ETIMEDOUT
- "Service unavailable"

### Config

```env
DOCLING_CONVERSION_TIMEOUT_MS=60000
DOCLING_MAX_CONVERSION_ATTEMPTS=3
```

## Env Vars

```env
DOCLING_SERVE_URL=http://localhost:5001
```

## Checklist

### Setup
- [ ] Add `docling` service to `docker-compose.yml`
- [ ] Add `DOCLING_SERVE_URL` to env

### Client
- [ ] Create `src/server/utils/doclingClient.ts`
- [ ] `convertPdfToText(pdfUrl: string): Promise<string>`
- [ ] Handle errors (timeout, service down)
- [ ] Log timing

### Integration
- [ ] Modify `processPromptWithLLM.ts`: fetch project.useFulltext
- [ ] If useFulltext && fullTextPDF exists && fullText is null → convert
- [ ] Cache result in `fullText` column
- [ ] Modify `judgeGetSinglePrompt.ts`: append fullText to prompt

### Optional/Future
- [ ] Add health check for Docling service
- [ ] Rate limit conversions
- [ ] GraniteDocling VLM for complex PDFs (--pipeline vlm)
- [ ] Parallel conversion for batch jobs
