import {randomUUID} from 'node:crypto'

import type {DataSourceRecord} from '../../../db/schemaTypes.ts'
import {createDataSourceTrackingRepository} from '../../services/dataSourceTrackingRepository.ts'

type DataSourceTrackingRepository = ReturnType<typeof createDataSourceTrackingRepository>

const manualImportLeaseMs = 10 * 60 * 1000

const getManualImportLeaseRenewalIntervalMs = () => {
  return Math.max(1000, Math.floor(manualImportLeaseMs / 2))
}

export const withDataSourceImportTrackingLease = async <T>(
  dataSource: DataSourceRecord,
  operation: (controls: {assertLeaseOwned: () => Promise<void>}) => Promise<T>,
  input: {trackingRepository?: DataSourceTrackingRepository} = {},
): Promise<T> => {
  if (!dataSource.trackingEnabled) {
    return await operation({
      assertLeaseOwned: async () => {
        return undefined
      },
    })
  }

  const trackingRepository = input.trackingRepository ?? createDataSourceTrackingRepository()
  const leaseOwner = `manual-data-source-import:${process.pid}:${randomUUID()}`
  let leaseLostError: Error | null = null
  const renewLease = async () => {
    if (leaseLostError) {
      throw leaseLostError
    }

    const now = new Date()
    const renewed = await trackingRepository.renewSourceLease({
      dataSourceId: dataSource.id,
      leaseExpiresAt: new Date(now.getTime() + manualImportLeaseMs),
      leaseOwner,
      now,
    })

    if (!renewed) {
      leaseLostError = new Error('Data source import lease was lost')
      throw leaseLostError
    }
  }
  const assertLeaseOwned = async () => {
    await renewLease()
  }
  const now = new Date()
  const claim = await trackingRepository.claimImportLease({
    dataSourceId: dataSource.id,
    leaseExpiresAt: new Date(now.getTime() + manualImportLeaseMs),
    leaseOwner,
    now,
  })

  if (!claim) {
    throw new Error('Data source tracking import is already running')
  }

  const timer = setInterval(() => {
    void renewLease().catch((error) => {
      leaseLostError ??= error instanceof Error ? error : new Error(String(error))
    })
  }, getManualImportLeaseRenewalIntervalMs())
  const maybeUnrefTimer = timer as {unref?: () => void}

  maybeUnrefTimer.unref?.()

  try {
    const result = await operation({assertLeaseOwned})
    await assertLeaseOwned()

    return result
  } finally {
    clearInterval(timer)
    await trackingRepository.releaseSourceLease({dataSourceId: dataSource.id, leaseOwner, now: new Date()})
  }
}
