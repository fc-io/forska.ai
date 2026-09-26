import {expect, test} from 'bun:test'

import type {
  DataSourceImportResumeCandidate,
  DataSourceImportTrigger,
} from '../../services/dataSourceImportStateRepository.ts'
import {HttpError} from '../../utils/httpError.ts'
import {runDataSourceImportResumerWake} from './dataSourceImportResumer.ts'

const now = new Date('2026-09-26T12:00:00.000Z')

const createRepository = (candidates: DataSourceImportResumeCandidate[]) => {
  const calls: string[] = []

  return {
    calls,
    repository: {
      listResumeCandidates: async () => {
        return candidates
      },
      markRunFailed: async (input: {dataSourceId: string; error: unknown}) => {
        calls.push(`failed:${input.dataSourceId}:${input.error instanceof Error ? input.error.message : ''}`)
        return null
      },
      markRunStopped: async (input: {dataSourceId: string; error: string}) => {
        calls.push(`stopped:${input.dataSourceId}`)
      },
    },
  }
}

const runningCandidate = (dataSourceId: string, consecutiveFailureCount = 0): DataSourceImportResumeCandidate => {
  return {consecutiveFailureCount, dataSourceId, importRoute: '/api/datasources/import/pubmed', status: 'running'}
}

test('an import left running by a previous process is resumed once and not again while it runs here', async () => {
  const running = new Set<string>()
  const started: Array<{dataSourceId: string; trigger: DataSourceImportTrigger}> = []
  const {repository} = createRepository([runningCandidate('source-a')])
  const startImport = async (candidate: DataSourceImportResumeCandidate, trigger: DataSourceImportTrigger) => {
    running.add(candidate.dataSourceId)
    started.push({dataSourceId: candidate.dataSourceId, trigger})
  }
  const isImportRunning = (dataSourceId: string) => {
    return running.has(dataSourceId)
  }

  const first = await runDataSourceImportResumerWake({isImportRunning, now, repository, startImport})
  const second = await runDataSourceImportResumerWake({isImportRunning, now, repository, startImport})

  expect(first).toEqual({
    attempts: [{dataSourceId: 'source-a', outcome: 'started', trigger: 'auto_resume'}],
    stopped: [],
  })
  expect(second).toEqual({attempts: [], stopped: []})
  expect(started).toEqual([{dataSourceId: 'source-a', trigger: 'auto_resume'}])
})

test('a due failed import is retried with the auto_retry trigger', async () => {
  const started: DataSourceImportTrigger[] = []
  const {repository} = createRepository([
    {
      consecutiveFailureCount: 2,
      dataSourceId: 'source-b',
      importRoute: '/api/datasources/import/europe-pmc-ppr',
      status: 'failed',
    },
  ])

  const result = await runDataSourceImportResumerWake({
    isImportRunning: () => {
      return false
    },
    now,
    repository,
    startImport: async (_candidate, trigger) => {
      started.push(trigger)
    },
  })

  expect(result.attempts).toEqual([{dataSourceId: 'source-b', outcome: 'started', trigger: 'auto_retry'}])
  expect(started).toEqual(['auto_retry'])
})

test('one import is resumed per wake, and a held guard or tracking lease moves on to the next source', async () => {
  const started: string[] = []
  const {calls, repository} = createRepository([
    runningCandidate('source-leased'),
    runningCandidate('source-c'),
    runningCandidate('source-d'),
  ])

  const result = await runDataSourceImportResumerWake({
    isImportRunning: () => {
      return false
    },
    now,
    repository,
    startImport: async (candidate) => {
      if (candidate.dataSourceId === 'source-leased') {
        throw new HttpError(409, 'Data source tracking import is already running')
      }
      started.push(candidate.dataSourceId)
    },
  })

  expect(result.attempts).toEqual([
    {dataSourceId: 'source-leased', outcome: 'skipped', reason: 'Data source tracking import is already running'},
    {dataSourceId: 'source-c', outcome: 'started', trigger: 'auto_resume'},
  ])
  expect(started).toEqual(['source-c'])
  expect(calls).toEqual([])
})

test('a resume that fails to start is recorded as a failure and ends the wake', async () => {
  const {calls, repository} = createRepository([runningCandidate('source-e'), runningCandidate('source-f')])

  const result = await runDataSourceImportResumerWake({
    isImportRunning: () => {
      return false
    },
    now,
    repository,
    startImport: async () => {
      throw new Error('DuckDB connection not started')
    },
  })

  expect(result.attempts).toEqual([
    {dataSourceId: 'source-e', error: 'DuckDB connection not started', outcome: 'failed'},
  ])
  expect(calls).toEqual(['failed:source-e:DuckDB connection not started'])
})

test('an import interrupted five times without progress is stopped instead of resumed', async () => {
  const started: string[] = []
  const {calls, repository} = createRepository([runningCandidate('source-g', 5), runningCandidate('source-h', 4)])

  const result = await runDataSourceImportResumerWake({
    isImportRunning: () => {
      return false
    },
    now,
    repository,
    startImport: async (candidate) => {
      started.push(candidate.dataSourceId)
    },
  })

  expect(result.stopped).toEqual(['source-g'])
  expect(calls).toEqual(['stopped:source-g'])
  expect(started).toEqual(['source-h'])
})
