import {type as arktype} from 'arktype'

export const projectTransferCurrentManifestSchemaVersion = 1 as const
export const projectTransferSchemaVNextManifestSchemaVersion = 2 as const
export const projectTransferManifestSchemaVersion = projectTransferSchemaVNextManifestSchemaVersion
export const projectTransferSupportedManifestSchemaVersions = [
  projectTransferCurrentManifestSchemaVersion,
  projectTransferSchemaVNextManifestSchemaVersion,
] as const

export type ProjectTransferSchemaVersion = (typeof projectTransferSupportedManifestSchemaVersions)[number]

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

export const projectTransferSchemaVNextPayloadPathByKey = {
  articleImportRoutes: 'payloads/articleImportRoutes.ndjson',
  articles: 'payloads/articles.ndjson',
  assetEntries: 'payloads/assetEntries.ndjson',
  assetReferences: 'payloads/assetReferences.ndjson',
  humanJudgmentSummaries: 'payloads/humanJudgmentSummaries.ndjson',
  humanJudgments: 'payloads/humanJudgments.ndjson',
  importRoutes: 'payloads/importRoutes.ndjson',
  judgmentAssessments: 'payloads/judgmentAssessments.ndjson',
  judgments: 'payloads/judgments.ndjson',
  models: 'payloads/models.ndjson',
  project: 'payloads/project.json',
  projectArticles: 'payloads/projectArticles.ndjson',
  projectImportRoutes: 'payloads/projectImportRoutes.ndjson',
  projectPrompts: 'payloads/projectPrompts.ndjson',
  prompts: 'payloads/prompts.ndjson',
  providerConnections: 'payloads/providerConnections.ndjson',
  reviews: 'payloads/reviews.ndjson',
} as const

export type ProjectTransferSchemaVNextPayloadKey = keyof typeof projectTransferSchemaVNextPayloadPathByKey
export type ProjectTransferPackagePayloadKey = ProjectTransferPayloadKey | ProjectTransferSchemaVNextPayloadKey

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

export const projectTransferSchemaVNextPayloadFormatByKey = {
  articleImportRoutes: 'ndjson',
  articles: 'ndjson',
  assetEntries: 'ndjson',
  assetReferences: 'ndjson',
  humanJudgmentSummaries: 'ndjson',
  humanJudgments: 'ndjson',
  importRoutes: 'ndjson',
  judgmentAssessments: 'ndjson',
  judgments: 'ndjson',
  models: 'ndjson',
  project: 'json',
  projectArticles: 'ndjson',
  projectImportRoutes: 'ndjson',
  projectPrompts: 'ndjson',
  prompts: 'ndjson',
  providerConnections: 'ndjson',
  reviews: 'ndjson',
} as const satisfies Record<ProjectTransferSchemaVNextPayloadKey, ProjectTransferPayloadFormat>

export const projectTransferPayloadKeys = Object.keys(projectTransferPayloadPathByKey) as ProjectTransferPayloadKey[]
export const projectTransferSchemaVNextPayloadKeys = Object.keys(
  projectTransferSchemaVNextPayloadPathByKey,
) as ProjectTransferSchemaVNextPayloadKey[]

export const projectTransferPayloadKeysBySchemaVersion = {
  [projectTransferCurrentManifestSchemaVersion]: projectTransferPayloadKeys,
  [projectTransferSchemaVNextManifestSchemaVersion]: projectTransferSchemaVNextPayloadKeys,
} as const satisfies Record<ProjectTransferSchemaVersion, readonly ProjectTransferPackagePayloadKey[]>

export const projectTransferPayloadPathBySchemaVersion = {
  [projectTransferCurrentManifestSchemaVersion]: projectTransferPayloadPathByKey,
  [projectTransferSchemaVNextManifestSchemaVersion]: projectTransferSchemaVNextPayloadPathByKey,
} as const

export const projectTransferPayloadFormatBySchemaVersion = {
  [projectTransferCurrentManifestSchemaVersion]: projectTransferPayloadFormatByKey,
  [projectTransferSchemaVNextManifestSchemaVersion]: projectTransferSchemaVNextPayloadFormatByKey,
} as const

export type ProjectTransferManifestPayload = {
  byteLength: number
  checksumSha256: string
  format: ProjectTransferPayloadFormat
  path: string
  recordCount: number
}

export type ProjectTransferManifestAssetSummary = {byteLength: number; entryCount: number}

export type ProjectTransferManifestProjectSummary = {
  counts: Partial<Record<ProjectTransferPackagePayloadKey, number>>
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
  payloads: Partial<Record<ProjectTransferPackagePayloadKey, ProjectTransferManifestPayload>>
  project: ProjectTransferManifestProjectSummary
  schemaVersion: ProjectTransferSchemaVersion
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
const projectTransferSchemaVNextPayloadKeySet = new Set<ProjectTransferSchemaVNextPayloadKey>(
  projectTransferSchemaVNextPayloadKeys,
)
const projectTransferSupportedManifestSchemaVersionSet = new Set<number>(projectTransferSupportedManifestSchemaVersions)

export const isProjectTransferPayloadKey = (value: string): value is ProjectTransferPayloadKey => {
  return projectTransferPayloadKeySet.has(value as ProjectTransferPayloadKey)
}

export const isProjectTransferSchemaVNextPayloadKey = (
  value: string,
): value is ProjectTransferSchemaVNextPayloadKey => {
  return projectTransferSchemaVNextPayloadKeySet.has(value as ProjectTransferSchemaVNextPayloadKey)
}

export const isProjectTransferSchemaVersion = (value: number): value is ProjectTransferSchemaVersion => {
  return projectTransferSupportedManifestSchemaVersionSet.has(value)
}

export const getProjectTransferPayloadKeysForSchemaVersion = (
  schemaVersion: ProjectTransferSchemaVersion,
): readonly ProjectTransferPackagePayloadKey[] => {
  return projectTransferPayloadKeysBySchemaVersion[schemaVersion]
}

export const isProjectTransferPayloadKeyForSchemaVersion = ({
  key,
  schemaVersion,
}: {
  key: string
  schemaVersion: ProjectTransferSchemaVersion
}): key is ProjectTransferPackagePayloadKey => {
  return schemaVersion === projectTransferSchemaVNextManifestSchemaVersion
    ? isProjectTransferSchemaVNextPayloadKey(key)
    : isProjectTransferPayloadKey(key)
}

export const getProjectTransferPayloadPathForSchemaVersion = ({
  key,
  schemaVersion,
}: {
  key: ProjectTransferPackagePayloadKey
  schemaVersion: ProjectTransferSchemaVersion
}): string | undefined => {
  const pathMap = projectTransferPayloadPathBySchemaVersion[schemaVersion] as Partial<
    Record<ProjectTransferPackagePayloadKey, string>
  >

  return pathMap[key]
}

export const getProjectTransferPayloadFormatForSchemaVersion = ({
  key,
  schemaVersion,
}: {
  key: ProjectTransferPackagePayloadKey
  schemaVersion: ProjectTransferSchemaVersion
}): ProjectTransferPayloadFormat | undefined => {
  const formatMap = projectTransferPayloadFormatBySchemaVersion[schemaVersion] as Partial<
    Record<ProjectTransferPackagePayloadKey, ProjectTransferPayloadFormat>
  >

  return formatMap[key]
}
