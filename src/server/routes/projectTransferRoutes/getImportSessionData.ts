import type {ProjectTransferImportPlanArtifact} from '../../services/projectTransfer/projectTransferAnalyze.ts'
import {isProjectTransferFailedCommitRetryCandidate} from '../../services/projectTransfer/projectTransferCommit.ts'
import {
  type ProjectTransferExecutionMode,
  type ProjectTransferImportCompletionPayload,
  type ProjectTransferPlanSummary,
  type ProjectTransferSessionResponse,
  validateProjectTransferPlanReadyToCommit,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import type {ProjectTransferPerformanceMetrics} from '../../services/projectTransfer/projectTransferPerformanceMetrics.ts'
import type {ProjectTransferPackageWarning} from '../../services/projectTransfer/projectTransferSchemas.ts'
import {getUploadMetadataFromProgress} from './getUploadMetadataFromProgress.ts'
import {isRecord} from './projectTransferRequestBody.ts'
import type {ProjectTransferImportSessionData} from './projectTransferRouteTypes.ts'

const getImportSessionUrls = (sessionId: string) => {
  const sessionUrl = `/api/projects/import/${sessionId}`

  return {
    analyzeUrl: `${sessionUrl}/analyze`,
    cancelUrl: sessionUrl,
    commitUrl: `${sessionUrl}/commit`,
    resolveDependenciesUrl: `${sessionUrl}/resolve-dependencies`,
    sessionUrl,
    uploadUrl: `${sessionUrl}/upload`,
  }
}

const getImportSessionBlockers = (planSummary: ProjectTransferPlanSummary | null) => {
  return planSummary?.blockers && planSummary.blockers.length > 0
    ? planSummary.blockers.map((blocker) => {
        return blocker.message
      })
    : planSummary === null || planSummary.blockerCount === 0
      ? []
      : [`${planSummary.blockerCount} import plan blocker(s) require resolution`]
}

const getImportSessionWarnings = (planSummary: ProjectTransferPlanSummary | null) => {
  return planSummary?.packageWarnings && planSummary.packageWarnings.length > 0
    ? planSummary.packageWarnings.map((warning) => {
        return warning.message
      })
    : planSummary === null || planSummary.warningCount === 0
      ? []
      : [`${planSummary.warningCount} import plan warning(s) require review`]
}

const canCommitImportSession = (response: ProjectTransferSessionResponse, failedCommitArtifactsAvailable = false) => {
  const isReadyToCommit =
    response.state === 'ready_to_commit' && validateProjectTransferPlanReadyToCommit(response.planSummary).ok

  return isReadyToCommit || (failedCommitArtifactsAvailable && isProjectTransferFailedCommitRetryCandidate(response))
}

export const getImportSessionData = (
  response: ProjectTransferSessionResponse,
  plan: ProjectTransferImportPlanArtifact | null,
  executionMode?: ProjectTransferExecutionMode,
  failedCommitArtifactsAvailable = false,
): ProjectTransferImportSessionData => {
  const completion = compactImportCompletionForApi(response.completion)
  const progress = compactImportProgressForApi(response.progress)

  return {
    ...response,
    completion,
    progress,
    ...getImportSessionUrls(response.id),
    blockers: getImportSessionBlockers(response.planSummary),
    canCommit: canCommitImportSession(response, failedCommitArtifactsAvailable),
    duplicatePackageWarnings: [],
    executionMode,
    overlapCounts: response.planSummary?.overlapCounts ?? null,
    plan,
    upload: getUploadMetadataFromProgress(response.progress),
    warnings: getImportSessionWarnings(response.planSummary),
  }
}

const maxImportCompletionWarningsInStatusResponse = 200
const compactImportWarningDetailKeys = [
  'dependencyReason',
  'field',
  'omittedParentRef',
  'reason',
  'sourceRowId',
  'triggeringField',
] as const

const getCompactWarningDetails = (details: unknown) => {
  if (!isRecord(details)) {
    return details
  }

  const compactDetails = compactImportWarningDetailKeys.reduce<Record<string, unknown>>((compact, key) => {
    const value = details[key]

    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? {...compact, [key]: value}
      : compact
  }, {})

  return Object.keys(compactDetails).length > 0 ? compactDetails : undefined
}

const compactImportWarningForApi = (warning: ProjectTransferPackageWarning): ProjectTransferPackageWarning => {
  const details = getCompactWarningDetails(warning.details)

  return details === undefined ? {...warning, details: undefined} : {...warning, details}
}

const compactImportProgressPerformanceMetricsForApi = (
  performanceMetrics: ProjectTransferPerformanceMetrics | undefined,
): ProjectTransferPerformanceMetrics | undefined => {
  return performanceMetrics === undefined
    ? undefined
    : {
        ...performanceMetrics,
        benchmark: {...performanceMetrics.benchmark, warningDetails: []},
        warnings: {...performanceMetrics.warnings, details: []},
      }
}

const compactImportProgressForApi = (
  progress: ProjectTransferSessionResponse['progress'],
): ProjectTransferSessionResponse['progress'] => {
  return progress === null
    ? null
    : {...progress, performanceMetrics: compactImportProgressPerformanceMetricsForApi(progress.performanceMetrics)}
}

const getWarningCodeCounts = (warnings: readonly unknown[]) => {
  return warnings.reduce<Record<string, number>>((counts, warning) => {
    const code =
      typeof warning === 'object' && warning !== null && 'code' in warning && typeof warning.code === 'string'
        ? warning.code
        : 'unknown'

    counts[code] = (counts[code] ?? 0) + 1

    return counts
  }, {})
}

const compactImportCompletionForApi = (
  completion: ProjectTransferSessionResponse['completion'],
): ProjectTransferSessionResponse['completion'] => {
  if (completion?.status !== 'completed') {
    return completion
  }

  const importWarnings = completion.importWarnings ?? []

  if (importWarnings.length <= maxImportCompletionWarningsInStatusResponse) {
    return {...completion, importWarnings: importWarnings.map(compactImportWarningForApi)}
  }

  const omittedWarningCount = importWarnings.length - maxImportCompletionWarningsInStatusResponse
  const compactCompletion: ProjectTransferImportCompletionPayload = {
    ...completion,
    importWarnings: [
      ...importWarnings.slice(0, maxImportCompletionWarningsInStatusResponse).map(compactImportWarningForApi),
      {
        action: 'summarized',
        code: 'postImportWarningsTruncated',
        details: {
          codeCounts: getWarningCodeCounts(importWarnings),
          includedWarningCount: maxImportCompletionWarningsInStatusResponse,
          omittedWarningCount,
          totalWarningCount: importWarnings.length,
        },
        message: `${omittedWarningCount.toLocaleString('en-US')} additional post-import warning(s) were omitted from this status response.`,
        scope: 'projectTransfer.importWarnings',
        severity: 'warning',
      },
    ],
  }

  return compactCompletion
}
