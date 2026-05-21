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
} from './projectTransferPaths.ts'

const projectTransferMiB = 1024 * 1024
const projectTransferGiB = 1024 * projectTransferMiB

export const projectTransferExecutionThresholds = {
  commitBackgroundArticleCount: 25_000,
  commitBackgroundExtractedAssetBytes: 2 * projectTransferGiB,
  commitBackgroundJudgmentCount: 250_000,
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

export const projectTransferOverlapSummaryKeys = ['exactDuplicateImports', 'reusedArticles'] as const

export const projectTransferConflictCountKeys = [
  'articleIdentifier',
  'dependency',
  'humanReview',
  'judgment',
  'packageContract',
  'projectPrompt',
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
  completedBytes?: number | null
  completedItems?: number | null
  completedRows?: number | null
  message?: string | null
  phase: ProjectTransferProgressPhase
  status: ProjectTransferProgressStatus
  totalBytes?: number | null
  totalItems?: number | null
  totalRows?: number | null
  updatedAt?: string | null
}

export type ProjectTransferDependencyStatus = (typeof projectTransferDependencyStatuses)[number]

export type ProjectTransferOverlapSummaryKey = (typeof projectTransferOverlapSummaryKeys)[number]

export type ProjectTransferConflictCountKey = (typeof projectTransferConflictCountKeys)[number]

export type ProjectTransferOverlapCounts = Record<ProjectTransferOverlapSummaryKey, number> & Record<string, number>

export type ProjectTransferConflictCounts = Record<ProjectTransferConflictCountKey, number> & Record<string, number>

export type ProjectTransferPlanSummary = {
  blockerCount: number
  conflictCounts: ProjectTransferConflictCounts
  dependencyStatuses: Record<string, ProjectTransferDependencyStatus>
  overlapCounts: ProjectTransferOverlapCounts
  warningCount: number
}

export type ProjectTransferCompletionPayload = {
  importWarnings?: unknown[]
  packageFingerprint?: string | null
  projectId?: string | null
  projectName?: string | null
  status: 'completed'
}

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
  checksumSha256?: string | null
  fileName: string
  sessionId: string
  uploadPath: string
}

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
  | 'plan_updated'
  | 'session_created'
  | 'state_transition'
  | 'upload_progress'

export type ProjectTransferRuntimeEvent = {
  direction: ProjectTransferDirection
  eventId: string
  eventType: ProjectTransferRuntimeEventType
  message?: string | null
  ownerToken?: string | null
  phase?: ProjectTransferProgressPhase | null
  planRevision: number
  sessionId: string
  state: ProjectTransferSessionState
  status?: ProjectTransferProgressStatus | null
  timestamp: string
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
  | 'completedBytes'
  | 'completedItems'
  | 'completedRows'
  | 'totalBytes'
  | 'totalItems'
  | 'totalRows'

const projectTransferProgressCountFields = [
  'completedBytes',
  'completedItems',
  'completedRows',
  'totalBytes',
  'totalItems',
  'totalRows',
] as const satisfies readonly ProjectTransferProgressCountField[]

const projectTransferProgressPairs = [
  ['completedBytes', 'totalBytes'],
  ['completedItems', 'totalItems'],
  ['completedRows', 'totalRows'],
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
  const isTempRoot =
    tempRootPath === projectTransferResourceGateLimits.writableTempRoot
    || tempRootPath.startsWith(`${projectTransferResourceGateLimits.writableTempRoot}/`)

  return isTempRoot
    ? {ok: true}
    : {
        error: `Project transfer temp root must stay under ${projectTransferResourceGateLimits.writableTempRoot}`,
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

const validateArchiveMemberBudget = (archiveMemberCount: number | null | undefined) => {
  return archiveMemberCount === null
    || archiveMemberCount === undefined
    || archiveMemberCount <= projectTransferResourceGateLimits.maxArchiveMemberCount
    ? {ok: true as const}
    : {error: 'Project transfer archive member budget exceeded', ok: false as const}
}

const validateArchiveInodeBudget = (archiveInodeCount: number | null | undefined) => {
  return archiveInodeCount === null
    || archiveInodeCount === undefined
    || archiveInodeCount <= projectTransferResourceGateLimits.maxArchiveInodeCount
    ? {ok: true as const}
    : {error: 'Project transfer archive inode budget exceeded', ok: false as const}
}

const validateFileSizeLimit = (fileBytes: number | null | undefined) => {
  return fileBytes === null
    || fileBytes === undefined
    || fileBytes <= projectTransferResourceGateLimits.maxSingleFileBytes
    ? {ok: true as const}
    : {error: 'Project transfer file-size limit exceeded', ok: false as const}
}

const validateNdjsonLineLimit = (ndjsonLineBytes: number | null | undefined) => {
  return ndjsonLineBytes === null
    || ndjsonLineBytes === undefined
    || ndjsonLineBytes <= projectTransferResourceGateLimits.maxNdjsonLineBytes
    ? {ok: true as const}
    : {error: 'Project transfer NDJSON line-size limit exceeded', ok: false as const}
}

const validateJsonDepthLimit = (jsonDepth: number | null | undefined) => {
  return jsonDepth === null || jsonDepth === undefined || jsonDepth <= projectTransferResourceGateLimits.maxJsonDepth
    ? {ok: true as const}
    : {error: 'Project transfer JSON depth limit exceeded', ok: false as const}
}

const validateJsonMemberLimit = (jsonMemberCount: number | null | undefined) => {
  return jsonMemberCount === null
    || jsonMemberCount === undefined
    || jsonMemberCount <= projectTransferResourceGateLimits.maxJsonMemberCount
    ? {ok: true as const}
    : {error: 'Project transfer JSON member-count limit exceeded', ok: false as const}
}

const validateStreamingParser = (usesStreamingParser: boolean) => {
  return usesStreamingParser
    ? {ok: true as const}
    : {error: 'Project transfer payload parsing must use streaming parsers', ok: false as const}
}

const validateExpandedArchiveBudget = (expandedBytes: number | null | undefined) => {
  return expandedBytes === null
    || expandedBytes === undefined
    || expandedBytes <= projectTransferResourceGateLimits.maxExpandedArchiveBytes
    ? {ok: true as const}
    : {error: 'Project transfer expanded archive byte budget exceeded', ok: false as const}
}

const validateDecompressionRatio = ({
  expandedBytes,
  zipBytes,
}: {
  expandedBytes: number | null | undefined
  zipBytes: number | null | undefined
}) => {
  const ratio = zipBytes === null || zipBytes === undefined || zipBytes === 0 ? null : (expandedBytes ?? 0) / zipBytes

  return ratio === null || ratio <= projectTransferResourceGateLimits.maxDecompressionRatio
    ? {ok: true as const}
    : {error: 'Project transfer decompression ratio budget exceeded', ok: false as const}
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
    return !projectTransferDependencyStatusSet.has(statuses[key])
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
    return !projectTransferReadyDependencyStatusSet.has(statuses[key])
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

  return !isNonNegativeInteger(planSummary.blockerCount)
    ? {error: 'Project transfer blockerCount must be a non-negative integer', ok: false}
    : !isNonNegativeInteger(planSummary.warningCount)
      ? {error: 'Project transfer warningCount must be a non-negative integer', ok: false}
      : planSummary.blockerCount > 0
        ? {error: 'Project transfer blockers must be resolved before ready_to_commit', ok: false}
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
    validateArchiveMemberBudget(input.archiveMemberCount),
    validateArchiveInodeBudget(input.archiveInodeCount),
    validateFileSizeLimit(input.fileBytes),
    validateNdjsonLineLimit(input.ndjsonLineBytes),
    validateJsonDepthLimit(input.jsonDepth),
    validateJsonMemberLimit(input.jsonMemberCount),
    validateStreamingParser(input.usesStreamingParser),
    validateExpandedArchiveBudget(input.expandedBytes),
    validateDecompressionRatio(input),
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

export const parseProjectTransferCompletionPayload = (value: unknown): ProjectTransferCompletionPayload | null => {
  const parsed = getJsonValue(value)

  return isRecord(parsed) ? (parsed as ProjectTransferCompletionPayload) : null
}

export const toProjectTransferSessionResponse = (
  record: ProjectTransferSessionRecord,
): ProjectTransferSessionResponse => {
  return {
    commitId: record.commitId,
    completion: parseProjectTransferCompletionPayload(record.completionPayloadJson),
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
    progress: parseProjectTransferProgressPayload(record.progressJson),
    state: record.state,
    updatedAt: record.updatedAt,
  }
}
