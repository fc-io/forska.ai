import {
  getJudgmentJobProviderHealth,
  getJudgmentJobProviderHealthMap,
  type JudgmentJobProviderHealth,
} from '../../services/judgmentJobProviderHealthService.ts'
import {providerHealthLogger} from './providerHealthLogger.ts'

type JudgmentJobMutationQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

const logProviderHealthReadFailure = (error: unknown) => {
  providerHealthLogger.warn('judgmentsJobs.providerHealth.readFailed', '[judgmentsJobs] provider health read failed', {
    component: 'JudgmentsJobsRoutes',
    error: error instanceof Error ? error.message : String(error),
    event: 'providerHealthReadFailed',
  })
}

export const getProviderHealthMapForReadableRoute = async ({
  db,
  jobIds,
}: {
  db: JudgmentJobMutationQueryRunner
  jobIds: string[]
}): Promise<Map<string, JudgmentJobProviderHealth>> => {
  return getJudgmentJobProviderHealthMap(jobIds, {database: db}).catch((error: unknown) => {
    logProviderHealthReadFailure(error)
    return new Map<string, JudgmentJobProviderHealth>()
  })
}

export const getProviderHealthForReadableRoute = async ({
  db,
  jobId,
}: {
  db: JudgmentJobMutationQueryRunner
  jobId: string
}): Promise<JudgmentJobProviderHealth | null> => {
  return getJudgmentJobProviderHealth(jobId, {database: db}).catch((error: unknown) => {
    logProviderHealthReadFailure(error)
    return null
  })
}
