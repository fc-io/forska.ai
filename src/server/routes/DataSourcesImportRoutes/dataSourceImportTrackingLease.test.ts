import {expect, test} from 'bun:test'

import type {DataSourceRecord} from '../../../db/schemaTypes.ts'
import {withDataSourceImportTrackingLease} from './dataSourceImportTrackingLease.ts'

const getDataSource = (overrides: Partial<DataSourceRecord> = {}): DataSourceRecord => {
  return {
    archived: false,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    cursor: null,
    dateFrom: new Date('2026-09-01T00:00:00.000Z'),
    dateTo: null,
    description: null,
    id: 'source-1',
    importRoute: '/api/datasources/import/pubmed',
    itemsAfterLastImport: 0,
    lastImportAt: null,
    title: 'Tracked PubMed',
    trackingEnabled: true,
    trackingReconcileScheduleMonths: [3, 12],
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

test('manual datasource import wrapper claims, renews, and releases the tracking lease', async () => {
  const calls: string[] = []
  let claimOwner: string | null = null
  const result = await withDataSourceImportTrackingLease(
    getDataSource(),
    async ({assertLeaseOwned}) => {
      calls.push('operation:start')
      await assertLeaseOwned()
      calls.push('operation:end')

      return 'ok'
    },
    {
      trackingRepository: {
        claimImportLease: async (input: {leaseOwner: string}) => {
          claimOwner = input.leaseOwner
          calls.push('lease:claim')
          return {leaseOwner: input.leaseOwner}
        },
        releaseSourceLease: async (input: {leaseOwner: string}) => {
          calls.push(`lease:release:${input.leaseOwner === claimOwner}`)
          return null
        },
        renewSourceLease: async (input: {leaseOwner: string}) => {
          calls.push(`lease:renew:${input.leaseOwner === claimOwner}`)
          return {leaseOwner: input.leaseOwner}
        },
      } as never,
    },
  )

  expect(result).toBe('ok')
  expect(calls).toEqual([
    'lease:claim',
    'operation:start',
    'lease:renew:true',
    'operation:end',
    'lease:renew:true',
    'lease:release:true',
  ])
})

test('manual datasource import wrapper skips tracking lease for untracked sources', async () => {
  const result = await withDataSourceImportTrackingLease(
    getDataSource({trackingEnabled: false}),
    async ({assertLeaseOwned}) => {
      await assertLeaseOwned()

      return 'untracked-ok'
    },
    {
      trackingRepository: {
        claimImportLease: async () => {
          throw new Error('untracked imports should not claim tracking lease')
        },
      } as never,
    },
  )

  expect(result).toBe('untracked-ok')
})
