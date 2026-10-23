import {providerHealthLogger} from './providerHealthLogger.ts'

export const logProviderHealthWriteFailure = (jobId: string, error: unknown): null => {
  providerHealthLogger.warn(
    `judgmentsJobs.providerHealth.writeFailed.${jobId}`,
    '[judgmentsJobs] provider health write failed',
    {
      component: 'JudgmentsJobsRoutes',
      error: error instanceof Error ? error.message : String(error),
      event: 'providerHealthWriteFailed',
      jobId,
    },
  )

  return null
}
