import type {
  ProjectTransferDirection,
  ProjectTransferSessionRecord,
  ProjectTransferSessionState,
} from '../../../db/schemaTypes.ts'
import {getJsonValue} from '../appQueryHelpers.ts'
import {
  projectTransferPathLimits,
  validateProjectTransferArchiveMemberPath,
  validateProjectTransferRuntimeAssetPath,
  validateProjectTransferTempWritablePath,
} from './projectTransferPaths.ts'
import type {ProjectTransferPerformanceMetrics} from './projectTransferPerformanceMetrics.ts'
import type {ProjectTransferPackageWarning, ProjectTransferPayloadKey} from './projectTransferSchemas.ts'

const projectTransferMiB = 1024 * 1024
const projectTransferGiB = 1024 * projectTransferMiB

export const projectTransferExecutionThresholds = {
  commitBackgroundArticleCount: 25_000,
  commitBackgroundExtractedAssetBytes: 2 * projectTransferGiB,
  commitBackgroundJudgmentCount: 250_000,
  commitBackgroundTotalRowCount: 50_000,
  exportInlineAssetBytes: 64 * projectTransferMiB,
  exportInlinePackageBytes: 128 * projectTransferMiB,
  importAnalyzeInlineExpandedBytes: 512 * projectTransferMiB,
  importAnalyzeInlineZipBytes: 128 * projectTransferMiB,
} as const

export const projectTransferResourceGateLimits = {
  maxArchiveInodeCount: 100_000,
  maxArchiveMemberCount: 100_000,
  maxDecompressionRatio: 100,
  maxExpandedArchiveBytes: 16 * projectTransferGiB,
  maxJsonDepth: 64,
  maxJsonMemberCount: 1_000_000,
  maxNdjsonLineBytes: 16 * projectTransferMiB,
  maxPathLength: projectTransferPathLimits.maxPathLength,
  maxPathSegmentLength: projectTransferPathLimits.maxPathSegmentLength,
  maxSingleFileBytes: 2 * projectTransferGiB,
  minimumDiskHeadroomRatio: 0.1,
  writableTempRoot: 'tmp/project-transfer',
} as const

export const projectTransferDependencyStatuses = [
  'ambiguous',
  'blocked',
  'missing',
  'not_required',
  'resolved',
] as const

export const projectTransferReadyDependencyStatuses = ['not_required', 'resolved'] as const

export const projectTransferJudgmentConflictStatuses = ['blocked', 'clear', 'unknown'] as const

export const projectTransferRawArticleProvenanceModes = ['include', 'omit'] as const

export const projectTransferOverlapSummaryKeys = [
  'reusedArticleCount',
  'newArticleCount',
  'reusedArticleUpdateCount',
  'reusedArticleFieldFillCount',
  'reusedArticleAssetPromotionCount',
  'reusedJudgmentCount',
  'dirtiedExistingProjectCount',
  'omittedRouteLinkCount',
  'omittedArticleRouteLinkCount',
  'routeArticleSnapshotLinkCount',
  'duplicateImportMatchCount',
  'storedSignatureJudgmentCount',
  'snapshotVerifiedJudgmentCount',
  'currentReviewRowsSignatureJudgmentCount',
  'storedSignatureHumanReviewCount',
  'currentReviewRowsSignatureHumanReviewCount',
] as const

export const projectTransferConflictCountKeys = [
  'packageContractConflictCount',
  'articleConflictCount',
  'projectPromptConflictCount',
  'judgmentConflictCount',
  'humanReviewFidelityConflictCount',
] as const

export const projectTransferWriterOnlyCleanupStates = ['cancelled', 'expired'] as const

export type ProjectTransferValidationResult = {ok: true} | {error: string; ok: false}

export type ProjectTransferProgressPhase =
  | 'analyze'
  | 'cleanup'
  | 'commit'
  | 'export_assembly'
  | 'export_package'
  | 'extract'
  | 'upload'

export type ProjectTransferProgressStatus = 'completed' | 'failed' | 'pending' | 'running'

export type ProjectTransferProgressPayload = {
  bytesProcessed?: number | null
  bytesTotal?: number | null
  completedBytes?: number | null
  completedItems?: number | null
  completedRows?: number | null
  expiresAt?: string | null
  message?: string | null
  percent?: number | null
  performanceMetrics?: ProjectTransferPerformanceMetrics
  phase: ProjectTransferProgressPhase
  planRevision?: number | null
  rowCountProcessed?: number | null
  rowCountTotal?: number | null
  startedAt?: string | null
  status: ProjectTransferProgressStatus
  totalBytes?: number | null
  totalItems?: number | null
  totalRows?: number | null
  updatedAt?: string | null
  uploadMetadata?: ProjectTransferUploadMetadataPayload | null
  warningCount?: number | null
}

export type ProjectTransferDependencyStatus = (typeof projectTransferDependencyStatuses)[number]

export type ProjectTransferOverlapSummaryKey = (typeof projectTransferOverlapSummaryKeys)[number]

export type ProjectTransferConflictCountKey = (typeof projectTransferConflictCountKeys)[number]
export type ProjectTransferJudgmentConflictStatus = (typeof projectTransferJudgmentConflictStatuses)[number]
export type ProjectTransferRawArticleProvenanceMode = (typeof projectTransferRawArticleProvenanceModes)[number]

export type ProjectTransferOverlapCounts = Record<ProjectTransferOverlapSummaryKey, number> & Record<string, number>

export type ProjectTransferConflictCounts = Record<ProjectTransferConflictCountKey, number> & Record<string, number>

export type ProjectTransferPlanBlockerResolutionKind = 'requires_new_package_or_target_changes' | 'wizard_resolvable'

export type ProjectTransferPlanBlocker = {
  code: string
  message: string
  resolutionKind: ProjectTransferPlanBlockerResolutionKind
  scope: string
}

export type ProjectTransferPlanSummary = {
  blockerCount: number
  blockers?: ProjectTransferPlanBlocker[]
  conflictCounts: ProjectTransferConflictCounts
  dependencyStatuses: Record<string, ProjectTransferDependencyStatus>
  judgmentConflictStatus?: ProjectTransferJudgmentConflictStatus
  overlapCounts: ProjectTransferOverlapCounts
  packageCounts?: Record<ProjectTransferPayloadKey, number>
  packageFingerprint?: string | null
  packageWarnings?: ProjectTransferPackageWarning[]
  warningCount: number
}

export type ProjectTransferImportCompletionPayload = {
  finalCounts?: Record<string, number>
  importWarnings?: unknown[]
  packageFingerprint?: string | null
  payloadCounts?: Record<string, number>
  projectId?: string | null
  projectName?: string | null
  status: 'completed'
  targetProjectId?: string | null
  targetProjectName?: string | null
  transferHistoryId?: string
}

export type ProjectTransferExportReadyPayload = {
  byteLength: number
  checksumSha256: string
  downloadUrl: string
  expiresAt: string
  filename: string
  packageFingerprint: string
  status: 'ready'
}

export type ProjectTransferCompletionPayload =
  | ProjectTransferExportReadyPayload
  | ProjectTransferImportCompletionPayload

export type ProjectTransferSessionResponse = {
  commitId: string | null
  completion: ProjectTransferCompletionPayload | null
  createdAt: Date
  direction: ProjectTransferDirection
  error: unknown
  expiresAt: Date
  heartbeatAt: Date | null
  id: string
  ownerToken: string | null
  packageFingerprint: string | null
  planRevision: number
  planSummary: ProjectTransferPlanSummary | null
  progress: ProjectTransferProgressPayload | null
  state: ProjectTransferSessionState
  updatedAt: Date
}

export type ProjectTransferUploadSession = {
  byteLength: number
  checksumSha256: string
  expiresAt: string
  fileName: string
  sessionUrl: string
  sessionId: string
  state: ProjectTransferSessionState
}

export type ProjectTransferUploadMetadataPayload = {byteLength: number; checksumSha256: string; fileName: string}

export type ProjectTransferSessionCreationRequest = {
  direction: ProjectTransferDirection
  expiresAt: string
  packageFingerprint?: string | null
  sessionId: string
}

export type ProjectTransferApiResponse<TData> = {data: TData; error: null} | {data: null; error: string}

export const getProjectTransferPlaceholderResponse = <TData = never>(
  endpoint: string,
): ProjectTransferApiResponse<TData> => {
  return {data: null, error: `Project transfer ${endpoint} endpoint is not implemented yet`}
}

export type ProjectTransferCancellationReason = 'cleanup_failed' | 'session_expired' | 'user_cancelled'

export type ProjectTransferCancellationRequest = {
  cleanupTempArtifacts: boolean
  expectedOwnerToken: string
  reason: ProjectTransferCancellationReason
  sessionId: string
}

export type ProjectTransferCancellationRule = {
  cleanupTempArtifacts: boolean
  requiresWriterOwnerToken: boolean
  state: (typeof projectTransferWriterOnlyCleanupStates)[number]
}

export type ProjectTransferAssetPromotionMetadata = {
  byteLength: number
  checksumSha256: string
  contentType?: string | null
  packagePath: string
  promotedPath: string
  sessionId: string
}

export type ProjectTransferRuntimeEventType =
  | 'cleanup_progress'
  | 'commit_progress'
  | 'export_progress'
  | 'plan_updated'
  | 'session_created'
  | 'state_transition'
  | 'upload_progress'

export type ProjectTransferRuntimeEvent = {
  bytesProcessed?: number | null
  bytesTotal?: number | null
  direction: ProjectTransferDirection
  eventId: string
  eventType: ProjectTransferRuntimeEventType
  message?: string | null
  ownerToken?: string | null
  phase?: ProjectTransferProgressPhase | null
  planRevision: number
  percent?: number | null
  rowCountProcessed?: number | null
  rowCountTotal?: number | null
  sessionId: string
  state: ProjectTransferSessionState
  status?: ProjectTransferProgressStatus | null
  timestamp: string
  warningCount?: number | null
}

export type ProjectTransferExecutionMode = 'background' | 'inline'

export type ProjectTransferExportThresholdInput = {assetBytes: number; packageBytes: number}

export type ProjectTransferImportAnalyzeThresholdInput = {expandedBytes: number; zipBytes: number}

export type ProjectTransferCommitThresholdInput = {
  articleCount: number
  extractedAssetBytes: number
  judgmentCount: number
}

export type ProjectTransferResourcePath = {kind: 'archive_member' | 'runtime_asset'; pathValue: string}

export type ProjectTransferResourceGateInput = {
  archiveInodeCount?: number | null
  archiveMemberCount?: number | null
  availableDiskBytes: number
  expandedBytes?: number | null
  fileBytes?: number | null
  jsonDepth?: number | null
  jsonMemberCount?: number | null
  ndjsonLineBytes?: number | null
  resourcePaths?: readonly ProjectTransferResourcePath[]
  targetWriteBytes: number
  tempRootPath: string
  usesStreamingParser: boolean
  zipBytes?: number | null
}

type ProjectTransferProgressCountField =
  | 'bytesProcessed'
  | 'bytesTotal'
  | 'completedBytes'
  | 'completedItems'
  | 'completedRows'
  | 'rowCountProcessed'
  | 'rowCountTotal'
  | 'totalBytes'
  | 'totalItems'
  | 'totalRows'
  | 'warningCount'

const projectTransferProgressCountFields = [
  'bytesProcessed',
  'bytesTotal',
  'completedBytes',
  'completedItems',
  'completedRows',
  'rowCountProcessed',
  'rowCountTotal',
  'totalBytes',
  'totalItems',
  'totalRows',
  'warningCount',
] as const satisfies readonly ProjectTransferProgressCountField[]

const projectTransferProgressPairs = [
  ['bytesProcessed', 'bytesTotal'],
  ['completedBytes', 'totalBytes'],
  ['completedItems', 'totalItems'],
  ['completedRows', 'totalRows'],
  ['rowCountProcessed', 'rowCountTotal'],
] as const

const projectTransferDependencyStatusSet = new Set<string>(projectTransferDependencyStatuses)
const projectTransferReadyDependencyStatusSet = new Set<string>(projectTransferReadyDependencyStatuses)

export const projectTransferCancellationRules = {
  cancelled: {cleanupTempArtifacts: true, requiresWriterOwnerToken: true, state: 'cancelled'},
  expired: {cleanupTempArtifacts: true, requiresWriterOwnerToken: true, state: 'expired'},
} as const satisfies Record<(typeof projectTransferWriterOnlyCleanupStates)[number], ProjectTransferCancellationRule>

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonNegativeInteger = (value: unknown) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const getCountValue = (payload: ProjectTransferProgressPayload, field: ProjectTransferProgressCountField) => {
  return payload[field] ?? null
}

const validateProgressCounts = (payload: ProjectTransferProgressPayload): ProjectTransferValidationResult => {
  const invalidField = projectTransferProgressCountFields.find((field) => {
    const value = getCountValue(payload, field)

    return value !== null && !isNonNegativeInteger(value)
  })

  if (invalidField) {
    return {error: `Project transfer progress field ${invalidField} must be a non-negative integer`, ok: false}
  }

  const invalidPair = projectTransferProgressPairs.find(([completedField, totalField]) => {
    const completed = getCountValue(payload, completedField)
    const total = getCountValue(payload, totalField)

    return completed !== null && total !== null && completed > total
  })

  return invalidPair
    ? {error: `Project transfer progress field ${invalidPair[0]} cannot exceed ${invalidPair[1]}`, ok: false}
    : payload.percent !== null
        && payload.percent !== undefined
        && (!Number.isFinite(payload.percent) || payload.percent < 0 || payload.percent > 100)
      ? {error: 'Project transfer progress field percent must be between 0 and 100', ok: false}
      : {ok: true}
}

const validateMonotonicProgressCounts = ({
  next,
  previous,
}: {
  next: ProjectTransferProgressPayload
  previous: ProjectTransferProgressPayload | null
}): ProjectTransferValidationResult => {
  if (previous === null) {
    return {ok: true}
  }

  if (previous.phase !== next.phase) {
    return {ok: true}
  }

  const regressedField = projectTransferProgressCountFields.find((field) => {
    const previousValue = getCountValue(previous, field)
    const nextValue = getCountValue(next, field)

    return previousValue !== null && nextValue !== null && nextValue < previousValue
  })

  return regressedField
    ? {error: `Project transfer progress field ${regressedField} must be monotonic`, ok: false}
    : {ok: true}
}

const validateRequiredCountRecord = ({
  counts,
  label,
  requiredKeys,
}: {
  counts: Record<string, number>
  label: string
  requiredKeys: readonly string[]
}): ProjectTransferValidationResult => {
  const missingKey = requiredKeys.find((key) => {
    return !Object.hasOwn(counts, key)
  })

  if (missingKey) {
    return {error: `Project transfer missing required ${label} count ${missingKey}`, ok: false}
  }

  const invalidKey = Object.keys(counts).find((key) => {
    return !isNonNegativeInteger(counts[key])
  })

  return invalidKey
    ? {error: `Project transfer ${label} count ${invalidKey} must be a non-negative integer`, ok: false}
    : {ok: true}
}

const validateOptionalNonNegativeInteger = (
  value: number | null | undefined,
  label: string,
): ProjectTransferValidationResult => {
  return value === null || value === undefined || isNonNegativeInteger(value)
    ? {ok: true}
    : {error: `Project transfer ${label} must be a non-negative integer`, ok: false}
}

const validateThresholdInput = (input: Record<string, number>, label: string): ProjectTransferValidationResult => {
  const invalidKey = Object.keys(input).find((key) => {
    return !isNonNegativeInteger(input[key])
  })

  return invalidKey
    ? {error: `Project transfer ${label} threshold input ${invalidKey} must be a non-negative integer`, ok: false}
    : {ok: true}
}

const getDiskHeadroomTargetBytes = (targetWriteBytes: number) => {
  return targetWriteBytes * (1 + projectTransferResourceGateLimits.minimumDiskHeadroomRatio)
}

const validateTempRoot = (tempRootPath: string): ProjectTransferValidationResult => {
  const validation = validateProjectTransferTempWritablePath(tempRootPath)

  return validation.ok
    ? {ok: true}
    : {
        error:
          `Project transfer temp root must stay under ${projectTransferResourceGateLimits.writableTempRoot}: `
          + `${validation.error.message}: ${tempRootPath}`,
        ok: false,
      }
}

const getPathValidationMessage = (path: ProjectTransferResourcePath) => {
  const validation =
    path.kind === 'archive_member'
      ? validateProjectTransferArchiveMemberPath({pathValue: path.pathValue})
      : validateProjectTransferRuntimeAssetPath(path.pathValue)

  return validation.ok ? null : validation.error.message
}

const validateResourcePaths = (paths: readonly ProjectTransferResourcePath[] = []): ProjectTransferValidationResult => {
  const invalidPath = paths
    .map((path) => {
      return {...path, message: getPathValidationMessage(path)}
    })
    .find((path) => {
      return path.message !== null
    })

  return invalidPath ? {error: `${invalidPath.message}: ${invalidPath.pathValue}`, ok: false} : {ok: true}
}

const validateDiskHeadroom = ({
  availableDiskBytes,
  targetWriteBytes,
}: {
  availableDiskBytes: number
  targetWriteBytes: number
}): ProjectTransferValidationResult => {
  return availableDiskBytes >= getDiskHeadroomTargetBytes(targetWriteBytes)
    ? {ok: true}
    : {error: 'Project transfer disk headroom requires target bytes plus 10%', ok: false}
}

const getFirstFailedValidation = (validations: ProjectTransferValidationResult[]) => {
  return (
    validations.find((validation) => {
      return !validation.ok
    }) ?? {ok: true}
  )
}

export const validateProjectTransferProgressUpdate = ({
  next,
  previous,
}: {
  next: ProjectTransferProgressPayload
  previous: ProjectTransferProgressPayload | null
}): ProjectTransferValidationResult => {
  const countValidation = validateProgressCounts(next)

  return countValidation.ok ? validateMonotonicProgressCounts({next, previous}) : countValidation
}

export const validateProjectTransferDependencyStatuses = (
  statuses: Record<string, ProjectTransferDependencyStatus>,
): ProjectTransferValidationResult => {
  const invalidKey = Object.keys(statuses).find((key) => {
    const status = statuses[key]

    return status === undefined || !projectTransferDependencyStatusSet.has(status)
  })

  return invalidKey
    ? {error: `Project transfer dependency ${invalidKey} has unknown status ${statuses[invalidKey]}`, ok: false}
    : {ok: true}
}

export const validateProjectTransferReadyDependencyStatuses = (
  statuses: Record<string, ProjectTransferDependencyStatus>,
): ProjectTransferValidationResult => {
  const statusValidation = validateProjectTransferDependencyStatuses(statuses)

  if (!statusValidation.ok) {
    return statusValidation
  }

  const blockedKey = Object.keys(statuses).find((key) => {
    const status = statuses[key]

    return status === undefined || !projectTransferReadyDependencyStatusSet.has(status)
  })

  return blockedKey
    ? {error: `Project transfer dependency ${blockedKey} is not ready to commit`, ok: false}
    : {ok: true}
}

export const validateProjectTransferPlanReadyToCommit = (
  planSummary: ProjectTransferPlanSummary | null,
): ProjectTransferValidationResult => {
  if (planSummary === null) {
    return {error: 'Project transfer plan summary is required before ready_to_commit', ok: false}
  }

  const overlapCountsValidation = validateRequiredCountRecord({
    counts: planSummary.overlapCounts,
    label: 'overlap',
    requiredKeys: projectTransferOverlapSummaryKeys,
  })
  const conflictCountsValidation = validateRequiredCountRecord({
    counts: planSummary.conflictCounts,
    label: 'conflict',
    requiredKeys: projectTransferConflictCountKeys,
  })
  const dependencyValidation = validateProjectTransferReadyDependencyStatuses(planSummary.dependencyStatuses)
  const judgmentConflictStatus = planSummary.judgmentConflictStatus ?? 'clear'

  return !isNonNegativeInteger(planSummary.blockerCount)
    ? {error: 'Project transfer blockerCount must be a non-negative integer', ok: false}
    : !isNonNegativeInteger(planSummary.warningCount)
      ? {error: 'Project transfer warningCount must be a non-negative integer', ok: false}
      : !projectTransferJudgmentConflictStatuses.includes(judgmentConflictStatus)
        ? {error: `Project transfer judgmentConflictStatus is unknown value ${judgmentConflictStatus}`, ok: false}
        : planSummary.blockerCount > 0
          ? {error: 'Project transfer blockers must be resolved before ready_to_commit', ok: false}
          : judgmentConflictStatus === 'unknown'
            ? {error: 'Project transfer judgment conflicts must be known before ready_to_commit', ok: false}
            : judgmentConflictStatus === 'blocked'
              ? {error: 'Project transfer judgment conflicts must be resolved before ready_to_commit', ok: false}
              : !overlapCountsValidation.ok
                ? overlapCountsValidation
                : !conflictCountsValidation.ok
                  ? conflictCountsValidation
                  : dependencyValidation
}

export const getProjectTransferExportExecutionMode = (
  input: ProjectTransferExportThresholdInput,
): ProjectTransferExecutionMode => {
  const validation = validateThresholdInput(input, 'export')

  if (!validation.ok) {
    throw new Error(validation.error)
  }

  return input.packageBytes <= projectTransferExecutionThresholds.exportInlinePackageBytes
    && input.assetBytes <= projectTransferExecutionThresholds.exportInlineAssetBytes
    ? 'inline'
    : 'background'
}

export const getProjectTransferImportAnalyzeExecutionMode = (
  input: ProjectTransferImportAnalyzeThresholdInput,
): ProjectTransferExecutionMode => {
  const validation = validateThresholdInput(input, 'import analyze')

  if (!validation.ok) {
    throw new Error(validation.error)
  }

  return input.zipBytes <= projectTransferExecutionThresholds.importAnalyzeInlineZipBytes
    && input.expandedBytes <= projectTransferExecutionThresholds.importAnalyzeInlineExpandedBytes
    ? 'inline'
    : 'background'
}

export const getProjectTransferCommitExecutionMode = (
  input: ProjectTransferCommitThresholdInput,
): ProjectTransferExecutionMode => {
  const validation = validateThresholdInput(input, 'commit')

  if (!validation.ok) {
    throw new Error(validation.error)
  }

  return input.articleCount >= projectTransferExecutionThresholds.commitBackgroundArticleCount
    || input.articleCount + input.judgmentCount >= projectTransferExecutionThresholds.commitBackgroundTotalRowCount
    || input.judgmentCount >= projectTransferExecutionThresholds.commitBackgroundJudgmentCount
    || input.extractedAssetBytes >= projectTransferExecutionThresholds.commitBackgroundExtractedAssetBytes
    ? 'background'
    : 'inline'
}

export const validateProjectTransferResourceGates = (
  input: ProjectTransferResourceGateInput,
): ProjectTransferValidationResult => {
  const validations = [
    validateTempRoot(input.tempRootPath),
    validateOptionalNonNegativeInteger(input.availableDiskBytes, 'availableDiskBytes'),
    validateOptionalNonNegativeInteger(input.targetWriteBytes, 'targetWriteBytes'),
    validateOptionalNonNegativeInteger(input.archiveMemberCount, 'archiveMemberCount'),
    validateOptionalNonNegativeInteger(input.archiveInodeCount, 'archiveInodeCount'),
    validateOptionalNonNegativeInteger(input.fileBytes, 'fileBytes'),
    validateOptionalNonNegativeInteger(input.ndjsonLineBytes, 'ndjsonLineBytes'),
    validateOptionalNonNegativeInteger(input.jsonDepth, 'jsonDepth'),
    validateOptionalNonNegativeInteger(input.jsonMemberCount, 'jsonMemberCount'),
    validateOptionalNonNegativeInteger(input.zipBytes, 'zipBytes'),
    validateOptionalNonNegativeInteger(input.expandedBytes, 'expandedBytes'),
    validateResourcePaths(input.resourcePaths),
    validateDiskHeadroom(input),
  ]

  return getFirstFailedValidation(validations)
}

export const parseProjectTransferProgressPayload = (value: unknown): ProjectTransferProgressPayload | null => {
  const parsed = getJsonValue(value)

  return isRecord(parsed) ? (parsed as ProjectTransferProgressPayload) : null
}

export const parseProjectTransferPlanSummary = (value: unknown): ProjectTransferPlanSummary | null => {
  const parsed = getJsonValue(value)

  return isRecord(parsed) ? (parsed as ProjectTransferPlanSummary) : null
}

const isOptionalString = (value: unknown) => {
  return value === undefined || typeof value === 'string'
}

const isOptionalNullableString = (value: unknown) => {
  return value === undefined || value === null || typeof value === 'string'
}

const isOptionalNumberRecord = (value: unknown) => {
  return (
    value === undefined
    || (isRecord(value)
      && Object.values(value).every((entry) => {
        return typeof entry === 'number' && Number.isFinite(entry)
      }))
  )
}

const isProjectTransferImportCompletionPayload = (
  value: Record<string, unknown>,
): value is ProjectTransferImportCompletionPayload => {
  return (
    value.status === 'completed'
    && isOptionalNullableString(value.packageFingerprint)
    && isOptionalNullableString(value.projectId)
    && isOptionalNullableString(value.projectName)
    && isOptionalNullableString(value.targetProjectId)
    && isOptionalNullableString(value.targetProjectName)
    && isOptionalString(value.transferHistoryId)
    && isOptionalNumberRecord(value.finalCounts)
    && isOptionalNumberRecord(value.payloadCounts)
    && (value.importWarnings === undefined || Array.isArray(value.importWarnings))
  )
}

const isProjectTransferExportReadyPayload = (
  value: Record<string, unknown>,
): value is ProjectTransferExportReadyPayload => {
  return (
    value.status === 'ready'
    && typeof value.filename === 'string'
    && typeof value.byteLength === 'number'
    && typeof value.checksumSha256 === 'string'
    && typeof value.packageFingerprint === 'string'
    && typeof value.downloadUrl === 'string'
    && typeof value.expiresAt === 'string'
  )
}

export const parseProjectTransferCompletionPayload = (
  value: unknown,
  direction?: ProjectTransferDirection,
): ProjectTransferCompletionPayload | null => {
  const parsed = getJsonValue(value)

  if (!isRecord(parsed)) {
    return null
  }

  if (direction === 'import') {
    return isProjectTransferImportCompletionPayload(parsed) ? parsed : null
  }

  if (direction === 'export') {
    return isProjectTransferExportReadyPayload(parsed) ? parsed : null
  }

  return isProjectTransferImportCompletionPayload(parsed) || isProjectTransferExportReadyPayload(parsed) ? parsed : null
}

const getProgressPercent = (progress: ProjectTransferProgressPayload) => {
  const explicitPercent = progress.percent
  const processedBytes = progress.bytesProcessed ?? progress.completedBytes ?? null
  const totalBytes = progress.bytesTotal ?? progress.totalBytes ?? null

  return explicitPercent !== null && explicitPercent !== undefined
    ? explicitPercent
    : processedBytes !== null && totalBytes !== null && totalBytes > 0
      ? Math.min(100, Math.floor((processedBytes / totalBytes) * 100))
      : null
}

const getProjectTransferSessionResponseProgress = (
  record: ProjectTransferSessionRecord,
): ProjectTransferProgressPayload | null => {
  const progress = parseProjectTransferProgressPayload(record.progressJson)

  return progress === null
    ? null
    : {
        ...progress,
        bytesProcessed: progress.bytesProcessed ?? progress.completedBytes ?? null,
        bytesTotal: progress.bytesTotal ?? progress.totalBytes ?? null,
        expiresAt: progress.expiresAt ?? record.expiresAt.toISOString(),
        percent: getProgressPercent(progress),
        planRevision: progress.planRevision ?? record.planRevision,
        rowCountProcessed: progress.rowCountProcessed ?? progress.completedRows ?? null,
        rowCountTotal: progress.rowCountTotal ?? progress.totalRows ?? null,
        updatedAt: progress.updatedAt ?? record.updatedAt.toISOString(),
        warningCount: progress.warningCount ?? null,
      }
}

export const toProjectTransferSessionResponse = (
  record: ProjectTransferSessionRecord,
): ProjectTransferSessionResponse => {
  return {
    commitId: record.commitId,
    completion: parseProjectTransferCompletionPayload(record.completionPayloadJson, record.direction),
    createdAt: record.createdAt,
    direction: record.direction,
    error: getJsonValue(record.errorJson),
    expiresAt: record.expiresAt,
    heartbeatAt: record.heartbeatAt,
    id: record.id,
    ownerToken: record.ownerToken,
    packageFingerprint: record.packageFingerprint,
    planRevision: record.planRevision,
    planSummary: parseProjectTransferPlanSummary(record.planSummaryJson),
    progress: getProjectTransferSessionResponseProgress(record),
    state: record.state,
    updatedAt: record.updatedAt,
  }
}
