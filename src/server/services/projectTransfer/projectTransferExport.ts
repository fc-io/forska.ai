import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {createWriteStream, type WriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {dirname, join} from 'node:path'

import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import {
  getSinglePromptEvidenceSystemPromptForArticle,
  getSinglePromptSystemPromptForArticle,
} from '../../../agent/judge/judgePromptSelection.ts'
import {type ArticleRecord} from '../../../db/schemaTypes.ts'
import type {ArticleIdentifierInput, ArticleIdentifierInputKind} from '../../../utils/articleIdentifierNormalization.ts'
import {
  getProviderModelMetadataContextLength,
  getProviderModelMetadataOptions,
  getProviderModelMetadataPromptTokenLimit,
} from '../../providers/providerModelMetadata.ts'
import {getProviderRegistryEntry} from '../../providers/providerRegistry.ts'
import {processFulltextForLLM} from '../../utils/fulltextProcessing.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from '../appQueryHelpers.ts'
import type {AppQueryDatabaseService} from '../appQueryServiceCore.ts'
import {type ProjectTransferRawArticleProvenanceMode} from './projectTransferContracts.ts'
import {
  getEmptyProjectTransferAssetManifestPayload,
  getProjectTransferExportAssetByteEstimateForArticles,
  getProjectTransferExportAssetCollectionForArticles,
  getProjectTransferExportAssetCollectionForReferences,
  getProjectTransferExportAssetReferenceCollectionForArticles,
  type ProjectTransferExportAssetArticle,
  type ProjectTransferExportAssetEntry,
  type ProjectTransferExportAssetReferenceInput,
} from './projectTransferExportAssets.ts'
import {getProjectTransferCanonicalJson, getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import type {ProjectTransferArticleIdentifierSource} from './projectTransferIdentifierNormalization.ts'
import {
  getProjectTransferNormalizedArticleIdentifiers,
  getProjectTransferStrongIdentifierComparisonKeys,
} from './projectTransferIdentifierNormalization.ts'
import {
  assertProjectTransferPayload,
  normalizeProjectTransferModelVariant,
  type ProjectTransferContentSettings,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
  type ProjectTransferPayloadWarning,
  serializeProjectTransferPayload,
  serializeProjectTransferPayloadNdjsonRow,
} from './projectTransferPayloadSchemas.ts'
import type {
  ProjectTransferManifestWarning,
  ProjectTransferPayloadFormat,
  ProjectTransferPayloadKey,
} from './projectTransferSchemas.ts'
import {
  projectTransferPayloadFormatByKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'

type ProjectTransferExportQueryOptions = {
  articleRawJsonOmissionThresholdChars?: number
  cwd?: string
  database?: AppQueryDatabaseService
  envValues?: Record<string, string | undefined>
  rawArticleProvenanceMode?: ProjectTransferRawArticleProvenanceMode
}

export type ProjectTransferExportSourceProjectSettings = {
  archived: boolean
  createdAt: Date | null
  dateFrom: Date | null
  dateTo: Date | null
  description: string | null
  humanJudgmentMode: 'prompt' | 'summary'
  modelId: string | null
  name: string
  sourceProjectId: string
  updatedAt: Date | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type ProjectTransferExportProjectPromptRow = {
  archived: boolean | null
  contentHash: string | null
  criteriaDisposition: 'include' | 'exclude' | 'combined' | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
  enabled: boolean | null
  order: number | null
  originProjectId: string | null
  promptArchived: boolean | null
  promptCreatedAt: unknown
  promptHeading: string | null
  promptId: string
  promptUpdatedAt: unknown
  projectPromptCreatedAt: unknown
  projectPromptId: string
  projectPromptUpdatedAt: unknown
  sourceProjectId: string
  transformedText: string | null
  type: string | null
  originalText: string
}

type ProjectTransferExportImportRouteRow = {
  active: boolean | null
  createdAt: unknown
  description: string | null
  importRouteId: string
  name: string | null
  route: string
  updatedAt: unknown
}

type ProjectTransferExportProjectImportRouteRow = {
  createdAt: unknown
  importRouteId: string
  projectImportRouteId: string
  sourceProjectId: string
  updatedAt: unknown
}

type ProjectTransferExportArticleIdentifierRow = {
  articleId: string
  inputKind: ArticleIdentifierInputKind
  source: string
  value: unknown
}

type ProjectTransferExportArticleRow = {
  articleAuthors: unknown
  articleCreatedAt: unknown
  articleId: string | null
  articleSummary: string | null
  articleTitle: string
  articleUpdatedAt: unknown
  articleVersion: number | null
  arxivId: string | null
  biorxivId: string | null
  canonicalArticleId: string | null
  canonicalOriginalData: unknown
  canonicalSourceMetadata: unknown
  contentHash: string | null
  createdAt: unknown
  doi: string | null
  fullText: string | null
  fullTextAssets: unknown
  fullTextCharCount: number | null
  fullTextConversionAttempts: number | null
  fullTextConversionError: string | null
  fullTextConversionMetadata: unknown
  fullTextConversionModelId: string | null
  fullTextConversionStatus: string | null
  fullTextFetchedAt: unknown
  fullTextHtml: string | null
  fullTextOriginalFormat: string | null
  fullTextPdf: string | null
  fullTextSource: string | null
  importRoute: string | null
  medrxivId: string | null
  originalData: unknown
  publicationStatus: string | null
  pubmedId: string | null
  scopedImportMetadata: unknown
  scopedRawPayload: unknown
  selectedExternalArticleId: string | null
  selectedImportRecordId: string | null
  selectedImportRoute: string | null
  selectedImportRouteId: string | null
  selectedSourceKind: string | null
  selectedSourceRecordHash: string | null
  selectedSourceRecordKey: string | null
  sourceMetadata: unknown
  updatedAt: unknown
  url: string | null
}

type ProjectTransferExportArticleImportRouteRow = {
  articleId: string
  createdAt: unknown
  externalArticleId: string | null
  importMetadata: unknown
  importRouteId: string
  importRunId: string | null
  matchMetadata: unknown
  rawPayload: unknown
  sourceArticleImportRouteId: string
  sourceKind: string | null
  sourceRecordHash: string | null
  sourceRecordKey: string | null
  updatedAt: unknown
}

type ProjectTransferExportProjectArticleRow = {
  articleId: string
  createdAt: unknown
  importedFromProjectId: string | null
  projectArticleId: string
  sourceProjectId: string
  updatedAt: unknown
}

type ProjectTransferExportJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: unknown
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number | null
  createdAt: unknown
  deleteGeneration: number | null
  deletedAt: unknown
  explanation: string | null
  isAnswered: boolean | null
  judgmentId: string
  modelId: string
  projectId: string | null
  promptId: string
  quotes: unknown
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  updatedAt: unknown
  useAbstract: boolean | null
  useFulltext: boolean | null
  useFulltextNoImages: boolean | null
  useTitle: boolean | null
}

type ProjectTransferExportAmbiguousJudgmentKeyRow = {
  articleId: string
  modelId: string
  promptId: string
  sourceJudgmentIds: unknown
  visibleRowCount: number | null
}

type ProjectTransferExportJudgmentAssessmentRow = {
  articleId: string
  assessmentComment: string | null
  assessmentIsCorrect: boolean | null
  createdAt: unknown
  judgmentAssessmentId: string
  judgmentId: string
  modelId: string
  promptId: string
  projectId: string | null
  updatedAt: unknown
}

type ProjectTransferExportHumanJudgmentRow = {
  answer: string | null
  articleId: string
  comment: string | null
  createdAt: unknown
  humanJudgmentId: string
  isAnswered: boolean | null
  promptId: string
  sourceProjectId: string | null
  updatedAt: unknown
}

type ProjectTransferExportHumanJudgmentSummaryRow = {
  answer: 'yes' | 'no' | 'maybe' | null
  articleId: string
  createdAt: unknown
  humanJudgmentSummaryId: string
  origin: 'covidence_import' | 'manual_override'
  sourceProjectId: string
  updatedAt: unknown
}

type ProjectTransferExportReviewRow = {
  articleId: string
  createdAt: unknown
  opened: boolean | null
  reviewId: string
  reviewedAbstract: boolean | null
  reviewedAbstractComment: string | null
  reviewedAppendix: boolean | null
  reviewedAppendixComment: string | null
  reviewedConclusion: boolean | null
  reviewedConclusionComment: string | null
  reviewedDiscussion: boolean | null
  reviewedDiscussionComment: string | null
  reviewedIntro: boolean | null
  reviewedIntroComment: string | null
  reviewedMethod: boolean | null
  reviewedMethodComment: string | null
  reviewedOther: boolean | null
  reviewedOtherComment: string | null
  reviewedResults: boolean | null
  reviewedResultsComment: string | null
  reviewedTitle: boolean | null
  reviewedTitleComment: string | null
  sourceProjectId: string
  updatedAt: unknown
}

type ProjectTransferExportProviderConnectionRow = {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  createdAt: unknown
  enabled: boolean | null
  label: string
  lastCheckedAt: unknown
  lastError: string | null
  maxInflightRequests: number | null
  providerConnectionId: string
  providerKind: string
  secretRef: string | null
  updatedAt: unknown
}

type ProjectTransferExportModelRow = {
  createdAt: unknown
  displayName: string | null
  enabled: boolean | null
  metadataJson: unknown
  modelId: string
  name: string
  providerConnectionId: string
  remoteModelId: string | null
  source: string | null
  updatedAt: unknown
  variant: string | null
  version: string | null
}

type ProjectTransferExportContext = {
  articleImportRouteRows: ProjectTransferExportArticleImportRouteRow[]
  articleRows: ProjectTransferExportArticlePayloadRecord[]
  humanJudgmentRows: ProjectTransferExportHumanJudgmentRow[]
  humanJudgmentSummaryRows: ProjectTransferExportHumanJudgmentSummaryRow[]
  importRouteRows: ProjectTransferExportImportRouteRow[]
  judgmentAssessmentRows: ProjectTransferExportJudgmentAssessmentRow[]
  judgmentRows: ProjectTransferExportJudgmentRow[]
  modelRows: ProjectTransferExportModelRow[]
  project: ProjectTransferExportSourceProjectSettings
  projectArticleRows: ProjectTransferExportProjectArticleRow[]
  projectImportRouteRows: ProjectTransferExportProjectImportRouteRow[]
  projectPromptRows: ProjectTransferExportProjectPromptRow[]
  providerConnectionRows: ProjectTransferExportProviderConnectionRow[]
  reviewRows: ProjectTransferExportReviewRow[]
  warnings: ProjectTransferManifestWarning[]
}

type ProjectTransferExportArticlePayloadRecord = ProjectTransferPayloadRecord
  & ProjectTransferArticleIdentifierSource & {
    articleTitle: string
    identifierInputs: ArticleIdentifierInput[]
    sourceArticleId: string
  }

export type ProjectTransferExportPayloadAssembly = {
  assetEntries: ProjectTransferExportAssetEntry[]
  payloads: ProjectTransferPayloadByKey
  warnings: ProjectTransferManifestWarning[]
}

export type ProjectTransferExportStagedPayloadFile = {
  byteLength: number
  checksumSha256: string
  filePath: string
  format: ProjectTransferPayloadFormat
  path: string
  recordCount: number
}

export type ProjectTransferExportStagedPayloadRows = {
  assetReferences: ProjectTransferExportAssetReferenceInput[]
  payloadFiles: Partial<Record<ProjectTransferPayloadKey, ProjectTransferExportStagedPayloadFile>>
  payloads: ProjectTransferPayloadByKey
  warnings: ProjectTransferManifestWarning[]
}

export type ProjectTransferExportStagedPayloadAssembly = ProjectTransferExportPayloadAssembly & {
  payloadFiles: Record<ProjectTransferPayloadKey, ProjectTransferExportStagedPayloadFile>
}

export type ProjectTransferExportSerializedPayloads = Record<ProjectTransferPayloadKey, string>

export type ProjectTransferExportPreflightEstimate = {
  assetBytes: number
  packageBytes: number
  stagedPayloadBytes: number
}
export type ProjectTransferExportSummary = {
  articleCount: number
  humanJudgmentCount: number
  judgmentCount: number
  promptHumanJudgmentCount: number
  summaryHumanJudgmentCount: number
}

type ProjectTransferExportIdentifierOmission = {inputKind: ArticleIdentifierInputKind; rawValue: string; source: string}

type ProjectTransferExportNormalizedArticleIdentifiers = ReturnType<
  typeof getProjectTransferNormalizedArticleIdentifiers
>

type ProjectTransferExportRejectedIdentifier = ProjectTransferExportNormalizedArticleIdentifiers['rejected'][number]

type ProjectTransferExportIdentifierConflict = ProjectTransferExportNormalizedArticleIdentifiers['conflicts'][number]

type ProjectTransferExportArticleIdentifierPayloadField = 'arxivId' | 'biorxivId' | 'doi' | 'medrxivId' | 'pubmedId'

const articleIdentifierPayloadFieldBySource: Partial<
  Record<string, ProjectTransferExportArticleIdentifierPayloadField>
> = {arxivId: 'arxivId', biorxivId: 'biorxivId', doi: 'doi', medrxivId: 'medrxivId', pubmedId: 'pubmedId'}

const providerSecretRedaction = {
  action: 'redacted',
  code: 'providerSecretRedacted' as const,
  jsonPointer: '/secretRef',
  message: 'Provider authentication secret reference was redacted from the package payload.',
  scope: 'providerConnections',
  severity: 'warning' as const,
}

const currentReviewRowsInputSignatureProvenance = {kind: 'currentReviewRows' as const, version: 1 as const}
const projectTransferInputSignatureVersion = 1 as const
const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)
const judgmentInvocationTemperature = 0.2
const judgmentMaxRetries = 2
const singlePromptOutputSchema = {
  additionalProperties: false,
  properties: {
    answer: {anyOf: [{type: 'string'}, {items: {type: 'string'}, type: 'array'}]},
    explanation: {type: 'string'},
    quotes: {anyOf: [{items: {type: 'string'}, type: 'array'}, {type: 'null'}]},
  },
  required: ['answer', 'explanation', 'quotes'],
  type: 'object',
}
const singlePromptEvidenceOutputSchema = {
  additionalProperties: false,
  properties: {facts: {items: {type: 'string'}, type: 'array'}, quotes: {items: {type: 'string'}, type: 'array'}},
  required: ['facts', 'quotes'],
  type: 'object',
}
const reviewedSectionContractVersion = 1 as const
const articleRawJsonOmissionThresholdChars = 64 * 1024 * 1024
const defaultRawArticleProvenanceMode: ProjectTransferRawArticleProvenanceMode = 'omit'
const textEncoder = new TextEncoder()
const rawArticleProvenanceFields = [
  'canonicalOriginalData',
  'canonicalSourceMetadata',
  'originalData',
  'scopedImportMetadata',
  'scopedRawPayload',
  'sourceMetadata',
] as const

const getDatabase = (options: ProjectTransferExportQueryOptions = {}) => {
  return options.database ?? getAppDatabaseService()
}

const getIsoDateValue = (value: unknown) => {
  return getDateValue(value)?.toISOString() ?? null
}

const getJsonRecordValue = (value: unknown) => {
  const parsed = getJsonValue(value)

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

const getJsonArrayValue = (value: unknown): unknown[] => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed) ? (parsed as unknown[]) : []
}

const getStringArrayValue = (value: unknown) => {
  return getJsonArrayValue(value).filter((entry): entry is string => {
    return typeof entry === 'string'
  })
}

const getStringValue = (value: unknown) => {
  return typeof value === 'string' ? value : null
}

const getNumberValue = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getRawArticleProvenanceMode = (
  mode?: ProjectTransferRawArticleProvenanceMode,
): ProjectTransferRawArticleProvenanceMode => {
  return mode ?? defaultRawArticleProvenanceMode
}

const getQueryNumberValue = (value: unknown) => {
  const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0

  return Number.isFinite(numericValue) ? numericValue : 0
}

const getDigestValue = (value: unknown) => {
  return getProjectTransferSha256Checksum(typeof value === 'string' ? value : getProjectTransferCanonicalJson(value))
}

const getNullableDigestValue = (value: unknown) => {
  return value === null || value === undefined ? null : getDigestValue(value)
}

const getSignatureTextDigest = (value: unknown) => {
  const text = getStringValue(value)

  return text === null ? null : getDigestValue(text)
}

const getUniqueValues = (values: Array<string | null | undefined>) => {
  return Array.from(
    new Set(
      values.filter((value): value is string => {
        return typeof value === 'string' && value.trim() !== ''
      }),
    ),
  )
}

const getRowsById = <TRow extends Record<string, unknown>>(rows: TRow[], idField: keyof TRow) => {
  return rows.reduce<Record<string, TRow>>((rowMap, row) => {
    const id = row[idField]

    return typeof id === 'string' ? {...rowMap, [id]: row} : rowMap
  }, {})
}

const getRowsByMany = <TRow>(rows: TRow[], getKey: (row: TRow) => string) => {
  return rows.reduce<Record<string, TRow[]>>((rowMap, row) => {
    const key = getKey(row)
    const existingRows = rowMap[key] ?? []

    return {...rowMap, [key]: [...existingRows, row]}
  }, {})
}

const getProjectTransferExportPayloadRecordCount = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  payload: ProjectTransferPayloadByKey[TKey],
) => {
  return key === 'project'
    ? 1
    : key === 'assetManifest'
      ? (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
      : Array.isArray(payload)
        ? payload.length
        : 0
}

const getStagedPayloadFilePath = (rootPath: string, key: ProjectTransferPayloadKey) => {
  return join(rootPath, projectTransferPayloadPathByKey[key])
}

const writeStagedPayloadBytes = async (
  stream: WriteStream,
  state: {byteLength: number; hash: ReturnType<typeof createHash>},
  text: string,
) => {
  const bytes = textEncoder.encode(text)

  state.hash.update(bytes)
  state.byteLength += bytes.byteLength

  if (!stream.write(bytes)) {
    await once(stream, 'drain')
  }
}

const closeStagedPayloadStream = async (stream: WriteStream) => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error)
    }
    stream.once('error', onError)
    stream.end(() => {
      stream.off('error', onError)
      resolve()
    })
  })
}

const writeStagedPayloadNdjsonFile = async <TKey extends ProjectTransferPayloadKey>({
  filePath,
  key,
  records,
}: {
  filePath: string
  key: TKey
  records: unknown[]
}) => {
  const stream = createWriteStream(filePath)
  const state = {byteLength: 0, hash: createHash('sha256')}

  try {
    await records.reduce<Promise<void>>(async (previous, record, index) => {
      await previous
      await writeStagedPayloadBytes(stream, state, `${serializeProjectTransferPayloadNdjsonRow(key, record, index)}\n`)
    }, Promise.resolve())
    await closeStagedPayloadStream(stream)
  } catch (error) {
    stream.destroy()
    throw error
  }

  return {
    byteLength: state.byteLength,
    checksumSha256: state.hash.digest('hex'),
    filePath,
    format: 'ndjson' as const,
    path: projectTransferPayloadPathByKey[key],
    recordCount: records.length,
  }
}

const writeStagedPayloadJsonFile = async <TKey extends ProjectTransferPayloadKey>({
  filePath,
  key,
  payload,
}: {
  filePath: string
  key: TKey
  payload: ProjectTransferPayloadByKey[TKey]
}) => {
  const serialized = serializeProjectTransferPayload(key, payload)
  const bytes = textEncoder.encode(serialized)

  await globalThis.Bun.write(filePath, bytes)

  return {
    byteLength: bytes.byteLength,
    checksumSha256: getProjectTransferSha256Checksum(bytes),
    filePath,
    format: 'json' as const,
    path: projectTransferPayloadPathByKey[key],
    recordCount: getProjectTransferExportPayloadRecordCount(key, payload),
  }
}

const writeProjectTransferExportStagedPayloadFile = async <TKey extends ProjectTransferPayloadKey>({
  key,
  payload,
  rootPath,
}: {
  key: TKey
  payload: ProjectTransferPayloadByKey[TKey]
  rootPath: string
}): Promise<ProjectTransferExportStagedPayloadFile> => {
  const filePath = getStagedPayloadFilePath(rootPath, key)
  const format = projectTransferPayloadFormatByKey[key]

  await mkdir(dirname(filePath), {recursive: true})

  return format === 'ndjson' && Array.isArray(payload)
    ? writeStagedPayloadNdjsonFile({filePath, key, records: payload})
    : writeStagedPayloadJsonFile({filePath, key, payload})
}

const writeProjectTransferExportStagedPayloadFiles = async ({
  keys,
  payloads,
  rootPath,
}: {
  keys: ProjectTransferPayloadKey[]
  payloads: ProjectTransferPayloadByKey
  rootPath: string
}) => {
  return keys.reduce<Promise<Partial<Record<ProjectTransferPayloadKey, ProjectTransferExportStagedPayloadFile>>>>(
    async (previousFiles, key) => {
      const files = await previousFiles
      const file = await writeProjectTransferExportStagedPayloadFile({key, payload: payloads[key], rootPath})

      return {...files, [key]: file}
    },
    Promise.resolve({}),
  )
}

const getProjectTransferExportEstimateTextLengthSql = (expression: string) => {
  return `LENGTH(COALESCE(CAST(${expression} AS VARCHAR), ''))`
}

const getProjectTransferExportEstimateTextLengthSumSql = (expressions: string[]) => {
  return expressions.map(getProjectTransferExportEstimateTextLengthSql).join(' + ')
}

const getProjectTransferExportEstimateQuerySql = (fromSql: string, expressions: string[]) => {
  return `
    SELECT
      COUNT(*) AS rowCount,
      COALESCE(SUM(${getProjectTransferExportEstimateTextLengthSumSql(expressions)}), 0) AS textChars
    ${fromSql}
  `
}

const getProjectTransferExportScopedArticleCteSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    project_transfer_source_project AS (
      SELECT *
      FROM app.project
      WHERE id = ${projectLiteral}
      LIMIT 1
    ),
    project_transfer_route_scope_article AS (
      SELECT air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      INNER JOIN app.article article ON article.id = air.article_id
      INNER JOIN project_transfer_source_project project ON project.id = pir.project_id
      WHERE pir.project_id = ${projectLiteral}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ),
    project_transfer_curated_scope_article AS (
      SELECT pa.article_id
      FROM app.project_article pa
      INNER JOIN app.article article ON article.id = pa.article_id
      INNER JOIN project_transfer_source_project project ON project.id = pa.project_id
      WHERE pa.project_id = ${projectLiteral}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ),
    project_transfer_scope_article AS (
      SELECT article_id FROM project_transfer_route_scope_article
      UNION
      SELECT article_id FROM project_transfer_curated_scope_article
    )
  `
}

const getProjectTransferExportJudgmentCandidateWhereSql = () => {
  return `
    scope.article_id = j.article_id
    AND project_prompt.project_id = project.id
    AND project_prompt.enabled = TRUE
    AND j.prompt_id = project_prompt.prompt_id
    AND (project.model_id IS NULL OR j.model_id = project.model_id)
    AND j.use_title = project.use_title
    AND j.use_abstract = project.use_abstract
    AND j.use_fulltext = project.use_fulltext
    AND j.use_fulltext_no_images = project.use_fulltext_no_images
    AND j.deleted_at IS NULL
  `
}

const getProjectTransferExportAnsweredJudgmentCandidateWhereSql = () => {
  return `
    ${getProjectTransferExportJudgmentCandidateWhereSql()}
    AND j.is_answered = TRUE
  `
}

const getProjectTransferExportAmbiguousJudgmentCteSql = () => {
  return `
    project_transfer_ambiguous_judgment_visible_key AS (
      SELECT
        j.article_id,
        j.prompt_id,
        j.model_id,
        j.use_title,
        j.use_abstract,
        j.use_fulltext,
        j.use_fulltext_no_images
      FROM app.judgment j
      INNER JOIN project_transfer_scope_article scope ON scope.article_id = j.article_id
      INNER JOIN project_transfer_source_project project ON TRUE
      INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
      WHERE ${getProjectTransferExportAnsweredJudgmentCandidateWhereSql()}
      GROUP BY
        j.article_id,
        j.prompt_id,
        j.model_id,
        j.use_title,
        j.use_abstract,
        j.use_fulltext,
        j.use_fulltext_no_images
      HAVING COUNT(*) > 1
    )
  `
}

const getProjectTransferExportJudgmentAmbiguityJoinSql = () => {
  return `
    ambiguous.article_id = j.article_id
    AND ambiguous.prompt_id = j.prompt_id
    AND ambiguous.model_id = j.model_id
    AND ambiguous.use_title = j.use_title
    AND ambiguous.use_abstract = j.use_abstract
    AND ambiguous.use_fulltext = j.use_fulltext
    AND ambiguous.use_fulltext_no_images = j.use_fulltext_no_images
  `
}

const getProjectTransferExportSettingsValue = (
  row: {
    dateFrom: unknown
    dateTo: unknown
    humanJudgmentMode: 'prompt' | 'summary' | null
    useAbstract: boolean | null
    useFulltext: boolean | null
    useFulltextNoImages: boolean | null
    useTitle: boolean | null
  },
  label: string,
) => {
  const dateFrom = getDateValue(row.dateFrom)
  const dateTo = getDateValue(row.dateTo)
  const useFulltext = row.useFulltext ?? false
  const useFulltextNoImages = row.useFulltextNoImages ?? false

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error(`Project transfer export invalid ${label}: date_from must be before or equal to date_to`)
  }

  if (useFulltext && useFulltextNoImages) {
    throw new Error(
      `Project transfer export invalid ${label}: use_fulltext and use_fulltext_no_images cannot both be enabled`,
    )
  }

  return {
    dateFrom,
    dateTo,
    humanJudgmentMode: row.humanJudgmentMode ?? 'prompt',
    useAbstract: row.useAbstract ?? true,
    useFulltext,
    useFulltextNoImages,
    useTitle: row.useTitle ?? true,
  }
}

export const getProjectTransferExportSourceProjectSettings = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
): Promise<ProjectTransferExportSourceProjectSettings> => {
  const [row] = await getDatabase(options).queryJson<{
    archived: boolean | null
    createdAt: unknown
    dateFrom: unknown
    dateTo: unknown
    description: string | null
    humanJudgmentMode: 'prompt' | 'summary' | null
    modelId: string | null
    name: string
    sourceProjectId: string
    updatedAt: unknown
    useAbstract: boolean | null
    useFulltext: boolean | null
    useFulltextNoImages: boolean | null
    useTitle: boolean | null
  }>(`
    SELECT
      id AS sourceProjectId,
      name,
      description,
      model_id AS modelId,
      human_judgment_mode AS humanJudgmentMode,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      date_from AS dateFrom,
      date_to AS dateTo,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  if (!row) {
    throw new Error(`Project transfer export source project not found: ${projectId}`)
  }

  const settings = getProjectTransferExportSettingsValue(row, `project ${projectId}`)

  return {
    ...settings,
    archived: row.archived ?? false,
    createdAt: getDateValue(row.createdAt),
    description: row.description,
    modelId: row.modelId,
    name: row.name,
    sourceProjectId: row.sourceProjectId,
    updatedAt: getDateValue(row.updatedAt),
  }
}

const getProjectTransferExportProjectPromptRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportProjectPromptRow>(`
    SELECT
      pp.id AS projectPromptId,
      pp.project_id AS sourceProjectId,
      pp.prompt_id AS promptId,
      pp.prompt_order AS "order",
      pp.archived AS archived,
      pp.origin_project_id AS originProjectId,
      pp.enabled AS enabled,
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel,
      pp.created_at AS projectPromptCreatedAt,
      pp.updated_at AS projectPromptUpdatedAt,
      p.original_text AS originalText,
      p.transformed_text AS transformedText,
      p.archived AS promptArchived,
      p.prompt_heading AS promptHeading,
      p.type AS type,
      p.content_hash AS contentHash,
      p.created_at AS promptCreatedAt,
      p.updated_at AS promptUpdatedAt
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = ${getSqlLiteral(projectId)}
    ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC, p.id ASC
  `)
}

const getProjectTransferExportImportRouteRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportImportRouteRow>(`
    SELECT
      ir.id AS importRouteId,
      ir.route,
      ir.name,
      ir.description,
      ir.active,
      ir.created_at AS createdAt,
      ir.updated_at AS updatedAt
    FROM app.project_import_route pir
    INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
    WHERE pir.project_id = ${getSqlLiteral(projectId)}
    ORDER BY ir.route ASC, ir.id ASC
  `)
}

const getProjectTransferExportProjectImportRouteRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportProjectImportRouteRow>(`
    SELECT
      id AS projectImportRouteId,
      project_id AS sourceProjectId,
      import_route_id AS importRouteId,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_import_route
    WHERE project_id = ${getSqlLiteral(projectId)}
    ORDER BY created_at ASC, id ASC
  `)
}

const getProjectTransferExportArticleIdentifierRows = async (
  articleIds: string[],
  database: AppQueryDatabaseService,
) => {
  return articleIds.length === 0
    ? []
    : database.queryJson<ProjectTransferExportArticleIdentifierRow>(`
      SELECT
        article_id AS articleId,
        kind AS inputKind,
        source,
        normalized_value AS value
      FROM app.article_identifier
      WHERE article_id IN (${articleIds.map(getSqlLiteral).join(', ')})
      ORDER BY article_id ASC, is_primary DESC, kind ASC, normalized_value ASC, id ASC
    `)
}

const getProjectTransferExportArticleRawJsonSelectSql = (includeRawArticleJson: boolean) => {
  return includeRawArticleJson
    ? {
        canonicalOriginalData: 'a.original_data',
        canonicalSourceMetadata: 'a.source_metadata',
        originalData: 'COALESCE(selected_import.raw_payload, a.original_data)',
        scopedImportMetadata: 'selected_import.import_metadata',
        scopedRawPayload: 'selected_import.raw_payload',
        selectedImportMetadata: 'air.import_metadata',
        selectedRawPayload: 'air.raw_payload',
        sourceMetadata: `
          CASE
            WHEN a.source_metadata IS NULL
              AND selected_import.import_metadata IS NULL
              THEN NULL
            ELSE json_merge_patch(
              COALESCE(a.source_metadata, CAST('{}' AS JSON)),
              COALESCE(selected_import.import_metadata, CAST('{}' AS JSON))
            )
          END
        `,
      }
    : {
        canonicalOriginalData: 'NULL',
        canonicalSourceMetadata: 'NULL',
        originalData: 'NULL',
        scopedImportMetadata: 'NULL',
        scopedRawPayload: 'NULL',
        selectedImportMetadata: 'NULL',
        selectedRawPayload: 'NULL',
        sourceMetadata: 'NULL',
      }
}

const getProjectTransferExportArticleRows = async (
  projectId: string,
  database: AppQueryDatabaseService,
  options: {includeFullText?: boolean; includeRawArticleJson?: boolean} = {},
) => {
  const fullTextSelectSql = options.includeFullText ? 'a.full_text' : 'NULL'
  const rawJsonSelectSql = getProjectTransferExportArticleRawJsonSelectSql(options.includeRawArticleJson ?? true)
  const articleRows = await database.queryJson<ProjectTransferExportArticleRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)},
    project_transfer_selected_article_import AS (
      SELECT *
      FROM (
        SELECT
          air.article_id,
          air.external_article_id,
          air.id,
          ${rawJsonSelectSql.selectedImportMetadata} AS import_metadata,
          ir.route AS import_route,
          air.import_route_id,
          ${rawJsonSelectSql.selectedRawPayload} AS raw_payload,
          air.source_kind,
          air.source_record_hash,
          air.source_record_key,
          ROW_NUMBER() OVER (
            PARTITION BY air.article_id
            ORDER BY
              CASE
                WHEN json_extract_string(air.import_metadata, '$.covidence.hasDuplicateStudyRecords') = 'true'
                  OR json_extract_string(air.import_metadata, '$.covidence.hasStudyDecisionConflict') = 'true'
                  THEN 0
                WHEN json_extract_string(air.import_metadata, '$.covidence.studyKey') IS NOT NULL THEN 1
                WHEN air.import_metadata IS NOT NULL THEN 2
                ELSE 3
              END ASC,
              CASE WHEN air.external_article_id IS NOT NULL THEN 0 ELSE 1 END ASC,
              CASE WHEN air.raw_payload IS NOT NULL THEN 0 ELSE 1 END ASC,
              air.import_route_id ASC,
              air.id ASC
          ) AS selected_rank
        FROM app.article_import_route air
        INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = air.article_id
        LEFT JOIN app.import_route ir ON ir.id = air.import_route_id
        WHERE pir.project_id = ${getSqlLiteral(projectId)}
      ) ranked_scoped_article_import
      WHERE selected_rank = 1
    )
    SELECT
      a.id AS canonicalArticleId,
      a.created_at AS createdAt,
      a.updated_at AS updatedAt,
      a.article_title AS articleTitle,
      TO_JSON(a.article_authors) AS articleAuthors,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt,
      COALESCE(selected_import.external_article_id, a.article_id) AS articleId,
      a.article_summary AS articleSummary,
      a.article_version AS articleVersion,
      a.arxiv_id AS arxivId,
      a.biorxiv_id AS biorxivId,
      a.medrxiv_id AS medrxivId,
      a.doi,
      a.pubmed_id AS pubmedId,
      a.url,
      a.full_text_fetched_at AS fullTextFetchedAt,
      ${fullTextSelectSql} AS fullText,
      a.full_text_html AS fullTextHtml,
      a.full_text_source AS fullTextSource,
      a.full_text_original_format AS fullTextOriginalFormat,
      a.full_text_pdf AS fullTextPdf,
      TO_JSON(a.full_text_assets) AS fullTextAssets,
      a.full_text_conversion_status AS fullTextConversionStatus,
      a.full_text_conversion_error AS fullTextConversionError,
      a.full_text_conversion_attempts AS fullTextConversionAttempts,
      a.full_text_conversion_model_id AS fullTextConversionModelId,
      TO_JSON(a.full_text_conversion_metadata) AS fullTextConversionMetadata,
      a.full_text_char_count AS fullTextCharCount,
      a.content_hash AS contentHash,
      COALESCE(selected_import.import_route, a.import_route) AS importRoute,
      ${rawJsonSelectSql.canonicalOriginalData} AS canonicalOriginalData,
      ${rawJsonSelectSql.originalData} AS originalData,
      ${rawJsonSelectSql.canonicalSourceMetadata} AS canonicalSourceMetadata,
      ${rawJsonSelectSql.scopedImportMetadata} AS scopedImportMetadata,
      ${rawJsonSelectSql.scopedRawPayload} AS scopedRawPayload,
      selected_import.external_article_id AS selectedExternalArticleId,
      selected_import.id AS selectedImportRecordId,
      selected_import.import_route_id AS selectedImportRouteId,
      selected_import.import_route AS selectedImportRoute,
      selected_import.source_kind AS selectedSourceKind,
      selected_import.source_record_key AS selectedSourceRecordKey,
      selected_import.source_record_hash AS selectedSourceRecordHash,
      ${rawJsonSelectSql.sourceMetadata} AS sourceMetadata,
      a.publication_status AS publicationStatus
    FROM app.article a
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = a.id
    LEFT JOIN project_transfer_selected_article_import selected_import ON selected_import.article_id = a.id
    ORDER BY a.article_created_at ASC NULLS LAST, a.id ASC
  `)
  const identifierRows = await getProjectTransferExportArticleIdentifierRows(
    articleRows.map((row) => {
      return row.canonicalArticleId ?? ''
    }),
    database,
  )
  const identifiersByArticleId = getRowsByMany(identifierRows, (row) => {
    return row.articleId
  })

  return articleRows.map((row) => {
    return getProjectTransferExportArticlePayloadRecord(row, identifiersByArticleId[row.canonicalArticleId ?? ''] ?? [])
  })
}

const getProjectTransferExportArticleRawJsonEstimate = async (
  projectId: string,
  database: AppQueryDatabaseService,
): Promise<ProjectTransferExportArticleRawJsonEstimate> => {
  const [row] = await database.queryJson<ProjectTransferExportArticleRawJsonEstimateRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)},
    project_transfer_selected_article_import AS (
      SELECT *
      FROM (
        SELECT
          air.article_id,
          air.import_metadata,
          air.raw_payload,
          ROW_NUMBER() OVER (
            PARTITION BY air.article_id
            ORDER BY
              CASE
                WHEN json_extract_string(air.import_metadata, '$.covidence.hasDuplicateStudyRecords') = 'true'
                  OR json_extract_string(air.import_metadata, '$.covidence.hasStudyDecisionConflict') = 'true'
                  THEN 0
                WHEN json_extract_string(air.import_metadata, '$.covidence.studyKey') IS NOT NULL THEN 1
                WHEN air.import_metadata IS NOT NULL THEN 2
                ELSE 3
              END ASC,
              CASE WHEN air.external_article_id IS NOT NULL THEN 0 ELSE 1 END ASC,
              CASE WHEN air.raw_payload IS NOT NULL THEN 0 ELSE 1 END ASC,
              air.import_route_id ASC,
              air.id ASC
          ) AS selected_rank
        FROM app.article_import_route air
        INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = air.article_id
        WHERE pir.project_id = ${getSqlLiteral(projectId)}
      ) ranked_scoped_article_import
      WHERE selected_rank = 1
    )
    SELECT
      COUNT(*) AS rowCount,
      COALESCE(SUM(
        COALESCE(LENGTH(CAST(a.original_data AS VARCHAR)), 0)
        + COALESCE(LENGTH(CAST(a.source_metadata AS VARCHAR)), 0)
        + COALESCE(LENGTH(CAST(selected_import.import_metadata AS VARCHAR)), 0)
        + COALESCE(LENGTH(CAST(selected_import.raw_payload AS VARCHAR)), 0)
      ), 0) AS estimatedChars
    FROM app.article a
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = a.id
    LEFT JOIN project_transfer_selected_article_import selected_import ON selected_import.article_id = a.id
  `)

  return {estimatedChars: getQueryNumberValue(row?.estimatedChars), rowCount: getQueryNumberValue(row?.rowCount)}
}

const getProjectTransferExportArticleRawJsonOmissionWarning = ({
  estimate,
  mode,
  thresholdChars,
}: {
  estimate: ProjectTransferExportArticleRawJsonEstimate
  mode: ProjectTransferRawArticleProvenanceMode
  thresholdChars: number
}): ProjectTransferManifestWarning => {
  return {
    action: 'omitted',
    code: 'payloadOmitted',
    details: {
      estimatedChars: estimate.estimatedChars,
      fields: [...rawArticleProvenanceFields],
      rawArticleProvenanceMode: mode,
      rowCount: estimate.rowCount,
      thresholdChars,
    },
    message:
      mode === 'omit'
        ? 'Article raw provenance JSON was omitted from the transfer payload by export option.'
        : 'Large article raw provenance JSON was omitted from the transfer payload.',
    scope: 'articles',
    severity: 'fidelity',
  }
}

const getProjectTransferExportArticleRawJsonDecision = ({
  estimate,
  mode,
  thresholdChars = articleRawJsonOmissionThresholdChars,
}: {
  estimate: ProjectTransferExportArticleRawJsonEstimate
  mode: ProjectTransferRawArticleProvenanceMode
  thresholdChars?: number
}): ProjectTransferExportArticleRawJsonDecision => {
  const includeRawArticleJson = mode === 'include'

  return includeRawArticleJson
    ? {includeRawArticleJson, rawArticleProvenanceMode: mode, warnings: []}
    : {
        includeRawArticleJson,
        rawArticleProvenanceMode: mode,
        warnings: [getProjectTransferExportArticleRawJsonOmissionWarning({estimate, mode, thresholdChars})],
      }
}

const getProjectTransferExportArticleImportRouteRows = async (
  projectId: string,
  database: AppQueryDatabaseService,
  options: {includeRawArticleJson?: boolean} = {},
) => {
  const rawJsonSelectSql = getProjectTransferExportArticleRawJsonSelectSql(options.includeRawArticleJson ?? true)

  return database.queryJson<ProjectTransferExportArticleImportRouteRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      air.id AS sourceArticleImportRouteId,
      air.article_id AS articleId,
      air.import_route_id AS importRouteId,
      air.external_article_id AS externalArticleId,
      air.source_kind AS sourceKind,
      ${rawJsonSelectSql.selectedImportMetadata} AS importMetadata,
      TO_JSON(air.match_metadata) AS matchMetadata,
      air.import_run_id AS importRunId,
      air.source_record_key AS sourceRecordKey,
      air.source_record_hash AS sourceRecordHash,
      ${rawJsonSelectSql.selectedRawPayload} AS rawPayload,
      air.created_at AS createdAt,
      air.updated_at AS updatedAt
    FROM app.article_import_route air
    INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = air.article_id
    WHERE pir.project_id = ${getSqlLiteral(projectId)}
    ORDER BY air.article_id ASC, air.import_route_id ASC, air.id ASC
  `)
}

const getProjectTransferExportProjectArticleRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportProjectArticleRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      pa.id AS projectArticleId,
      pa.project_id AS sourceProjectId,
      pa.article_id AS articleId,
      pa.imported_from_project_id AS importedFromProjectId,
      pa.created_at AS createdAt,
      pa.updated_at AS updatedAt
    FROM app.project_article pa
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = pa.article_id
    WHERE pa.project_id = ${getSqlLiteral(projectId)}
    ORDER BY pa.created_at ASC, pa.id ASC
  `)
}

const getProjectTransferExportAmbiguousJudgmentWarnings = async (
  projectId: string,
  database: AppQueryDatabaseService,
) => {
  const rows = await database.queryJson<ProjectTransferExportAmbiguousJudgmentKeyRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      j.article_id AS articleId,
      j.prompt_id AS promptId,
      j.model_id AS modelId,
      COUNT(*)::INTEGER AS visibleRowCount,
      TO_JSON(list(j.id ORDER BY j.delete_generation ASC, j.created_at ASC, j.id ASC)) AS sourceJudgmentIds
    FROM app.judgment j
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = j.article_id
    INNER JOIN project_transfer_source_project project ON TRUE
    INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
    WHERE ${getProjectTransferExportAnsweredJudgmentCandidateWhereSql()}
    GROUP BY
      j.article_id,
      j.prompt_id,
      j.model_id,
      j.use_title,
      j.use_abstract,
      j.use_fulltext,
      j.use_fulltext_no_images
    HAVING COUNT(*) > 1
    ORDER BY j.article_id ASC, j.prompt_id ASC, j.model_id ASC
  `)

  return rows.map<ProjectTransferManifestWarning>((row) => {
    return {
      action: 'omitted',
      code: 'ambiguousJudgmentVisibleKey',
      details: {
        sourceArticleId: row.articleId,
        sourceJudgmentIds: getStringArrayValue(row.sourceJudgmentIds),
        sourceModelId: row.modelId,
        sourcePromptId: row.promptId,
        visibleRowCount: Number(row.visibleRowCount ?? 0),
      },
      jsonPointer: '/judgments',
      message: 'Omitted active source judgments with an ambiguous review-visible natural key.',
      scope: 'judgments',
      severity: 'fidelity',
    }
  })
}

const getProjectTransferExportChunkedJudgmentWarnings = (rows: ProjectTransferExportJudgmentRow[]) => {
  const chunkedRows = rows.filter((row) => {
    return row.chunkingStrategy !== null
  })

  return chunkedRows.length === 0
    ? []
    : [
        {
          action: 'omitted',
          code: 'chunkedJudgmentInputProofMissing',
          details: {
            omittedJudgmentCount: chunkedRows.length,
            sourceJudgmentIds: chunkedRows.map((row) => {
              return row.judgmentId
            }),
          },
          jsonPointer: '/judgments',
          message: 'Omitted chunked source judgments without durable final-prompt and evidence proof.',
          scope: 'judgments',
          severity: 'fidelity' as const,
        },
      ]
}

const getProjectTransferExportJudgmentRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportJudgmentRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)},
    ${getProjectTransferExportAmbiguousJudgmentCteSql()}
    SELECT
      j.id AS judgmentId,
      j.created_at AS createdAt,
      j.updated_at AS updatedAt,
      j.deleted_at AS deletedAt,
      j.article_id AS articleId,
      j.model_id AS modelId,
      j.prompt_id AS promptId,
      j.project_id AS projectId,
      j.use_title AS useTitle,
      j.use_abstract AS useAbstract,
      j.use_fulltext AS useFulltext,
      j.use_fulltext_no_images AS useFulltextNoImages,
      j.chunking_strategy AS chunkingStrategy,
      j.is_answered AS isAnswered,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray,
      j.confidence_original AS confidenceOriginal,
      j.explanation AS explanation,
      TO_JSON(j.quotes) AS quotes,
      j.delete_generation AS deleteGeneration,
      j.snapshot_project_id AS snapshotProjectId,
      j.snapshot_project_model_name AS snapshotProjectModelName
    FROM app.judgment j
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = j.article_id
    INNER JOIN project_transfer_source_project project ON TRUE
    INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
    LEFT JOIN project_transfer_ambiguous_judgment_visible_key ambiguous
      ON ${getProjectTransferExportJudgmentAmbiguityJoinSql()}
    WHERE ${getProjectTransferExportAnsweredJudgmentCandidateWhereSql()}
      AND ambiguous.article_id IS NULL
    ORDER BY j.article_id ASC, project_prompt.prompt_order ASC NULLS LAST, j.created_at DESC, j.id ASC
  `)
}

const getProjectTransferExportJudgmentAssessmentRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportJudgmentAssessmentRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)},
    ${getProjectTransferExportAmbiguousJudgmentCteSql()},
    project_transfer_export_judgment AS (
      SELECT j.*
      FROM app.judgment j
      INNER JOIN project_transfer_scope_article scope ON scope.article_id = j.article_id
      INNER JOIN project_transfer_source_project project ON TRUE
      INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
      LEFT JOIN project_transfer_ambiguous_judgment_visible_key ambiguous
        ON ${getProjectTransferExportJudgmentAmbiguityJoinSql()}
      WHERE ${getProjectTransferExportAnsweredJudgmentCandidateWhereSql()}
        AND ambiguous.article_id IS NULL
    )
    SELECT
      ja.id AS judgmentAssessmentId,
      ja.judgment_id AS judgmentId,
      j.article_id AS articleId,
      j.prompt_id AS promptId,
      j.model_id AS modelId,
      j.project_id AS projectId,
      ja.assessment_is_correct AS assessmentIsCorrect,
      ja.assessment_comment AS assessmentComment,
      ja.created_at AS createdAt,
      ja.updated_at AS updatedAt
    FROM app.judgment_assessment ja
    INNER JOIN project_transfer_export_judgment j ON j.id = ja.judgment_id
    ORDER BY j.article_id ASC, j.prompt_id ASC, ja.created_at ASC, ja.id ASC
  `)
}

const getProjectTransferExportHumanJudgmentRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportHumanJudgmentRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      jh.id AS humanJudgmentId,
      jh.project_id AS sourceProjectId,
      jh.article_id AS articleId,
      jh.prompt_id AS promptId,
      jh.is_answered AS isAnswered,
      jh.answer,
      jh.comment,
      jh.created_at AS createdAt,
      jh.updated_at AS updatedAt
    FROM app.judgment_human jh
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = jh.article_id
    INNER JOIN app.project_prompt pp
      ON pp.project_id = ${getSqlLiteral(projectId)}
     AND pp.prompt_id = jh.prompt_id
    WHERE jh.project_id = ${getSqlLiteral(projectId)}
    ORDER BY jh.article_id ASC, pp.prompt_order ASC NULLS LAST, jh.updated_at DESC, jh.id ASC
  `)
}

const getProjectTransferExportHumanJudgmentSummaryRows = async (
  projectId: string,
  database: AppQueryDatabaseService,
) => {
  return database.queryJson<ProjectTransferExportHumanJudgmentSummaryRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      jhs.id AS humanJudgmentSummaryId,
      jhs.project_id AS sourceProjectId,
      jhs.article_id AS articleId,
      jhs.answer,
      jhs.origin,
      jhs.created_at AS createdAt,
      jhs.updated_at AS updatedAt
    FROM app.judgment_human_summary jhs
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = jhs.article_id
    WHERE jhs.project_id = ${getSqlLiteral(projectId)}
    ORDER BY jhs.article_id ASC, jhs.updated_at DESC, jhs.id ASC
  `)
}

const getProjectTransferExportReviewRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportReviewRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      r.id AS reviewId,
      r.project_id AS sourceProjectId,
      r.article_id AS articleId,
      r.opened,
      r.reviewed_title AS reviewedTitle,
      r.reviewed_title_comment AS reviewedTitleComment,
      r.reviewed_abstract AS reviewedAbstract,
      r.reviewed_abstract_comment AS reviewedAbstractComment,
      r.reviewed_intro AS reviewedIntro,
      r.reviewed_intro_comment AS reviewedIntroComment,
      r.reviewed_method AS reviewedMethod,
      r.reviewed_method_comment AS reviewedMethodComment,
      r.reviewed_results AS reviewedResults,
      r.reviewed_results_comment AS reviewedResultsComment,
      r.reviewed_discussion AS reviewedDiscussion,
      r.reviewed_discussion_comment AS reviewedDiscussionComment,
      r.reviewed_conclusion AS reviewedConclusion,
      r.reviewed_conclusion_comment AS reviewedConclusionComment,
      r.reviewed_appendix AS reviewedAppendix,
      r.reviewed_appendix_comment AS reviewedAppendixComment,
      r.reviewed_other AS reviewedOther,
      r.reviewed_other_comment AS reviewedOtherComment,
      r.created_at AS createdAt,
      r.updated_at AS updatedAt
    FROM app.review r
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = r.article_id
    WHERE r.project_id = ${getSqlLiteral(projectId)}
    ORDER BY r.article_id ASC, r.created_at ASC, r.id ASC
  `)
}

const getProjectTransferExportModelRows = async (modelIds: string[], database: AppQueryDatabaseService) => {
  return modelIds.length === 0
    ? []
    : database.queryJson<ProjectTransferExportModelRow>(`
      SELECT
        id AS modelId,
        provider_connection_id AS providerConnectionId,
        name,
        remote_model_id AS remoteModelId,
        display_name AS displayName,
        variant,
        CASE
          WHEN json_extract(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model') IS NOT NULL
          THEN json_extract_string(metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.version')
          ELSE variant
        END AS version,
        source,
        enabled,
        TO_JSON(metadata_json) AS metadataJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.model
      WHERE id IN (${modelIds.map(getSqlLiteral).join(', ')})
      ORDER BY provider_connection_id ASC, remote_model_id ASC NULLS LAST, name ASC, id ASC
    `)
}

const getProjectTransferExportProviderConnectionRows = async (
  providerConnectionIds: string[],
  database: AppQueryDatabaseService,
) => {
  return providerConnectionIds.length === 0
    ? []
    : database.queryJson<ProjectTransferExportProviderConnectionRow>(`
      SELECT
        id AS providerConnectionId,
        provider_kind AS providerKind,
        label,
        enabled,
        auth_mode AS authMode,
        base_url AS baseURL,
        max_inflight_requests AS maxInflightRequests,
        TO_JSON(config_json) AS configJson,
        secret_ref AS secretRef,
        last_checked_at AS lastCheckedAt,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.provider_connection
      WHERE id IN (${providerConnectionIds.map(getSqlLiteral).join(', ')})
      ORDER BY provider_kind ASC, label ASC, id ASC
    `)
}

const getProjectTransferExportArticleSignature = (record: ProjectTransferExportArticlePayloadRecord) => {
  return {identifierKeys: getProjectTransferStrongIdentifierComparisonKeys(record), title: record.articleTitle}
}

const getProjectTransferExportArticleIdentifierPayloadField = (
  source: string,
): ProjectTransferExportArticleIdentifierPayloadField | null => {
  return articleIdentifierPayloadFieldBySource[source] ?? null
}

const getProjectTransferExportIdentifierRawValue = (value: unknown) => {
  return typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
}

const getProjectTransferExportIdentifierOmissionKey = (omission: ProjectTransferExportIdentifierOmission) => {
  return `${omission.inputKind}\u0000${omission.source}\u0000${omission.rawValue}`
}

const getProjectTransferExportIdentifierInputKey = (input: ArticleIdentifierInput) => {
  return getProjectTransferExportIdentifierOmissionKey({
    inputKind: input.inputKind,
    rawValue: getProjectTransferExportIdentifierRawValue(input.value),
    source: input.source,
  })
}

const getProjectTransferExportArticleIdentifierJsonPointer = (
  record: ProjectTransferExportArticlePayloadRecord,
  omission: ProjectTransferExportIdentifierOmission,
) => {
  const field = getProjectTransferExportArticleIdentifierPayloadField(omission.source)
  const inputIndex = record.identifierInputs.findIndex((input) => {
    return getProjectTransferExportIdentifierInputKey(input) === getProjectTransferExportIdentifierOmissionKey(omission)
  })

  return field !== null ? `/${field}` : inputIndex >= 0 ? `/identifierInputs/${inputIndex}` : '/identifierInputs'
}

const getProjectTransferExportArticleIdentifierWarning = ({
  code,
  details,
  jsonPointer,
  message,
  sourceArticleId,
}: {
  code: ProjectTransferPayloadWarning['code']
  details: unknown
  jsonPointer: string
  message: string
  sourceArticleId: string
}): ProjectTransferPayloadWarning => {
  return {
    action: 'omitted',
    code,
    details,
    jsonPointer,
    message,
    scope: 'articles',
    severity: 'warning',
    sourceRef: `article:${sourceArticleId}`,
  }
}

const getProjectTransferExportRejectedIdentifierOmission = (
  rejected: ProjectTransferExportRejectedIdentifier,
): ProjectTransferExportIdentifierOmission => {
  return {inputKind: rejected.inputKind, rawValue: rejected.rawValue, source: rejected.source}
}

const getProjectTransferExportConflictIdentifierOmissions = (
  conflict: ProjectTransferExportIdentifierConflict,
): ProjectTransferExportIdentifierOmission[] => {
  return conflict.candidates.map((candidate) => {
    return {inputKind: candidate.inputKind, rawValue: candidate.rawValue, source: candidate.source}
  })
}

const getUniqueProjectTransferExportIdentifierOmissions = (omissions: ProjectTransferExportIdentifierOmission[]) => {
  return Array.from(
    new Map(
      omissions.map((omission) => {
        return [getProjectTransferExportIdentifierOmissionKey(omission), omission]
      }),
    ).values(),
  )
}

const getProjectTransferExportRejectedIdentifierWarning = (
  record: ProjectTransferExportArticlePayloadRecord,
  rejected: ProjectTransferExportRejectedIdentifier,
) => {
  const omission = getProjectTransferExportRejectedIdentifierOmission(rejected)

  return getProjectTransferExportArticleIdentifierWarning({
    code: 'identifierRejected',
    details: {detail: rejected.detail, inputKind: rejected.inputKind, reason: rejected.reason, source: rejected.source},
    jsonPointer: getProjectTransferExportArticleIdentifierJsonPointer(record, omission),
    message: 'Rejected article identifier was omitted from transfer identity.',
    sourceArticleId: record.sourceArticleId,
  })
}

const getProjectTransferExportIdentifierConflictWarning = (
  record: ProjectTransferExportArticlePayloadRecord,
  conflict: ProjectTransferExportIdentifierConflict,
) => {
  return getProjectTransferExportArticleIdentifierWarning({
    code: 'identifierConflict',
    details: {
      candidateCount: conflict.candidates.length,
      kind: conflict.kind,
      normalizedValues: conflict.normalizedValues,
      reason: conflict.reason,
    },
    jsonPointer: '/signature/identifierKeys',
    message: 'Conflicting article identifiers were omitted from transfer identity.',
    sourceArticleId: record.sourceArticleId,
  })
}

const getProjectTransferExportArticleIdentifierWarnings = (
  record: ProjectTransferExportArticlePayloadRecord,
  normalized: ProjectTransferExportNormalizedArticleIdentifiers,
) => {
  return [
    ...normalized.rejected.map((rejected) => {
      return getProjectTransferExportRejectedIdentifierWarning(record, rejected)
    }),
    ...normalized.conflicts.map((conflict) => {
      return getProjectTransferExportIdentifierConflictWarning(record, conflict)
    }),
  ]
}

const getProjectTransferExportIdentifierOmittedFields = (omissions: ProjectTransferExportIdentifierOmission[]) => {
  return omissions.reduce<Partial<Record<ProjectTransferExportArticleIdentifierPayloadField, null>>>(
    (fields, omission) => {
      const field = getProjectTransferExportArticleIdentifierPayloadField(omission.source)

      return field === null ? fields : {...fields, [field]: null}
    },
    {},
  )
}

const getProjectTransferExportSanitizedIdentifierInputs = (
  inputs: ArticleIdentifierInput[],
  omissions: ProjectTransferExportIdentifierOmission[],
) => {
  const omissionKeys = new Set(omissions.map(getProjectTransferExportIdentifierOmissionKey))

  return inputs.filter((input) => {
    return !omissionKeys.has(getProjectTransferExportIdentifierInputKey(input))
  })
}

const getProjectTransferExportSanitizedArticleIdentifierRecord = (
  record: ProjectTransferExportArticlePayloadRecord,
): ProjectTransferExportArticlePayloadRecord => {
  const normalized = getProjectTransferNormalizedArticleIdentifiers(record)
  const omissions = getUniqueProjectTransferExportIdentifierOmissions([
    ...normalized.rejected.map(getProjectTransferExportRejectedIdentifierOmission),
    ...normalized.conflicts.flatMap(getProjectTransferExportConflictIdentifierOmissions),
  ])
  const warnings = getProjectTransferExportArticleIdentifierWarnings(record, normalized)
  const sanitizedRecord = {
    ...record,
    ...getProjectTransferExportIdentifierOmittedFields(omissions),
    identifierInputs: getProjectTransferExportSanitizedIdentifierInputs(record.identifierInputs, omissions),
  }
  const sanitizedRecordWithWarnings =
    warnings.length === 0 ? sanitizedRecord : {...sanitizedRecord, warnings: [...(record.warnings ?? []), ...warnings]}

  return {
    ...sanitizedRecordWithWarnings,
    signature: getProjectTransferExportArticleSignature(sanitizedRecordWithWarnings),
  }
}

const getProjectTransferExportArticleWarnings = (articles: ProjectTransferExportArticlePayloadRecord[]) => {
  return articles.flatMap((article) => {
    return article.warnings ?? []
  })
}

const getProjectTransferExportPromptSignature = (
  row: Pick<ProjectTransferExportProjectPromptRow, 'contentHash' | 'originalText'>,
) => {
  return {contentHash: row.contentHash, originalText: row.originalText}
}

const getProjectTransferExportImportRouteSignature = (row: Pick<ProjectTransferExportImportRouteRow, 'route'>) => {
  return {route: row.route}
}

const getProjectTransferExportProviderConnectionSignature = (
  row: Pick<ProjectTransferExportProviderConnectionRow, 'authMode' | 'baseURL' | 'configJson' | 'providerKind'>,
) => {
  return {
    authMode: row.authMode,
    baseURL: row.baseURL,
    configSignature: getJsonValue(row.configJson) ?? null,
    providerKind: row.providerKind,
  }
}

const getProjectTransferExportModelName = (row: Pick<ProjectTransferExportModelRow, 'name' | 'remoteModelId'>) => {
  return row.remoteModelId ?? row.name
}

const getProjectTransferExportModelDisplayName = (row: Pick<ProjectTransferExportModelRow, 'displayName' | 'name'>) => {
  return row.displayName ?? row.name
}

const getProjectTransferExportModelSignature = (
  row: ProjectTransferExportModelRow,
  providerConnectionRow: ProjectTransferExportProviderConnectionRow,
) => {
  const variant = normalizeProjectTransferModelVariant(row.variant)
  const version = normalizeProjectTransferModelVariant(row.version)

  return {
    displayName: getProjectTransferExportModelDisplayName(row),
    modelName: getProjectTransferExportModelName(row),
    name: row.name,
    providerConnectionSignature: getProjectTransferExportProviderConnectionSignature(providerConnectionRow),
    remoteModelId: row.remoteModelId,
    variant,
    version,
  }
}

const getProjectTransferExportEmptyModelSignature = () => {
  return {
    displayName: null,
    modelName: null,
    name: null,
    providerConnectionSignature: null,
    remoteModelId: null,
    variant: null,
    version: null,
  }
}

const getProjectTransferExportContentSettings = (
  row: Pick<
    ProjectTransferExportSourceProjectSettings | ProjectTransferExportJudgmentRow,
    'useAbstract' | 'useFulltext' | 'useFulltextNoImages' | 'useTitle'
  >,
) => {
  return {
    useAbstract: row.useAbstract ?? true,
    useFulltext: row.useFulltext ?? false,
    useFulltextNoImages: row.useFulltextNoImages ?? false,
    useTitle: row.useTitle ?? true,
  }
}

const getProjectTransferExportProjectSettingsPayload = (project: ProjectTransferExportSourceProjectSettings) => {
  return {humanJudgmentMode: project.humanJudgmentMode ?? 'prompt', ...getProjectTransferExportContentSettings(project)}
}

const getProjectTransferExportArticleRecordForSignature = (
  article: ProjectTransferExportArticlePayloadRecord,
  fullText: string | null,
): ArticleRecord => {
  return {
    articleAuthors: null,
    articleCreatedAt: getDateValue(article.articleCreatedAt),
    articleId: getStringValue(article.articleId),
    articleSummary: getStringValue(article.articleSummary),
    articleTitle: getStringValue(article.articleTitle) ?? '',
    articleUpdatedAt: getDateValue(article.articleUpdatedAt),
    articleVersion: getNumberValue(article.articleVersion),
    arxivId: getStringValue(article.arxivId),
    biorxivId: getStringValue(article.biorxivId),
    contentHash: getStringValue(article.contentHash),
    createdAt: getDateValue(article.createdAt) ?? new Date(0),
    doi: getStringValue(article.doi),
    fullText,
    fullTextAssets: article.fullTextAssets ?? null,
    fullTextCharCount: getNumberValue(article.fullTextCharCount),
    fullTextConversionAttempts: getNumberValue(article.fullTextConversionAttempts),
    fullTextConversionError: getStringValue(article.fullTextConversionError),
    fullTextConversionMetadata: article.fullTextConversionMetadata ?? null,
    fullTextConversionModelId: getStringValue(article.fullTextConversionModelId),
    fullTextConversionStatus: getStringValue(article.fullTextConversionStatus),
    fullTextFetchedAt: getDateValue(article.fullTextFetchedAt),
    fullTextHtml: getStringValue(article.fullTextHtml),
    fullTextOriginalFormat: getStringValue(article.fullTextOriginalFormat),
    fullTextPDF: getStringValue(article.fullTextPdf),
    fullTextSource: getStringValue(article.fullTextSource),
    id: 'project-transfer-signature-article',
    importRoute: getStringValue(article.importRoute),
    medrxivId: getStringValue(article.medrxivId),
    originalData: article.originalData ?? null,
    publicationStatus: getStringValue(article.publicationStatus) as ArticleRecord['publicationStatus'],
    pubmedId: getStringValue(article.pubmedId),
    sourceMetadata: article.sourceMetadata ?? null,
    updatedAt: getDateValue(article.updatedAt) ?? new Date(0),
    url: getStringValue(article.url),
  }
}

const getProjectTransferExportFullTextProcessingSignature = ({
  article,
  contentSettings,
  promptTokenLimit,
}: {
  article: ProjectTransferExportArticlePayloadRecord
  contentSettings: ProjectTransferContentSettings
  promptTokenLimit: number
}) => {
  const includeFullText = contentSettings.useFulltext || contentSettings.useFulltextNoImages
  const fullText = includeFullText ? getStringValue(article.fullText) : null
  const result = fullText
    ? processFulltextForLLM(fullText, {promptTokenLimit, stripImages: contentSettings.useFulltextNoImages})
    : null

  return {
    fullText,
    signature: {
      maxTokens: result?.maxTokens ?? null,
      processedTextDigest: getSignatureTextDigest(result?.processedText ?? null),
      stripImages: contentSettings.useFulltextNoImages,
      tokenCount: result?.tokenCount ?? null,
      withinBudget: result?.withinBudget ?? null,
    },
  }
}

const getProjectTransferExportPromptInputSignature = (
  prompt: Pick<
    ProjectTransferExportProjectPromptRow,
    'contentHash' | 'originalText' | 'promptHeading' | 'order' | 'transformedText' | 'type'
  >,
) => {
  return {
    contentHash: prompt.contentHash,
    originalTextDigest: getDigestValue(prompt.originalText),
    promptHeading: prompt.promptHeading,
    serializedPromptIdentifier: null,
    transformedTextDigest: getSignatureTextDigest(prompt.transformedText),
    type: prompt.type,
  }
}

const getProjectTransferExportHumanPromptInputSignature = (
  prompt: Pick<
    ProjectTransferExportProjectPromptRow,
    'contentHash' | 'originalText' | 'order' | 'promptHeading' | 'transformedText' | 'type'
  >,
) => {
  return {...getProjectTransferExportPromptInputSignature(prompt), order: prompt.order}
}

const getProjectTransferExportArticleDisplaySignature = (article: ProjectTransferExportArticlePayloadRecord) => {
  return {
    articleSummaryDigest: getSignatureTextDigest(article.articleSummary),
    articleTitleDigest: getDigestValue(article.articleTitle),
    contentHash: getStringValue(article.contentHash),
    fullTextAssetsDigest: getNullableDigestValue(article.fullTextAssets),
    fullTextDigest: getSignatureTextDigest(article.fullText),
    fullTextHtmlDigest: getSignatureTextDigest(article.fullTextHtml),
    fullTextPdfReferenceDigest: getSignatureTextDigest(article.fullTextPdf),
    identifierKeys: getProjectTransferStrongIdentifierComparisonKeys(article),
  }
}

const getProjectTransferExportModelRequestSignature = ({
  model,
  providerConnection,
}: {
  model: ProjectTransferExportModelRow
  providerConnection: ProjectTransferExportProviderConnectionRow
}) => {
  const promptTokenLimit =
    getProviderModelMetadataPromptTokenLimit(getJsonValue(model.metadataJson), MAX_COMPLETION_TOKENS)
    ?? defaultJudgmentPromptTokenLimit

  return {
    contextLimit:
      getProviderModelMetadataContextLength(getJsonValue(model.metadataJson)) ?? defaultJudgmentModelContext,
    modelOptions: getProviderModelMetadataOptions(getJsonValue(model.metadataJson)),
    modelSignature: getProjectTransferExportModelSignature(model, providerConnection),
    promptTokenLimit,
  }
}

const getProjectTransferExportProviderRequestSignature = (
  providerConnection: ProjectTransferExportProviderConnectionRow,
) => {
  const registryEntry = getProviderRegistryEntry(providerConnection.providerKind)

  return {
    providerConnectionSignature: getProjectTransferExportProviderConnectionSignature(providerConnection),
    providerKind: providerConnection.providerKind,
    transportFamily: registryEntry?.transportFamily ?? null,
  }
}

const isAnthropicProviderKind = (providerKind: string | null | undefined) => {
  return providerKind?.toLowerCase() === 'anthropic'
}

const getProjectTransferExportJudgmentPromptTemplateSignature = ({
  article,
  contentSettings,
  prompt,
  providerKind,
}: {
  article: ProjectTransferExportArticlePayloadRecord
  contentSettings: ProjectTransferContentSettings
  prompt: ProjectTransferExportProjectPromptRow
  providerKind: string | null
}) => {
  return {
    articleSummaryDigest: contentSettings.useAbstract ? getSignatureTextDigest(article.articleSummary) : null,
    articleTitleDigest: contentSettings.useTitle ? getDigestValue(article.articleTitle) : null,
    promptOriginalTextDigest: getDigestValue(prompt.originalText),
    promptTemplateFamily: 'judgeGetSinglePrompt:v1',
    promptType: prompt.type,
    sourceTextWrapper: isAnthropicProviderKind(providerKind) ? 'providerRawSourceText' : 'sourceTextBoundaryWrapper:v1',
  }
}

export const getProjectTransferExportJudgmentInputSignature = ({
  article,
  chunkEvidenceDigests = null,
  chunkFinalPromptDigest = null,
  chunkingStrategy,
  contentSettings,
  model,
  prompt,
  providerConnection,
}: {
  article: ProjectTransferExportArticlePayloadRecord
  chunkEvidenceDigests?: string[] | null
  chunkFinalPromptDigest?: string | null
  chunkingStrategy: string | null
  contentSettings: ProjectTransferContentSettings
  model: ProjectTransferExportModelRow
  prompt: ProjectTransferExportProjectPromptRow
  providerConnection: ProjectTransferExportProviderConnectionRow
}) => {
  const modelRequestSignature = getProjectTransferExportModelRequestSignature({model, providerConnection})
  const providerKind = providerConnection.providerKind
  const fullTextProcessing = getProjectTransferExportFullTextProcessingSignature({
    article,
    contentSettings,
    promptTokenLimit: modelRequestSignature.promptTokenLimit,
  })
  const articleRecord = getProjectTransferExportArticleRecordForSignature(article, fullTextProcessing.fullText)
  const systemPrompt = getSinglePromptSystemPromptForArticle(articleRecord, providerKind)
  const evidenceSystemPrompt = chunkingStrategy
    ? getSinglePromptEvidenceSystemPromptForArticle(articleRecord, providerKind)
    : null

  return {
    article: {
      ...getProjectTransferExportArticleDisplaySignature(article),
      promptInput: getProjectTransferExportJudgmentPromptTemplateSignature({
        article,
        contentSettings,
        prompt,
        providerKind,
      }),
    },
    chunking: {chunkEvidenceDigests, finalPromptDigest: chunkFinalPromptDigest, strategy: chunkingStrategy},
    contentSettings,
    fullTextProcessing: fullTextProcessing.signature,
    kind: 'judgmentInputSignature',
    model: modelRequestSignature,
    prompt: getProjectTransferExportPromptInputSignature(prompt),
    provider: getProjectTransferExportProviderRequestSignature(providerConnection),
    request: {
      evidenceOutputSchemaDigest: getDigestValue(singlePromptEvidenceOutputSchema),
      evidenceSystemPromptDigest: getSignatureTextDigest(evidenceSystemPrompt),
      invocationTemperature: judgmentInvocationTemperature,
      maxRetries: judgmentMaxRetries,
      outputSchemaDigest: getDigestValue(singlePromptOutputSchema),
      providerInvocationAdapter: 'invokeStoredProviderModel:v1',
      quoteValidationContract: 'exact-source-substring:v1',
      reservedCompletionTokens: MAX_COMPLETION_TOKENS,
      retryContract: 'json-schema-and-quote-validation:v1',
      systemPromptDigest: getDigestValue(systemPrompt),
      systemPromptFamily: 'getSinglePromptSystemPromptForArticle:v1',
    },
    version: projectTransferInputSignatureVersion,
  }
}

export const getProjectTransferExportHumanReviewInputSignature = ({
  article,
  mode,
  prompt = null,
  sections = null,
}: {
  article: ProjectTransferExportArticlePayloadRecord
  mode: 'promptHumanJudgment' | 'reviewRow' | 'summaryHumanJudgment'
  prompt?: ProjectTransferExportProjectPromptRow | null
  sections?: Record<string, boolean> | null
}) => {
  return {
    article: getProjectTransferExportArticleDisplaySignature(article),
    kind: 'humanReviewInputSignature',
    mode,
    prompt: prompt ? getProjectTransferExportHumanPromptInputSignature(prompt) : null,
    reviewedSectionContractVersion,
    sections,
    version: projectTransferInputSignatureVersion,
  }
}

const getProjectTransferExportArticlePayloadRecord = (
  row: ProjectTransferExportArticleRow,
  identifierRows: ProjectTransferExportArticleIdentifierRow[],
): ProjectTransferExportArticlePayloadRecord => {
  const sourceArticleId = row.canonicalArticleId ?? ''
  const identifierInputs = identifierRows.map((identifier) => {
    return {inputKind: identifier.inputKind, source: identifier.source, value: identifier.value}
  })
  const record = {
    articleAuthors: getJsonArrayValue(row.articleAuthors),
    articleCreatedAt: getIsoDateValue(row.articleCreatedAt),
    articleId: row.articleId,
    articleSummary: row.articleSummary,
    articleTitle: row.articleTitle,
    articleUpdatedAt: getIsoDateValue(row.articleUpdatedAt),
    articleVersion: row.articleVersion,
    arxivId: row.arxivId,
    biorxivId: row.biorxivId,
    canonicalArticleId: row.canonicalArticleId,
    canonicalOriginalData: getJsonValue(row.canonicalOriginalData),
    canonicalSourceMetadata: getJsonValue(row.canonicalSourceMetadata),
    contentHash: row.contentHash,
    createdAt: getIsoDateValue(row.createdAt),
    doi: row.doi,
    fullText: row.fullText,
    fullTextAssets: getJsonValue(row.fullTextAssets),
    fullTextCharCount: row.fullTextCharCount,
    fullTextConversionAttempts: row.fullTextConversionAttempts,
    fullTextConversionError: row.fullTextConversionError,
    fullTextConversionMetadata: getJsonValue(row.fullTextConversionMetadata),
    fullTextConversionModelId: row.fullTextConversionModelId,
    fullTextConversionStatus: row.fullTextConversionStatus,
    fullTextFetchedAt: getIsoDateValue(row.fullTextFetchedAt),
    fullTextHtml: row.fullTextHtml,
    fullTextOriginalFormat: row.fullTextOriginalFormat,
    fullTextPdf: row.fullTextPdf,
    fullTextSource: row.fullTextSource,
    identifierInputs,
    importRoute: row.importRoute,
    medrxivId: row.medrxivId,
    originalData: getJsonValue(row.originalData),
    provenance: {sourceArticleId},
    publicationStatus: row.publicationStatus,
    pubmedId: row.pubmedId,
    scopedImportMetadata: getJsonValue(row.scopedImportMetadata),
    scopedRawPayload: getJsonValue(row.scopedRawPayload),
    selectedExternalArticleId: row.selectedExternalArticleId,
    selectedImportRecordId: row.selectedImportRecordId,
    selectedImportRoute: row.selectedImportRoute,
    selectedImportRouteId: row.selectedImportRouteId,
    selectedSourceKind: row.selectedSourceKind,
    selectedSourceRecordHash: row.selectedSourceRecordHash,
    selectedSourceRecordKey: row.selectedSourceRecordKey,
    signature: {identifierKeys: [] as string[], title: row.articleTitle},
    sourceArticleId,
    sourceMetadata: getJsonValue(row.sourceMetadata),
    updatedAt: getIsoDateValue(row.updatedAt),
    url: row.url,
  }

  return getProjectTransferExportSanitizedArticleIdentifierRecord({
    ...record,
    signature: getProjectTransferExportArticleSignature(record),
  })
}

const getProjectTransferExportArticleSignatureById = (articleRows: ProjectTransferExportArticlePayloadRecord[]) => {
  return articleRows.reduce<Record<string, ReturnType<typeof getProjectTransferExportArticleSignature>>>(
    (signatureMap, row) => {
      return {...signatureMap, [row.sourceArticleId]: getProjectTransferExportArticleSignature(row)}
    },
    {},
  )
}

const getProjectTransferExportPromptSignatureById = (projectPromptRows: ProjectTransferExportProjectPromptRow[]) => {
  return projectPromptRows.reduce<Record<string, ReturnType<typeof getProjectTransferExportPromptSignature>>>(
    (signatureMap, row) => {
      return {...signatureMap, [row.promptId]: getProjectTransferExportPromptSignature(row)}
    },
    {},
  )
}

const getProjectTransferExportImportRouteSignatureById = (importRouteRows: ProjectTransferExportImportRouteRow[]) => {
  return importRouteRows.reduce<Record<string, ReturnType<typeof getProjectTransferExportImportRouteSignature>>>(
    (signatureMap, row) => {
      return {...signatureMap, [row.importRouteId]: getProjectTransferExportImportRouteSignature(row)}
    },
    {},
  )
}

const getProjectTransferExportModelSignatureById = (
  modelRows: ProjectTransferExportModelRow[],
  providerConnectionRows: ProjectTransferExportProviderConnectionRow[],
) => {
  const providerConnectionById = getRowsById(providerConnectionRows, 'providerConnectionId')

  return modelRows.reduce<Record<string, ReturnType<typeof getProjectTransferExportModelSignature>>>(
    (signatureMap, row) => {
      const providerConnectionRow = providerConnectionById[row.providerConnectionId]

      return providerConnectionRow
        ? {...signatureMap, [row.modelId]: getProjectTransferExportModelSignature(row, providerConnectionRow)}
        : signatureMap
    },
    {},
  )
}

const getProjectTransferExportProjectPayloadFromContext = (context: ProjectTransferExportContext) => {
  const modelById = getRowsById(context.modelRows, 'modelId')
  const providerConnectionById = getRowsById(context.providerConnectionRows, 'providerConnectionId')
  const projectModelRow = context.project.modelId ? modelById[context.project.modelId] : null
  const projectProviderConnectionRow = projectModelRow
    ? (providerConnectionById[projectModelRow.providerConnectionId] ?? null)
    : null
  const modelSignature =
    projectModelRow && projectProviderConnectionRow
      ? getProjectTransferExportModelSignature(projectModelRow, projectProviderConnectionRow)
      : getProjectTransferExportEmptyModelSignature()

  return assertProjectTransferPayload('project', {
    archived: context.project.archived,
    createdAt: context.project.createdAt?.toISOString() ?? null,
    dateFrom: context.project.dateFrom?.toISOString() ?? null,
    dateTo: context.project.dateTo?.toISOString() ?? null,
    description: context.project.description,
    modelSignature,
    name: context.project.name,
    provenance: {sourceProjectId: context.project.sourceProjectId},
    settings: getProjectTransferExportProjectSettingsPayload(context.project),
    signature: {
      modelSignature,
      name: context.project.name,
      settings: getProjectTransferExportProjectSettingsPayload(context.project),
    },
    sourceProjectId: context.project.sourceProjectId,
    updatedAt: context.project.updatedAt?.toISOString() ?? null,
  })
}

const getProjectTransferExportPromptsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const records = context.projectPromptRows.map((row) => {
    const signature = getProjectTransferExportPromptSignature(row)

    return {
      archived: row.promptArchived ?? false,
      contentHash: row.contentHash,
      createdAt: getIsoDateValue(row.promptCreatedAt),
      originalText: row.originalText,
      promptHeading: row.promptHeading,
      provenance: {sourcePromptId: row.promptId},
      signature,
      sourcePromptId: row.promptId,
      transformedText: row.transformedText,
      type: row.type,
      updatedAt: getIsoDateValue(row.promptUpdatedAt),
    }
  })

  return assertProjectTransferPayload('prompts', records)
}

const getProjectTransferExportProjectPromptsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const records = context.projectPromptRows.map((row) => {
    const promptSignature = getProjectTransferExportPromptSignature(row)
    const signature = {
      criteria: {
        disposition: row.criteriaDisposition,
        sectionKey: row.criteriaSectionKey,
        sectionLabel: row.criteriaSectionLabel,
      },
      enabled: row.enabled ?? true,
      order: row.order,
      promptSignature,
    }

    return {
      archived: row.archived ?? false,
      createdAt: getIsoDateValue(row.projectPromptCreatedAt),
      criteriaDisposition: row.criteriaDisposition,
      criteriaSectionKey: row.criteriaSectionKey,
      criteriaSectionLabel: row.criteriaSectionLabel,
      enabled: row.enabled ?? true,
      order: row.order,
      originSourceProjectId: row.originProjectId,
      provenance: {sourceProjectId: row.sourceProjectId, sourcePromptId: row.promptId},
      signature,
      sourceProjectId: row.sourceProjectId,
      sourceProjectPromptId: row.projectPromptId,
      sourcePromptId: row.promptId,
      updatedAt: getIsoDateValue(row.projectPromptUpdatedAt),
    }
  })

  return assertProjectTransferPayload('projectPrompts', records)
}

const getProjectTransferExportImportRoutesPayloadFromContext = (context: ProjectTransferExportContext) => {
  const records = context.importRouteRows.map((row) => {
    const signature = getProjectTransferExportImportRouteSignature(row)

    return {
      active: row.active ?? true,
      createdAt: getIsoDateValue(row.createdAt),
      description: row.description,
      name: row.name,
      provenance: {sourceImportRouteId: row.importRouteId},
      route: row.route,
      signature,
      sourceImportRouteId: row.importRouteId,
      updatedAt: getIsoDateValue(row.updatedAt),
    }
  })

  return assertProjectTransferPayload('importRoutes', records)
}

const getProjectTransferExportProjectImportRoutesPayloadFromContext = (context: ProjectTransferExportContext) => {
  const importRouteSignatureById = getProjectTransferExportImportRouteSignatureById(context.importRouteRows)
  const records = context.projectImportRouteRows.map((row) => {
    const importRouteSignature = importRouteSignatureById[row.importRouteId]

    return {
      createdAt: getIsoDateValue(row.createdAt),
      provenance: {sourceImportRouteId: row.importRouteId, sourceProjectId: row.sourceProjectId},
      signature: {importRouteSignature},
      sourceImportRouteId: row.importRouteId,
      sourceProjectId: row.sourceProjectId,
      sourceProjectImportRouteId: row.projectImportRouteId,
      updatedAt: getIsoDateValue(row.updatedAt),
    }
  })

  return assertProjectTransferPayload('projectImportRoutes', records)
}

const getProjectTransferExportArticleImportRoutesPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)
  const importRouteSignatureById = getProjectTransferExportImportRouteSignatureById(context.importRouteRows)

  return assertProjectTransferPayload(
    'articleImportRoutes',
    context.articleImportRouteRows.map((row) => {
      return {
        createdAt: getIsoDateValue(row.createdAt),
        externalArticleId: row.externalArticleId,
        importMetadata: getJsonValue(row.importMetadata),
        importRunId: row.importRunId,
        matchMetadata: getJsonValue(row.matchMetadata),
        provenance: {sourceArticleId: row.articleId, sourceImportRouteId: row.importRouteId},
        rawPayload: getJsonValue(row.rawPayload),
        signature: {
          articleSignature: articleSignatureById[row.articleId],
          importRouteSignature: importRouteSignatureById[row.importRouteId],
          sourceRecordHash: row.sourceRecordHash,
        },
        sourceArticleId: row.articleId,
        sourceArticleImportRouteId: row.sourceArticleImportRouteId,
        sourceImportRouteId: row.importRouteId,
        sourceKind: row.sourceKind,
        sourceRecordHash: row.sourceRecordHash ?? row.sourceArticleImportRouteId,
        sourceRecordKey: row.sourceRecordKey ?? row.sourceArticleImportRouteId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportProjectArticlesPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)

  return assertProjectTransferPayload(
    'projectArticles',
    context.projectArticleRows.map((row) => {
      return {
        createdAt: getIsoDateValue(row.createdAt),
        importedFromSourceProjectId: row.importedFromProjectId,
        provenance: {sourceArticleId: row.articleId, sourceProjectId: row.sourceProjectId},
        signature: {articleSignature: articleSignatureById[row.articleId]},
        sourceArticleId: row.articleId,
        sourceProjectArticleId: row.projectArticleId,
        sourceProjectId: row.sourceProjectId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportJudgmentsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)
  const articleById = getRowsById(context.articleRows, 'sourceArticleId')
  const promptById = getRowsById(context.projectPromptRows, 'promptId')
  const promptSignatureById = getProjectTransferExportPromptSignatureById(context.projectPromptRows)
  const modelById = getRowsById(context.modelRows, 'modelId')
  const providerConnectionById = getRowsById(context.providerConnectionRows, 'providerConnectionId')
  const modelSignatureById = getProjectTransferExportModelSignatureById(
    context.modelRows,
    context.providerConnectionRows,
  )

  return assertProjectTransferPayload(
    'judgments',
    context.judgmentRows.map((row) => {
      const contentSettings = getProjectTransferExportContentSettings(row)
      const article = articleById[row.articleId]
      const prompt = promptById[row.promptId]
      const model = modelById[row.modelId]
      const providerConnection = model ? providerConnectionById[model.providerConnectionId] : undefined
      const judgmentInputSignature =
        article && prompt && model && providerConnection
          ? getProjectTransferExportJudgmentInputSignature({
              article,
              chunkingStrategy: row.chunkingStrategy,
              contentSettings,
              model,
              prompt,
              providerConnection,
            })
          : null

      return {
        answeredOriginal: row.answeredOriginal,
        answeredOriginalAsArray: getStringArrayValue(row.answeredOriginalAsArray),
        chunkingStrategy: row.chunkingStrategy,
        confidenceOriginal: row.confidenceOriginal ?? 50,
        contentSettings,
        createdAt: getIsoDateValue(row.createdAt),
        deleteGeneration: row.deleteGeneration ?? 0,
        deletedAt: getIsoDateValue(row.deletedAt),
        explanation: row.explanation,
        isAnswered: row.isAnswered ?? false,
        judgmentInputSignature,
        judgmentInputSignatureProvenance: currentReviewRowsInputSignatureProvenance,
        provenance: {sourceArticleId: row.articleId, sourceModelId: row.modelId, sourcePromptId: row.promptId},
        quotes: getJsonArrayValue(row.quotes),
        signature: {
          articleSignature: articleSignatureById[row.articleId],
          contentSettings,
          modelSignature: modelSignatureById[row.modelId],
          promptSignature: promptSignatureById[row.promptId],
        },
        snapshotProjectId: row.snapshotProjectId,
        snapshotProjectModelName: row.snapshotProjectModelName,
        sourceArticleId: row.articleId,
        sourceJudgmentId: row.judgmentId,
        sourceModelId: row.modelId,
        sourceProjectId: row.projectId,
        sourcePromptId: row.promptId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportJudgmentAssessmentsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)
  const promptSignatureById = getProjectTransferExportPromptSignatureById(context.projectPromptRows)
  const modelSignatureById = getProjectTransferExportModelSignatureById(
    context.modelRows,
    context.providerConnectionRows,
  )
  const contentSettings = getProjectTransferExportContentSettings(context.project)

  return assertProjectTransferPayload(
    'judgmentAssessments',
    context.judgmentAssessmentRows.map((row) => {
      return {
        assessmentComment: row.assessmentComment,
        assessmentIsCorrect: row.assessmentIsCorrect ?? false,
        createdAt: getIsoDateValue(row.createdAt),
        provenance: {sourceJudgmentId: row.judgmentId},
        signature: {
          judgmentSignature: {
            articleSignature: articleSignatureById[row.articleId],
            contentSettings,
            modelSignature: modelSignatureById[row.modelId],
            promptSignature: promptSignatureById[row.promptId],
          },
        },
        sourceArticleId: row.articleId,
        sourceJudgmentAssessmentId: row.judgmentAssessmentId,
        sourceJudgmentId: row.judgmentId,
        sourceModelId: row.modelId,
        sourceProjectId: row.projectId,
        sourcePromptId: row.promptId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportHumanJudgmentsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)
  const articleById = getRowsById(context.articleRows, 'sourceArticleId')
  const promptById = getRowsById(context.projectPromptRows, 'promptId')
  const promptSignatureById = getProjectTransferExportPromptSignatureById(context.projectPromptRows)
  const projectHumanMode = context.project.humanJudgmentMode ?? 'prompt'

  return assertProjectTransferPayload(
    'humanJudgments',
    context.humanJudgmentRows.map((row) => {
      const article = articleById[row.articleId]
      const prompt = promptById[row.promptId]
      const humanReviewInputSignature =
        article && prompt
          ? getProjectTransferExportHumanReviewInputSignature({article, mode: 'promptHumanJudgment', prompt})
          : null

      return {
        answer: row.answer,
        comment: row.comment,
        createdAt: getIsoDateValue(row.createdAt),
        humanReviewInputSignature,
        humanReviewInputSignatureProvenance: currentReviewRowsInputSignatureProvenance,
        isAnswered: row.isAnswered ?? false,
        provenance: {
          sourceArticleId: row.articleId,
          sourceProjectId: row.sourceProjectId,
          sourcePromptId: row.promptId,
        },
        signature: {
          articleSignature: articleSignatureById[row.articleId],
          projectHumanMode,
          promptSignature: promptSignatureById[row.promptId],
        },
        sourceArticleId: row.articleId,
        sourceHumanJudgmentId: row.humanJudgmentId,
        sourceProjectId: row.sourceProjectId,
        sourcePromptId: row.promptId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportHumanJudgmentSummariesPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)
  const articleById = getRowsById(context.articleRows, 'sourceArticleId')
  const projectHumanMode = context.project.humanJudgmentMode ?? 'prompt'

  return assertProjectTransferPayload(
    'humanJudgmentSummaries',
    context.humanJudgmentSummaryRows.map((row) => {
      const article = articleById[row.articleId]
      const humanReviewInputSignature = article
        ? getProjectTransferExportHumanReviewInputSignature({article, mode: 'summaryHumanJudgment'})
        : null

      return {
        answer: row.answer,
        createdAt: getIsoDateValue(row.createdAt),
        humanReviewInputSignature,
        humanReviewInputSignatureProvenance: currentReviewRowsInputSignatureProvenance,
        origin: row.origin,
        provenance: {sourceArticleId: row.articleId, sourceProjectId: row.sourceProjectId},
        signature: {articleSignature: articleSignatureById[row.articleId], projectHumanMode},
        sourceArticleId: row.articleId,
        sourceHumanJudgmentSummaryId: row.humanJudgmentSummaryId,
        sourceProjectId: row.sourceProjectId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportReviewSections = (row: ProjectTransferExportReviewRow) => {
  return {
    abstract: {comment: row.reviewedAbstractComment, reviewed: row.reviewedAbstract ?? false},
    appendix: {comment: row.reviewedAppendixComment, reviewed: row.reviewedAppendix ?? false},
    conclusion: {comment: row.reviewedConclusionComment, reviewed: row.reviewedConclusion ?? false},
    discussion: {comment: row.reviewedDiscussionComment, reviewed: row.reviewedDiscussion ?? false},
    intro: {comment: row.reviewedIntroComment, reviewed: row.reviewedIntro ?? false},
    method: {comment: row.reviewedMethodComment, reviewed: row.reviewedMethod ?? false},
    other: {comment: row.reviewedOtherComment, reviewed: row.reviewedOther ?? false},
    results: {comment: row.reviewedResultsComment, reviewed: row.reviewedResults ?? false},
    title: {comment: row.reviewedTitleComment, reviewed: row.reviewedTitle ?? false},
  }
}

const getProjectTransferExportReviewSectionSignature = (
  sections: ReturnType<typeof getProjectTransferExportReviewSections>,
) => {
  return Object.fromEntries(
    Object.entries(sections).map(([section, value]) => {
      return [section, value.reviewed]
    }),
  )
}

const getProjectTransferExportReviewsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const articleSignatureById = getProjectTransferExportArticleSignatureById(context.articleRows)
  const articleById = getRowsById(context.articleRows, 'sourceArticleId')

  return assertProjectTransferPayload(
    'reviews',
    context.reviewRows.map((row) => {
      const sections = getProjectTransferExportReviewSections(row)
      const sectionSignature = getProjectTransferExportReviewSectionSignature(sections)
      const article = articleById[row.articleId]
      const humanReviewInputSignature = article
        ? getProjectTransferExportHumanReviewInputSignature({article, mode: 'reviewRow', sections: sectionSignature})
        : null

      return {
        createdAt: getIsoDateValue(row.createdAt),
        humanReviewInputSignature,
        humanReviewInputSignatureProvenance: currentReviewRowsInputSignatureProvenance,
        opened: row.opened ?? false,
        provenance: {sourceArticleId: row.articleId, sourceProjectId: row.sourceProjectId},
        sections,
        signature: {articleSignature: articleSignatureById[row.articleId], sections: sectionSignature},
        sourceArticleId: row.articleId,
        sourceProjectId: row.sourceProjectId,
        sourceReviewId: row.reviewId,
        updatedAt: getIsoDateValue(row.updatedAt),
      }
    }),
  )
}

const getProjectTransferExportProviderConnectionsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const records = context.providerConnectionRows.map((row) => {
    const signature = getProjectTransferExportProviderConnectionSignature(row)

    return {
      authMode: row.authMode,
      baseURL: row.baseURL,
      configJson: getJsonRecordValue(row.configJson),
      createdAt: getIsoDateValue(row.createdAt),
      enabled: row.enabled ?? true,
      label: row.label,
      lastCheckedAt: getIsoDateValue(row.lastCheckedAt),
      lastError: row.lastError,
      maxInflightRequests: row.maxInflightRequests,
      provenance: {sourceProviderConnectionId: row.providerConnectionId},
      providerKind: row.providerKind,
      secretRef: null,
      signature,
      sourceProviderConnectionId: row.providerConnectionId,
      updatedAt: getIsoDateValue(row.updatedAt),
      warnings: [providerSecretRedaction],
    }
  })

  return assertProjectTransferPayload('providerConnections', records)
}

const getProjectTransferExportModelsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const providerConnectionById = getRowsById(context.providerConnectionRows, 'providerConnectionId')
  const records = context.modelRows.map((row) => {
    const providerConnectionRow = providerConnectionById[row.providerConnectionId]
    const signature = providerConnectionRow
      ? getProjectTransferExportModelSignature(row, providerConnectionRow)
      : getProjectTransferExportEmptyModelSignature()

    return {
      createdAt: getIsoDateValue(row.createdAt),
      displayName: getProjectTransferExportModelDisplayName(row),
      enabled: row.enabled ?? true,
      metadataJson: getJsonValue(row.metadataJson),
      modelName: getProjectTransferExportModelName(row),
      name: row.name,
      provenance: {sourceModelId: row.modelId, sourceProviderConnectionId: row.providerConnectionId},
      remoteModelId: row.remoteModelId,
      signature,
      source: row.source,
      sourceModelId: row.modelId,
      sourceProviderConnectionId: row.providerConnectionId,
      updatedAt: getIsoDateValue(row.updatedAt),
      variant: row.variant,
      version: normalizeProjectTransferModelVariant(row.version),
    }
  })

  return assertProjectTransferPayload('models', records)
}

const getProjectTransferExportCurrentReviewRowsSignatureWarnings = (context: ProjectTransferExportContext) => {
  const humanReviewRowCount =
    context.humanJudgmentRows.length + context.humanJudgmentSummaryRows.length + context.reviewRows.length
  const judgmentWarning =
    context.judgmentRows.length === 0
      ? null
      : {
          action: 'used_current_review_rows',
          code: 'currentReviewRowsJudgmentInputSignature',
          details: {
            provenance: currentReviewRowsInputSignatureProvenance.kind,
            recordCount: context.judgmentRows.length,
          },
          jsonPointer: '/judgments',
          message: 'Exported judgment input signatures are certified against current source review rows.',
          scope: 'judgments',
          severity: 'warning' as const,
        }
  const humanReviewWarning =
    humanReviewRowCount === 0
      ? null
      : {
          action: 'used_current_review_rows',
          code: 'currentReviewRowsHumanReviewInputSignature',
          details: {provenance: currentReviewRowsInputSignatureProvenance.kind, recordCount: humanReviewRowCount},
          message: 'Exported human/review input signatures are certified against current source review rows.',
          scope: 'humanReviewRows',
          severity: 'warning' as const,
        }

  return [judgmentWarning, humanReviewWarning].filter((warning): warning is ProjectTransferManifestWarning => {
    return warning !== null
  })
}

export const assertProjectTransferExportModelDependencies = (params: {
  modelRows: Array<Pick<ProjectTransferExportModelRow, 'modelId'>>
  requiredModelIds: string[]
}) => {
  const exportedModelIdSet = new Set(
    params.modelRows.map((row) => {
      return row.modelId
    }),
  )
  const missingModelIds = params.requiredModelIds.filter((modelId) => {
    return !exportedModelIdSet.has(modelId)
  })

  if (missingModelIds.length > 0) {
    throw new Error(`Project transfer export missing required model rows: ${missingModelIds.join(', ')}`)
  }
}

export const assertProjectTransferExportProviderConnectionDependencies = (params: {
  providerConnectionRows: Array<Pick<ProjectTransferExportProviderConnectionRow, 'providerConnectionId'>>
  requiredProviderConnectionIds: string[]
}) => {
  const exportedProviderConnectionIdSet = new Set(
    params.providerConnectionRows.map((row) => {
      return row.providerConnectionId
    }),
  )
  const missingProviderConnectionIds = params.requiredProviderConnectionIds.filter((providerConnectionId) => {
    return !exportedProviderConnectionIdSet.has(providerConnectionId)
  })

  if (missingProviderConnectionIds.length > 0) {
    throw new Error(
      `Project transfer export missing required provider connection rows: ${missingProviderConnectionIds.join(', ')}`,
    )
  }
}

const getProjectTransferExportContext = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
): Promise<ProjectTransferExportContext> => {
  const database = getDatabase(options)
  const project = await getProjectTransferExportSourceProjectSettings(projectId, {database})
  const projectPromptRows = await getProjectTransferExportProjectPromptRows(projectId, database)
  const importRouteRows = await getProjectTransferExportImportRouteRows(projectId, database)
  const projectImportRouteRows = await getProjectTransferExportProjectImportRouteRows(projectId, database)
  const projectArticleRows = await getProjectTransferExportProjectArticleRows(projectId, database)
  const ambiguousJudgmentWarnings = await getProjectTransferExportAmbiguousJudgmentWarnings(projectId, database)
  const judgmentRows = await getProjectTransferExportJudgmentRows(projectId, database)
  const includeFullText =
    project.useFulltext
    || project.useFulltextNoImages
    || judgmentRows.some((row) => {
      return row.useFulltext || row.useFulltextNoImages
    })
  const articleRawJsonEstimate = await getProjectTransferExportArticleRawJsonEstimate(projectId, database)
  const articleRawJsonDecision = getProjectTransferExportArticleRawJsonDecision({
    estimate: articleRawJsonEstimate,
    mode: getRawArticleProvenanceMode(options.rawArticleProvenanceMode),
    thresholdChars: options.articleRawJsonOmissionThresholdChars,
  })
  const articleRows = await getProjectTransferExportArticleRows(projectId, database, {
    includeFullText,
    includeRawArticleJson: articleRawJsonDecision.includeRawArticleJson,
  })
  const articleImportRouteRows = await getProjectTransferExportArticleImportRouteRows(projectId, database, {
    includeRawArticleJson: articleRawJsonDecision.includeRawArticleJson,
  })
  const judgmentAssessmentRows = await getProjectTransferExportJudgmentAssessmentRows(projectId, database)
  const humanJudgmentRows = await getProjectTransferExportHumanJudgmentRows(projectId, database)
  const humanJudgmentSummaryRows = await getProjectTransferExportHumanJudgmentSummaryRows(projectId, database)
  const reviewRows = await getProjectTransferExportReviewRows(projectId, database)
  const chunkedJudgmentWarnings = getProjectTransferExportChunkedJudgmentWarnings(judgmentRows)
  const exportedJudgmentRows = judgmentRows.filter((row) => {
    return row.chunkingStrategy === null
  })
  const exportedJudgmentIdSet = new Set(
    exportedJudgmentRows.map((row) => {
      return row.judgmentId
    }),
  )
  const exportedJudgmentAssessmentRows = judgmentAssessmentRows.filter((row) => {
    return exportedJudgmentIdSet.has(row.judgmentId)
  })
  const requiredModelIds = getUniqueValues([
    project.modelId,
    ...exportedJudgmentRows.map((row) => {
      return row.modelId
    }),
  ])
  const modelRows = await getProjectTransferExportModelRows(requiredModelIds, database)

  assertProjectTransferExportModelDependencies({modelRows, requiredModelIds})

  const requiredProviderConnectionIds = getUniqueValues(
    modelRows.map((row) => {
      return row.providerConnectionId
    }),
  )
  const providerConnectionRows = await getProjectTransferExportProviderConnectionRows(
    requiredProviderConnectionIds,
    database,
  )

  assertProjectTransferExportProviderConnectionDependencies({providerConnectionRows, requiredProviderConnectionIds})

  return {
    articleImportRouteRows,
    articleRows,
    humanJudgmentRows,
    humanJudgmentSummaryRows,
    importRouteRows,
    judgmentAssessmentRows: exportedJudgmentAssessmentRows,
    judgmentRows: exportedJudgmentRows,
    modelRows,
    project,
    projectArticleRows,
    projectImportRouteRows,
    projectPromptRows,
    providerConnectionRows,
    reviewRows,
    warnings: [
      ...ambiguousJudgmentWarnings,
      ...chunkedJudgmentWarnings,
      ...articleRawJsonDecision.warnings,
      ...getProjectTransferExportArticleWarnings(articleRows),
    ],
  }
}

type ProjectTransferExportPreflightEstimateRow = {
  articleCount: number | null
  estimatedPayloadChars: number | null
  rowCount: number | null
}

type ProjectTransferExportPreflightAssetArticleRow = {
  fullTextAssets: unknown
  fullTextHtml: string | null
  fullTextPdf: string | null
  sourceArticleId: string
}

type ProjectTransferExportArticleRawJsonEstimateRow = {
  estimatedChars: number | string | null
  rowCount: number | string | null
}

type ProjectTransferExportSummaryRow = {
  articleCount: number | string | null
  judgmentCount: number | string | null
  promptHumanJudgmentCount: number | string | null
  summaryHumanJudgmentCount: number | string | null
}

type ProjectTransferExportArticleRawJsonEstimate = {estimatedChars: number; rowCount: number}
type ProjectTransferExportArticleRawJsonDecision = {
  includeRawArticleJson: boolean
  rawArticleProvenanceMode: ProjectTransferRawArticleProvenanceMode
  warnings: ProjectTransferManifestWarning[]
}

const getProjectTransferExportPreflightPackageEstimate = async (
  projectId: string,
  database: AppQueryDatabaseService,
  options: {rawArticleProvenanceMode?: ProjectTransferRawArticleProvenanceMode} = {},
) => {
  const includeRawArticleProvenanceInEstimate = getRawArticleProvenanceMode(options.rawArticleProvenanceMode) !== 'omit'
  const [row] = await database.queryJson<ProjectTransferExportPreflightEstimateRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)},
    project_transfer_export_judgment AS (
      SELECT j.*
      FROM app.judgment j
      INNER JOIN project_transfer_scope_article scope ON scope.article_id = j.article_id
      INNER JOIN project_transfer_source_project project ON TRUE
      INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
      WHERE ${getProjectTransferExportAnsweredJudgmentCandidateWhereSql()}
        AND j.chunking_strategy IS NULL
    ),
    project_transfer_required_model AS (
      SELECT project.model_id
      FROM project_transfer_source_project project
      WHERE project.model_id IS NOT NULL
      UNION
      SELECT judgment.model_id
      FROM project_transfer_export_judgment judgment
    ),
    project_transfer_required_provider_connection AS (
      SELECT DISTINCT model.provider_connection_id
      FROM app.model model
      INNER JOIN project_transfer_required_model required_model ON required_model.model_id = model.id
    ),
    article_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.article article
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = article.id
      `,
        [
          'article.id',
          'article.article_id',
          'article.article_title',
          'article.article_summary',
          'article.article_authors',
          'article.arxiv_id',
          'article.biorxiv_id',
          'article.medrxiv_id',
          'article.doi',
          'article.pubmed_id',
          'article.url',
          'article.full_text',
          'article.full_text_html',
          'article.full_text_pdf',
          'article.full_text_source',
          'article.full_text_original_format',
          'article.full_text_assets',
          'article.full_text_conversion_status',
          'article.full_text_conversion_error',
          'article.full_text_conversion_model_id',
          'article.full_text_conversion_metadata',
          'article.content_hash',
          'article.import_route',
          ...(includeRawArticleProvenanceInEstimate ? ['article.original_data', 'article.source_metadata'] : []),
          'article.publication_status',
        ],
      )}
    ),
    article_import_route_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.article_import_route article_import_route
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = article_import_route.article_id
      `,
        [
          'article_import_route.id',
          'article_import_route.external_article_id',
          'article_import_route.match_metadata',
          ...(includeRawArticleProvenanceInEstimate
            ? ['article_import_route.import_metadata', 'article_import_route.raw_payload']
            : []),
          'article_import_route.source_kind',
          'article_import_route.source_record_hash',
          'article_import_route.source_record_key',
        ],
      )}
    ),
    project_article_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.project_article project_article
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = project_article.article_id
        WHERE project_article.project_id = ${getSqlLiteral(projectId)}
      `,
        ['project_article.id', 'project_article.imported_from_project_id'],
      )}
    ),
    project_prompt_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.project_prompt project_prompt
        INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id
        WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      `,
        [
          'project_prompt.id',
          'project_prompt.origin_project_id',
          'prompt.id',
          'prompt.original_text',
          'prompt.transformed_text',
          'prompt.prompt_heading',
          'prompt.type',
          'prompt.content_hash',
        ],
      )}
    ),
    import_route_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.project_import_route project_import_route
        INNER JOIN app.import_route import_route ON import_route.id = project_import_route.import_route_id
        WHERE project_import_route.project_id = ${getSqlLiteral(projectId)}
      `,
        [
          'project_import_route.id',
          'import_route.id',
          'import_route.route',
          'import_route.name',
          'import_route.description',
        ],
      )}
    ),
    judgment_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM project_transfer_export_judgment judgment
      `,
        [
          'judgment.id',
          'judgment.answered_original',
          'judgment.answered_original_as_array',
          'judgment.explanation',
          'judgment.quotes',
          'judgment.snapshot_project_id',
          'judgment.snapshot_project_model_name',
        ],
      )}
    ),
    judgment_assessment_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.judgment_assessment judgment_assessment
        INNER JOIN project_transfer_export_judgment judgment ON judgment.id = judgment_assessment.judgment_id
      `,
        ['judgment_assessment.id', 'judgment_assessment.assessment_comment'],
      )}
    ),
    human_judgment_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.judgment_human human_judgment
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = human_judgment.article_id
        WHERE human_judgment.project_id = ${getSqlLiteral(projectId)}
      `,
        ['human_judgment.id', 'human_judgment.answer', 'human_judgment.comment'],
      )}
    ),
    human_judgment_summary_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.judgment_human_summary human_judgment_summary
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = human_judgment_summary.article_id
        WHERE human_judgment_summary.project_id = ${getSqlLiteral(projectId)}
      `,
        ['human_judgment_summary.id', 'human_judgment_summary.answer', 'human_judgment_summary.origin'],
      )}
    ),
    review_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.review review
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = review.article_id
        WHERE review.project_id = ${getSqlLiteral(projectId)}
      `,
        [
          'review.id',
          'review.reviewed_title_comment',
          'review.reviewed_abstract_comment',
          'review.reviewed_intro_comment',
          'review.reviewed_method_comment',
          'review.reviewed_results_comment',
          'review.reviewed_discussion_comment',
          'review.reviewed_conclusion_comment',
          'review.reviewed_appendix_comment',
          'review.reviewed_other_comment',
        ],
      )}
    ),
    model_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.model model
        INNER JOIN project_transfer_required_model required_model ON required_model.model_id = model.id
      `,
        [
          'model.id',
          'model.display_name',
          'model.metadata_json',
          'model.name',
          'model.provider_connection_id',
          'model.remote_model_id',
          'model.source',
          'model.variant',
        ],
      )}
    ),
    provider_connection_estimate AS (
      ${getProjectTransferExportEstimateQuerySql(
        `
        FROM app.provider_connection provider_connection
        INNER JOIN project_transfer_required_provider_connection required_provider_connection
          ON required_provider_connection.provider_connection_id = provider_connection.id
      `,
        [
          'provider_connection.id',
          'provider_connection.auth_mode',
          'provider_connection.base_url',
          'provider_connection.config_json',
          'provider_connection.label',
          'provider_connection.last_error',
          'provider_connection.provider_kind',
          'provider_connection.secret_ref',
        ],
      )}
    )
    SELECT
      CAST(article_estimate.rowCount AS DOUBLE) AS articleCount,
      CAST(
        article_estimate.rowCount
        + article_import_route_estimate.rowCount
        + project_article_estimate.rowCount
        + project_prompt_estimate.rowCount
        + import_route_estimate.rowCount
        + judgment_estimate.rowCount
        + judgment_assessment_estimate.rowCount
        + human_judgment_estimate.rowCount
        + human_judgment_summary_estimate.rowCount
        + review_estimate.rowCount
        + model_estimate.rowCount
        + provider_connection_estimate.rowCount
        AS DOUBLE
      ) AS rowCount,
      CAST(
        article_estimate.textChars
        + article_import_route_estimate.textChars
        + project_article_estimate.textChars
        + project_prompt_estimate.textChars
        + import_route_estimate.textChars
        + judgment_estimate.textChars
        + judgment_assessment_estimate.textChars
        + human_judgment_estimate.textChars
        + human_judgment_summary_estimate.textChars
        + review_estimate.textChars
        + model_estimate.textChars
        + provider_connection_estimate.textChars
        AS DOUBLE
      ) AS estimatedPayloadChars
    FROM article_estimate,
      article_import_route_estimate,
      project_article_estimate,
      project_prompt_estimate,
      import_route_estimate,
      judgment_estimate,
      judgment_assessment_estimate,
      human_judgment_estimate,
      human_judgment_summary_estimate,
      review_estimate,
      model_estimate,
      provider_connection_estimate
  `)

  return row ?? {articleCount: 0, estimatedPayloadChars: 0, rowCount: 0}
}

const getProjectTransferExportPreflightAssetArticles = async (
  projectId: string,
  database: AppQueryDatabaseService,
): Promise<ProjectTransferExportAssetArticle[]> => {
  const rows = await database.queryJson<ProjectTransferExportPreflightAssetArticleRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      article.id AS sourceArticleId,
      TO_JSON(article.full_text_assets) AS fullTextAssets,
      article.full_text_html AS fullTextHtml,
      article.full_text_pdf AS fullTextPdf
    FROM app.article article
    INNER JOIN project_transfer_scope_article scope ON scope.article_id = article.id
    WHERE article.full_text_assets IS NOT NULL
      OR article.full_text_html IS NOT NULL
      OR article.full_text_pdf IS NOT NULL
    ORDER BY article.id ASC
  `)

  return rows.map((row) => {
    return {
      fullTextAssets: getJsonValue(row.fullTextAssets),
      fullTextHtml: row.fullTextHtml,
      fullTextPdf: row.fullTextPdf,
      sourceArticleId: row.sourceArticleId,
    } as ProjectTransferExportAssetArticle
  })
}

const getProjectTransferExportEstimatedPackageBytes = ({
  estimatedPayloadChars,
  rowCount,
}: {
  estimatedPayloadChars: number
  rowCount: number
}) => {
  const manifestAndZipOverheadBytes = 1024 * 1024

  return (
    getProjectTransferExportEstimatedStagedPayloadBytes({estimatedPayloadChars, rowCount}) + manifestAndZipOverheadBytes
  )
}

const getProjectTransferExportEstimatedStagedPayloadBytes = ({
  estimatedPayloadChars,
  rowCount,
}: {
  estimatedPayloadChars: number
  rowCount: number
}) => {
  const rowOverheadBytes = rowCount * 1024

  return Math.ceil((estimatedPayloadChars + rowOverheadBytes) * 4)
}

const getProjectTransferExportEstimateNumber = (value: number | null | undefined) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export const getProjectTransferExportPreflightEstimate = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
): Promise<ProjectTransferExportPreflightEstimate> => {
  const database = getDatabase(options)
  await getProjectTransferExportSourceProjectSettings(projectId, {database})

  const packageEstimate = await getProjectTransferExportPreflightPackageEstimate(projectId, database, {
    rawArticleProvenanceMode: options.rawArticleProvenanceMode,
  })
  const stagedPayloadBytes = getProjectTransferExportEstimatedStagedPayloadBytes({
    estimatedPayloadChars: getProjectTransferExportEstimateNumber(packageEstimate.estimatedPayloadChars),
    rowCount: getProjectTransferExportEstimateNumber(packageEstimate.rowCount),
  })
  const packageBytes = getProjectTransferExportEstimatedPackageBytes({
    estimatedPayloadChars: getProjectTransferExportEstimateNumber(packageEstimate.estimatedPayloadChars),
    rowCount: getProjectTransferExportEstimateNumber(packageEstimate.rowCount),
  })
  const assetBytes = await getProjectTransferExportAssetByteEstimateForArticles(
    await getProjectTransferExportPreflightAssetArticles(projectId, database),
    {cwd: options.cwd, envValues: options.envValues},
  )

  return {assetBytes, packageBytes, stagedPayloadBytes}
}

export const getProjectTransferExportSummary = async (
  projectId: string,
  options: {database?: AppQueryDatabaseService} = {},
): Promise<ProjectTransferExportSummary> => {
  const database = getDatabase(options)
  const [row] = await database.queryJson<ProjectTransferExportSummaryRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)},
    ${getProjectTransferExportAmbiguousJudgmentCteSql()},
    project_transfer_export_judgment AS (
      SELECT j.*
      FROM app.judgment j
      INNER JOIN project_transfer_scope_article scope ON scope.article_id = j.article_id
      INNER JOIN project_transfer_source_project project ON TRUE
      INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
      LEFT JOIN project_transfer_ambiguous_judgment_visible_key ambiguous
        ON ${getProjectTransferExportJudgmentAmbiguityJoinSql()}
      WHERE ${getProjectTransferExportAnsweredJudgmentCandidateWhereSql()}
        AND ambiguous.article_id IS NULL
        AND j.chunking_strategy IS NULL
    )
    SELECT
      (SELECT COUNT(*) FROM project_transfer_scope_article)::DOUBLE AS articleCount,
      (SELECT COUNT(*) FROM project_transfer_export_judgment)::DOUBLE AS judgmentCount,
      (
        SELECT COUNT(*)
        FROM app.judgment_human human_judgment
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = human_judgment.article_id
        INNER JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = ${getSqlLiteral(projectId)}
         AND project_prompt.prompt_id = human_judgment.prompt_id
        WHERE human_judgment.project_id = ${getSqlLiteral(projectId)}
      )::DOUBLE AS promptHumanJudgmentCount,
      (
        SELECT COUNT(*)
        FROM app.judgment_human_summary human_judgment_summary
        INNER JOIN project_transfer_scope_article scope ON scope.article_id = human_judgment_summary.article_id
        WHERE human_judgment_summary.project_id = ${getSqlLiteral(projectId)}
      )::DOUBLE AS summaryHumanJudgmentCount
  `)
  const promptHumanJudgmentCount = getQueryNumberValue(row?.promptHumanJudgmentCount)
  const summaryHumanJudgmentCount = getQueryNumberValue(row?.summaryHumanJudgmentCount)

  return {
    articleCount: getQueryNumberValue(row?.articleCount),
    humanJudgmentCount: promptHumanJudgmentCount + summaryHumanJudgmentCount,
    judgmentCount: getQueryNumberValue(row?.judgmentCount),
    promptHumanJudgmentCount,
    summaryHumanJudgmentCount,
  }
}

export const getProjectTransferExportProjectPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportProjectPayloadFromContext(await getProjectTransferExportContext(projectId, options))
}

export const getProjectTransferExportPromptsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportPromptsPayloadFromContext(await getProjectTransferExportContext(projectId, options))
}

export const getProjectTransferExportProjectPromptsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportProjectPromptsPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportImportRoutesPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportImportRoutesPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportProjectImportRoutesPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportProjectImportRoutesPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportArticlesPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return assertProjectTransferPayload(
    'articles',
    (await getProjectTransferExportContext(projectId, options)).articleRows,
  )
}

export const getProjectTransferExportArticleImportRoutesPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportArticleImportRoutesPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportProjectArticlesPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportProjectArticlesPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportJudgmentsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportJudgmentsPayloadFromContext(await getProjectTransferExportContext(projectId, options))
}

export const getProjectTransferExportJudgmentAssessmentsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportJudgmentAssessmentsPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportHumanJudgmentsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportHumanJudgmentsPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportHumanJudgmentSummariesPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportHumanJudgmentSummariesPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportReviewsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportReviewsPayloadFromContext(await getProjectTransferExportContext(projectId, options))
}

export const getProjectTransferExportProviderConnectionsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportProviderConnectionsPayloadFromContext(
    await getProjectTransferExportContext(projectId, options),
  )
}

export const getProjectTransferExportModelsPayload = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
) => {
  return getProjectTransferExportModelsPayloadFromContext(await getProjectTransferExportContext(projectId, options))
}

const getProjectTransferExportPayloadsFromContext = (
  context: ProjectTransferExportContext,
  assetManifest: ProjectTransferPayloadByKey['assetManifest'],
) => {
  return {
    articleImportRoutes: getProjectTransferExportArticleImportRoutesPayloadFromContext(context),
    articles: assertProjectTransferPayload('articles', context.articleRows),
    assetManifest: assertProjectTransferPayload('assetManifest', assetManifest),
    humanJudgmentSummaries: getProjectTransferExportHumanJudgmentSummariesPayloadFromContext(context),
    humanJudgments: getProjectTransferExportHumanJudgmentsPayloadFromContext(context),
    importRoutes: getProjectTransferExportImportRoutesPayloadFromContext(context),
    judgmentAssessments: getProjectTransferExportJudgmentAssessmentsPayloadFromContext(context),
    judgments: getProjectTransferExportJudgmentsPayloadFromContext(context),
    models: getProjectTransferExportModelsPayloadFromContext(context),
    project: getProjectTransferExportProjectPayloadFromContext(context),
    projectArticles: getProjectTransferExportProjectArticlesPayloadFromContext(context),
    projectImportRoutes: getProjectTransferExportProjectImportRoutesPayloadFromContext(context),
    projectPrompts: getProjectTransferExportProjectPromptsPayloadFromContext(context),
    prompts: getProjectTransferExportPromptsPayloadFromContext(context),
    providerConnections: getProjectTransferExportProviderConnectionsPayloadFromContext(context),
    reviews: getProjectTransferExportReviewsPayloadFromContext(context),
  } satisfies ProjectTransferPayloadByKey
}

const getProjectTransferExportWarningsFromContext = (context: ProjectTransferExportContext) => {
  return [...context.warnings, ...getProjectTransferExportCurrentReviewRowsSignatureWarnings(context)]
}

export const getProjectTransferExportPayloads = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
): Promise<ProjectTransferExportPayloadAssembly> => {
  const context = await getProjectTransferExportContext(projectId, options)
  const assetCollection = await getProjectTransferExportAssetCollectionForArticles(context.articleRows, {
    cwd: options.cwd,
    envValues: options.envValues,
  })
  const contextWithAssets = {...context, articleRows: assetCollection.articles}

  return {
    assetEntries: assetCollection.assetEntries,
    payloads: getProjectTransferExportPayloadsFromContext(contextWithAssets, assetCollection.assetManifest),
    warnings: getProjectTransferExportWarningsFromContext(contextWithAssets),
  }
}

export const stageProjectTransferExportPayloadRows = async ({
  projectId,
  rootPath,
  ...options
}: ProjectTransferExportQueryOptions & {
  projectId: string
  rootPath: string
}): Promise<ProjectTransferExportStagedPayloadRows> => {
  const context = await getProjectTransferExportContext(projectId, options)
  const assetReferences = getProjectTransferExportAssetReferenceCollectionForArticles(context.articleRows)
  const contextWithAssets = {...context, articleRows: assetReferences.articles}
  const payloads = getProjectTransferExportPayloadsFromContext(
    contextWithAssets,
    getEmptyProjectTransferAssetManifestPayload(),
  )
  const payloadFiles = await writeProjectTransferExportStagedPayloadFiles({
    keys: projectTransferPayloadKeys.filter((key) => {
      return key !== 'assetManifest'
    }),
    payloads,
    rootPath,
  })

  return {
    assetReferences: assetReferences.references,
    payloadFiles,
    payloads,
    warnings: getProjectTransferExportWarningsFromContext(contextWithAssets),
  }
}

export const completeProjectTransferExportStagedPayloads = async ({
  cwd,
  envValues,
  rootPath,
  stagedRows,
}: {
  cwd?: string
  envValues?: Record<string, string | undefined>
  rootPath: string
  stagedRows: ProjectTransferExportStagedPayloadRows
}): Promise<ProjectTransferExportStagedPayloadAssembly> => {
  const assetCollection = await getProjectTransferExportAssetCollectionForReferences(stagedRows.assetReferences, {
    cwd,
    envValues,
    readBytes: false,
    stagingRootPath: rootPath,
  })
  const payloads = {
    ...stagedRows.payloads,
    assetManifest: assertProjectTransferPayload('assetManifest', assetCollection.assetManifest),
  }
  const assetManifestFile = await writeProjectTransferExportStagedPayloadFile({
    key: 'assetManifest',
    payload: payloads.assetManifest,
    rootPath,
  })
  const payloadFiles = {...stagedRows.payloadFiles, assetManifest: assetManifestFile}

  return {
    assetEntries: assetCollection.assetEntries,
    payloadFiles: payloadFiles as Record<ProjectTransferPayloadKey, ProjectTransferExportStagedPayloadFile>,
    payloads,
    warnings: stagedRows.warnings,
  }
}

export const serializeProjectTransferExportPayload = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  payload: ProjectTransferPayloadByKey[TKey],
) => {
  return serializeProjectTransferPayload(key, payload)
}

export const serializeProjectTransferExportPayloads = (
  payloads: ProjectTransferPayloadByKey,
): ProjectTransferExportSerializedPayloads => {
  return projectTransferPayloadKeys.reduce<ProjectTransferExportSerializedPayloads>((serializedPayloads, key) => {
    return {...serializedPayloads, [key]: serializeProjectTransferPayload(key, payloads[key])}
  }, {} as ProjectTransferExportSerializedPayloads)
}

export const getProjectTransferExportPayloadKeys = () => {
  return [...projectTransferPayloadKeys]
}
