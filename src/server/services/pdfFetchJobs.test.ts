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
