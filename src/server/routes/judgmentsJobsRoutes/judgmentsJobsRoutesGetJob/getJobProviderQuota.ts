import {
  getLatestProviderQuotaReadings,
  getProviderQuotaHeadlines,
  type ProviderQuotaHeadline,
} from '../../../services/providerQuotaReadingService.ts'
import {providerHealthLogger} from '../providerHealthLogger.ts'

export type JobProviderQuota = {headlines: ProviderQuotaHeadline[]; providerConnectionId: string; providerKind: string}

type JobProviderQuotaConnection = {id: string; providerKind: string} | null

type JobProviderQuotaReader = {queryJson: <T>(statement: string) => Promise<T[]>}

const quotaPolledProviderKinds = new Set(['claude-code', 'codex'])

const getPolledConnection = (connection: JobProviderQuotaConnection) => {
  return connection && quotaPolledProviderKinds.has(connection.providerKind) ? connection : null
}

const readJobProviderQuota = async (
  connection: {id: string; providerKind: string},
  db: JobProviderQuotaReader,
): Promise<JobProviderQuota | null> => {
  const readings = await getLatestProviderQuotaReadings({providerConnectionId: connection.id, reader: db})

  return {
    headlines: getProviderQuotaHeadlines(readings),
    providerConnectionId: connection.id,
    providerKind: connection.providerKind,
  }
}

export const getJobProviderQuota = async ({
  connection,
  db,
}: {
  connection: JobProviderQuotaConnection
  db: JobProviderQuotaReader
}): Promise<JobProviderQuota | null> => {
  const polledConnection = getPolledConnection(connection)

  return polledConnection
    ? readJobProviderQuota(polledConnection, db).catch((error: unknown) => {
        providerHealthLogger.warn(
          'judgmentsJobs.providerQuota.readFailed',
          '[judgmentsJobs] provider quota read failed',
          {
            component: 'JudgmentsJobsRoutes',
            error: error instanceof Error ? error.message : String(error),
            event: 'providerQuotaReadFailed',
          },
        )
        return null
      })
    : null
}
