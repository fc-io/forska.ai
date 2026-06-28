import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const sourcePath = new URL('./pdfFetchJobs.ts', import.meta.url)

test('PDF fetch jobs do not expose process-local job state', () => {
  const source = readFileSync(sourcePath, 'utf8')

  expect(source).not.toContain('new Map<string, PdfFetchJob>')
  expect(source).not.toContain('startPdfFetchJob')
  expect(source).not.toContain('getPdfFetchJob =')
  expect(source).toContain('getPdfFetchJobFromDatabase')
})

test('PDF fetch batch processing uses background workload context and appends deltas', () => {
  const source = readFileSync(sourcePath, 'utf8')

  expect(source).toContain("routeOrJobKey: 'review.pdf.selection'")
  expect(source).toContain("workloadClass: 'background.review.pdfFetch'")
  expect(source).toContain('queryJsonBackground')
  expect(source).toContain('runBackground')
  expect(source).toContain('maxResultRows: ids.length')
  expect(source).toContain('appendArticleReviewServingDeltas(tx')
  expect(source).toContain("changedFields: result?.fullTextPDF ? ['fullText', 'fullTextHtml', 'fullTextPDF'] : []")
})
