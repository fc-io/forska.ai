import {afterEach, beforeEach, expect, test} from 'bun:test'

import {getDataSourceImportDateWindow} from './dataSourcesImportDateWindow.ts'

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

test('date bounds stored as UTC midnight keep their calendar day in a negative-offset time zone', () => {
  const window = getDataSourceImportDateWindow(
    {dateFrom: new Date('2026-09-01T00:00:00.000Z'), dateTo: new Date('2026-09-30T00:00:00.000Z')},
    new Date('2026-10-09T18:00:00.000Z'),
  )

  expect(window).toEqual({fromDate: '2026-09-01', toDate: '2026-09-30'})
})

test('an end date in the future is capped at the current UTC day', () => {
  const window = getDataSourceImportDateWindow(
    {dateFrom: new Date('2026-09-01T00:00:00.000Z'), dateTo: new Date('2027-01-01T00:00:00.000Z')},
    new Date('2026-10-09T03:00:00.000Z'),
  )

  expect(window).toEqual({fromDate: '2026-09-01', toDate: '2026-10-09'})
})

test('missing bounds fall back to the default start and the current UTC day', () => {
  const window = getDataSourceImportDateWindow({dateFrom: null, dateTo: null}, new Date('2026-10-09T03:00:00.000Z'))

  expect(window).toEqual({fromDate: '2020-01-01', toDate: '2026-10-09'})
})
