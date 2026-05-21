import type {
  ProjectTransferDirection,
  ProjectTransferExportState,
  ProjectTransferImportState,
  ProjectTransferSessionState,
} from '../../../db/schemaTypes.ts'

export type {
  ProjectTransferCompletionPayload,
  ProjectTransferDependencyStatus,
  ProjectTransferPlanSummary,
  ProjectTransferProgressPayload,
  ProjectTransferProgressPhase,
  ProjectTransferProgressStatus,
  ProjectTransferSessionResponse,
} from './projectTransferContracts.ts'
export {
  parseProjectTransferCompletionPayload,
  parseProjectTransferPlanSummary,
  parseProjectTransferProgressPayload,
  toProjectTransferSessionResponse,
  validateProjectTransferPlanReadyToCommit,
  validateProjectTransferProgressUpdate,
} from './projectTransferContracts.ts'

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

const getImportRootPath = (sessionId: string) => {
  assertProjectTransferSessionId(sessionId)

  return `tmp/project-transfer/import/${sessionId}`
}

const getExportRootPath = (sessionId: string) => {
  assertProjectTransferSessionId(sessionId)

  return `tmp/project-transfer/export/${sessionId}`
}

const getArtifactPath = (rootPath: string, artifact: string) => {
  return `${rootPath}/${artifact}`
}

const projectTransferSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export const isProjectTransferSessionId = (sessionId: string) => {
  return projectTransferSessionIdPattern.test(sessionId)
}

export const assertProjectTransferSessionId = (sessionId: string) => {
  if (!isProjectTransferSessionId(sessionId)) {
    throw new Error('Project transfer session id must be path-safe')
  }
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
