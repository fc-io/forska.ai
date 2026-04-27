import {afterEach, expect, mock, test} from 'bun:test'

const apiClientModulePath = new URL('./apiClient.ts', import.meta.url).pathname

let fetchProjectsResponse: {data?: unknown; error?: unknown; status?: number} = {data: {data: []}}
let fetchArchivedProjectsResponse: {data?: unknown; error?: unknown; status?: number} = {data: {data: []}}

void mock.module(apiClientModulePath, () => {
  return {
    apiClient: {
      api: {
        projects: {
          archived: {
            get: async () => {
              return fetchArchivedProjectsResponse
            },
          },
          get: async () => {
            return fetchProjectsResponse
          },
        },
      },
    },
  }
})

const {fetchArchivedProjects, fetchProjects} = require('./projectsService.ts') as typeof import('./projectsService.ts')

const buildProjectRow = (overrides: Record<string, unknown> = {}) => {
  return {
    archived: false,
    createdAt: '2026-04-26T00:00:00.000Z',
    dateFrom: null,
    dateTo: null,
    description: null,
    humanJudgmentMode: null,
    id: 'project-1',
    modelId: 'model-1',
    modelName: 'Qwen 122B',
    modelProvider: 'sglang',
    modelVersion: null,
    name: 'Project 1',
    updatedAt: '2026-04-26T00:00:00.000Z',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
    ...overrides,
  }
}

const getThrownError = async (run: () => Promise<unknown>) => {
  return run().catch((error: unknown) => {
    return error instanceof Error ? error : new Error(String(error))
  })
}

afterEach(() => {
  fetchProjectsResponse = {data: {data: []}}
  fetchArchivedProjectsResponse = {data: {data: []}}
})

test('fetchProjects returns projects from nested response data', async () => {
  fetchProjectsResponse = {data: {data: [buildProjectRow()], error: null}}

  expect(await fetchProjects()).toEqual([buildProjectRow()])
})

test('fetchProjects rejects plain-text responses instead of treating them as iterable project data', async () => {
  fetchProjectsResponse = {data: 'ENOENT: no such file or directory'}
  const error = await getThrownError(fetchProjects)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('ENOENT: no such file or directory')
})

test('fetchProjects rejects invalid project list rows with missing names', async () => {
  fetchProjectsResponse = {data: {data: [buildProjectRow({name: undefined})], error: null}}
  const error = await getThrownError(fetchProjects)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('invalid project list response')
})

test('fetchProjects surfaces nested API errors instead of treating them as an empty list', async () => {
  fetchProjectsResponse = {data: {data: null, error: 'DuckDB owner proxy target unavailable'}}
  const error = await getThrownError(fetchProjects)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('DuckDB owner proxy target unavailable')
})

test('fetchArchivedProjects surfaces nested API errors instead of treating them as an empty list', async () => {
  fetchArchivedProjectsResponse = {data: {data: null, error: 'DuckDB owner proxy target unavailable'}}
  const error = await getThrownError(fetchArchivedProjects)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('DuckDB owner proxy target unavailable')
})
