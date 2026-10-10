import {afterAll, afterEach, expect, mock, test} from 'bun:test'

let fetchResponse = new Response(JSON.stringify({data: {source: {}}}), {status: 200})

const originalFetch = globalThis.fetch
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
  return fetchResponse
})

globalThis.fetch = fetchMock as unknown as typeof fetch

const {
  analyzeComparisonProjectConflictResolutionPdfImport,
  fetchComparisonProjectJudgmentsCount,
  fetchComparisonProjectJudgmentsPage,
  fetchComparisonProjectStats,
  setComparisonProjectConflictResolutionComment,
} = await import('./comparisonProjectsService.ts')

const getJsonResponse = (data: unknown) => {
  return new Response(JSON.stringify({data}), {headers: {'Content-Type': 'application/json'}, status: 200})
}

const getFetchCall = () => {
  const [input, init] = fetchMock.mock.calls.at(-1) ?? []
  const url = input instanceof Request ? input.url : String(input)
  const body = input instanceof Request ? null : init?.body

  return {body: typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : null, url: new URL(url)}
}

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

test('judgments page and count requests carry the resolution prompt filter', async () => {
  fetchResponse = getJsonResponse({data: [], nextCursor: null})
  await fetchComparisonProjectJudgmentsPage('comparison-project-1', 50, [], [], [], ['yes'], 'metformin', 'cursor-1', [
    'outdated',
    'unknown',
  ])
  const pageCall = getFetchCall()

  fetchResponse = getJsonResponse({totalCount: 3})
  await fetchComparisonProjectJudgmentsCount('comparison-project-1', 50, [], [], [], ['yes'], '', ['current'])
  const countCall = getFetchCall()

  expect(pageCall.url.pathname).toBe('/api/comparison-projects/comparison-project-1/judgments')
  expect(pageCall.body).toMatchObject({
    conflictResolutionFilter: ['yes'],
    conflictResolutionProvenanceFilter: ['outdated', 'unknown'],
    cursor: 'cursor-1',
    search: 'metformin',
  })
  expect(countCall.url.pathname).toBe('/api/comparison-projects/comparison-project-1/judgments/count')
  expect(countCall.body).toMatchObject({
    conflictResolutionFilter: ['yes'],
    conflictResolutionProvenanceFilter: ['current'],
  })
})

test('stats requests send the provenance scope only for the current-prompts scope', async () => {
  fetchResponse = getJsonResponse({comparisons: []})
  await fetchComparisonProjectStats('comparison-project-1', 'current')
  const currentCall = getFetchCall()

  fetchResponse = getJsonResponse({comparisons: []})
  await fetchComparisonProjectStats('comparison-project-1')
  const allCall = getFetchCall()

  expect(currentCall.url.pathname).toBe('/api/comparison-projects/comparison-project-1/stats')
  expect(currentCall.url.searchParams.get('conflictResolutionProvenance')).toBe('current')
  expect(allCall.url.pathname).toBe('/api/comparison-projects/comparison-project-1/stats')
  expect(allCall.url.searchParams.has('conflictResolutionProvenance')).toBe(false)
})

test('resolution comment requests post the article and the comment, null to remove it', async () => {
  const savedResolution = {
    articleId: 'article-1',
    comment: 'Checked the full text',
    commentUpdatedAt: '2026-10-10T12:00:00.000Z',
    label: 'Yes',
    provenance: null,
    provenanceMatchesCurrent: null,
    reviewer: null,
    reviewerDisplayName: null,
    reviewerUserId: null,
    setAt: '2026-10-10T11:00:00.000Z',
    value: 'yes',
  }

  fetchResponse = getJsonResponse(savedResolution)
  const saved = await setComparisonProjectConflictResolutionComment('comparison-project-1', {
    articleId: 'article-1',
    comment: 'Checked the full text',
  })
  const saveCall = getFetchCall()

  fetchResponse = getJsonResponse({...savedResolution, comment: null})
  await setComparisonProjectConflictResolutionComment('comparison-project-1', {articleId: 'article-1', comment: null})
  const removeCall = getFetchCall()

  expect(saved).toEqual({
    ...savedResolution,
    commentUpdatedAt: new Date('2026-10-10T12:00:00.000Z'),
    setAt: new Date('2026-10-10T11:00:00.000Z'),
  })
  expect(saveCall.url.pathname).toBe('/api/comparison-projects/comparison-project-1/conflict-resolution/comment')
  expect(saveCall.body).toEqual({articleId: 'article-1', comment: 'Checked the full text'})
  expect(removeCall.url.pathname).toBe('/api/comparison-projects/comparison-project-1/conflict-resolution/comment')
  expect(removeCall.body).toEqual({articleId: 'article-1', comment: null})
})

test('resolution comment requests surface server errors', async () => {
  fetchResponse = new Response(
    JSON.stringify({data: null, error: 'Set a conflict resolution before commenting on it'}),
    {headers: {'Content-Type': 'application/json'}, status: 400},
  )

  const error = await getThrownError(() => {
    return setComparisonProjectConflictResolutionComment('comparison-project-1', {articleId: 'article-1', comment: 'x'})
  })

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('Set a conflict resolution before commenting on it')
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
