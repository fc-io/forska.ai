// @vitest-environment happy-dom

import {describe, expect, test} from 'vitest'

import type {DataSourceImportStatusView} from '../dataSourceImportStatus/dataSourceImportStatus.ts'
import {
  getCovidenceDataSourceIds,
  getProjectImportProgressRefetchInterval,
  getVisibleImportStatus,
  hasImportJustCompleted,
  projectImportProgressPollIntervalMs,
} from './projectDetailsImportProgress.tsx'

const createImportStatus = (status: DataSourceImportStatusView['status']): DataSourceImportStatusView => {
  return {
    completedAt: null,
    consecutiveFailureCount: 0,
    failedAt: null,
    fetchedCount: 500,
    lastError: null,
    lastProgressAt: '2026-10-01T15:00:00.000Z',
    nextRetryAt: null,
    progressFromStart: true,
    runStartedAt: '2026-10-01T14:59:00.000Z',
    runStartFetchedCount: 0,
    status,
    storedCount: 500,
    totalCount: 19251,
  }
}

describe('ProjectDetailsImportProgress helpers', () => {
  test('picks the Covidence data source ids out of the project import routes', () => {
    expect(
      getCovidenceDataSourceIds([
        'covidence:5cc79008',
        '/api/datasources/import/pubmed',
        'covidence:',
        'covidence:abc',
      ]),
    ).toEqual(['5cc79008', 'abc'])
    expect(getCovidenceDataSourceIds([])).toEqual([])
  })

  test('shows running, failed and interrupted imports and hides completed ones', () => {
    expect(getVisibleImportStatus(createImportStatus('running'))?.status).toBe('running')
    expect(getVisibleImportStatus(createImportStatus('failed'))?.status).toBe('failed')
    expect(getVisibleImportStatus(createImportStatus('interrupted'))?.status).toBe('interrupted')
    expect(getVisibleImportStatus(createImportStatus('completed'))).toBeNull()
    expect(getVisibleImportStatus(null)).toBeNull()
    expect(getVisibleImportStatus(undefined)).toBeNull()
  })

  test('polls only while the import is running', () => {
    expect(getProjectImportProgressRefetchInterval({importStatus: createImportStatus('running'), title: 'cov 6'})).toBe(
      projectImportProgressPollIntervalMs,
    )
    expect(
      getProjectImportProgressRefetchInterval({importStatus: createImportStatus('completed'), title: 'cov 6'}),
    ).toBe(false)
    expect(getProjectImportProgressRefetchInterval({importStatus: null, title: 'cov 6'})).toBe(false)
    expect(getProjectImportProgressRefetchInterval(undefined)).toBe(false)
  })

  test('detects the running to completed transition exactly once', () => {
    expect(hasImportJustCompleted('completed', 'running')).toBe(true)
    expect(hasImportJustCompleted('completed', 'completed')).toBe(false)
    expect(hasImportJustCompleted('completed', undefined)).toBe(false)
    expect(hasImportJustCompleted('failed', 'running')).toBe(false)
  })
})
