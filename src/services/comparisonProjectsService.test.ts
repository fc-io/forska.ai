import {afterAll, afterEach, expect, mock, test} from 'bun:test'

let fetchResponse = new Response(JSON.stringify({data: {source: {}}}), {status: 200})

const originalFetch = globalThis.fetch
const fetchMock = mock(async () => {
  return fetchResponse
})

globalThis.fetch = fetchMock as unknown as typeof fetch

const {analyzeComparisonProjectConflictResolutionPdfImport} = await import('./comparisonProjectsService.ts')

const getThrownError = async (run: () => Promise<unknown>) => {
  return run().catch((error: unknown) => {
    return error instanceof Error ? error : new Error(String(error))
  })
}

afterEach(() => {
  fetchResponse = new Response(JSON.stringify({data: {source: {}}}), {status: 200})
  fetchMock.mockClear()
})

test('PDF conflict-resolution import surfaces plain-text server errors', async () => {
  fetchResponse = new Response('The selected PDF has no fillable form fields. It may have been flattened or printed.', {
    status: 400,
  })

  const error = await getThrownError(() => {
    return analyzeComparisonProjectConflictResolutionPdfImport('comparison-project-1', {
      file: new File(['not a pdf'], 'flattened.pdf', {type: 'application/pdf'}),
    })
  })

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('no fillable form fields')
  expect((error as Error).message).not.toBe('No data returned')
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
