import type {
  ProjectTransferDirection,
  ProjectTransferExportState,
  ProjectTransferImportState,
  ProjectTransferSessionRecord,
  ProjectTransferSessionState,
} from '../../../db/schemaTypes.ts'
import {getJsonValue} from '../appQueryHelpers.ts'

export const projectTransferImportStates = [
  'awaiting_upload',
  'uploading',
  'queued',
  'extracting',
  'analyzing',
  'awaiting_resolution',
  'ready_to_commit',
  'committing',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const satisfies readonly ProjectTransferImportState[]

export const projectTransferExportStates = [
  'queued',
  'assembling',
  'packaging',
  'ready',
  'failed',
  'expired',
] as const satisfies readonly ProjectTransferExportState[]

export const projectTransferTerminalStates = ['completed', 'failed', 'cancelled', 'expired'] as const

export const projectTransferWriterOnlyStates = ['cancelled', 'expired'] as const

export const projectTransferImportArtifacts = {
  analysis: 'analysis.json',
  completion: 'completion.json',
  extracted: 'extracted',
  manifest: 'manifest.json',
  plan: 'plan.json',
  progress: 'progress.json',
  promotionManifest: 'promotionManifest.json',
  upload: 'upload.zip',
} as const

export const projectTransferExportArtifacts = {
  build: 'build',
  completion: 'completion.json',
  manifest: 'manifest.json',
  package: 'package.zip',
  progress: 'progress.json',
} as const

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

export type ProjectTransferDependencyStatus = 'ambiguous' | 'blocked' | 'missing' | 'not_required' | 'resolved'

export type ProjectTransferPlanSummary = {
  blockerCount: number
  conflictCounts: Record<string, number>
  dependencyStatuses: Record<string, ProjectTransferDependencyStatus>
  overlapCounts: Record<string, number>
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

export type ProjectTransferImportTempLayout = {
  analysisPath: string
  completionPath: string
  extractedPath: string
  manifestPath: string
  planPath: string
  progressPath: string
  promotionManifestPath: string
  rootPath: string
  uploadPath: string
}

export type ProjectTransferExportTempLayout = {
  buildPath: string
  completionPath: string
  manifestPath: string
  packagePath: string
  progressPath: string
  rootPath: string
}

type ProjectTransferCountField =
  | 'completedBytes'
  | 'completedItems'
  | 'completedRows'
  | 'totalBytes'
  | 'totalItems'
  | 'totalRows'

type ProjectTransferValidationResult = {ok: true} | {error: string; ok: false}

const projectTransferProgressCountFields = [
  'completedBytes',
  'completedItems',
  'completedRows',
  'totalBytes',
  'totalItems',
  'totalRows',
] as const satisfies readonly ProjectTransferCountField[]

const projectTransferProgressPairs = [
  ['completedBytes', 'totalBytes'],
  ['completedItems', 'totalItems'],
  ['completedRows', 'totalRows'],
] as const

const readyDependencyStatuses = new Set<ProjectTransferDependencyStatus>(['not_required', 'resolved'])

const getImportRootPath = (sessionId: string) => {
  return `tmp/project-transfer/import/${sessionId}`
}

const getExportRootPath = (sessionId: string) => {
  return `tmp/project-transfer/export/${sessionId}`
}

const getArtifactPath = (rootPath: string, artifact: string) => {
  return `${rootPath}/${artifact}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonNegativeInteger = (value: unknown) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const getCountValue = (payload: ProjectTransferProgressPayload, field: ProjectTransferCountField) => {
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

const validateCountRecord = (value: Record<string, number>, label: string): ProjectTransferValidationResult => {
  const invalidKey = Object.keys(value).find((key) => {
    return !isNonNegativeInteger(value[key])
  })

  return invalidKey
    ? {error: `Project transfer ${label} count ${invalidKey} must be a non-negative integer`, ok: false}
    : {ok: true}
}

const validateDependencyStatuses = (
  statuses: Record<string, ProjectTransferDependencyStatus>,
): ProjectTransferValidationResult => {
  const blockedKey = Object.keys(statuses).find((key) => {
    return !readyDependencyStatuses.has(statuses[key])
  })

  return blockedKey
    ? {error: `Project transfer dependency ${blockedKey} is not ready to commit`, ok: false}
    : {ok: true}
}

export const isProjectTransferImportState = (state: string): state is ProjectTransferImportState => {
  return projectTransferImportStates.includes(state as ProjectTransferImportState)
}

export const isProjectTransferExportState = (state: string): state is ProjectTransferExportState => {
  return projectTransferExportStates.includes(state as ProjectTransferExportState)
}

export const isProjectTransferStateForDirection = (direction: ProjectTransferDirection, state: string) => {
  return direction === 'import' ? isProjectTransferImportState(state) : isProjectTransferExportState(state)
}

export const isProjectTransferTerminalState = (state: ProjectTransferSessionState) => {
  return projectTransferTerminalStates.includes(state as (typeof projectTransferTerminalStates)[number])
}

export const isProjectTransferWriterOnlyState = (state: ProjectTransferSessionState) => {
  return projectTransferWriterOnlyStates.includes(state as (typeof projectTransferWriterOnlyStates)[number])
}

export const getProjectTransferImportTempLayout = (sessionId: string): ProjectTransferImportTempLayout => {
  const rootPath = getImportRootPath(sessionId)

  return {
    analysisPath: getArtifactPath(rootPath, projectTransferImportArtifacts.analysis),
    completionPath: getArtifactPath(rootPath, projectTransferImportArtifacts.completion),
    extractedPath: getArtifactPath(rootPath, projectTransferImportArtifacts.extracted),
    manifestPath: getArtifactPath(rootPath, projectTransferImportArtifacts.manifest),
    planPath: getArtifactPath(rootPath, projectTransferImportArtifacts.plan),
    progressPath: getArtifactPath(rootPath, projectTransferImportArtifacts.progress),
    promotionManifestPath: getArtifactPath(rootPath, projectTransferImportArtifacts.promotionManifest),
    rootPath,
    uploadPath: getArtifactPath(rootPath, projectTransferImportArtifacts.upload),
  }
}

export const getProjectTransferExportTempLayout = (sessionId: string): ProjectTransferExportTempLayout => {
  const rootPath = getExportRootPath(sessionId)

  return {
    buildPath: getArtifactPath(rootPath, projectTransferExportArtifacts.build),
    completionPath: getArtifactPath(rootPath, projectTransferExportArtifacts.completion),
    manifestPath: getArtifactPath(rootPath, projectTransferExportArtifacts.manifest),
    packagePath: getArtifactPath(rootPath, projectTransferExportArtifacts.package),
    progressPath: getArtifactPath(rootPath, projectTransferExportArtifacts.progress),
    rootPath,
  }
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

export const validateProjectTransferPlanReadyToCommit = (
  planSummary: ProjectTransferPlanSummary | null,
): ProjectTransferValidationResult => {
  if (planSummary === null) {
    return {error: 'Project transfer plan summary is required before ready_to_commit', ok: false}
  }

  const overlapCountsValidation = validateCountRecord(planSummary.overlapCounts, 'overlap')
  const conflictCountsValidation = validateCountRecord(planSummary.conflictCounts, 'conflict')
  const dependencyValidation = validateDependencyStatuses(planSummary.dependencyStatuses)

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
