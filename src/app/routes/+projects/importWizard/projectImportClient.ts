import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'
import {getApiRequestUrl} from '../../../utils/getApiRequestUrl.ts'

export type ProjectImportSessionState =
  | 'analyzing'
  | 'awaiting_resolution'
  | 'awaiting_upload'
  | 'cancelled'
  | 'completed'
  | 'committing'
  | 'expired'
  | 'extracting'
  | 'failed'
  | 'queued'
  | 'ready_to_commit'
  | 'uploading'

export type ProjectImportProgress = {
  bytesProcessed?: number | null
  bytesTotal?: number | null
  completedBytes?: number | null
  completedRows?: number | null
  message?: string | null
  percent?: number | null
  phase: string
  rowCountProcessed?: number | null
  rowCountTotal?: number | null
  status: 'completed' | 'failed' | 'pending' | 'running'
  totalBytes?: number | null
  totalRows?: number | null
  updatedAt?: string | null
  uploadMetadata?: ProjectImportUploadMetadata | null
  warningCount?: number | null
}

export type ProjectImportUploadMetadata = {byteLength: number; checksumSha256: string; fileName: string}

export type ProjectImportPlanBlocker = {
  code: string
  message: string
  resolutionKind: 'requires_new_package_or_target_changes' | 'wizard_resolvable'
  scope: string
}

export type ProjectImportPlanSummary = {
  blockerCount: number
  blockers?: ProjectImportPlanBlocker[]
  conflictCounts: Record<string, number>
  dependencyStatuses: Record<string, string>
  judgmentConflictStatus?: 'blocked' | 'clear' | 'unknown'
  overlapCounts: Record<string, number>
  packageCounts?: Record<string, number>
  packageFingerprint?: string | null
  packageWarnings?: ProjectImportPackageWarning[]
  warningCount: number
}

export type ProjectImportPackageWarning = {
  action?: string
  code?: string
  details?: unknown
  message: string
  scope?: string
}

export type ProjectImportCompletion = {
  finalCounts?: Record<string, number>
  importWarnings?: ProjectImportPackageWarning[]
  packageFingerprint?: string | null
  projectId?: string | null
  projectName?: string | null
  status: 'completed'
  targetProjectId?: string | null
  targetProjectName?: string | null
  transferHistoryId?: string
}

export type ProjectImportDependencyResolution = {
  acceptedSubstituteModelSourceIds?: string[]
  codexSetupState?: 'complete' | 'login_pending' | 'not_ready' | 'setup_pending' | null
  modelMaterializationRequests?: ProjectImportModelMaterializationRequest[]
  modelTargetBySourceId?: Record<string, string>
  providerTargetBySourceId?: Record<string, string>
  unresolvedModelSourceIds?: string[]
  unresolvedProviderSourceIds?: string[]
}

export type ProjectImportTargetPlan = {
  articleMatches?: unknown[]
  articleRoutePlan?: unknown[]
  articleUpdatePlan?: unknown[]
  assetPromotionPlan?: unknown[]
  duplicateImportMatches?: unknown[]
  humanReviewPlan?: unknown[]
  judgmentAssessmentPlan?: unknown[]
  judgmentPlan?: unknown[]
  projectPromptPlan?: unknown[]
  projectRoutePlan?: unknown[]
  promptPlan?: unknown[]
}

export type ProjectImportPlanArtifact = {
  blockers: ProjectImportPlanBlocker[]
  canCommit: boolean
  dependencyResolution?: ProjectImportDependencyResolution | null
  packageCounts: Record<string, number>
  packageFingerprint: string | null
  packageWarnings: ProjectImportPackageWarning[]
  planRevision: number
  resolutionKinds: Record<string, ProjectImportPlanBlocker['resolutionKind']>
  summary: ProjectImportPlanSummary
  targetPlan: ProjectImportTargetPlan
}

export type ProjectImportSession = {
  analyzeUrl: string
  blockers: string[]
  canCommit: boolean
  cancelUrl: string
  commitId: string | null
  commitUrl: string
  completion: ProjectImportCompletion | null
  createdAt: string | Date
  direction: 'import'
  duplicatePackageWarnings: string[]
  error: unknown
  executionMode?: 'background' | 'inline'
  expiresAt: string | Date
  heartbeatAt: string | Date | null
  id: string
  overlapCounts: Record<string, number> | null
  ownerToken: string | null
  packageFingerprint: string | null
  plan: ProjectImportPlanArtifact | null
  planRevision: number
  planSummary: ProjectImportPlanSummary | null
  progress: ProjectImportProgress | null
  resolveDependenciesUrl: string
  sessionUrl: string
  stalePlan?: boolean
  state: ProjectImportSessionState
  updatedAt: string | Date
  upload: ProjectImportUploadMetadata | null
  uploadUrl: string
  warnings: string[]
}

export type ProjectImportProviderSelection = {sourceProviderConnectionId: string; targetProviderConnectionId: string}

export type ProjectImportCreatedProviderSelection = ProjectImportProviderSelection & {
  setupState?: 'auth_pending' | 'complete' | 'connection_test_pending' | 'discovery_pending'
}

export type ProjectImportModelSelection = {acceptSubstitute?: boolean; sourceModelId: string; targetModelId: string}

export type ProjectImportMaterializedModelSelection = ProjectImportModelSelection & {
  targetProviderConnectionId?: string
}

export type ProjectImportModelMaterializationRequest = {
  displayName?: string
  remoteModelId: string
  sourceModelId: string
  targetProviderConnectionId: string
  variant?: string | null
}

export type ProjectImportResolveDependenciesRequest = {
  autoResolve?: boolean
  codexSetupState?: 'complete' | 'login_pending' | 'not_ready' | 'setup_pending'
  createdProviderConnections?: ProjectImportCreatedProviderSelection[]
  materializedModels?: ProjectImportMaterializedModelSelection[]
  modelMaterializationRequests?: ProjectImportModelMaterializationRequest[]
  planRevision: number
  selectedModels?: ProjectImportModelSelection[]
  selectedProviderConnections?: ProjectImportProviderSelection[]
  unresolvedModels?: Array<{reason?: string; sourceModelId: string; status?: 'ambiguous' | 'blocked' | 'missing'}>
  unresolvedProviders?: Array<{
    reason?: string
    sourceProviderConnectionId: string
    status?: 'ambiguous' | 'blocked' | 'missing'
  }>
}

type ProjectImportApiResponse<TData> = {data: TData; error: null} | {data: null; error: string}

const unwrapProjectImportResponse = <TData>(response: ProjectImportApiResponse<TData>, errorMessage: string) => {
  if (response.error !== null) {
    throw new Error(response.error)
  }

  if (response.data === null) {
    throw new Error(errorMessage)
  }

  return response.data
}

const readJsonBody = async (response: Response): Promise<unknown> => {
  return response.json().catch(() => {
    return null
  }) as Promise<unknown>
}

const getEnvelopeError = (value: unknown) => {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : null
}

const getEnvelopeData = (value: unknown) => {
  return typeof value === 'object' && value !== null && 'data' in value ? value.data : null
}

const getUploadProgressStream = (file: File, onProgress: (percent: number) => void) => {
  const reader = file.stream().getReader()
  const uploaded = {bytes: 0}

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()

      if (next.done) {
        controller.close()
        return
      }

      uploaded.bytes += next.value.byteLength
      onProgress(file.size === 0 ? 100 : Math.round((uploaded.bytes / file.size) * 100))
      controller.enqueue(next.value)
    },
  })
}

export const projectImportSessionQueryKey = (sessionId: string | null) => {
  return ['project-import-session', sessionId ?? 'none'] as const
}

export const getProjectImportUploadRequestPath = (sessionId: string) => {
  return `/api/projects/import/${encodeURIComponent(sessionId)}/upload`
}

export const getProjectImportUploadRequestUrl = (
  sessionId: string,
  locationOrigin?: string | null,
  desktopApiOrigin?: string | null,
) => {
  return getApiRequestUrl(getProjectImportUploadRequestPath(sessionId), locationOrigin, desktopApiOrigin)
}

export const createProjectImportSession = async () => {
  const response = await apiClient.api.projects.import.sessions.post({})
  const envelope = handleApiResponse<ProjectImportApiResponse<ProjectImportSession>>(
    response as unknown as {data?: ProjectImportApiResponse<ProjectImportSession>; error?: unknown; status?: number},
    'Failed to create project import session',
  )

  return unwrapProjectImportResponse(envelope, 'Project import session was not returned')
}

export const fetchProjectImportSession = async (sessionId: string) => {
  const response = await apiClient.api.projects.import({sessionId}).get()
  const envelope = handleApiResponse<ProjectImportApiResponse<ProjectImportSession>>(
    response as unknown as {data?: ProjectImportApiResponse<ProjectImportSession>; error?: unknown; status?: number},
    'Failed to fetch project import session',
  )

  return unwrapProjectImportResponse(envelope, 'Project import session was not returned')
}

export const analyzeProjectImportSession = async (input: {expectedPlanRevision?: number; sessionId: string}) => {
  const response = await apiClient.api.projects
    .import({sessionId: input.sessionId})
    .analyze.post({expectedPlanRevision: input.expectedPlanRevision})
  const envelope = handleApiResponse<ProjectImportApiResponse<ProjectImportSession>>(
    response as unknown as {data?: ProjectImportApiResponse<ProjectImportSession>; error?: unknown; status?: number},
    'Failed to analyze project import package',
  )

  return unwrapProjectImportResponse(envelope, 'Project import session was not returned')
}

export const resolveProjectImportDependencies = async (
  input: {sessionId: string} & ProjectImportResolveDependenciesRequest,
) => {
  const response = await apiClient.api.projects
    .import({sessionId: input.sessionId})
    [
      'resolve-dependencies'
    ].post({autoResolve: input.autoResolve, codexSetupState: input.codexSetupState, createdProviderConnections: input.createdProviderConnections, materializedModels: input.materializedModels, modelMaterializationRequests: input.modelMaterializationRequests, planRevision: input.planRevision, selectedModels: input.selectedModels, selectedProviderConnections: input.selectedProviderConnections, unresolvedModels: input.unresolvedModels, unresolvedProviders: input.unresolvedProviders})
  const envelope = handleApiResponse<ProjectImportApiResponse<ProjectImportSession>>(
    response as unknown as {data?: ProjectImportApiResponse<ProjectImportSession>; error?: unknown; status?: number},
    'Failed to resolve project import dependencies',
  )

  return unwrapProjectImportResponse(envelope, 'Project import session was not returned')
}

export const commitProjectImportSession = async (input: {planRevision: number; sessionId: string}) => {
  const response = await apiClient.api.projects
    .import({sessionId: input.sessionId})
    .commit.post({planRevision: input.planRevision})
  const envelope = handleApiResponse<ProjectImportApiResponse<ProjectImportSession>>(
    response as unknown as {data?: ProjectImportApiResponse<ProjectImportSession>; error?: unknown; status?: number},
    'Failed to commit project import',
  )

  return unwrapProjectImportResponse(envelope, 'Project import session was not returned')
}

export const cancelProjectImportSession = async (sessionId: string) => {
  const response = await apiClient.api.projects.import({sessionId}).delete({reason: 'user_cancelled'})
  const envelope = handleApiResponse<ProjectImportApiResponse<ProjectImportSession>>(
    response as unknown as {data?: ProjectImportApiResponse<ProjectImportSession>; error?: unknown; status?: number},
    'Failed to cancel project import session',
  )

  return unwrapProjectImportResponse(envelope, 'Project import session was not returned')
}

export const uploadProjectImportPackage = async ({
  file,
  onProgress,
  sessionId,
}: {
  file: File
  onProgress: (percent: number) => void
  sessionId: string
}) => {
  const response = await fetch(getProjectImportUploadRequestUrl(sessionId), {
    body: getUploadProgressStream(file, onProgress),
    credentials: 'include',
    headers: {
      'content-type': file.type || 'application/zip',
      'x-project-transfer-filename': file.name.replace(/[\r\n]/g, '_'),
    },
    method: 'PUT',
    ...(file.size === 0 ? {} : {duplex: 'half'}),
  } as RequestInit & {duplex?: 'half'})
  const body = await readJsonBody(response)
  const error = getEnvelopeError(body)
  const data = getEnvelopeData(body)

  if (!response.ok || error !== null) {
    throw new Error(error ?? 'Failed to upload project import package')
  }

  if (data === null) {
    throw new Error('Project import session was not returned')
  }

  onProgress(100)

  return data as ProjectImportSession
}
