import {afterEach, beforeEach, expect, test} from 'bun:test'

import {pubmedHarvestGetIdParams} from './pubmedHarvestGetIdParams.ts'

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

test('the date window is passed through unchanged regardless of the process time zone', () => {
  const idParams = pubmedHarvestGetIdParams({
    fromDate: '2026-09-01',
    importRoute: '/api/datasources/import/pubmed',
    toDate: '2026-09-30',
  })

  expect(idParams.searchParams.mindate).toBe('2026/09/01')
  expect(idParams.searchParams.maxdate).toBe('2026/09/30')
})
