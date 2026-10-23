import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (path: string) => {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('full text fetch cron uses bounded background DuckDB scans and delta-appending writes', () => {
  const source = readSource('./fullTextJobs.ts')

  expect(source).toContain("routeOrJobKey: 'fullText.fetch.cron'")
  expect(source).toContain("workloadClass: 'background.fullText.fetch'")
  expect(source).not.toMatch(/getAppDatabaseService\(\)\.queryJson</)
  expect(source).not.toMatch(/getAppDatabaseService\(\)\.run\(/)
  expect(source).toContain('selectFullTextCronArticles<ArticleRow>({')
  expect(source).not.toContain('fallbackLimit')
  expect(source).toContain('workloadContext: fullTextFetchWorkloadContext')
  expect(source).toContain('full_text_pdf = ${getSqlLiteral(fullText.fullTextPDF)}')
  expect(source).toContain('appendArticleReviewServingDeltas(tx')
  expect(source).toContain("changedFields: fullText.fullTextPDF ? ['fullTextPDF'] : []")
})

test('full-text cron scope reads projects and articles with bounded background scans and no fallback', () => {
  const source = readSource('./fullTextJobs/fullTextCronScope.ts')

  expect(source).toContain('MAX_FULL_TEXT_PROJECTS_PER_SCAN = 100')
  expect(source).not.toMatch(/getAppDatabaseService\(\)\.queryJson</)
  expect(source).not.toMatch(/getAppDatabaseService\(\)\.run\(/)
  expect(source).toContain('maxResultRows: MAX_FULL_TEXT_PROJECTS_PER_SCAN')
  expect(source).toContain('maxResultRows: limit')
  expect(source).toContain('COALESCE(p.use_fulltext, FALSE) = TRUE')
  expect(source).toContain('COALESCE(p.archived, FALSE) = FALSE')
  expect(source).not.toContain('fallbackLimit')
})

test('full text conversion cron and on-demand conversion use background workload contexts', () => {
  const conversionCronSource = readSource('./fullTextConversionJobs.ts')
  const ensureFullTextSource = readSource('../utils/ensureFullText.ts')

  expect(conversionCronSource).toContain("routeOrJobKey: 'fullText.conversion.cron'")
  expect(conversionCronSource).toContain("workloadClass: 'background.fullText.conversion'")
  expect(conversionCronSource).not.toMatch(/getAppDatabaseService\(\)\.queryJson</)
  expect(conversionCronSource).not.toMatch(/getAppDatabaseService\(\)\.run\(/)
  expect(conversionCronSource).toContain('runBackground')
  expect(conversionCronSource).toContain('selectFullTextCronArticles<ArticleForConversion>({')
  expect(conversionCronSource).not.toContain('fallbackLimit')
  expect(conversionCronSource).toContain('workloadContext: fullTextConversionWorkloadContext')
  expect(conversionCronSource).toContain('storeConvertedFullText({')

  expect(ensureFullTextSource).toContain("routeOrJobKey: 'fullText.ensure'")
  expect(ensureFullTextSource).toContain("workloadClass: 'background.fullText.ensure'")
  expect(ensureFullTextSource).not.toMatch(/getAppDatabaseService\(\)\.queryJson</)
  expect(ensureFullTextSource).not.toMatch(/getAppDatabaseService\(\)\.run\(/)
  expect(ensureFullTextSource).toContain('queryJsonBackground')
  expect(ensureFullTextSource).toContain('runBackground')
  expect(ensureFullTextSource).toContain('maxResultRows: 1')
  expect(ensureFullTextSource).toContain('workloadContext: ensureFullTextWorkloadContext')
  expect(ensureFullTextSource).toContain('storeConvertedFullText({')
  expect(readSource('../fullText/canonicalFullTextStore.ts')).toContain('appendArticleReviewServingDeltas(tx')
})

test('article full_text_pdf update paths append review serving deltas', () => {
  const sources = [
    readSource('./fullTextJobs.ts'),
    readSource('../services/pdfFetchJobs.ts'),
    readSource('../routes/articleAdminRoutes/articleAdminRoutesPostFetchPdf.ts'),
    readSource('../routes/articleAdminRoutes/articleAdminRoutesPostUploadPdf.ts'),
    readSource('../routes/articlesRoutes/articlesRoutesPostPdfFetchReset.ts'),
  ]

  expect(sources.join('\n')).toContain('full_text_pdf = ${getSqlLiteral(fullText.fullTextPDF)}')
  expect(sources.join('\n')).toContain("fullTextPDF: 'full_text_pdf'")
  expect(sources.join('\n')).toContain('SET full_text_pdf = ${getSqlLiteral(fullTextPDF)}')
  expect(sources.join('\n')).toContain('full_text_pdf = NULL')

  for (const source of sources) {
    expect(source).toContain('appendArticleReviewServingDeltas')
  }
})
