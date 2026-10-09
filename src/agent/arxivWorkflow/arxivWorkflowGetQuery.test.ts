import {afterEach, beforeEach, expect, test} from 'bun:test'

import {arxivWorkflowGetQuery} from './arxivWorkflowGetQuery.ts'

const originalTimeZone = process.env.TZ

beforeEach(() => {
  process.env.TZ = 'America/Los_Angeles'
})

afterEach(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = originalTimeZone
  }
})

test('the OAI-PMH from and until dates match the harvest window regardless of the process time zone', () => {
  const url = new URL(
    arxivWorkflowGetQuery({fromDate: '2026-09-01', importRoute: '/api/datasources/import/arxiv', toDate: '2026-09-30'}),
  )

  expect(url.searchParams.get('from')).toBe('2026-09-01')
  expect(url.searchParams.get('until')).toBe('2026-09-30')
})

test('a resumption token replaces the date window', () => {
  const url = new URL(
    arxivWorkflowGetQuery(
      {fromDate: '2026-09-01', importRoute: '/api/datasources/import/arxiv', toDate: '2026-09-30'},
      'token-1',
    ),
  )

  expect(url.searchParams.get('resumptionToken')).toBe('token-1')
  expect(url.searchParams.get('from')).toBeNull()
})
