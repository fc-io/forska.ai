import {
  getJudgmentJobProviderClaimGate,
  getJudgmentJobProviderHealth,
  markJudgmentJobProviderProbeClaimed,
} from '../../../services/judgmentJobProviderHealthService.ts'
import {providerHealthLogger, providerHealthLogWindowMs} from '../providerHealthLogger.ts'

type ProviderClaimGate = Awaited<ReturnType<typeof getJudgmentJobProviderClaimGate>>
const providerClaimGateLoggedAt = new Map<string, number>()
const openProviderClaimGate: ProviderClaimGate = {backoffUntil: null, claimsAllowed: true, maxClaims: null}

export const getOwnerProviderClaimGate = async (jobId: string): Promise<ProviderClaimGate> => {
  return getJudgmentJobProviderClaimGate(jobId).catch((error: unknown) => {
    providerHealthLogger.warn(
      `judgmentsJobs.providerHealth.claimGateFailed.${jobId}`,
      '[judgmentsJobs] provider claim gate lookup failed, claims allowed',
      {
        component: 'JudgmentsJobsRoutes',
        error: error instanceof Error ? error.message : String(error),
        event: 'providerClaimGateFailed',
        jobId,
      },
    )
    return openProviderClaimGate
  })
}

export const getProviderGatedClaimLimit = (limit: number, providerClaimGate: ProviderClaimGate): number => {
  return providerClaimGate.maxClaims === null ? limit : Math.min(limit, providerClaimGate.maxClaims)
}

export const markOwnerProviderProbeClaimed = ({
  claimedCount,
  jobId,
  providerClaimGate,
}: {
  claimedCount: number
  jobId: string
  providerClaimGate: ProviderClaimGate
}): void => {
  if (providerClaimGate.maxClaims === null || claimedCount === 0) {
    return undefined
  }

  try {
    markJudgmentJobProviderProbeClaimed(jobId)
  } catch (error) {
    providerHealthLogger.warn(
      `judgmentsJobs.providerHealth.probeClaimMarkFailed.${jobId}`,
      '[judgmentsJobs] provider probe claim could not be recorded',
      {
        component: 'JudgmentsJobsRoutes',
        error: error instanceof Error ? error.message : String(error),
        event: 'providerProbeClaimMarkFailed',
        jobId,
      },
    )
  }
}

const shouldLogProviderClaimGate = (jobId: string): boolean => {
  const now = Date.now()
  const shouldLog = now - (providerClaimGateLoggedAt.get(jobId) ?? 0) >= providerHealthLogWindowMs

  if (shouldLog) {
    providerClaimGateLoggedAt.set(jobId, now)
  }

  return shouldLog
}

export const logProviderClaimGate = async (jobId: string, providerClaimGate: ProviderClaimGate): Promise<void> => {
  if (!shouldLogProviderClaimGate(jobId)) {
    return undefined
  }

  const providerHealth = await getJudgmentJobProviderHealth(jobId).catch(() => {
    return null
  })

  providerHealthLogger.log(
    `judgmentsJobs.providerHealth.claimGated.${jobId}`,
    '[judgmentsJobs] claims held back while the LLM provider is failing',
    {
      backoffUntil: providerClaimGate.backoffUntil?.toISOString() ?? null,
      component: 'JudgmentsJobsRoutes',
      consecutiveFailureCount: providerHealth?.consecutiveFailureCount ?? null,
      event: 'providerClaimGated',
      failureKind: providerHealth?.failureKind ?? null,
      jobId,
    },
  )
}

export const logModelContextWindowClaimGate = (jobId: string, message: string): void => {
  providerHealthLogger.warn(
    `judgmentsJobs.modelContextWindow.claimGated.${jobId}`,
    `[judgmentsJobs] claims held back: ${message}`,
    {component: 'JudgmentsJobsRoutes', event: 'modelContextWindowClaimGated', jobId},
  )
}

export const logFullTextClaimGate = (jobId: string, message: string): void => {
  providerHealthLogger.warn(
    `judgmentsJobs.fullText.claimGated.${jobId}`,
    `[judgmentsJobs] claims held back: ${message}`,
    {component: 'JudgmentsJobsRoutes', event: 'fullTextClaimGated', jobId},
  )
}
