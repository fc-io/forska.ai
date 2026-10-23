import type {ProjectTransferImportPlanArtifact} from '../../services/projectTransfer/projectTransferAnalyze.ts'
import type {
  ProjectTransferExecutionMode,
  ProjectTransferPlanSummary,
  ProjectTransferProgressPayload,
  ProjectTransferSessionResponse,
  ProjectTransferUploadMetadataPayload,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import type {ProjectTransferExportPackageMetadata} from '../../services/projectTransfer/projectTransferExportPackage.ts'
import type {getProjectTransferExportSourceProject} from './getProjectTransferExportSourceProject.ts'

export type ProjectTransferExportNonReadyStatus = 'assembling' | 'packaging' | 'queued'
type ProjectTransferExportSessionPendingResponse = {
  exportId: string
  expiresAt: string
  progress: ProjectTransferProgressPayload | null
  status: ProjectTransferExportNonReadyStatus
}
export type ProjectTransferExportSessionReadyResponse = ProjectTransferExportPackageMetadata & {
  exportId: string
  progress: ProjectTransferProgressPayload | null
  status: 'ready'
}
export type ProjectTransferExportSessionData =
  | ProjectTransferExportSessionPendingResponse
  | ProjectTransferExportSessionReadyResponse
export type ProjectTransferImportSessionData = ProjectTransferSessionResponse & {
  analyzeUrl: string
  blockers: string[]
  canCommit: boolean
  cancelUrl: string
  commitUrl: string
  duplicatePackageWarnings: string[]
  executionMode?: ProjectTransferExecutionMode
  overlapCounts: ProjectTransferPlanSummary['overlapCounts'] | null
  plan: ProjectTransferImportPlanArtifact | null
  resolveDependenciesUrl: string
  sessionUrl: string
  stalePlan?: boolean
  upload: ProjectTransferUploadMetadataPayload | null
  uploadUrl: string
  warnings: string[]
}

export type RouteSet = {status?: number | string}

export type ProjectTransferRoutesDependencies = {getExportSourceProject?: typeof getProjectTransferExportSourceProject}
