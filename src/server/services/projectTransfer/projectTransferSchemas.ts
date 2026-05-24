import {type as arktype} from 'arktype'

export const projectTransferManifestSchemaVersion = 1 as const

export const projectTransferPayloadPathByKey = {
  articleImportRoutes: 'articleImportRoutes.ndjson',
  articles: 'articles.ndjson',
  assetManifest: 'assetManifest.json',
  humanJudgmentSummaries: 'humanJudgmentSummaries.ndjson',
  humanJudgments: 'humanJudgments.ndjson',
  importRoutes: 'importRoutes.json',
  judgmentAssessments: 'judgmentAssessments.ndjson',
  judgments: 'judgments.ndjson',
  models: 'models.json',
  project: 'project.json',
  projectArticles: 'projectArticles.ndjson',
  projectImportRoutes: 'projectImportRoutes.json',
  projectPrompts: 'projectPrompts.json',
  prompts: 'prompts.json',
  providerConnections: 'providerConnections.json',
  reviews: 'reviews.ndjson',
} as const

export type ProjectTransferPayloadKey = keyof typeof projectTransferPayloadPathByKey

export type ProjectTransferPayloadFormat = 'json' | 'ndjson'

export const projectTransferPayloadFormatByKey = {
  articleImportRoutes: 'ndjson',
  articles: 'ndjson',
  assetManifest: 'json',
  humanJudgmentSummaries: 'ndjson',
  humanJudgments: 'ndjson',
  importRoutes: 'json',
  judgmentAssessments: 'ndjson',
  judgments: 'ndjson',
  models: 'json',
  project: 'json',
  projectArticles: 'ndjson',
  projectImportRoutes: 'json',
  projectPrompts: 'json',
  prompts: 'json',
  providerConnections: 'json',
  reviews: 'ndjson',
} as const satisfies Record<ProjectTransferPayloadKey, ProjectTransferPayloadFormat>

export const projectTransferPayloadKeys = Object.keys(projectTransferPayloadPathByKey) as ProjectTransferPayloadKey[]

export type ProjectTransferManifestPayload = {
  byteLength: number
  checksumSha256: string
  format: ProjectTransferPayloadFormat
  path: string
  recordCount: number
}

export type ProjectTransferManifestAssetSummary = {byteLength: number; entryCount: number}

export type ProjectTransferManifestProjectSummary = {
  counts: Record<ProjectTransferPayloadKey, number>
  currentModel: {modelName: string | null; remoteModelId: string | null; sourceModelId: string | null}
  humanJudgmentMode: 'prompt' | 'summary'
  name: string
  sourceProjectId: string
}

export type ProjectTransferWarningSeverity = 'blocking' | 'fidelity' | 'info' | 'warning'

export type ProjectTransferPackageWarning = {
  action: string
  code: string
  details?: unknown
  jsonPointer?: string
  message: string
  payload?: unknown
  scope: string
  severity: ProjectTransferWarningSeverity
  sourceRef?: string
}

export type ProjectTransferManifestWarning = ProjectTransferPackageWarning

export type ProjectTransferManifest = {
  assetSummary?: ProjectTransferManifestAssetSummary
  exportedAt: string
  packageFingerprint?: string | null
  payloads: Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>
  project: ProjectTransferManifestProjectSummary
  schemaVersion: typeof projectTransferManifestSchemaVersion
  sourceAppVersion: string
  warnings?: ProjectTransferManifestWarning[]
}

export const projectTransferPayloadFormatShape = arktype('"json" | "ndjson"')

export const projectTransferManifestPayloadShape = arktype({
  byteLength: 'number.integer >= 0',
  checksumSha256: 'string',
  format: projectTransferPayloadFormatShape,
  path: 'string',
  recordCount: 'number.integer >= 0',
})

export const projectTransferManifestWarningShape = arktype({
  action: 'string',
  code: 'string',
  'details?': 'unknown',
  'jsonPointer?': 'string | undefined',
  message: 'string',
  'payload?': 'unknown',
  scope: 'string',
  severity: '"blocking" | "fidelity" | "info" | "warning"',
  'sourceRef?': 'string | undefined',
})

export const projectTransferManifestShape = arktype({
  'assetSummary?': 'object | undefined',
  exportedAt: 'string',
  'packageFingerprint?': 'string | null | undefined',
  payloads: 'object',
  project: 'object',
  schemaVersion: 'number.integer',
  sourceAppVersion: 'string',
  'warnings?': 'unknown[] | undefined',
})

const projectTransferPayloadKeySet = new Set<ProjectTransferPayloadKey>(projectTransferPayloadKeys)

export const isProjectTransferPayloadKey = (value: string): value is ProjectTransferPayloadKey => {
  return projectTransferPayloadKeySet.has(value as ProjectTransferPayloadKey)
}
