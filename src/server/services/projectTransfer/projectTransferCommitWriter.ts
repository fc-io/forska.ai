import type {ProjectTransferHistoryRecord} from '../../../db/schemaTypes.ts'
import {computePromptContentHash} from '../../utils/computePromptContentHash.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../appQueryHelpers.ts'
import {getProjectMartDirtyRefreshStateService} from '../projectMartDirtyRefreshStateService.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import {
  assertProjectTransferCommitGeneratedIdsAvailable,
  dropProjectTransferCommitIdMapTables,
  getProjectTransferCommitMapsWithDependencyTargets,
  getProjectTransferCommitMapsWithPromptTargets,
  getProjectTransferPlanWithCommitIdMaps,
  getProjectTransferPromptContentHashBySourceId,
  loadProjectTransferCommitIdMapTables,
  type ProjectTransferCommitIdMaps,
  type ProjectTransferCommitIdMapTableSet,
} from './projectTransferCommitIdMaps.ts'
import type {ProjectTransferCommitPromotionResult} from './projectTransferCommitRollback.ts'
import type {ProjectTransferImportCompletionPayload} from './projectTransferContracts.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {getProjectTransferHistoryRepository} from './projectTransferHistoryRepository.ts'
import {getProjectTransferNormalizedArticleIdentifiers} from './projectTransferIdentifierNormalization.ts'
import type {ProjectTransferOperationTableSet} from './projectTransferOperationTables.ts'
import type {
  ProjectTransferArticlePayloadRecord,
  ProjectTransferPayloadByKey,
  ProjectTransferPayloadRecord,
  ProjectTransferProjectPayload,
} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  measureProjectTransferPhase,
  mergeProjectTransferPerformanceMetrics,
  type ProjectTransferPerformanceMetrics,
} from './projectTransferPerformanceMetrics.ts'
import type {ProjectTransferPackageWarning, ProjectTransferPayloadKey} from './projectTransferSchemas.ts'
import {
  getProjectTransferModelSnapshotFingerprint,
  getProjectTransferProviderSnapshotFingerprint,
} from './projectTransferSnapshotFingerprint.ts'
import {
  getProjectTransferTargetStateDirtyTokenService,
  type ProjectTransferTargetStateSafetySurface,
} from './projectTransferTargetStateDirtyTokenService.ts'

type ProjectTransferCommitWriterTx = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ProjectTransferCommitWriterDatabase = ProjectTransferCommitWriterTx & {
  transaction: <T>(work: (tx: ProjectTransferCommitWriterTx) => Promise<T> | T) => Promise<T>
}

export type ProjectTransferCommitWriterInput = {
  commitId: string
  database?: ProjectTransferCommitWriterDatabase
  now?: Date
  operationTables?: ProjectTransferOperationTableSet
  payloads: Partial<ProjectTransferPayloadByKey>
  plan: ProjectTransferImportPlanArtifact
  promotion: ProjectTransferCommitPromotionResult
  schemaVersion: number
  sessionId: string
}

export type ProjectTransferCommitAppWriteResult = {
  articleIdBySourceId: Record<string, string>
  commitIdMaps?: ProjectTransferCommitIdMaps
  completion: ProjectTransferImportCompletionPayload
  history: ProjectTransferHistoryRecord
  importWarnings: ProjectTransferPackageWarning[]
  performanceMetrics?: ProjectTransferPerformanceMetrics
  projectId: string
  projectName: string
  promptIdBySourceId: Record<string, string>
  routeIdBySourceId: Record<string, string>
}

type DependencyResolutionState = {
  modelTargetBySourceId?: Record<string, string>
  providerTargetBySourceId?: Record<string, string>
}

type ImportedProviderConnectionCommitRow = {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  enabled: boolean
  label: string
  maxInflightRequests: number | null
  providerKind: string
  secretRef: string | null
  sourceProviderConnectionId: string
}

type ImportedModelCommitRow = {
  displayName: string | null
  enabled: boolean
  metadataJson: unknown
  modelName: string | null
  name: string
  remoteModelId: string | null
  source: string | null
  sourceModelId: string
  sourceProviderConnectionId: string
  variant: string | null
  version: string | null
}

type ImportedProviderSnapshotTargetRow = {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  id: string
  providerKind: string
}

type ImportedModelSnapshotTargetRow = {
  displayName: string | null
  id: string
  metadataJson: unknown
  name: string
  providerAuthMode: string | null
  providerBaseURL: string | null
  providerConfigJson: unknown
  providerKind: string
  remoteModelId: string | null
  variant: string | null
  version: string | null
}

type ArticleField = keyof typeof articleColumnByPayloadField
type ArticleMatchPlan = ProjectTransferTargetPlan['articleMatches'][number]
type ArticleIdentifierCommitRow = {
  action: ArticleMatchPlan['action']
  articleId: string
  id: string
  identifier: ReturnType<typeof getProjectTransferNormalizedArticleIdentifiers>['strongIdentifiers'][number]
  isPrimary: boolean
  sourceArticleId: string
}
type ArticleIdentifierStageRow = {
  isPrimary: boolean
  kind: string
  normalizedValue: string
  source: string
  sourceArticleId: string
  sourceKey: string
}
type ArticleIdentifierTargetRow = {articleId: string; kind: string; normalizedValue: string}
type ArticleRoutePlanEntry = ProjectTransferTargetPlan['articleRoutePlan'][number]
type HumanReviewPlanEntry = NonNullable<ProjectTransferTargetPlan['humanReviewPlan']>[number]
type JudgmentAssessmentPlanEntry = NonNullable<ProjectTransferTargetPlan['judgmentAssessmentPlan']>[number]
type JudgmentPlanEntry = NonNullable<ProjectTransferTargetPlan['judgmentPlan']>[number]
type ProjectRoutePlanEntry = ProjectTransferTargetPlan['projectRoutePlan'][number]
type PromptPlanEntry = ProjectTransferTargetPlan['promptPlan'][number]
type ProjectPromptPlanEntry = ProjectTransferTargetPlan['projectPromptPlan'][number]

type TargetArticleFieldRow = Record<ArticleField, unknown> & {id: string}
type TargetJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: unknown
  confidenceOriginal: number | null
  deleteGeneration: number | null
  explanation: string | null
  id: string
  isAnswered: boolean | null
  quotes: unknown
  articleId: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type TargetJudgmentAssessmentRow = {
  assessmentComment: string | null
  assessmentIsCorrect: boolean | null
  id: string
  judgmentId: string
}

type JudgmentCommitRow = {
  action: 'insert' | 'reuse'
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: Date
  deleteGeneration: number
  explanation: string | null
  id: string
  modelId: string
  promptId: string
  quotes: unknown[]
  snapshotProjectModelName: string | null
  sourceJudgmentId: string
  updatedAt: Date
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type JudgmentAssessmentCommitRow = {
  action: 'insert' | 'reuse'
  assessmentComment: string | null
  assessmentIsCorrect: boolean
  createdAt: Date
  id: string
  judgmentId: string
  sourceJudgmentAssessmentId: string
  updatedAt: Date
}

type HumanJudgmentCommitRow = {
  answer: string | null
  articleId: string
  comment: string | null
  createdAt: Date
  id: string
  isAnswered: boolean
  projectId: string
  promptId: string
  sourceHumanJudgmentId: string
  updatedAt: Date
}

type HumanJudgmentSummaryCommitRow = {
  answer: string | null
  articleId: string
  createdAt: Date
  id: string
  origin: string
  projectId: string
  sourceHumanJudgmentSummaryId: string
  updatedAt: Date
}

type ReviewCommitRow = {
  articleId: string
  createdAt: Date
  id: string
  opened: boolean
  projectId: string
  sections: Record<string, {comment: string | null; reviewed: boolean}>
  sourceReviewId: string
  updatedAt: Date
}

type ProjectTransferCommitWriterTempTableSet = {
  articleCreates: string
  articleFieldFills: string
  articleIdentifiers: string
  articleRoutePlan: string
  humanReviewPlan: string
  judgmentAssessmentPlan: string
  judgmentPlan: string
  projectArticleSources: string
  projectRoutePlan: string
}

type ProjectTransferCommitWriterSetBasedContext = {
  commitIdMapTables: ProjectTransferCommitIdMapTableSet
  operationTables: ProjectTransferOperationTableSet
  tempTables: ProjectTransferCommitWriterTempTableSet
}

const articleColumnByPayloadField = {
  articleAuthors: 'article_authors',
  articleCreatedAt: 'article_created_at',
  articleId: 'article_id',
  articleSummary: 'article_summary',
  articleTitle: 'article_title',
  articleUpdatedAt: 'article_updated_at',
  articleVersion: 'article_version',
  arxivId: 'arxiv_id',
  biorxivId: 'biorxiv_id',
  contentHash: 'content_hash',
  doi: 'doi',
  fullText: 'full_text',
  fullTextAssets: 'full_text_assets',
  fullTextCharCount: 'full_text_char_count',
  fullTextConversionAttempts: 'full_text_conversion_attempts',
  fullTextConversionError: 'full_text_conversion_error',
  fullTextConversionMetadata: 'full_text_conversion_metadata',
  fullTextConversionModelId: 'full_text_conversion_model_id',
  fullTextConversionStatus: 'full_text_conversion_status',
  fullTextFetchedAt: 'full_text_fetched_at',
  fullTextHtml: 'full_text_html',
  fullTextOriginalFormat: 'full_text_original_format',
  fullTextPdf: 'full_text_pdf',
  fullTextSource: 'full_text_source',
  importRoute: 'import_route',
  medrxivId: 'medrxiv_id',
  originalData: 'original_data',
  publicationStatus: 'publication_status',
  pubmedId: 'pubmed_id',
  sourceMetadata: 'source_metadata',
  url: 'url',
} as const

const articleJsonFields = new Set<ArticleField>([
  'fullTextAssets',
  'fullTextConversionMetadata',
  'originalData',
  'sourceMetadata',
])
const articleArrayFields = new Set<ArticleField>(['articleAuthors'])
const articleDateFields = new Set<ArticleField>(['articleCreatedAt', 'articleUpdatedAt', 'fullTextFetchedAt'])
const articleNumberFields = new Set<ArticleField>(['articleVersion', 'fullTextCharCount', 'fullTextConversionAttempts'])
const articleNumberSqlTypeByField: Partial<Record<ArticleField, string>> = {
  articleVersion: 'INTEGER',
  fullTextCharCount: 'BIGINT',
  fullTextConversionAttempts: 'INTEGER',
}
const articleStringFields = new Set<ArticleField>(
  Object.keys(articleColumnByPayloadField).filter((field) => {
    return (
      !articleJsonFields.has(field as ArticleField)
      && !articleArrayFields.has(field as ArticleField)
      && !articleDateFields.has(field as ArticleField)
      && !articleNumberFields.has(field as ArticleField)
    )
  }) as ArticleField[],
)
const articleFieldSelectSql = Object.entries(articleColumnByPayloadField)
  .map(([field, column]) => {
    return articleJsonFields.has(field as ArticleField) || articleArrayFields.has(field as ArticleField)
      ? `TO_JSON(${column}) AS ${field}`
      : `${column} AS ${field}`
  })
  .join(',\n')
const commitWriterInsertBatchSize = 500
const importedSnapshotMarker = 'projectTransferImportedSnapshot'
const commitWriterSetBasedTableSuffixes = [
  'articleCreates',
  'articleFieldFills',
  'articleIdentifiers',
  'articleRoutePlan',
  'humanReviewPlan',
  'judgmentAssessmentPlan',
  'judgmentPlan',
  'projectArticleSources',
  'projectRoutePlan',
] as const satisfies readonly (keyof ProjectTransferCommitWriterTempTableSet)[]
const projectTransferCommitWriteDirtyTokenSurfaces = [
  'project',
  'article',
  'articleIdentifier',
  'importRoute',
  'projectImportRoute',
  'projectArticle',
  'prompt',
  'projectPrompt',
  'judgment',
  'judgmentAssessment',
  'humanJudgment',
  'humanJudgmentSummary',
  'review',
  'model',
  'providerConnection',
  'importedSnapshotMarker',
  'snapshotFingerprintInput',
] as const satisfies readonly ProjectTransferTargetStateSafetySurface[]

const failCommitWriter = (message: string): never => {
  throw new Error(`Project transfer commit writer: ${message}`)
}

const getSafeOperationId = (value: string) => {
  const identifier = value.replaceAll('-', '_').replace(/[^A-Za-z0-9_]/g, '_')

  return identifier === '' ? 'commit_writer' : identifier
}

const getCommitWriterTempTableName = ({
  operationId,
  suffix,
}: {
  operationId: string
  suffix: keyof ProjectTransferCommitWriterTempTableSet
}) => {
  return `temp_project_transfer_${getSafeOperationId(operationId)}_commit_${suffix.replace(/[A-Z]/g, (match) => {
    return `_${match.toLowerCase()}`
  })}`
}

const getCommitWriterTempTables = (operationId: string): ProjectTransferCommitWriterTempTableSet => {
  return commitWriterSetBasedTableSuffixes.reduce<ProjectTransferCommitWriterTempTableSet>((tables, suffix) => {
    return {...tables, [suffix]: getCommitWriterTempTableName({operationId, suffix})}
  }, {} as ProjectTransferCommitWriterTempTableSet)
}

const getJsonArrayRowsSourceSql = (rows: readonly unknown[]) => {
  return rows.length === 0
    ? `(SELECT CAST(NULL AS JSON) AS row_json WHERE FALSE) AS rows`
    : `UNNEST(json_extract(CAST(${getSqlLiteral(JSON.stringify(rows))} AS JSON), '$[*]')) AS rows(row_json)`
}

const getJsonStringFieldSql = (jsonExpression: string, field: string) => {
  return `json_extract_string(${jsonExpression}, '$.${field}')`
}

const getNullableJsonStringFieldSql = (jsonExpression: string, field: string) => {
  const valueSql = getJsonStringFieldSql(jsonExpression, field)

  return `CASE WHEN trim(COALESCE(${valueSql}, '')) = '' THEN NULL ELSE ${valueSql} END`
}

const getJsonStringPathSql = (jsonExpression: string, path: string) => {
  return `json_extract_string(${jsonExpression}, '${path}')`
}

const getNullableJsonStringPathSql = (jsonExpression: string, path: string) => {
  const valueSql = getJsonStringPathSql(jsonExpression, path)

  return `CASE WHEN trim(COALESCE(${valueSql}, '')) = '' THEN NULL ELSE ${valueSql} END`
}

const getJsonBooleanPathSql = (jsonExpression: string, path: string, defaultValue: boolean) => {
  return `COALESCE(TRY_CAST(${getJsonStringPathSql(jsonExpression, path)} AS BOOLEAN), ${getSqlLiteral(defaultValue)})`
}

const getJsonIntegerFieldSql = (jsonExpression: string, field: string, defaultValue: number) => {
  return `COALESCE(TRY_CAST(${getJsonStringFieldSql(jsonExpression, field)} AS INTEGER), ${getSqlLiteral(defaultValue)})`
}

const getJsonBigIntFieldSql = (jsonExpression: string, field: string, defaultValue: number) => {
  return `COALESCE(TRY_CAST(${getJsonStringFieldSql(jsonExpression, field)} AS BIGINT), ${getSqlLiteral(defaultValue)})`
}

const getJsonTimestampFieldSql = (jsonExpression: string, field: string, defaultValue: Date) => {
  return `COALESCE(TRY_CAST(${getJsonStringFieldSql(jsonExpression, field)} AS TIMESTAMPTZ), ${getTimestampLiteral(defaultValue)})`
}

const getJsonStringArrayFieldSql = (jsonExpression: string, field: string) => {
  return `COALESCE(json_extract(${jsonExpression}, '$.${field}')::VARCHAR[], []::VARCHAR[])`
}

const getJsonArrayFieldSql = (jsonExpression: string, field: string) => {
  return `COALESCE(json_extract(${jsonExpression}, '$.${field}'), CAST('[]' AS JSON))`
}

const getPlannedTargetMatchesSql = ({actualSql, plannedSql}: {actualSql: string; plannedSql: string}) => {
  return `(${plannedSql} IS NULL OR starts_with(${plannedSql}, 'new:') OR ${plannedSql} = ${actualSql})`
}

const getArticleJsonFieldSql = (jsonExpression: string, field: ArticleField) => {
  return field === 'articleTitle'
    ? getJsonStringFieldSql(jsonExpression, field)
    : articleJsonFields.has(field)
      ? `json_extract(${jsonExpression}, '$.${field}')`
      : articleArrayFields.has(field)
        ? `json_extract(${jsonExpression}, '$.${field}')::VARCHAR[]`
        : articleDateFields.has(field)
          ? `TRY_CAST(${getJsonStringFieldSql(jsonExpression, field)} AS TIMESTAMPTZ)`
          : articleNumberFields.has(field)
            ? `TRY_CAST(${getJsonStringFieldSql(jsonExpression, field)} AS ${articleNumberSqlTypeByField[field] ?? 'DOUBLE'})`
            : getNullableJsonStringFieldSql(jsonExpression, field)
}

const getArticleFillValueSql = (field: ArticleField) => {
  return articleJsonFields.has(field)
    ? 'fill.value_json'
    : articleArrayFields.has(field)
      ? 'fill.value_json::VARCHAR[]'
      : articleDateFields.has(field)
        ? "TRY_CAST(json_extract_string(fill.value_json, '$') AS TIMESTAMPTZ)"
        : articleNumberFields.has(field)
          ? `TRY_CAST(json_extract_string(fill.value_json, '$') AS ${articleNumberSqlTypeByField[field] ?? 'DOUBLE'})`
          : "json_extract_string(fill.value_json, '$')"
}

const getMissingTargetArticleValueSql = ({alias, field}: {alias: string; field: ArticleField}) => {
  const column = articleColumnByPayloadField[field]

  return articleJsonFields.has(field)
    ? `${alias}.${column} IS NULL`
    : articleArrayFields.has(field)
      ? `(${alias}.${column} IS NULL OR COALESCE(array_length(${alias}.${column}), 0) = 0)`
      : articleStringFields.has(field)
        ? `(${alias}.${column} IS NULL OR trim(${alias}.${column}) = '')`
        : `${alias}.${column} IS NULL`
}

const getTableCount = async ({sql, tx}: {sql: string; tx: ProjectTransferCommitWriterTx}) => {
  const [row] = await tx.queryJson<{count: number}>(`SELECT COUNT(*)::INTEGER AS count FROM (${sql}) counted`)

  return row?.count ?? 0
}

const getValueChunks = <TValue>(values: readonly TValue[], chunkSize = commitWriterInsertBatchSize): TValue[][] => {
  return Array.from({length: Math.ceil(values.length / chunkSize)}, (_value, index) => {
    return values.slice(index * chunkSize, (index + 1) * chunkSize)
  })
}

const runChunks = async <TValue>(
  values: readonly TValue[],
  work: (chunk: readonly TValue[]) => Promise<void>,
): Promise<void> => {
  await getValueChunks(values).reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    return work(chunk)
  }, Promise.resolve())
}

const queryChunks = async <TValue, TRow>(
  values: readonly TValue[],
  work: (chunk: readonly TValue[]) => Promise<TRow[]>,
): Promise<TRow[]> => {
  return getValueChunks(values).reduce<Promise<TRow[]>>(async (previous, chunk) => {
    const rows = await previous
    const chunkRows = await work(chunk)

    rows.push(...chunkRows)

    return rows
  }, Promise.resolve([]))
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRecordField = (record: Record<string, unknown>, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : null
}

const getRequiredString = (value: unknown, label: string) => {
  return typeof value === 'string' && value.trim() !== '' ? value : failCommitWriter(`${label} is required`)
}

const getNullableString = (value: unknown) => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getNullableNumber = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getNonNegativeInteger = (value: unknown, defaultValue: number) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : defaultValue
}

const getBoolean = (value: unknown, defaultValue: boolean) => {
  return typeof value === 'boolean' ? value : defaultValue
}

const getStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : null
}

const getArrayValue = (value: unknown) => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? (parsed as readonly unknown[]).map((entry) => {
        return entry
      })
    : []
}

const valuesEquivalent = (left: unknown, right: unknown) => {
  return getProjectTransferCanonicalJson(left ?? null) === getProjectTransferCanonicalJson(right ?? null)
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getImportedSnapshotJson = (value: unknown, snapshot: Record<string, unknown>) => {
  const parsed = getJsonValue(value)
  const record = isRecord(parsed) ? parsed : {}

  return {...record, [importedSnapshotMarker]: snapshot}
}

const getImportedSnapshotMarker = (value: unknown) => {
  const parsed = getJsonValue(value)
  const marker = isRecord(parsed) ? parsed[importedSnapshotMarker] : null

  return isRecord(marker) ? marker : null
}

const importedSnapshotMarkerFingerprintMatches = ({fingerprint, marker}: {fingerprint: unknown; marker: unknown}) => {
  return (
    isRecord(marker)
    && getProjectTransferCanonicalJson(marker.snapshotFingerprint) === getProjectTransferCanonicalJson(fingerprint)
  )
}

const getImportedProviderSnapshotFingerprint = (importedProvider: ImportedProviderConnectionCommitRow) => {
  return getProjectTransferProviderSnapshotFingerprint({
    authMode: importedProvider.authMode,
    baseURL: importedProvider.baseURL,
    configJson: importedProvider.configJson,
    providerKind: importedProvider.providerKind,
  })
}

const getTargetProviderSnapshotFingerprint = (targetProvider: ImportedProviderSnapshotTargetRow) => {
  return getProjectTransferProviderSnapshotFingerprint({
    authMode: targetProvider.authMode,
    baseURL: targetProvider.baseURL,
    configJson: targetProvider.configJson,
    providerKind: targetProvider.providerKind,
  })
}

const getImportedModelSnapshotFingerprint = ({
  importedModel,
  importedProvider,
}: {
  importedModel: ImportedModelCommitRow
  importedProvider: ImportedProviderConnectionCommitRow
}) => {
  return getProjectTransferModelSnapshotFingerprint({
    displayName: importedModel.displayName,
    metadataJson: importedModel.metadataJson,
    modelName: importedModel.modelName,
    name: importedModel.name,
    provider: {
      authMode: importedProvider.authMode,
      baseURL: importedProvider.baseURL,
      configJson: importedProvider.configJson,
      providerKind: importedProvider.providerKind,
    },
    remoteModelId: importedModel.remoteModelId,
    variant: importedModel.variant,
    version: importedModel.version,
  })
}

const getTargetModelSnapshotFingerprint = ({
  importedModel,
  targetModel,
}: {
  importedModel: ImportedModelCommitRow
  targetModel: ImportedModelSnapshotTargetRow
}) => {
  return getProjectTransferModelSnapshotFingerprint({
    displayName: targetModel.displayName,
    metadataJson: targetModel.metadataJson,
    modelName: importedModel.modelName,
    name: targetModel.name,
    provider: {
      authMode: targetModel.providerAuthMode,
      baseURL: targetModel.providerBaseURL,
      configJson: targetModel.providerConfigJson,
      providerKind: targetModel.providerKind,
    },
    remoteModelId: targetModel.remoteModelId,
    variant: targetModel.variant,
    version: targetModel.version,
  })
}

const targetModelIdentityMatches = ({
  importedModel,
  targetModel,
}: {
  importedModel: ImportedModelCommitRow
  targetModel: ImportedModelSnapshotTargetRow
}) => {
  return (
    targetModel.name === importedModel.name
    && targetModel.remoteModelId === (importedModel.remoteModelId ?? importedModel.modelName)
    && targetModel.displayName === importedModel.displayName
    && targetModel.variant === importedModel.variant
    && targetModel.version === importedModel.version
  )
}

const getReusableImportedProviderConnectionId = async ({
  importedProvider,
  tx,
}: {
  importedProvider: ImportedProviderConnectionCommitRow
  tx: ProjectTransferCommitWriterTx
}) => {
  const sourceFingerprint = getImportedProviderSnapshotFingerprint(importedProvider)
  const rows = await tx.queryJson<ImportedProviderSnapshotTargetRow>(`
    SELECT
      id,
      provider_kind AS providerKind,
      auth_mode AS authMode,
      base_url AS baseURL,
      TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE json_extract_string(config_json, '$.${importedSnapshotMarker}.sourceProviderConnectionId') = ${getSqlLiteral(importedProvider.sourceProviderConnectionId)}
    ORDER BY created_at ASC, id ASC
  `)
  const matchingRows = rows.filter((row) => {
    const marker = getImportedSnapshotMarker(row.configJson)
    const targetFingerprint = getTargetProviderSnapshotFingerprint(row)

    return (
      importedSnapshotMarkerFingerprintMatches({fingerprint: sourceFingerprint, marker})
      && getProjectTransferCanonicalJson(targetFingerprint) === getProjectTransferCanonicalJson(sourceFingerprint)
    )
  })

  return matchingRows.length === 1 ? (matchingRows[0]?.id ?? null) : null
}

const disableImportedProviderConnectionSnapshot = async ({
  providerConnectionId,
  tx,
}: {
  providerConnectionId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  await tx.run(`
    UPDATE app.provider_connection
    SET enabled = FALSE
    WHERE id = ${getSqlLiteral(providerConnectionId)}
  `)
}

const getReusableImportedModelId = async ({
  importedModel,
  importedProvider,
  providerConnectionId,
  tx,
}: {
  importedModel: ImportedModelCommitRow
  importedProvider: ImportedProviderConnectionCommitRow
  providerConnectionId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const sourceFingerprint = getImportedModelSnapshotFingerprint({importedModel, importedProvider})
  const rows = await tx.queryJson<ImportedModelSnapshotTargetRow>(`
    SELECT
      model.id,
      model.name,
      model.remote_model_id AS remoteModelId,
      model.display_name AS displayName,
      model.variant,
      json_extract_string(model.metadata_json, '$.${importedSnapshotMarker}.snapshotFingerprint.model.version') AS version,
      TO_JSON(model.metadata_json) AS metadataJson,
      provider.provider_kind AS providerKind,
      provider.auth_mode AS providerAuthMode,
      provider.base_url AS providerBaseURL,
      TO_JSON(provider.config_json) AS providerConfigJson
    FROM app.model model
    INNER JOIN app.provider_connection provider ON provider.id = model.provider_connection_id
    WHERE model.provider_connection_id = ${getSqlLiteral(providerConnectionId)}
      AND json_extract_string(model.metadata_json, '$.${importedSnapshotMarker}.sourceModelId') = ${getSqlLiteral(importedModel.sourceModelId)}
    ORDER BY model.created_at ASC, model.id ASC
  `)
  const matchingRows = rows.filter((row) => {
    const marker = getImportedSnapshotMarker(row.metadataJson)
    const targetFingerprint = getTargetModelSnapshotFingerprint({importedModel, targetModel: row})

    return (
      targetModelIdentityMatches({importedModel, targetModel: row})
      && importedSnapshotMarkerFingerprintMatches({fingerprint: sourceFingerprint, marker})
      && getProjectTransferCanonicalJson(targetFingerprint) === getProjectTransferCanonicalJson(sourceFingerprint)
    )
  })

  if (rows.length > 0 && matchingRows.length === 0) {
    failCommitWriter(
      `imported model snapshot ${importedModel.sourceModelId} no longer matches its materialized target; rerun import analysis before commit`,
    )
  }

  return matchingRows.length === 1 ? (matchingRows[0]?.id ?? null) : null
}

const disableImportedModelSnapshot = async ({modelId, tx}: {modelId: string; tx: ProjectTransferCommitWriterTx}) => {
  await tx.run(`
    UPDATE app.model
    SET enabled = FALSE
    WHERE id = ${getSqlLiteral(modelId)}
  `)
}

const getNullableDateLiteral = (value: unknown) => {
  const date = getDateValue(value)

  return date === null ? 'NULL' : getTimestampLiteral(date)
}

const getDateOrDefault = (value: unknown, defaultValue: Date) => {
  return getDateValue(value) ?? defaultValue
}

const getArticleFieldSqlLiteral = (field: ArticleField, value: unknown) => {
  return articleJsonFields.has(field)
    ? getJsonLiteral(value ?? null)
    : articleArrayFields.has(field)
      ? getSqlLiteral(getStringArray(value))
      : articleDateFields.has(field)
        ? getNullableDateLiteral(value)
        : articleNumberFields.has(field)
          ? getSqlLiteral(getNullableNumber(value))
          : getSqlLiteral(getNullableString(value))
}

const getArticlePayloadField = (article: ProjectTransferArticlePayloadRecord, field: ArticleField) => {
  return getRecordField(article, field)
}

const getArticleSqlValue = (article: ProjectTransferArticlePayloadRecord, field: ArticleField) => {
  return field === 'articleTitle'
    ? getSqlLiteral(getRequiredString(getArticlePayloadField(article, field), `article.${field}`))
    : getArticleFieldSqlLiteral(field, getArticlePayloadField(article, field))
}

const getCreatedArticleValuesSql = ({
  article,
  articleId,
  now,
}: {
  article: ProjectTransferArticlePayloadRecord
  articleId: string
  now: Date
}) => {
  return `(
    ${getSqlLiteral(articleId)},
    ${Object.keys(articleColumnByPayloadField)
      .map((field) => {
        return getArticleSqlValue(article, field as ArticleField)
      })
      .join(', ')},
    ${getTimestampLiteral(now)},
    ${getTimestampLiteral(now)}
  )`
}

const getDependencyResolutionState = (plan: ProjectTransferImportPlanArtifact): DependencyResolutionState => {
  return isRecord(plan.dependencyResolution) ? (plan.dependencyResolution as DependencyResolutionState) : {}
}

const getImportedTargetProviderConnectionId = (sourceProviderConnectionId: string) => {
  return `new:provider:${sourceProviderConnectionId}`
}

const getImportedTargetModelId = (sourceModelId: string) => {
  return `new:model:${sourceModelId}`
}

const isImportedTargetProviderConnectionId = (targetProviderConnectionId: string) => {
  return targetProviderConnectionId.startsWith(getImportedTargetProviderConnectionId(''))
}

const isImportedTargetModelId = (targetModelId: string) => {
  return targetModelId.startsWith(getImportedTargetModelId(''))
}

const getImportedProviderConnection = (record: ProjectTransferPayloadRecord): ImportedProviderConnectionCommitRow => {
  return {
    authMode: getNullableString(getRecordField(record, 'authMode')),
    baseURL: getNullableString(getRecordField(record, 'baseURL')),
    configJson: getRecordField(record, 'configJson'),
    enabled: getBoolean(getRecordField(record, 'enabled'), true),
    label: getRequiredString(getRecordField(record, 'label'), 'providerConnections.label'),
    maxInflightRequests: getNullableNumber(getRecordField(record, 'maxInflightRequests')),
    providerKind: getRequiredString(getRecordField(record, 'providerKind'), 'providerConnections.providerKind'),
    secretRef: getNullableString(getRecordField(record, 'secretRef')),
    sourceProviderConnectionId: getRequiredString(
      getRecordField(record, 'sourceProviderConnectionId'),
      'providerConnections.sourceProviderConnectionId',
    ),
  }
}

const getImportedModel = (record: ProjectTransferPayloadRecord): ImportedModelCommitRow => {
  return {
    displayName: getNullableString(getRecordField(record, 'displayName')),
    enabled: getBoolean(getRecordField(record, 'enabled'), true),
    metadataJson: getRecordField(record, 'metadataJson'),
    modelName: getNullableString(getRecordField(record, 'modelName')),
    name: getRequiredString(getRecordField(record, 'name'), 'models.name'),
    remoteModelId: getNullableString(getRecordField(record, 'remoteModelId')),
    source: getNullableString(getRecordField(record, 'source')),
    sourceModelId: getRequiredString(getRecordField(record, 'sourceModelId'), 'models.sourceModelId'),
    sourceProviderConnectionId: getRequiredString(
      getRecordField(record, 'sourceProviderConnectionId'),
      'models.sourceProviderConnectionId',
    ),
    variant: getNullableString(getRecordField(record, 'variant')),
    version: getNullableString(getRecordField(record, 'version')),
  }
}

const getImportedProviderConnectionBySourceId = (providers: readonly ProjectTransferPayloadRecord[]) => {
  return providers.reduce<Record<string, ImportedProviderConnectionCommitRow>>((mapped, provider) => {
    const importedProvider = getImportedProviderConnection(provider)

    mapped[importedProvider.sourceProviderConnectionId] = importedProvider

    return mapped
  }, {})
}

const getImportedModelBySourceId = (models: readonly ProjectTransferPayloadRecord[]) => {
  return models.reduce<Record<string, ImportedModelCommitRow>>((mapped, model) => {
    const importedModel = getImportedModel(model)

    mapped[importedModel.sourceModelId] = importedModel

    return mapped
  }, {})
}

const getResolvedProviderTargetBySourceId = async ({
  commitIdMaps,
  importedProviderBySourceId,
  providerTargetBySourceId,
  tx,
}: {
  commitIdMaps: ProjectTransferCommitIdMaps
  importedProviderBySourceId: Record<string, ImportedProviderConnectionCommitRow>
  providerTargetBySourceId: Record<string, string>
  tx: ProjectTransferCommitWriterTx
}) => {
  return Object.entries(providerTargetBySourceId).reduce<Promise<Record<string, string>>>(async (previous, entry) => {
    const mapped = await previous
    const [sourceProviderConnectionId, targetProviderConnectionId] = entry

    if (!isImportedTargetProviderConnectionId(targetProviderConnectionId)) {
      mapped[sourceProviderConnectionId] = targetProviderConnectionId

      return mapped
    }

    const importedProvider =
      importedProviderBySourceId[sourceProviderConnectionId]
      ?? failCommitWriter(`missing imported provider for ${sourceProviderConnectionId}`)
    const existingProviderConnectionId = await getReusableImportedProviderConnectionId({importedProvider, tx})

    if (existingProviderConnectionId !== null) {
      mapped[sourceProviderConnectionId] = existingProviderConnectionId

      return mapped
    }

    const providerConnectionId = getMappedTargetId({
      label: 'generated provider connection',
      mapped: commitIdMaps.providerConnectionIdBySourceId,
      sourceId: sourceProviderConnectionId,
    })

    mapped[sourceProviderConnectionId] = providerConnectionId

    return mapped
  }, Promise.resolve({}))
}

const materializeImportedProviderConnectionSnapshots = async ({
  generatedProviderConnectionIds,
  importedProviderBySourceId,
  materializedProviderTargetBySourceId,
  providerTargetBySourceId,
  tx,
}: {
  generatedProviderConnectionIds: readonly string[]
  importedProviderBySourceId: Record<string, ImportedProviderConnectionCommitRow>
  materializedProviderTargetBySourceId: Record<string, string>
  providerTargetBySourceId: Record<string, string>
  tx: ProjectTransferCommitWriterTx
}) => {
  const generatedProviderConnectionIdSet = new Set(generatedProviderConnectionIds)

  await Object.entries(providerTargetBySourceId).reduce<Promise<void>>(async (previous, entry) => {
    await previous
    const [sourceProviderConnectionId, targetProviderConnectionId] = entry

    if (!isImportedTargetProviderConnectionId(targetProviderConnectionId)) {
      return undefined
    }

    const importedProvider =
      importedProviderBySourceId[sourceProviderConnectionId]
      ?? failCommitWriter(`missing imported provider for ${sourceProviderConnectionId}`)
    const providerConnectionId = getMappedTargetId({
      label: 'provider connection',
      mapped: materializedProviderTargetBySourceId,
      sourceId: sourceProviderConnectionId,
    })

    if (!generatedProviderConnectionIdSet.has(providerConnectionId)) {
      await disableImportedProviderConnectionSnapshot({providerConnectionId, tx})

      return undefined
    }

    await tx.run(`
      INSERT INTO app.provider_connection (
        id,
        provider_kind,
        label,
        enabled,
        auth_mode,
        base_url,
        max_inflight_requests,
        config_json,
        secret_ref
      ) VALUES (
        ${getSqlLiteral(providerConnectionId)},
        ${getSqlLiteral(importedProvider.providerKind)},
        ${getSqlLiteral(importedProvider.label)},
        FALSE,
        ${getSqlLiteral(importedProvider.authMode)},
        ${getSqlLiteral(importedProvider.baseURL)},
        ${getSqlLiteral(importedProvider.maxInflightRequests)},
        ${getJsonLiteral(
          getImportedSnapshotJson(importedProvider.configJson, {
            snapshotFingerprint: getImportedProviderSnapshotFingerprint(importedProvider),
            sourceProviderConnectionId: importedProvider.sourceProviderConnectionId,
          }),
        )},
        NULL
      )
    `)

    return undefined
  }, Promise.resolve())
}

const getResolvedModelTargetBySourceId = async ({
  commitIdMaps,
  importedProviderBySourceId,
  importedModelBySourceId,
  modelTargetBySourceId,
  providerTargetBySourceId,
  tx,
}: {
  commitIdMaps: ProjectTransferCommitIdMaps
  importedProviderBySourceId: Record<string, ImportedProviderConnectionCommitRow>
  importedModelBySourceId: Record<string, ImportedModelCommitRow>
  modelTargetBySourceId: Record<string, string>
  providerTargetBySourceId: Record<string, string>
  tx: ProjectTransferCommitWriterTx
}) => {
  return Object.entries(modelTargetBySourceId).reduce<Promise<Record<string, string>>>(async (previous, entry) => {
    const mapped = await previous
    const [sourceModelId, targetModelId] = entry

    if (!isImportedTargetModelId(targetModelId)) {
      mapped[sourceModelId] = targetModelId

      return mapped
    }

    const importedModel =
      importedModelBySourceId[sourceModelId] ?? failCommitWriter(`missing imported model for ${sourceModelId}`)
    const importedProvider =
      importedProviderBySourceId[importedModel.sourceProviderConnectionId]
      ?? failCommitWriter(`missing imported provider for ${importedModel.sourceProviderConnectionId}`)
    const providerConnectionId = getMappedTargetId({
      label: 'provider connection',
      mapped: providerTargetBySourceId,
      sourceId: importedModel.sourceProviderConnectionId,
    })
    const existingModelId = await getReusableImportedModelId({
      importedModel,
      importedProvider,
      providerConnectionId,
      tx,
    })

    if (existingModelId !== null) {
      mapped[sourceModelId] = existingModelId

      return mapped
    }

    const materializedModelId = getMappedTargetId({
      label: 'generated model',
      mapped: commitIdMaps.modelIdBySourceId,
      sourceId: sourceModelId,
    })

    mapped[sourceModelId] = materializedModelId

    return mapped
  }, Promise.resolve({}))
}

const materializeImportedModelSnapshots = async ({
  generatedModelIds,
  importedProviderBySourceId,
  importedModelBySourceId,
  materializedModelTargetBySourceId,
  materializedProviderTargetBySourceId,
  modelTargetBySourceId,
  tx,
}: {
  generatedModelIds: readonly string[]
  importedProviderBySourceId: Record<string, ImportedProviderConnectionCommitRow>
  importedModelBySourceId: Record<string, ImportedModelCommitRow>
  materializedModelTargetBySourceId: Record<string, string>
  materializedProviderTargetBySourceId: Record<string, string>
  modelTargetBySourceId: Record<string, string>
  tx: ProjectTransferCommitWriterTx
}) => {
  const generatedModelIdSet = new Set(generatedModelIds)

  await Object.entries(modelTargetBySourceId).reduce<Promise<void>>(async (previous, entry) => {
    await previous
    const [sourceModelId, targetModelId] = entry

    if (!isImportedTargetModelId(targetModelId)) {
      return undefined
    }

    const importedModel =
      importedModelBySourceId[sourceModelId] ?? failCommitWriter(`missing imported model for ${sourceModelId}`)
    const importedProvider =
      importedProviderBySourceId[importedModel.sourceProviderConnectionId]
      ?? failCommitWriter(`missing imported provider for ${importedModel.sourceProviderConnectionId}`)
    const providerConnectionId = getMappedTargetId({
      label: 'provider connection',
      mapped: materializedProviderTargetBySourceId,
      sourceId: importedModel.sourceProviderConnectionId,
    })
    const materializedModelId = getMappedTargetId({
      label: 'model',
      mapped: materializedModelTargetBySourceId,
      sourceId: sourceModelId,
    })

    if (!generatedModelIdSet.has(materializedModelId)) {
      await disableImportedModelSnapshot({modelId: materializedModelId, tx})

      return undefined
    }

    await tx.run(`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES (
        ${getSqlLiteral(materializedModelId)},
        ${getSqlLiteral(providerConnectionId)},
        ${getSqlLiteral(importedModel.name)},
        ${getSqlLiteral(importedModel.remoteModelId ?? importedModel.modelName)},
        ${getSqlLiteral(importedModel.displayName)},
        ${getSqlLiteral(importedModel.variant)},
        ${getSqlLiteral(importedModel.source ?? 'manual')},
        FALSE,
        ${getJsonLiteral(
          getImportedSnapshotJson(importedModel.metadataJson, {
            snapshotFingerprint: getImportedModelSnapshotFingerprint({importedModel, importedProvider}),
            sourceModelId: importedModel.sourceModelId,
            sourceProviderConnectionId: importedModel.sourceProviderConnectionId,
          }),
        )}
      )
    `)

    return undefined
  }, Promise.resolve())
}

const getPlanWithMaterializedImportedDependencies = async ({
  commitIdMaps,
  payloads,
  plan,
  tx,
}: {
  commitIdMaps: ProjectTransferCommitIdMaps
  payloads: Partial<ProjectTransferPayloadByKey>
  plan: ProjectTransferImportPlanArtifact & {commitIdMaps: ProjectTransferCommitIdMaps}
  tx: ProjectTransferCommitWriterTx
}) => {
  const dependencyResolution = getDependencyResolutionState(plan)
  const providerTargetBySourceId = dependencyResolution.providerTargetBySourceId ?? {}
  const modelTargetBySourceId = dependencyResolution.modelTargetBySourceId ?? {}
  const importedProviderBySourceId = getImportedProviderConnectionBySourceId(payloads.providerConnections ?? [])
  const importedModelBySourceId = getImportedModelBySourceId(payloads.models ?? [])
  const materializedProviderTargetBySourceId = await getResolvedProviderTargetBySourceId({
    commitIdMaps,
    importedProviderBySourceId,
    providerTargetBySourceId,
    tx,
  })
  const materializedModelTargetBySourceId = await getResolvedModelTargetBySourceId({
    commitIdMaps,
    importedProviderBySourceId,
    importedModelBySourceId,
    modelTargetBySourceId,
    providerTargetBySourceId: materializedProviderTargetBySourceId,
    tx,
  })
  const generatedProviderConnectionIds = Object.entries(providerTargetBySourceId)
    .filter(([sourceId, targetId]) => {
      return (
        isImportedTargetProviderConnectionId(targetId)
        && materializedProviderTargetBySourceId[sourceId] === commitIdMaps.providerConnectionIdBySourceId[sourceId]
      )
    })
    .map(([sourceId]) => {
      return materializedProviderTargetBySourceId[sourceId] as string
    })
  const generatedModelIds = Object.entries(modelTargetBySourceId)
    .filter(([sourceId, targetId]) => {
      return (
        isImportedTargetModelId(targetId)
        && materializedModelTargetBySourceId[sourceId] === commitIdMaps.modelIdBySourceId[sourceId]
      )
    })
    .map(([sourceId]) => {
      return materializedModelTargetBySourceId[sourceId] as string
    })
  const materializedCommitIdMaps = getProjectTransferCommitMapsWithDependencyTargets({
    generatedModelIds,
    generatedProviderConnectionIds,
    maps: commitIdMaps,
    modelIdBySourceId: materializedModelTargetBySourceId,
    providerConnectionIdBySourceId: materializedProviderTargetBySourceId,
  })

  return {
    importedModelBySourceId,
    importedProviderBySourceId,
    generatedModelIds,
    generatedProviderConnectionIds,
    plan: {
      ...plan,
      commitIdMaps: materializedCommitIdMaps,
      dependencyResolution: {
        ...(isRecord(plan.dependencyResolution) ? plan.dependencyResolution : {}),
        modelTargetBySourceId: materializedModelTargetBySourceId,
        providerTargetBySourceId: materializedProviderTargetBySourceId,
      },
    },
    sourceDependencyResolution: {modelTargetBySourceId, providerTargetBySourceId},
  }
}

const getPayloadArrayBySourceId = <TRecord extends ProjectTransferPayloadRecord>(
  records: readonly TRecord[],
  sourceField: string,
) => {
  return records.reduce<Record<string, TRecord>>((mapped, record) => {
    const sourceId = getNullableString(getRecordField(record, sourceField))

    if (sourceId !== null) {
      mapped[sourceId] = record
    }

    return mapped
  }, {})
}

const getArticleBySourceId = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  return articles.reduce<Record<string, ProjectTransferArticlePayloadRecord>>((mapped, article) => {
    mapped[article.sourceArticleId] = article

    return mapped
  }, {})
}

const getProjectSourceModelId = ({
  models,
  project,
}: {
  models: readonly ProjectTransferPayloadRecord[]
  project: ProjectTransferProjectPayload
}) => {
  const projectModelSignature = getProjectTransferCanonicalJson(project.modelSignature ?? null)
  const matchingModel = models.find((model) => {
    return getProjectTransferCanonicalJson(model.signature ?? null) === projectModelSignature
  })
  const fallbackModel = models.length === 1 ? models[0] : null
  const sourceModelId = getNullableString(getRecordField(matchingModel ?? fallbackModel ?? {}, 'sourceModelId'))

  return sourceModelId ?? failCommitWriter('source project model could not be resolved from package model signature')
}

const getTargetModelId = ({
  plan,
  project,
  models,
}: {
  models: readonly ProjectTransferPayloadRecord[]
  plan: ProjectTransferImportPlanArtifact
  project: ProjectTransferProjectPayload
}) => {
  const sourceModelId = getProjectSourceModelId({models, project})
  const targetModelId = getDependencyResolutionState(plan).modelTargetBySourceId?.[sourceModelId]

  return targetModelId ?? failCommitWriter(`target model is missing for source model ${sourceModelId}`)
}

const getProjectSettings = (project: ProjectTransferProjectPayload) => {
  const settings: Record<string, unknown> = isRecord(project.settings) ? project.settings : {}
  const humanJudgmentMode = settings.humanJudgmentMode === 'summary' ? 'summary' : 'prompt'

  return {
    humanJudgmentMode,
    useAbstract: getBoolean(settings.useAbstract, true),
    useFulltext: getBoolean(settings.useFulltext, false),
    useFulltextNoImages: getBoolean(settings.useFulltextNoImages, false),
    useTitle: getBoolean(settings.useTitle, true),
  }
}

const insertImportedProject = async ({
  now,
  plan,
  project,
  projectId,
  tx,
  models,
}: {
  models: readonly ProjectTransferPayloadRecord[]
  now: Date
  plan: ProjectTransferImportPlanArtifact
  project: ProjectTransferProjectPayload
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const settings = getProjectSettings(project)
  const [created] = await tx.queryJson<{id: string; name: string}>(`
    INSERT INTO app.project (
      id,
      name,
      description,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      date_from,
      date_to,
      archived,
      created_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(projectId)},
      ${getSqlLiteral(getRequiredString(project.name, 'project.name'))},
      ${getSqlLiteral(getNullableString(project.description))},
      ${getSqlLiteral(getTargetModelId({models, plan, project}))},
      ${getSqlLiteral(settings.humanJudgmentMode)},
      ${getSqlLiteral(settings.useTitle)},
      ${getSqlLiteral(settings.useAbstract)},
      ${getSqlLiteral(settings.useFulltext)},
      ${getSqlLiteral(settings.useFulltextNoImages)},
      ${getNullableDateLiteral(project.dateFrom)},
      ${getNullableDateLiteral(project.dateTo)},
      FALSE,
      ${getTimestampLiteral(now)},
      ${getTimestampLiteral(now)}
    )
    RETURNING id, name
  `)

  return created ?? failCommitWriter('project insert failed')
}

const getActiveSourcePromptIds = (projectPromptPlan: readonly ProjectPromptPlanEntry[]) => {
  return new Set(
    projectPromptPlan
      .filter((entry) => {
        return entry.enabled && entry.metadata.archived !== true
      })
      .map((entry) => {
        return entry.sourcePromptId
      }),
  )
}

const getPromptMaterializationPlanBySourceId = async ({
  activeSourcePromptIds,
  commitIdMaps,
  prompts,
  tx,
}: {
  activeSourcePromptIds: Set<string>
  commitIdMaps: ProjectTransferCommitIdMaps
  prompts: readonly ProjectTransferPayloadRecord[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const contentHashBySourceId = getProjectTransferPromptContentHashBySourceId(prompts)
  const sourceIdByContentHash = Object.entries(contentHashBySourceId).reduce<Record<string, string>>(
    (mapped, [sourcePromptId, contentHash]) => {
      if (mapped[contentHash] === undefined) {
        mapped[contentHash] = sourcePromptId
      }

      return mapped
    },
    {},
  )
  const contentHashes = [...new Set(Object.values(contentHashBySourceId))]
  const existingPromptRows =
    contentHashes.length === 0
      ? []
      : await queryChunks<string, {archived: boolean; contentHash: string; id: string}>(contentHashes, (chunk) => {
          return tx.queryJson<{archived: boolean; contentHash: string; id: string}>(`
            SELECT id, archived, content_hash AS contentHash
            FROM app.prompt
            WHERE content_hash IN (${getQuotedStringList([...chunk]).join(', ')})
            ORDER BY content_hash ASC, id ASC
          `)
        })
  const existingPromptByContentHash = existingPromptRows.reduce<Record<string, {archived: boolean; id: string}>>(
    (mapped, row) => {
      if (mapped[row.contentHash] === undefined) {
        mapped[row.contentHash] = row
      }

      return mapped
    },
    {},
  )
  const generatedPromptIdByContentHash = contentHashes.reduce<Record<string, string>>((mapped, contentHash) => {
    const existingPrompt = existingPromptByContentHash[contentHash]
    const sourcePromptId =
      sourceIdByContentHash[contentHash] ?? failCommitWriter(`missing source prompt for content hash ${contentHash}`)
    const generatedPromptId =
      commitIdMaps.promptIdBySourceId[sourcePromptId]
      ?? failCommitWriter(`missing generated prompt target id for ${sourcePromptId}`)

    if (existingPrompt === undefined) {
      mapped[contentHash] = generatedPromptId
    }

    return mapped
  }, {})
  const promptBySourceId = getPayloadArrayBySourceId(prompts, 'sourcePromptId')
  const createPromptRows = Object.entries(generatedPromptIdByContentHash).map(([contentHash, promptId]) => {
    const sourcePromptId =
      sourceIdByContentHash[contentHash] ?? failCommitWriter(`missing source prompt for content hash ${contentHash}`)
    const prompt = promptBySourceId[sourcePromptId] ?? failCommitWriter(`missing prompt payload ${sourcePromptId}`)

    return {contentHash, prompt, promptId, sourcePromptId}
  })
  const unarchivePromptIds = existingPromptRows
    .filter((row) => {
      const activeSourceIds = Object.entries(contentHashBySourceId)
        .filter(([_sourcePromptId, contentHash]) => {
          return contentHash === row.contentHash
        })
        .map(([sourcePromptId]) => {
          return sourcePromptId
        })

      return (
        row.archived
        && activeSourceIds.some((sourcePromptId) => {
          return activeSourcePromptIds.has(sourcePromptId)
        })
      )
    })
    .map((row) => {
      return row.id
    })

  const promptIdBySourceId = Object.entries(contentHashBySourceId).reduce<Record<string, string>>(
    (mapped, [sourcePromptId, contentHash]) => {
      const promptId = existingPromptByContentHash[contentHash]?.id ?? generatedPromptIdByContentHash[contentHash]

      if (promptId !== undefined) {
        mapped[sourcePromptId] = promptId
      }

      return mapped
    },
    {},
  )

  return {
    commitIdMaps: getProjectTransferCommitMapsWithPromptTargets({
      contentHashTargetIdBySourceId: promptIdBySourceId,
      generatedPromptIds: Object.values(generatedPromptIdByContentHash),
      maps: commitIdMaps,
    }),
    createPromptRows,
    promptIdBySourceId,
    unarchivePromptIds: [...new Set(unarchivePromptIds)],
  }
}

const materializePromptRows = async ({
  activeSourcePromptIds,
  createPromptRows,
  tx,
  unarchivePromptIds,
}: {
  activeSourcePromptIds: Set<string>
  createPromptRows: Awaited<ReturnType<typeof getPromptMaterializationPlanBySourceId>>['createPromptRows']
  tx: ProjectTransferCommitWriterTx
  unarchivePromptIds: readonly string[]
}) => {
  await runChunks(createPromptRows, (rowChunk) => {
    return tx.run(`
      INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
      VALUES ${rowChunk
        .map((row) => {
          const active = activeSourcePromptIds.has(row.sourcePromptId)

          return `(
            ${getSqlLiteral(row.promptId)},
            ${getSqlLiteral(getRequiredString(getRecordField(row.prompt, 'originalText'), `prompts.${row.sourcePromptId}.originalText`))},
            ${getSqlLiteral(getNullableString(getRecordField(row.prompt, 'transformedText')))},
            ${getSqlLiteral(getNullableString(getRecordField(row.prompt, 'promptHeading')))},
            ${getSqlLiteral(getNullableString(getRecordField(row.prompt, 'type')))},
            ${getSqlLiteral(row.contentHash)},
            ${getSqlLiteral(!active && getBoolean(getRecordField(row.prompt, 'archived'), false))}
          )`
        })
        .join(', ')}
      ON CONFLICT(content_hash) DO NOTHING
    `)
  })
  await runChunks([...unarchivePromptIds], (rowChunk) => {
    return tx.run(`
      UPDATE app.prompt
      SET archived = FALSE,
          updated_at = current_timestamp
      WHERE id IN (${getQuotedStringList([...rowChunk]).join(', ')})
        AND archived = TRUE
    `)
  })
}
const getPlannedPromptHashBySourceId = (prompts: readonly ProjectTransferPayloadRecord[]) => {
  return prompts.reduce<Record<string, string>>((mapped, prompt) => {
    const sourcePromptId = getRequiredString(getRecordField(prompt, 'sourcePromptId'), 'prompt.sourcePromptId')
    const contentHash = computePromptContentHash(
      getRequiredString(getRecordField(prompt, 'originalText'), `prompts.${sourcePromptId}.originalText`),
      getNullableString(getRecordField(prompt, 'transformedText')),
      getNullableString(getRecordField(prompt, 'promptHeading')),
      getNullableString(getRecordField(prompt, 'type')),
    )

    mapped[sourcePromptId] = contentHash

    return mapped
  }, {})
}

const assertPromptPlanHashes = ({
  promptPlan,
  prompts,
}: {
  promptPlan: readonly PromptPlanEntry[]
  prompts: readonly ProjectTransferPayloadRecord[]
}) => {
  const promptHashBySourceId = getPlannedPromptHashBySourceId(prompts)
  const mismatch = promptPlan.find((entry) => {
    return promptHashBySourceId[entry.sourcePromptId] !== entry.computedContentHash
  })

  return mismatch
    ? failCommitWriter(
        `prompt ${mismatch.sourcePromptId} content hash changed after revalidation (${promptHashBySourceId[mismatch.sourcePromptId] ?? 'missing'} !== ${mismatch.computedContentHash})`,
      )
    : undefined
}

const getDuplicateValue = (values: readonly string[]) => {
  const seen = new Set<string>()
  const duplicate = values.find((value) => {
    const alreadySeen = seen.has(value)

    if (!alreadySeen) {
      seen.add(value)
    }

    return alreadySeen
  })

  return duplicate ?? null
}

const assertNoProjectPromptDuplicates = (projectPromptRows: readonly {promptId: string}[]) => {
  const duplicatePromptId = getDuplicateValue(
    projectPromptRows.map((row) => {
      return row.promptId
    }),
  )

  return duplicatePromptId
    ? failCommitWriter(`duplicate project_prompt link after remap for prompt ${duplicatePromptId}`)
    : undefined
}

const getCriteriaDisposition = (value: unknown) => {
  return value === 'include' || value === 'exclude' || value === 'combined' ? value : null
}

const getProjectPromptRows = ({
  projectId,
  projectPromptPlan,
  projectPrompts,
  promptIdBySourceId,
}: {
  projectId: string
  projectPromptPlan: readonly ProjectPromptPlanEntry[]
  projectPrompts: readonly ProjectTransferPayloadRecord[]
  promptIdBySourceId: Record<string, string>
}) => {
  const projectPromptBySourceId = getPayloadArrayBySourceId(projectPrompts, 'sourceProjectPromptId')

  return projectPromptPlan.map((entry) => {
    const projectPrompt = projectPromptBySourceId[entry.sourceProjectPromptId]
    const promptId = promptIdBySourceId[entry.sourcePromptId]

    if (projectPrompt === undefined) {
      return failCommitWriter(`missing project prompt payload ${entry.sourceProjectPromptId}`)
    }

    if (promptId === undefined) {
      return failCommitWriter(`missing target prompt for ${entry.sourcePromptId}`)
    }

    return {
      archived: getBoolean(getRecordField(projectPrompt, 'archived'), entry.metadata.archived === true),
      criteriaDisposition: getCriteriaDisposition(getRecordField(projectPrompt, 'criteriaDisposition')),
      criteriaSectionKey: getNullableString(getRecordField(projectPrompt, 'criteriaSectionKey')),
      criteriaSectionLabel: getNullableString(getRecordField(projectPrompt, 'criteriaSectionLabel')),
      enabled: getBoolean(getRecordField(projectPrompt, 'enabled'), entry.enabled),
      order: getNullableNumber(getRecordField(projectPrompt, 'order')),
      projectId,
      promptId,
      sourceProjectPromptId: entry.sourceProjectPromptId,
    }
  })
}

const insertProjectPromptRows = async (
  tx: ProjectTransferCommitWriterTx,
  rows: readonly ReturnType<typeof getProjectPromptRows>[number][],
  commitIdMaps: ProjectTransferCommitIdMaps,
) => {
  assertNoProjectPromptDuplicates(rows)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.project_prompt (
          id,
          project_id,
          prompt_id,
          prompt_order,
          archived,
          enabled,
          origin_project_id,
          criteria_disposition,
          criteria_section_key,
          criteria_section_label
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(
                getMappedTargetId({
                  label: 'project prompt',
                  mapped: commitIdMaps.projectPromptIdBySourceId,
                  sourceId: row.sourceProjectPromptId,
                }),
              )},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.promptId)},
              ${getSqlLiteral(row.order)},
              ${getSqlLiteral(row.archived)},
              ${getSqlLiteral(row.enabled)},
              NULL,
              ${getSqlLiteral(row.criteriaDisposition)},
              ${getSqlLiteral(row.criteriaSectionKey)},
              ${getSqlLiteral(row.criteriaSectionLabel)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getResolvedArticleIdBySourceId = ({
  articleMatches,
  commitIdMaps,
  promotion,
}: {
  articleMatches: readonly ArticleMatchPlan[]
  commitIdMaps: ProjectTransferCommitIdMaps
  promotion: ProjectTransferCommitPromotionResult
}) => {
  const createdArticleSources = new Set(
    promotion.articleCreates.map((entry) => {
      return entry.sourceArticleId
    }),
  )

  return articleMatches.reduce<Record<string, string>>((mapped, match) => {
    if (match.action === 'create' && createdArticleSources.has(match.sourceArticleId)) {
      mapped[match.sourceArticleId] = getMappedTargetId({
        label: 'article',
        mapped: commitIdMaps.articleIdBySourceId,
        sourceId: match.sourceArticleId,
      })

      return mapped
    }

    if (match.action === 'reuse' && match.selectedTargetArticleId !== null) {
      mapped[match.sourceArticleId] = match.selectedTargetArticleId

      return mapped
    }

    return failCommitWriter(`article ${match.sourceArticleId} is not commit-safe`)
  }, {})
}

const assertNoArticleIdConflicts = async ({
  articles,
  matches,
  tx,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  matches: readonly ArticleMatchPlan[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const articleBySourceId = getArticleBySourceId(articles)
  const newLegacyIds = matches
    .filter((match) => {
      return match.action === 'create'
    })
    .map((match) => {
      return getNullableString(articleBySourceId[match.sourceArticleId]?.articleId)
    })
    .filter((articleId): articleId is string => {
      return articleId !== null
    })
  const duplicateLegacyId = getDuplicateValue(newLegacyIds)

  if (duplicateLegacyId) {
    return failCommitWriter(`duplicate package article_id after remap: ${duplicateLegacyId}`)
  }

  const existingRows =
    newLegacyIds.length === 0
      ? []
      : await queryChunks<string, {articleId: string; id: string}>(newLegacyIds, (legacyIdChunk) => {
          return tx.queryJson<{articleId: string; id: string}>(`
          SELECT id, article_id AS articleId
          FROM app.article
          WHERE article_id IN (${getQuotedStringList([...legacyIdChunk]).join(', ')})
          ORDER BY article_id ASC, id ASC
        `)
        })
  const conflict = existingRows[0]

  return conflict ? failCommitWriter(`target article_id already exists: ${conflict.articleId}`) : undefined
}

const insertCreatedArticlesSetBased = async ({
  context,
  now,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await getTableCount({
    sql: `SELECT source_article_id FROM ${context.tempTables.articleCreates}`,
    tx,
  })

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.article (
      id,
      ${Object.values(articleColumnByPayloadField).join(',\n')},
      created_at,
      updated_at
    )
    SELECT
      article_map.target_id,
      ${Object.keys(articleColumnByPayloadField)
        .map((field) => {
          return getArticleJsonFieldSql('create_row.article_json', field as ArticleField)
        })
        .join(',\n')},
      ${getTimestampLiteral(now)},
      ${getTimestampLiteral(now)}
    FROM ${context.tempTables.articleCreates} create_row
    INNER JOIN ${context.operationTables.tableNames.articles} staged_article
      ON ${getJsonStringFieldSql('staged_article.payload_json', 'sourceArticleId')} = create_row.source_article_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = create_row.source_article_id
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`created article insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const insertCreatedArticles = async ({
  articleIdBySourceId,
  context,
  now,
  promotion,
  tx,
}: {
  articleIdBySourceId: Record<string, string>
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  promotion: ProjectTransferCommitPromotionResult
  tx: ProjectTransferCommitWriterTx
}) => {
  return context !== null
    ? insertCreatedArticlesSetBased({context, now, tx})
    : promotion.articleCreates.length === 0
      ? undefined
      : runChunks(promotion.articleCreates, (articleChunk) => {
          return tx.run(`
          INSERT INTO app.article (
            id,
            ${Object.values(articleColumnByPayloadField).join(',\n')},
            created_at,
            updated_at
          ) VALUES ${articleChunk
            .map((entry) => {
              const articleId = articleIdBySourceId[entry.sourceArticleId]

              return articleId === undefined
                ? failCommitWriter(`missing target article id for ${entry.sourceArticleId}`)
                : getCreatedArticleValuesSql({article: entry.article, articleId, now})
            })
            .join(', ')}
        `)
        })
}

const getFillTargetArticleRows = async ({
  promotion,
  tx,
}: {
  promotion: ProjectTransferCommitPromotionResult
  tx: ProjectTransferCommitWriterTx
}) => {
  const targetArticleIds = [
    ...new Set(
      promotion.articleFieldFills.map((fill) => {
        return fill.targetArticleId
      }),
    ),
  ]
  const rows =
    targetArticleIds.length === 0
      ? []
      : await queryChunks<string, TargetArticleFieldRow>(targetArticleIds, (articleIdChunk) => {
          return tx.queryJson<TargetArticleFieldRow>(`
          SELECT
            id,
            ${articleFieldSelectSql}
          FROM app.article
          WHERE id IN (${getQuotedStringList([...articleIdChunk]).join(', ')})
          ORDER BY id ASC
        `)
        })

  return rows.reduce<Record<string, TargetArticleFieldRow>>((mapped, row) => {
    mapped[row.id] = row

    return mapped
  }, {})
}

const isMissingTargetArticleValue = (field: ArticleField, value: unknown) => {
  const parsed = articleJsonFields.has(field) || articleArrayFields.has(field) ? getJsonValue(value) : value

  return articleJsonFields.has(field)
    ? parsed === null || parsed === undefined
    : articleArrayFields.has(field)
      ? parsed === null || parsed === undefined || (Array.isArray(parsed) && parsed.length === 0)
      : articleStringFields.has(field)
        ? parsed === null || parsed === undefined || (typeof parsed === 'string' && parsed.trim() === '')
        : parsed === null || parsed === undefined
}

const assertArticleFieldFillsStillMissing = ({
  promotion,
  targetArticleById,
}: {
  promotion: ProjectTransferCommitPromotionResult
  targetArticleById: Record<string, TargetArticleFieldRow>
}) => {
  return promotion.articleFieldFills.map((fill) => {
    const field = fill.field as ArticleField
    const targetArticle = targetArticleById[fill.targetArticleId]

    if (targetArticle === undefined) {
      return failCommitWriter(`target article ${fill.targetArticleId} is missing`)
    }

    return isMissingTargetArticleValue(field, targetArticle[field])
      ? undefined
      : failCommitWriter(`target article ${fill.targetArticleId} field ${field} is no longer missing`)
  })
}

const assertArticleFieldFillStageRowsCommitSafe = async ({
  context,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  tx: ProjectTransferCommitWriterTx
}) => {
  const [unsupported] = await tx.queryJson<{field: string}>(`
    SELECT field
    FROM ${context.tempTables.articleFieldFills}
    WHERE field NOT IN (${getQuotedStringList(Object.keys(articleColumnByPayloadField)).join(', ')})
    ORDER BY field ASC
    LIMIT 1
  `)
  const [duplicate] = await tx.queryJson<{field: string; targetArticleId: string}>(`
    SELECT target_article_id AS targetArticleId, field
    FROM ${context.tempTables.articleFieldFills}
    GROUP BY target_article_id, field
    HAVING COUNT(*) > 1
    ORDER BY target_article_id ASC, field ASC
    LIMIT 1
  `)

  if (unsupported) {
    return failCommitWriter(`unsupported article field fill ${unsupported.field}`)
  }

  return duplicate
    ? failCommitWriter(`duplicate article field fill after remap: ${duplicate.targetArticleId}:${duplicate.field}`)
    : undefined
}

const getArticleFieldFillCounts = async ({
  context,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  tx: ProjectTransferCommitWriterTx
}) => {
  const rows = await tx.queryJson<{count: number; field: string}>(`
    SELECT field, COUNT(*)::INTEGER AS count
    FROM ${context.tempTables.articleFieldFills}
    GROUP BY field
    ORDER BY field ASC
  `)

  return rows.reduce<Record<string, number>>((mapped, row) => {
    mapped[row.field] = row.count

    return mapped
  }, {})
}

const getInvalidArticleFieldFillRow = async ({
  context,
  field,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  field: ArticleField
  tx: ProjectTransferCommitWriterTx
}) => {
  const [row] = await tx.queryJson<{field: string; targetArticleId: string}>(`
    SELECT fill.target_article_id AS targetArticleId, fill.field
    FROM ${context.tempTables.articleFieldFills} fill
    LEFT JOIN app.article article ON article.id = fill.target_article_id
    WHERE fill.field = ${getSqlLiteral(field)}
      AND (
        article.id IS NULL
        OR NOT (${getMissingTargetArticleValueSql({alias: 'article', field})})
      )
    ORDER BY fill.target_article_id ASC
    LIMIT 1
  `)

  return row ?? null
}

const updateReusedArticleFieldSetBased = async ({
  context,
  expectedCount,
  field,
  now,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  expectedCount: number
  field: ArticleField
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  if (expectedCount === 0) {
    return undefined
  }

  const column = articleColumnByPayloadField[field]
  const updatedRows = await tx.queryJson<{id: string}>(`
    UPDATE app.article AS article
    SET
      ${column} = ${getArticleFillValueSql(field)},
      updated_at = ${getTimestampLiteral(now)}
    FROM ${context.tempTables.articleFieldFills} fill
    WHERE fill.field = ${getSqlLiteral(field)}
      AND article.id = fill.target_article_id
      AND ${getMissingTargetArticleValueSql({alias: 'article', field})}
    RETURNING article.id
  `)

  if (updatedRows.length === expectedCount) {
    return undefined
  }

  const invalid = await getInvalidArticleFieldFillRow({context, field, tx})

  return invalid === null
    ? failCommitWriter(`article field ${field} update wrote ${updatedRows.length} of ${expectedCount} staged rows`)
    : failCommitWriter(`target article ${invalid.targetArticleId} field ${field} is no longer missing`)
}

const updateReusedArticlesSetBased = async ({
  context,
  now,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  await assertArticleFieldFillStageRowsCommitSafe({context, tx})

  const counts = await getArticleFieldFillCounts({context, tx})

  return (Object.keys(articleColumnByPayloadField) as ArticleField[]).reduce<Promise<void>>(async (previous, field) => {
    await previous

    return updateReusedArticleFieldSetBased({context, expectedCount: counts[field] ?? 0, field, now, tx})
  }, Promise.resolve())
}

const updateReusedArticles = async ({
  context,
  now,
  promotion,
  targetArticleById,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  promotion: ProjectTransferCommitPromotionResult
  targetArticleById: Record<string, TargetArticleFieldRow>
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return updateReusedArticlesSetBased({context, now, tx})
  }

  const fillsByArticleId = promotion.articleFieldFills.reduce<
    Record<string, (typeof promotion.articleFieldFills)[number][]>
  >((mapped, fill) => {
    const fills = mapped[fill.targetArticleId] ?? []
    fills.push(fill)
    mapped[fill.targetArticleId] = fills

    return mapped
  }, {})

  assertArticleFieldFillsStillMissing({promotion, targetArticleById})

  return Object.entries(fillsByArticleId).reduce<Promise<void>>(async (previous, [articleId, fills]) => {
    await previous
    const setSql = fills
      .map((fill) => {
        const field = fill.field as ArticleField
        const column = articleColumnByPayloadField[field]

        return column === undefined
          ? failCommitWriter(`unsupported article field fill ${fill.field}`)
          : `${column} = ${getArticleFieldSqlLiteral(field, fill.value)}`
      })
      .join(',\n')

    return tx.run(`
      UPDATE app.article
      SET
        ${setSql},
        updated_at = ${getTimestampLiteral(now)}
      WHERE id = ${getSqlLiteral(articleId)}
    `)
  }, Promise.resolve())
}

const getArticleActionBySourceId = (articleMatches: readonly ArticleMatchPlan[]) => {
  return articleMatches.reduce<Record<string, ArticleMatchPlan['action']>>((mapped, match) => {
    mapped[match.sourceArticleId] = match.action

    return mapped
  }, {})
}

const getArticleIdentifierCommitRows = ({
  articleIdBySourceId,
  articleMatches,
  articles,
  commitIdMaps,
}: {
  articleIdBySourceId: Record<string, string>
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  commitIdMaps: ProjectTransferCommitIdMaps
}) => {
  const articleActionBySourceId = getArticleActionBySourceId(articleMatches)

  return articles.flatMap((article) => {
    const articleId = articleIdBySourceId[article.sourceArticleId]
    const action = articleActionBySourceId[article.sourceArticleId]
    const normalized = getProjectTransferNormalizedArticleIdentifiers(article)

    return articleId === undefined
      ? []
      : normalized.strongIdentifiers.map((identifier, index) => {
          const sourceKey = getProjectTransferCanonicalJson({
            kind: identifier.kind,
            normalizedValue: identifier.normalizedValue,
            sourceArticleId: article.sourceArticleId,
          })

          return action === undefined
            ? failCommitWriter(`article identifier source ${article.sourceArticleId} has no article match plan`)
            : {
                action,
                articleId,
                id: getMappedTargetId({
                  label: 'article identifier',
                  mapped: commitIdMaps.articleIdentifierIdBySourceKey,
                  sourceId: sourceKey,
                }),
                identifier,
                isPrimary: index === 0,
                sourceArticleId: article.sourceArticleId,
              }
        })
  })
}

const getArticleIdentifierStageRows = ({
  articleMatches,
  articles,
}: {
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
}): ArticleIdentifierStageRow[] => {
  const articleActionBySourceId = getArticleActionBySourceId(articleMatches)

  return articles.flatMap((article) => {
    const action = articleActionBySourceId[article.sourceArticleId]
    const normalized = getProjectTransferNormalizedArticleIdentifiers(article)

    if (action === undefined) {
      return failCommitWriter(`article identifier source ${article.sourceArticleId} has no article match plan`)
    }

    return normalized.strongIdentifiers.map((identifier, index) => {
      return {
        isPrimary: index === 0,
        kind: identifier.kind,
        normalizedValue: identifier.normalizedValue,
        source: identifier.evidence[0]?.source ?? 'project_transfer',
        sourceArticleId: article.sourceArticleId,
        sourceKey: getProjectTransferCanonicalJson({
          kind: identifier.kind,
          normalizedValue: identifier.normalizedValue,
          sourceArticleId: article.sourceArticleId,
        }),
      }
    })
  })
}

const getArticleCreateStageRows = (promotion: ProjectTransferCommitPromotionResult) => {
  return promotion.articleCreates.map((entry) => {
    return {article: entry.article, sourceArticleId: entry.sourceArticleId}
  })
}

const getArticleFieldFillStageRows = (promotion: ProjectTransferCommitPromotionResult) => {
  return promotion.articleFieldFills.map((fill) => {
    return {
      field: fill.field,
      sourceArticleId: fill.sourceArticleId,
      targetArticleId: fill.targetArticleId,
      value: fill.value ?? null,
    }
  })
}

const getCreateArticleCreatesTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly ReturnType<typeof getArticleCreateStageRows>[number][]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'sourceArticleId')} AS source_article_id,
      json_extract(row_json, '$.article') AS article_json
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateArticleFieldFillsTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly ReturnType<typeof getArticleFieldFillStageRows>[number][]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'sourceArticleId')} AS source_article_id,
      ${getJsonStringFieldSql('row_json', 'targetArticleId')} AS target_article_id,
      ${getJsonStringFieldSql('row_json', 'field')} AS field,
      json_extract(row_json, '$.value') AS value_json
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateArticleIdentifiersTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly ArticleIdentifierStageRow[]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'sourceArticleId')} AS source_article_id,
      ${getJsonStringFieldSql('row_json', 'sourceKey')} AS source_key,
      ${getJsonStringFieldSql('row_json', 'kind')} AS kind,
      ${getJsonStringFieldSql('row_json', 'normalizedValue')} AS normalized_value,
      ${getJsonStringFieldSql('row_json', 'source')} AS source,
      COALESCE(TRY_CAST(${getJsonStringFieldSql('row_json', 'isPrimary')} AS BOOLEAN), FALSE) AS is_primary
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateProjectRoutePlanTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly ProjectRoutePlanEntry[]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'action')} AS action,
      ${getJsonStringFieldSql('row_json', 'sourceImportRouteId')} AS source_import_route_id,
      ${getJsonStringFieldSql('row_json', 'sourceProjectImportRouteId')} AS source_project_import_route_id,
      ${getJsonStringFieldSql('row_json', 'targetImportRouteId')} AS target_import_route_id
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateArticleRoutePlanTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly ArticleRoutePlanEntry[]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'action')} AS action,
      COALESCE(TRY_CAST(${getJsonStringFieldSql('row_json', 'snapshotProjectArticleLink')} AS BOOLEAN), FALSE) AS snapshot_project_article_link,
      ${getJsonStringFieldSql('row_json', 'sourceArticleId')} AS source_article_id,
      ${getJsonStringFieldSql('row_json', 'sourceArticleImportRouteId')} AS source_article_import_route_id,
      ${getJsonStringFieldSql('row_json', 'sourceImportRouteId')} AS source_import_route_id,
      ${getJsonStringFieldSql('row_json', 'targetImportRouteId')} AS target_import_route_id
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateJudgmentPlanTableSql = ({rows, tableName}: {rows: readonly JudgmentPlanEntry[]; tableName: string}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'action')} AS action,
      ${getJsonStringFieldSql('row_json', 'sourceJudgmentId')} AS source_judgment_id,
      ${getJsonStringFieldSql('row_json', 'targetArticleId')} AS target_article_id,
      ${getJsonStringFieldSql('row_json', 'targetJudgmentId')} AS target_judgment_id,
      ${getJsonStringFieldSql('row_json', 'targetModelId')} AS target_model_id,
      ${getJsonStringFieldSql('row_json', 'targetPromptId')} AS target_prompt_id
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateJudgmentAssessmentPlanTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly JudgmentAssessmentPlanEntry[]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'action')} AS action,
      ${getJsonStringFieldSql('row_json', 'sourceJudgmentAssessmentId')} AS source_judgment_assessment_id,
      ${getJsonStringFieldSql('row_json', 'sourceJudgmentId')} AS source_judgment_id,
      ${getJsonStringFieldSql('row_json', 'targetAssessmentId')} AS target_assessment_id,
      ${getJsonStringFieldSql('row_json', 'targetJudgmentId')} AS target_judgment_id
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateHumanReviewPlanTableSql = ({
  rows,
  tableName,
}: {
  rows: readonly HumanReviewPlanEntry[]
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      ${getJsonStringFieldSql('row_json', 'action')} AS action,
      ${getJsonStringFieldSql('row_json', 'kind')} AS kind,
      ${getJsonStringFieldSql('row_json', 'sourceId')} AS source_id,
      ${getJsonStringFieldSql('row_json', 'targetArticleId')} AS target_article_id,
      ${getJsonStringFieldSql('row_json', 'targetPromptId')} AS target_prompt_id
    FROM ${getJsonArrayRowsSourceSql(rows)}
  `
}

const getCreateProjectArticleSourcesTableSql = ({
  articleRoutePlanTable,
  operationTables,
  tableName,
}: {
  articleRoutePlanTable: string
  operationTables: ProjectTransferOperationTableSet
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT DISTINCT source_article_id
    FROM (
      SELECT ${getJsonStringFieldSql('payload_json', 'sourceArticleId')} AS source_article_id
      FROM ${operationTables.tableNames.projectArticles}
      UNION ALL
      SELECT source_article_id
      FROM ${articleRoutePlanTable}
      WHERE snapshot_project_article_link = TRUE
    ) source_rows
    WHERE source_article_id IS NOT NULL
      AND trim(source_article_id) <> ''
  `
}

const loadProjectTransferCommitWriterTempTables = async ({
  articles,
  operationTables,
  plan,
  promotion,
  tables,
  tx,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  operationTables: ProjectTransferOperationTableSet
  plan: ProjectTransferImportPlanArtifact
  promotion: ProjectTransferCommitPromotionResult
  tables: ProjectTransferCommitWriterTempTableSet
  tx: ProjectTransferCommitWriterTx
}) => {
  const articleCreates = getArticleCreateStageRows(promotion)
  const articleFieldFills = getArticleFieldFillStageRows(promotion)
  const articleIdentifiers = getArticleIdentifierStageRows({articleMatches: plan.targetPlan.articleMatches, articles})

  await tx.run(
    commitWriterSetBasedTableSuffixes
      .map((suffix) => {
        return `DROP TABLE IF EXISTS ${tables[suffix]}`
      })
      .join(';\n'),
  )
  await tx.run(`
    ${getCreateArticleCreatesTableSql({rows: articleCreates, tableName: tables.articleCreates})};
    ${getCreateArticleFieldFillsTableSql({rows: articleFieldFills, tableName: tables.articleFieldFills})};
    ${getCreateArticleIdentifiersTableSql({rows: articleIdentifiers, tableName: tables.articleIdentifiers})};
    ${getCreateProjectRoutePlanTableSql({rows: plan.targetPlan.projectRoutePlan, tableName: tables.projectRoutePlan})};
    ${getCreateArticleRoutePlanTableSql({rows: plan.targetPlan.articleRoutePlan, tableName: tables.articleRoutePlan})};
    ${getCreateJudgmentPlanTableSql({rows: plan.targetPlan.judgmentPlan ?? [], tableName: tables.judgmentPlan})};
    ${getCreateJudgmentAssessmentPlanTableSql({
      rows: plan.targetPlan.judgmentAssessmentPlan ?? [],
      tableName: tables.judgmentAssessmentPlan,
    })};
    ${getCreateHumanReviewPlanTableSql({rows: plan.targetPlan.humanReviewPlan ?? [], tableName: tables.humanReviewPlan})};
    ${getCreateProjectArticleSourcesTableSql({
      articleRoutePlanTable: tables.articleRoutePlan,
      operationTables,
      tableName: tables.projectArticleSources,
    })}
  `)

  return tables
}

const dropProjectTransferCommitWriterTempTables = async ({
  tables,
  tx,
}: {
  tables: ProjectTransferCommitWriterTempTableSet
  tx: ProjectTransferCommitWriterTx
}) => {
  await tx.run(
    commitWriterSetBasedTableSuffixes
      .map((suffix) => {
        return `DROP TABLE IF EXISTS ${tables[suffix]}`
      })
      .join(';\n'),
  )
}

const getArticleIdentifierKey = (row: Pick<ArticleIdentifierCommitRow, 'identifier'>) => {
  return `${row.identifier.kind}\0${row.identifier.normalizedValue}`
}

const getArticleIdentifierTargetKey = (row: Pick<ArticleIdentifierTargetRow, 'kind' | 'normalizedValue'>) => {
  return `${row.kind}\0${row.normalizedValue}`
}

const getArticleIdentifierWhereCondition = (row: ArticleIdentifierCommitRow) => {
  return `(kind = ${getSqlLiteral(row.identifier.kind)} AND normalized_value = ${getSqlLiteral(row.identifier.normalizedValue)})`
}

const getArticleIdentifierTargetRowsByKey = async ({
  rows,
  tx,
}: {
  rows: readonly ArticleIdentifierCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const targetRows = await queryChunks<ArticleIdentifierCommitRow, ArticleIdentifierTargetRow>(rows, (rowChunk) => {
    return tx.queryJson<ArticleIdentifierTargetRow>(`
      SELECT article_id AS articleId, kind, normalized_value AS normalizedValue
      FROM app.article_identifier
      WHERE ${rowChunk.map(getArticleIdentifierWhereCondition).join(' OR ')}
      ORDER BY kind ASC, normalized_value ASC
    `)
  })

  return targetRows.reduce<Record<string, ArticleIdentifierTargetRow>>((mapped, row) => {
    mapped[getArticleIdentifierTargetKey(row)] = row

    return mapped
  }, {})
}

const assertArticleIdentifierRowsCommitted = async ({
  rows,
  tx,
}: {
  rows: readonly ArticleIdentifierCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const targetRowsByKey = await getArticleIdentifierTargetRowsByKey({rows, tx})
  const missing = rows.find((row) => {
    return targetRowsByKey[getArticleIdentifierKey(row)] === undefined
  })

  if (missing) {
    return failCommitWriter(
      `article identifier ${missing.identifier.kind}:${missing.identifier.normalizedValue} for ${missing.sourceArticleId} was not committed`,
    )
  }

  const conflict = rows.find((row) => {
    return targetRowsByKey[getArticleIdentifierKey(row)]?.articleId !== row.articleId
  })

  return conflict
    ? failCommitWriter(
        `article identifier ${conflict.identifier.kind}:${conflict.identifier.normalizedValue} for ${conflict.sourceArticleId} is no longer available`,
      )
    : undefined
}

const getSetBasedArticleIdentifierJoinSql = (context: ProjectTransferCommitWriterSetBasedContext) => {
  return `
    FROM ${context.tempTables.articleIdentifiers} identifier
    INNER JOIN ${context.operationTables.tableNames.articles} staged_article
      ON ${getJsonStringFieldSql('staged_article.payload_json', 'sourceArticleId')} = identifier.source_article_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = identifier.source_article_id
    INNER JOIN ${context.commitIdMapTables.idMap} identifier_map
      ON identifier_map.map_kind = 'articleIdentifier'
      AND identifier_map.source_id = identifier.source_key
  `
}

const assertArticleIdentifierStageRowsMapped = async ({
  context,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await getTableCount({
    sql: `SELECT source_key FROM ${context.tempTables.articleIdentifiers}`,
    tx,
  })
  const mappedCount = await getTableCount({
    sql: `SELECT identifier.source_key ${getSetBasedArticleIdentifierJoinSql(context)}`,
    tx,
  })

  return expectedCount === mappedCount
    ? expectedCount
    : failCommitWriter(`article identifier stage rows mapped ${mappedCount} of ${expectedCount} staged rows`)
}

const assertSetBasedArticleIdentifierRowsCommitted = async ({
  context,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  tx: ProjectTransferCommitWriterTx
}) => {
  const [conflict] = await tx.queryJson<{kind: string; normalizedValue: string; sourceArticleId: string}>(`
    SELECT
      identifier.kind,
      identifier.normalized_value AS normalizedValue,
      identifier.source_article_id AS sourceArticleId
    ${getSetBasedArticleIdentifierJoinSql(context)}
    LEFT JOIN app.article_identifier target_identifier
      ON target_identifier.kind = identifier.kind
      AND target_identifier.normalized_value = identifier.normalized_value
    WHERE target_identifier.article_id IS NULL
      OR target_identifier.article_id <> article_map.target_id
    ORDER BY identifier.kind ASC, identifier.normalized_value ASC, identifier.source_article_id ASC
    LIMIT 1
  `)

  return conflict
    ? failCommitWriter(
        `article identifier ${conflict.kind}:${conflict.normalizedValue} for ${conflict.sourceArticleId} is no longer available`,
      )
    : undefined
}

const insertArticleIdentifiersSetBased = async ({
  context,
  now,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await assertArticleIdentifierStageRowsMapped({context, tx})

  if (expectedCount === 0) {
    return undefined
  }

  await tx.run(`
    INSERT INTO app.article_identifier (
      id,
      article_id,
      kind,
      normalized_value,
      source,
      provenance,
      is_primary,
      created_at,
      updated_at
    )
    SELECT
      identifier_map.target_id,
      article_map.target_id,
      identifier.kind,
      identifier.normalized_value,
      identifier.source,
      json_object('commit', TRUE, 'sourceArticleId', identifier.source_article_id),
      identifier.is_primary,
      ${getTimestampLiteral(now)},
      ${getTimestampLiteral(now)}
    ${getSetBasedArticleIdentifierJoinSql(context)}
    ON CONFLICT(kind, normalized_value) DO NOTHING
  `)

  return assertSetBasedArticleIdentifierRowsCommitted({context, tx})
}

const insertArticleIdentifiers = async ({
  articleIdBySourceId,
  articleMatches,
  articles,
  commitIdMaps,
  context,
  now,
  tx,
}: {
  articleIdBySourceId: Record<string, string>
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  commitIdMaps: ProjectTransferCommitIdMaps
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return insertArticleIdentifiersSetBased({context, now, tx})
  }

  const rows = getArticleIdentifierCommitRows({articleIdBySourceId, articleMatches, articles, commitIdMaps})

  if (rows.length === 0) {
    return undefined
  }

  await runChunks(rows, (rowChunk) => {
    return tx.run(`
        INSERT INTO app.article_identifier (
          id,
          article_id,
          kind,
          normalized_value,
          source,
          provenance,
          is_primary,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.identifier.kind)},
              ${getSqlLiteral(row.identifier.normalizedValue)},
              ${getSqlLiteral(row.identifier.evidence[0]?.source ?? 'project_transfer')},
              ${getJsonLiteral({commit: true, sourceArticleId: row.sourceArticleId})},
              ${getSqlLiteral(row.isPrimary)},
              ${getTimestampLiteral(now)},
              ${getTimestampLiteral(now)}
            )`
          })
          .join(', ')}
        ON CONFLICT(kind, normalized_value) DO NOTHING
      `)
  })

  return assertArticleIdentifierRowsCommitted({rows, tx})
}

const getRouteIdBySourceId = (projectRoutePlan: readonly ProjectRoutePlanEntry[]) => {
  return projectRoutePlan.reduce<Record<string, string>>((mapped, route) => {
    if (route.action === 'link' && route.targetImportRouteId !== null) {
      mapped[route.sourceImportRouteId] = route.targetImportRouteId
    }

    return mapped
  }, {})
}

const assertNoDuplicateRows = (label: string, keys: readonly string[]) => {
  const duplicate = getDuplicateValue([...keys])

  return duplicate ? failCommitWriter(`duplicate ${label} after remap: ${duplicate}`) : undefined
}

const getArticleImportRouteRows = ({
  articleIdBySourceId,
  articleImportRoutes,
  articleRoutePlan,
  routeIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  articleImportRoutes: readonly ProjectTransferPayloadRecord[]
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  routeIdBySourceId: Record<string, string>
}) => {
  const articleRoutePayloadBySourceId = getPayloadArrayBySourceId(articleImportRoutes, 'sourceArticleImportRouteId')

  return articleRoutePlan
    .filter((entry) => {
      return entry.action === 'write'
    })
    .map((entry) => {
      const payload = articleRoutePayloadBySourceId[entry.sourceArticleImportRouteId]
      const articleId = articleIdBySourceId[entry.sourceArticleId]
      const importRouteId = routeIdBySourceId[entry.sourceImportRouteId]

      if (payload === undefined) {
        return failCommitWriter(`missing article import route payload ${entry.sourceArticleImportRouteId}`)
      }

      if (articleId === undefined || importRouteId === undefined) {
        return failCommitWriter(`article import route ${entry.sourceArticleImportRouteId} is not commit-safe`)
      }

      return {articleId, importRouteId, payload, sourceArticleImportRouteId: entry.sourceArticleImportRouteId}
    })
}

const assertNoExistingArticleRouteRows = async ({
  rows,
  tx,
}: {
  rows: readonly ReturnType<typeof getArticleImportRouteRows>[number][]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.articleId}\u0000${row.importRouteId}`
  })

  assertNoDuplicateRows('article_import_route', keys)

  const existing =
    rows.length === 0
      ? []
      : await tx.queryJson<{articleId: string; importRouteId: string}>(`
          SELECT air.article_id AS articleId, air.import_route_id AS importRouteId
          FROM app.article_import_route air
          WHERE ${rows
            .map((row) => {
              return `(air.article_id = ${getSqlLiteral(row.articleId)} AND air.import_route_id = ${getSqlLiteral(row.importRouteId)})`
            })
            .join(' OR ')}
          ORDER BY air.article_id ASC, air.import_route_id ASC
        `)
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(
        `target article_import_route already has remapped key ${conflict.articleId}:${conflict.importRouteId}`,
      )
    : undefined
}

const getSetBasedArticleImportRouteRowsSql = (context: ProjectTransferCommitWriterSetBasedContext) => {
  return `
    SELECT
      article_route_map.target_id AS id,
      article_map.target_id AS article_id,
      route_map.target_id AS import_route_id,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'externalArticleId')} AS external_article_id,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'sourceKind')} AS source_kind,
      json_extract(payload.payload_json, '$.importMetadata') AS import_metadata,
      json_extract(payload.payload_json, '$.matchMetadata') AS match_metadata,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'importRunId')} AS import_run_id,
      ${getJsonStringFieldSql('payload.payload_json', 'sourceRecordKey')} AS source_record_key,
      ${getJsonStringFieldSql('payload.payload_json', 'sourceRecordHash')} AS source_record_hash,
      json_extract(payload.payload_json, '$.rawPayload') AS raw_payload
    FROM ${context.tempTables.articleRoutePlan} plan
    INNER JOIN ${context.operationTables.tableNames.articleImportRoutes} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceArticleImportRouteId')} = plan.source_article_import_route_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_route_map
      ON article_route_map.map_kind = 'articleImportRoute'
      AND article_route_map.source_id = plan.source_article_import_route_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = plan.source_article_id
    INNER JOIN ${context.commitIdMapTables.idMap} route_map
      ON route_map.map_kind = 'route'
      AND route_map.source_id = plan.source_import_route_id
      AND route_map.target_id = plan.target_import_route_id
    WHERE plan.action = 'write'
      AND plan.target_import_route_id IS NOT NULL
  `
}

const assertSetBasedArticleImportRouteRowsCommitSafe = async ({
  context,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedArticleImportRouteRowsSql(context)
  const expectedCount = await getTableCount({
    sql: `
      SELECT source_article_import_route_id
      FROM ${context.tempTables.articleRoutePlan}
      WHERE action = 'write'
        AND target_import_route_id IS NOT NULL
    `,
    tx,
  })
  const mappedCount = await getTableCount({sql: rowsSql, tx})
  const [duplicate] = await tx.queryJson<{articleId: string; importRouteId: string}>(`
    SELECT article_id AS articleId, import_route_id AS importRouteId
    FROM (${rowsSql}) rows
    GROUP BY article_id, import_route_id
    HAVING COUNT(*) > 1
    ORDER BY article_id ASC, import_route_id ASC
    LIMIT 1
  `)
  const [existing] = await tx.queryJson<{articleId: string; importRouteId: string}>(`
    SELECT rows.article_id AS articleId, rows.import_route_id AS importRouteId
    FROM (${rowsSql}) rows
    INNER JOIN app.article_import_route existing
      ON existing.article_id = rows.article_id
      AND existing.import_route_id = rows.import_route_id
    ORDER BY rows.article_id ASC, rows.import_route_id ASC
    LIMIT 1
  `)

  if (mappedCount !== expectedCount) {
    return failCommitWriter(`article_import_route rows mapped ${mappedCount} of ${expectedCount} staged plan rows`)
  }

  if (duplicate) {
    return failCommitWriter(
      `duplicate article_import_route after remap: ${duplicate.articleId}\u0000${duplicate.importRouteId}`,
    )
  }

  return existing
    ? failCommitWriter(
        `target article_import_route already has remapped key ${existing.articleId}:${existing.importRouteId}`,
      )
    : expectedCount
}

const insertArticleImportRoutesSetBased = async ({
  context,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await assertSetBasedArticleImportRouteRowsCommitSafe({context, tx})

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.article_import_route (
      id,
      article_id,
      import_route_id,
      external_article_id,
      source_kind,
      import_metadata,
      match_metadata,
      import_run_id,
      source_record_key,
      source_record_hash,
      raw_payload
    )
    SELECT
      id,
      article_id,
      import_route_id,
      external_article_id,
      source_kind,
      import_metadata,
      match_metadata,
      import_run_id,
      source_record_key,
      source_record_hash,
      raw_payload
    FROM (${getSetBasedArticleImportRouteRowsSql(context)}) rows
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`article_import_route insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const insertArticleImportRoutes = async ({
  commitIdMaps,
  context,
  rows,
  tx,
}: {
  commitIdMaps: ProjectTransferCommitIdMaps
  context: ProjectTransferCommitWriterSetBasedContext | null
  rows: readonly ReturnType<typeof getArticleImportRouteRows>[number][]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return insertArticleImportRoutesSetBased({context, tx})
  }

  await assertNoExistingArticleRouteRows({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.article_import_route (
          id,
          article_id,
          import_route_id,
          external_article_id,
          source_kind,
          import_metadata,
          match_metadata,
          import_run_id,
          source_record_key,
          source_record_hash,
          raw_payload
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(
                getMappedTargetId({
                  label: 'article import route',
                  mapped: commitIdMaps.articleImportRouteIdBySourceId,
                  sourceId: row.sourceArticleImportRouteId,
                }),
              )},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.importRouteId)},
              ${getSqlLiteral(getNullableString(getRecordField(row.payload, 'externalArticleId')))},
              ${getSqlLiteral(getNullableString(getRecordField(row.payload, 'sourceKind')))},
              ${getJsonLiteral(getRecordField(row.payload, 'importMetadata'))},
              ${getJsonLiteral(getRecordField(row.payload, 'matchMetadata'))},
              ${getSqlLiteral(getNullableString(getRecordField(row.payload, 'importRunId')))},
              ${getSqlLiteral(getRequiredString(getRecordField(row.payload, 'sourceRecordKey'), 'articleImportRoute.sourceRecordKey'))},
              ${getSqlLiteral(getRequiredString(getRecordField(row.payload, 'sourceRecordHash'), 'articleImportRoute.sourceRecordHash'))},
              ${getJsonLiteral(getRecordField(row.payload, 'rawPayload'))}
            )`
          })
          .join(', ')}
      `)
      })
}

const getSetBasedProjectImportRouteRowsSql = ({
  context,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  projectId: string
}) => {
  return `
    SELECT
      project_route_map.target_id AS id,
      ${getSqlLiteral(projectId)} AS project_id,
      route_map.target_id AS import_route_id
    FROM ${context.tempTables.projectRoutePlan} plan
    INNER JOIN ${context.commitIdMapTables.idMap} project_route_map
      ON project_route_map.map_kind = 'projectImportRoute'
      AND project_route_map.source_id = plan.source_project_import_route_id
    INNER JOIN ${context.commitIdMapTables.idMap} route_map
      ON route_map.map_kind = 'route'
      AND route_map.source_id = plan.source_import_route_id
      AND route_map.target_id = plan.target_import_route_id
    WHERE plan.action = 'link'
      AND plan.target_import_route_id IS NOT NULL
  `
}

const assertSetBasedProjectImportRouteRowsCommitSafe = async ({
  context,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedProjectImportRouteRowsSql({context, projectId})
  const expectedCount = await getTableCount({
    sql: `
      SELECT source_project_import_route_id
      FROM ${context.tempTables.projectRoutePlan}
      WHERE action = 'link'
        AND target_import_route_id IS NOT NULL
    `,
    tx,
  })
  const mappedCount = await getTableCount({sql: rowsSql, tx})
  const [duplicate] = await tx.queryJson<{importRouteId: string; projectId: string}>(`
    SELECT project_id AS projectId, import_route_id AS importRouteId
    FROM (${rowsSql}) rows
    GROUP BY project_id, import_route_id
    HAVING COUNT(*) > 1
    ORDER BY project_id ASC, import_route_id ASC
    LIMIT 1
  `)

  if (mappedCount !== expectedCount) {
    return failCommitWriter(`project_import_route rows mapped ${mappedCount} of ${expectedCount} staged plan rows`)
  }

  return duplicate
    ? failCommitWriter(
        `duplicate project_import_route after remap: ${duplicate.projectId}\u0000${duplicate.importRouteId}`,
      )
    : expectedCount
}

const insertProjectImportRoutesSetBased = async ({
  context,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await assertSetBasedProjectImportRouteRowsCommitSafe({context, projectId, tx})

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    SELECT id, project_id, import_route_id
    FROM (${getSetBasedProjectImportRouteRowsSql({context, projectId})}) rows
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`project_import_route insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const insertProjectImportRoutes = async ({
  commitIdMaps,
  context,
  projectId,
  projectRoutePlan,
  tx,
}: {
  commitIdMaps: ProjectTransferCommitIdMaps
  context: ProjectTransferCommitWriterSetBasedContext | null
  projectId: string
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return insertProjectImportRoutesSetBased({context, projectId, tx})
  }

  const rows = projectRoutePlan
    .filter((entry) => {
      return entry.action === 'link' && entry.targetImportRouteId !== null
    })
    .map((entry) => {
      return {
        importRouteId: entry.targetImportRouteId as string,
        projectId,
        sourceProjectImportRouteId: entry.sourceProjectImportRouteId,
      }
    })
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.importRouteId}`
  })

  assertNoDuplicateRows('project_import_route', keys)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.project_import_route (id, project_id, import_route_id)
        VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(
                getMappedTargetId({
                  label: 'project import route',
                  mapped: commitIdMaps.projectImportRouteIdBySourceId,
                  sourceId: row.sourceProjectImportRouteId,
                }),
              )},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.importRouteId)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getProjectArticleSourceIds = ({
  articleRoutePlan,
  projectArticles,
}: {
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  projectArticles: readonly ProjectTransferPayloadRecord[]
}) => {
  const directSources = projectArticles.map((entry) => {
    return getRequiredString(getRecordField(entry, 'sourceArticleId'), 'projectArticle.sourceArticleId')
  })
  const snapshotSources = articleRoutePlan
    .filter((entry) => {
      return entry.snapshotProjectArticleLink
    })
    .map((entry) => {
      return entry.sourceArticleId
    })

  return [...new Set([...directSources, ...snapshotSources])]
}

const getSetBasedProjectArticleRowsSql = ({
  context,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  projectId: string
}) => {
  return `
    SELECT
      project_article_map.target_id AS id,
      ${getSqlLiteral(projectId)} AS project_id,
      article_map.target_id AS article_id,
      NULL AS imported_from_project_id
    FROM ${context.tempTables.projectArticleSources} source_row
    INNER JOIN ${context.commitIdMapTables.idMap} project_article_map
      ON project_article_map.map_kind = 'projectArticle'
      AND project_article_map.source_id = source_row.source_article_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = source_row.source_article_id
  `
}

const assertSetBasedProjectArticleRowsCommitSafe = async ({
  context,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedProjectArticleRowsSql({context, projectId})
  const expectedCount = await getTableCount({
    sql: `SELECT source_article_id FROM ${context.tempTables.projectArticleSources}`,
    tx,
  })
  const mappedCount = await getTableCount({sql: rowsSql, tx})
  const [duplicate] = await tx.queryJson<{articleId: string; projectId: string}>(`
    SELECT project_id AS projectId, article_id AS articleId
    FROM (${rowsSql}) rows
    GROUP BY project_id, article_id
    HAVING COUNT(*) > 1
    ORDER BY project_id ASC, article_id ASC
    LIMIT 1
  `)

  if (mappedCount !== expectedCount) {
    return failCommitWriter(`project_article rows mapped ${mappedCount} of ${expectedCount} staged rows`)
  }

  return duplicate
    ? failCommitWriter(`duplicate project_article after remap: ${duplicate.projectId}\u0000${duplicate.articleId}`)
    : expectedCount
}

const insertProjectArticlesSetBased = async ({
  context,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await assertSetBasedProjectArticleRowsCommitSafe({context, projectId, tx})

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
    SELECT id, project_id, article_id, imported_from_project_id
    FROM (${getSetBasedProjectArticleRowsSql({context, projectId})}) rows
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`project_article insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const insertProjectArticles = async ({
  articleIdBySourceId,
  articleRoutePlan,
  commitIdMaps,
  context,
  projectArticles,
  projectId,
  tx,
}: {
  articleIdBySourceId: Record<string, string>
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  commitIdMaps: ProjectTransferCommitIdMaps
  context: ProjectTransferCommitWriterSetBasedContext | null
  projectArticles: readonly ProjectTransferPayloadRecord[]
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return insertProjectArticlesSetBased({context, projectId, tx})
  }

  const rows = getProjectArticleSourceIds({articleRoutePlan, projectArticles}).map((sourceArticleId) => {
    const articleId = articleIdBySourceId[sourceArticleId]

    return articleId === undefined
      ? failCommitWriter(`missing target article id for project article ${sourceArticleId}`)
      : {articleId, projectId, sourceArticleId}
  })
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}`
  })

  assertNoDuplicateRows('project_article', keys)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
        VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(
                getMappedTargetId({
                  label: 'project article',
                  mapped: commitIdMaps.projectArticleIdBySourceArticleId,
                  sourceId: row.sourceArticleId,
                }),
              )},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              NULL
            )`
          })
          .join(', ')}
      `)
      })
}

const markUpdatedReusedArticlesDirty = async ({
  promotion,
  tx,
}: {
  promotion: ProjectTransferCommitPromotionResult
  tx: ProjectTransferCommitWriterTx
}) => {
  const updatedReusedArticleIds = [
    ...new Set(
      promotion.articleFieldFills.map((fill) => {
        return fill.targetArticleId
      }),
    ),
  ]

  return updatedReusedArticleIds.length === 0
    ? undefined
    : getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({
        articleIds: updatedReusedArticleIds,
        reason: 'projectTransferCommit.reusedArticleUpdate',
        runner: tx,
      })
}

const markImportedProjectDirty = async ({projectId, tx}: {projectId: string; tx: ProjectTransferCommitWriterTx}) => {
  await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
    projects: [{projectId}],
    reason: 'projectTransferCommit.import',
    runner: tx,
  })
}

const getOmittedRouteWarnings = ({
  articleRoutePlan,
  projectRoutePlan,
}: {
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
}): ProjectTransferPackageWarning[] => {
  const projectWarnings = projectRoutePlan
    .filter((entry) => {
      return entry.action === 'omit'
    })
    .map((entry): ProjectTransferPackageWarning => {
      return {
        action: 'omitted',
        code: 'targetProjectImportRouteOmitted',
        details: {
          dateBoundedOutsideExportedArticleCount: entry.dateBoundedOutsideExportedArticleCount,
          outsideExportedArticleCount: entry.outsideExportedArticleCount,
          sourceImportRouteId: entry.sourceImportRouteId,
          sourceProjectImportRouteId: entry.sourceProjectImportRouteId,
          targetImportRouteId: entry.targetImportRouteId,
        },
        message: `${entry.sourceProjectImportRouteId} target project import route was omitted`,
        scope: `projectImportRoutes.${entry.sourceProjectImportRouteId}`,
        severity: 'warning',
      }
    })
  const articleWarnings = articleRoutePlan
    .filter((entry) => {
      return entry.action === 'omit'
    })
    .map((entry): ProjectTransferPackageWarning => {
      return {
        action: 'omitted',
        code: 'targetArticleImportRouteOmitted',
        details: {
          sourceArticleId: entry.sourceArticleId,
          sourceArticleImportRouteId: entry.sourceArticleImportRouteId,
          sourceImportRouteId: entry.sourceImportRouteId,
          targetArticleId: entry.targetArticleId,
          targetImportRouteId: entry.targetImportRouteId,
          unsafeProjectIds: entry.unsafeProjectIds,
        },
        message: `${entry.sourceArticleImportRouteId} target article import route was omitted`,
        scope: `articleImportRoutes.${entry.sourceArticleImportRouteId}`,
        severity: 'warning',
      }
    })

  return [...projectWarnings, ...articleWarnings]
}

const getDedupedWarnings = (warnings: readonly ProjectTransferPackageWarning[]) => {
  const result = warnings.reduce<{seen: Set<string>; warnings: ProjectTransferPackageWarning[]}>(
    (current, warning) => {
      const key = getProjectTransferCanonicalJson(warning)

      if (!current.seen.has(key)) {
        current.seen.add(key)
        current.warnings.push(warning)
      }

      return current
    },
    {seen: new Set(), warnings: []},
  )

  return result.warnings
}

const getPlanWarnings = (plan: ProjectTransferImportPlanArtifact) => {
  return getDedupedWarnings([...(plan.packageWarnings ?? []), ...(plan.summary.packageWarnings ?? [])])
}

const advanceCommitTargetStateDirtyTokens = async ({now, tx}: {now: Date; tx: ProjectTransferCommitWriterTx}) => {
  await getProjectTransferTargetStateDirtyTokenService().advanceTargetStateDirtyTokensAtomically({
    now,
    reason: 'projectTransferCommit.write',
    runner: tx,
    surfaces: projectTransferCommitWriteDirtyTokenSurfaces,
  })
}

const getEquivalentReusedJudgmentWarnings = (
  judgmentPlan: readonly JudgmentPlanEntry[],
): ProjectTransferPackageWarning[] => {
  return judgmentPlan
    .filter((entry) => {
      return entry.action === 'reuse' && entry.targetJudgmentId !== null
    })
    .map((entry): ProjectTransferPackageWarning => {
      return {
        action: 'reused',
        code: 'equivalentTargetJudgmentReused',
        details: {
          inputSignatureProvenance: entry.provenanceKind,
          physicalKey: entry.physicalKey,
          reviewVisibleKey: entry.reviewVisibleKey,
          sourceJudgmentId: entry.sourceJudgmentId,
          targetJudgmentId: entry.targetJudgmentId,
        },
        message: `${entry.sourceJudgmentId} reused equivalent target judgment ${entry.targetJudgmentId}`,
        scope: `judgments.${entry.sourceJudgmentId}`,
        severity: 'info',
      }
    })
}

const getCommitImportWarnings = ({
  articleRoutePlan,
  judgmentPlan,
  plan,
  projectRoutePlan,
}: {
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  judgmentPlan: readonly JudgmentPlanEntry[]
  plan: ProjectTransferImportPlanArtifact
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
}) => {
  return getDedupedWarnings([
    ...getPlanWarnings(plan),
    ...getOmittedRouteWarnings({articleRoutePlan, projectRoutePlan}),
    ...getEquivalentReusedJudgmentWarnings(judgmentPlan),
  ])
}

const getPayloadCounts = (plan: ProjectTransferImportPlanArtifact): Record<ProjectTransferPayloadKey, number> => {
  return plan.packageCounts
}

const getFinalCounts = ({
  articleIdBySourceId,
  humanJudgmentRows,
  humanSummaryRows,
  importWarnings,
  judgmentAssessmentRows,
  judgmentIdBySourceId,
  promptIdBySourceId,
  reviewRows,
  routeIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  humanJudgmentRows: readonly HumanJudgmentCommitRow[]
  humanSummaryRows: readonly HumanJudgmentSummaryCommitRow[]
  importWarnings: readonly ProjectTransferPackageWarning[]
  judgmentAssessmentRows: readonly JudgmentAssessmentCommitRow[]
  judgmentIdBySourceId: Record<string, string>
  promptIdBySourceId: Record<string, string>
  reviewRows: readonly ReviewCommitRow[]
  routeIdBySourceId: Record<string, string>
}) => {
  return {
    articles: Object.keys(articleIdBySourceId).length,
    humanJudgmentSummaries: humanSummaryRows.length,
    humanJudgments: humanJudgmentRows.length,
    judgmentAssessments: judgmentAssessmentRows.length,
    judgments: Object.keys(judgmentIdBySourceId).length,
    prompts: Object.keys(promptIdBySourceId).length,
    reviews: reviewRows.length,
    routes: Object.keys(routeIdBySourceId).length,
    warnings: importWarnings.length,
  }
}

const getCompletionPayload = ({
  finalCounts,
  importWarnings,
  packageFingerprint,
  payloadCounts,
  projectId,
  projectName,
  transferHistoryId,
}: {
  finalCounts: Record<string, number>
  importWarnings: ProjectTransferPackageWarning[]
  packageFingerprint: string
  payloadCounts: Record<string, number>
  projectId: string
  projectName: string
  transferHistoryId: string
}): ProjectTransferImportCompletionPayload => {
  return {
    finalCounts,
    importWarnings,
    packageFingerprint,
    payloadCounts,
    projectId,
    projectName,
    status: 'completed',
    targetProjectId: projectId,
    targetProjectName: projectName,
    transferHistoryId,
  }
}

const getRequiredPlanEntries = <TEntry>(
  entries: readonly TEntry[] | undefined,
  label: string,
  payloadCount: number,
) => {
  return payloadCount === 0 ? (entries ?? []) : (entries ?? failCommitWriter(`${label} is required`))
}

const getContentSettings = (record: ProjectTransferPayloadRecord) => {
  const settings = isRecord(record.contentSettings) ? record.contentSettings : {}

  return {
    useAbstract: getBoolean(settings.useAbstract, true),
    useFulltext: getBoolean(settings.useFulltext, false),
    useFulltextNoImages: getBoolean(settings.useFulltextNoImages, false),
    useTitle: getBoolean(settings.useTitle, true),
  }
}

const getMappedTargetId = ({
  label,
  mapped,
  sourceId,
}: {
  label: string
  mapped: Record<string, string>
  sourceId: string
}) => {
  return mapped[sourceId] ?? failCommitWriter(`missing target ${label} for ${sourceId}`)
}

const getTargetModelIdForSource = ({
  plan,
  sourceModelId,
}: {
  plan: ProjectTransferImportPlanArtifact
  sourceModelId: string
}) => {
  return (
    getDependencyResolutionState(plan).modelTargetBySourceId?.[sourceModelId]
    ?? failCommitWriter(`missing target model for ${sourceModelId}`)
  )
}

const assertPlanTargetMatches = ({actual, label, planned}: {actual: string; label: string; planned: string | null}) => {
  return planned === null || planned.startsWith('new:') || planned === actual
    ? undefined
    : failCommitWriter(`${label} plan target ${planned} does not match final target ${actual}`)
}

const getJudgmentPhysicalKey = (row: {
  articleId: string
  deleteGeneration: number
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}) => {
  return [
    row.articleId,
    row.promptId,
    row.modelId,
    String(row.useTitle),
    String(row.useAbstract),
    String(row.useFulltext),
    String(row.useFulltextNoImages),
    String(row.deleteGeneration),
  ].join('\u0000')
}

const getJudgmentReviewVisibleKey = (row: {
  articleId: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}) => {
  return [
    row.articleId,
    row.promptId,
    row.modelId,
    String(row.useTitle),
    String(row.useAbstract),
    String(row.useFulltext),
    String(row.useFulltextNoImages),
  ].join('\u0000')
}

const getTargetJudgmentPhysicalKey = (row: TargetJudgmentRow) => {
  return getJudgmentPhysicalKey({
    articleId: row.articleId,
    deleteGeneration: row.deleteGeneration ?? 0,
    modelId: row.modelId,
    promptId: row.promptId,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useTitle: row.useTitle,
  })
}

const getTargetJudgmentReviewVisibleKey = (row: TargetJudgmentRow) => {
  return getJudgmentReviewVisibleKey(row)
}

const getJudgmentFieldSignature = (row: JudgmentCommitRow) => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: row.answeredOriginalAsArray,
    confidenceOriginal: row.confidenceOriginal,
    explanation: row.explanation,
    isAnswered: true,
    quotes: row.quotes,
  }
}

const getTargetJudgmentFieldSignature = (row: TargetJudgmentRow) => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: getArrayValue(row.answeredOriginalAsArray),
    confidenceOriginal: row.confidenceOriginal ?? 50,
    explanation: row.explanation,
    isAnswered: row.isAnswered ?? false,
    quotes: getArrayValue(row.quotes),
  }
}

const getJudgmentRows = ({
  articleIdBySourceId,
  commitIdMaps,
  judgmentPlan,
  judgments,
  now,
  plan,
  promptIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  commitIdMaps: ProjectTransferCommitIdMaps
  judgmentPlan: readonly JudgmentPlanEntry[]
  judgments: readonly ProjectTransferPayloadRecord[]
  now: Date
  plan: ProjectTransferImportPlanArtifact
  promptIdBySourceId: Record<string, string>
}) => {
  const planBySourceId = judgmentPlan.reduce<Record<string, JudgmentPlanEntry>>((mapped, entry) => {
    mapped[entry.sourceJudgmentId] = entry

    return mapped
  }, {})
  const judgmentBySourceId = getPayloadArrayBySourceId(judgments, 'sourceJudgmentId')
  const extraPlanEntry = judgmentPlan.find((entry) => {
    return judgmentBySourceId[entry.sourceJudgmentId] === undefined
  })

  if (extraPlanEntry) {
    return failCommitWriter(`judgment plan references missing payload ${extraPlanEntry.sourceJudgmentId}`)
  }

  return judgments.map((judgment): JudgmentCommitRow => {
    const sourceJudgmentId = getRequiredString(
      getRecordField(judgment, 'sourceJudgmentId'),
      'judgment.sourceJudgmentId',
    )
    const sourceArticleId = getRequiredString(
      getRecordField(judgment, 'sourceArticleId'),
      `judgments.${sourceJudgmentId}.sourceArticleId`,
    )
    const sourcePromptId = getRequiredString(
      getRecordField(judgment, 'sourcePromptId'),
      `judgments.${sourceJudgmentId}.sourcePromptId`,
    )
    const sourceModelId = getRequiredString(
      getRecordField(judgment, 'sourceModelId'),
      `judgments.${sourceJudgmentId}.sourceModelId`,
    )
    const entry = planBySourceId[sourceJudgmentId] ?? failCommitWriter(`missing judgment plan for ${sourceJudgmentId}`)
    const action =
      entry.action === 'insert' || entry.action === 'reuse'
        ? entry.action
        : failCommitWriter(`judgment ${sourceJudgmentId} is not commit-safe`)
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})
    const promptId = getMappedTargetId({label: 'prompt', mapped: promptIdBySourceId, sourceId: sourcePromptId})
    const modelId = getTargetModelIdForSource({plan, sourceModelId})
    const settings = getContentSettings(judgment)

    assertPlanTargetMatches({
      actual: articleId,
      label: `judgment ${sourceJudgmentId} article`,
      planned: entry.targetArticleId,
    })
    assertPlanTargetMatches({
      actual: promptId,
      label: `judgment ${sourceJudgmentId} prompt`,
      planned: entry.targetPromptId,
    })
    assertPlanTargetMatches({
      actual: modelId,
      label: `judgment ${sourceJudgmentId} model`,
      planned: entry.targetModelId,
    })

    if (getRecordField(judgment, 'isAnswered') !== true) {
      return failCommitWriter(`judgment ${sourceJudgmentId} is not answered`)
    }

    return {
      action,
      answeredOriginal: getNullableString(getRecordField(judgment, 'answeredOriginal')),
      answeredOriginalAsArray: getStringArray(getRecordField(judgment, 'answeredOriginalAsArray')) ?? [],
      articleId,
      chunkingStrategy: getNullableString(getRecordField(judgment, 'chunkingStrategy')),
      confidenceOriginal: getNonNegativeInteger(getRecordField(judgment, 'confidenceOriginal'), 50),
      createdAt: getDateOrDefault(getRecordField(judgment, 'createdAt'), now),
      deleteGeneration: getNonNegativeInteger(getRecordField(judgment, 'deleteGeneration'), 0),
      explanation: getNullableString(getRecordField(judgment, 'explanation')),
      id:
        action === 'insert'
          ? getMappedTargetId({
              label: 'judgment',
              mapped: commitIdMaps.judgmentIdBySourceId,
              sourceId: sourceJudgmentId,
            })
          : (entry.targetJudgmentId ?? failCommitWriter(`reused judgment ${sourceJudgmentId} has no target id`)),
      modelId,
      promptId,
      quotes: getArrayValue(getRecordField(judgment, 'quotes')),
      snapshotProjectModelName: getNullableString(getRecordField(judgment, 'snapshotProjectModelName')),
      sourceJudgmentId,
      updatedAt: getDateOrDefault(getRecordField(judgment, 'updatedAt'), now),
      ...settings,
    }
  })
}

const getTargetJudgmentRows = async ({
  rows,
  tx,
}: {
  rows: readonly JudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const articleIds = [
    ...new Set(
      rows.map((row) => {
        return row.articleId
      }),
    ),
  ]
  const promptIds = [
    ...new Set(
      rows.map((row) => {
        return row.promptId
      }),
    ),
  ]
  const modelIds = [
    ...new Set(
      rows.map((row) => {
        return row.modelId
      }),
    ),
  ]

  return rows.length === 0
    ? []
    : getValueChunks(articleIds).reduce<Promise<TargetJudgmentRow[]>>(async (articleRowsPromise, articleIdChunk) => {
        const articleRows = await articleRowsPromise
        const promptRows = await getValueChunks(promptIds).reduce<Promise<TargetJudgmentRow[]>>(
          async (promptRowsPromise, promptIdChunk) => {
            const currentPromptRows = await promptRowsPromise
            const modelRows = await queryChunks<string, TargetJudgmentRow>(modelIds, (modelIdChunk) => {
              return tx.queryJson<TargetJudgmentRow>(`
                SELECT
                  id,
                  article_id AS articleId,
                  prompt_id AS promptId,
                  model_id AS modelId,
                  use_title AS useTitle,
                  use_abstract AS useAbstract,
                  use_fulltext AS useFulltext,
                  use_fulltext_no_images AS useFulltextNoImages,
                  is_answered AS isAnswered,
                  answered_original AS answeredOriginal,
                  TO_JSON(answered_original_as_array) AS answeredOriginalAsArray,
                  confidence_original AS confidenceOriginal,
                  explanation,
                  TO_JSON(quotes) AS quotes,
                  delete_generation AS deleteGeneration
                FROM app.judgment
                WHERE deleted_at IS NULL
                  AND article_id IN (${getQuotedStringList([...articleIdChunk]).join(', ')})
                  AND prompt_id IN (${getQuotedStringList([...promptIdChunk]).join(', ')})
                  AND model_id IN (${getQuotedStringList([...modelIdChunk]).join(', ')})
                ORDER BY article_id ASC, prompt_id ASC, model_id ASC, id ASC
              `)
            })

            return [...currentPromptRows, ...modelRows]
          },
          Promise.resolve([]),
        )

        return [...articleRows, ...promptRows]
      }, Promise.resolve([]))
}

const assertNoDuplicateJudgmentRows = (rows: readonly JudgmentCommitRow[]) => {
  assertNoDuplicateRows(
    'judgment physical key',
    rows.map((row) => {
      return getJudgmentPhysicalKey(row)
    }),
  )

  return assertNoDuplicateRows(
    'judgment active review-visible key',
    rows.map((row) => {
      return getJudgmentReviewVisibleKey(row)
    }),
  )
}

const assertJudgmentTargetsCommitSafe = async ({
  rows,
  tx,
}: {
  rows: readonly JudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  assertNoDuplicateJudgmentRows(rows)

  const targets = await getTargetJudgmentRows({rows, tx})
  const targetsByPhysicalKey = targets.reduce<Record<string, TargetJudgmentRow[]>>((mapped, target) => {
    const key = getTargetJudgmentPhysicalKey(target)
    const keyTargets = mapped[key] ?? []
    keyTargets.push(target)
    mapped[key] = keyTargets

    return mapped
  }, {})
  const targetsByVisibleKey = targets.reduce<Record<string, TargetJudgmentRow[]>>((mapped, target) => {
    const key = getTargetJudgmentReviewVisibleKey(target)
    const keyTargets = mapped[key] ?? []
    keyTargets.push(target)
    mapped[key] = keyTargets

    return mapped
  }, {})

  return rows.map((row) => {
    const physicalKey = getJudgmentPhysicalKey(row)
    const visibleKey = getJudgmentReviewVisibleKey(row)
    const physicalTargets = targetsByPhysicalKey[physicalKey] ?? []
    const visibleTargets = targetsByVisibleKey[visibleKey] ?? []
    const target = physicalTargets.find((targetRow) => {
      return targetRow.id === row.id
    })
    const extraVisibleTarget = visibleTargets.find((targetRow) => {
      return targetRow.id !== row.id
    })

    if (row.action === 'insert' && physicalTargets.length > 0) {
      return failCommitWriter(`target judgment physical key already exists for ${row.sourceJudgmentId}`)
    }

    if (row.action === 'insert' && visibleTargets.length > 0) {
      return failCommitWriter(`target judgment review-visible key already exists for ${row.sourceJudgmentId}`)
    }

    if (row.action === 'reuse' && target === undefined) {
      return failCommitWriter(
        `reused target judgment ${row.id} is missing or no longer matches ${row.sourceJudgmentId}`,
      )
    }

    if (row.action === 'reuse' && extraVisibleTarget !== undefined) {
      return failCommitWriter(`reused judgment ${row.sourceJudgmentId} has an active review-visible conflict`)
    }

    return row.action === 'reuse'
      && target !== undefined
      && !valuesEquivalent(getJudgmentFieldSignature(row), getTargetJudgmentFieldSignature(target))
      ? failCommitWriter(`reused target judgment ${row.id} is not equivalent to ${row.sourceJudgmentId}`)
      : undefined
  })
}

const getSetBasedJudgmentRowsSql = ({
  context,
  now,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
}) => {
  return `
    SELECT
      plan.action,
      judgment_map.target_id AS id,
      plan.source_judgment_id,
      article_map.target_id AS article_id,
      prompt_map.target_id AS prompt_id,
      model_map.target_id AS model_id,
      plan.target_article_id,
      plan.target_judgment_id,
      plan.target_model_id,
      plan.target_prompt_id,
      ${getSqlLiteral(projectId)} AS project_id,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'snapshotProjectModelName')} AS snapshot_project_model_name,
      ${getJsonBooleanPathSql('payload.payload_json', '$.contentSettings.useTitle', true)} AS use_title,
      ${getJsonBooleanPathSql('payload.payload_json', '$.contentSettings.useAbstract', true)} AS use_abstract,
      ${getJsonBooleanPathSql('payload.payload_json', '$.contentSettings.useFulltext', false)} AS use_fulltext,
      ${getJsonBooleanPathSql('payload.payload_json', '$.contentSettings.useFulltextNoImages', false)} AS use_fulltext_no_images,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'chunkingStrategy')} AS chunking_strategy,
      ${getJsonBooleanPathSql('payload.payload_json', '$.isAnswered', false)} AS is_answered,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'answeredOriginal')} AS answered_original,
      ${getJsonStringArrayFieldSql('payload.payload_json', 'answeredOriginalAsArray')} AS answered_original_as_array,
      ${getJsonIntegerFieldSql('payload.payload_json', 'confidenceOriginal', 50)} AS confidence_original,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'explanation')} AS explanation,
      ${getJsonArrayFieldSql('payload.payload_json', 'quotes')} AS quotes,
      ${getJsonBigIntFieldSql('payload.payload_json', 'deleteGeneration', 0)} AS delete_generation,
      ${getJsonTimestampFieldSql('payload.payload_json', 'createdAt', now)} AS created_at,
      ${getJsonTimestampFieldSql('payload.payload_json', 'updatedAt', now)} AS updated_at
    FROM ${context.tempTables.judgmentPlan} plan
    INNER JOIN ${context.operationTables.tableNames.judgments} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentId')} = plan.source_judgment_id
    INNER JOIN ${context.commitIdMapTables.idMap} judgment_map
      ON judgment_map.map_kind = 'judgment'
      AND judgment_map.source_id = plan.source_judgment_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceArticleId')}
    INNER JOIN ${context.commitIdMapTables.idMap} prompt_map
      ON prompt_map.map_kind = 'prompt'
      AND prompt_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourcePromptId')}
    INNER JOIN ${context.commitIdMapTables.idMap} model_map
      ON model_map.map_kind = 'model'
      AND model_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceModelId')}
    WHERE plan.action IN ('insert', 'reuse')
  `
}

const assertSetBasedJudgmentPlanRowsCommitSafe = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedJudgmentRowsSql({context, now, projectId})
  const [invalidAction] = await tx.queryJson<{action: string | null; sourceJudgmentId: string}>(`
    SELECT source_judgment_id AS sourceJudgmentId, action
    FROM ${context.tempTables.judgmentPlan}
    WHERE action NOT IN ('insert', 'reuse')
    ORDER BY source_judgment_id ASC
    LIMIT 1
  `)
  const [extraPlan] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT plan.source_judgment_id AS sourceJudgmentId
    FROM ${context.tempTables.judgmentPlan} plan
    LEFT JOIN ${context.operationTables.tableNames.judgments} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentId')} = plan.source_judgment_id
    WHERE payload.row_index IS NULL
    ORDER BY plan.source_judgment_id ASC
    LIMIT 1
  `)
  const [missingPlan] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentId')} AS sourceJudgmentId
    FROM ${context.operationTables.tableNames.judgments} payload
    LEFT JOIN ${context.tempTables.judgmentPlan} plan
      ON plan.source_judgment_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentId')}
    WHERE plan.source_judgment_id IS NULL
    ORDER BY sourceJudgmentId ASC
    LIMIT 1
  `)
  const expectedCount = await getTableCount({
    sql: `SELECT row_index FROM ${context.operationTables.tableNames.judgments}`,
    tx,
  })
  const mappedCount = await getTableCount({sql: rowsSql, tx})
  const [unanswered] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentId')} AS sourceJudgmentId
    FROM ${context.operationTables.tableNames.judgments} payload
    WHERE ${getJsonBooleanPathSql('payload.payload_json', '$.isAnswered', false)} <> TRUE
    ORDER BY sourceJudgmentId ASC
    LIMIT 1
  `)
  const [targetMismatch] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT rows.source_judgment_id AS sourceJudgmentId
    FROM (${rowsSql}) rows
    WHERE NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.article_id', plannedSql: 'rows.target_article_id'})}
      OR NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.prompt_id', plannedSql: 'rows.target_prompt_id'})}
      OR NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.model_id', plannedSql: 'rows.target_model_id'})}
      OR NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.id', plannedSql: 'rows.target_judgment_id'})}
    ORDER BY rows.source_judgment_id ASC
    LIMIT 1
  `)

  if (invalidAction) {
    return failCommitWriter(`judgment ${invalidAction.sourceJudgmentId} is not commit-safe`)
  }

  if (extraPlan) {
    return failCommitWriter(`judgment plan references missing payload ${extraPlan.sourceJudgmentId}`)
  }

  if (missingPlan) {
    return failCommitWriter(`missing judgment plan for ${missingPlan.sourceJudgmentId}`)
  }

  if (mappedCount !== expectedCount) {
    return failCommitWriter(`judgment rows mapped ${mappedCount} of ${expectedCount} staged rows`)
  }

  if (unanswered) {
    return failCommitWriter(`judgment ${unanswered.sourceJudgmentId} is not answered`)
  }

  return targetMismatch
    ? failCommitWriter(`judgment ${targetMismatch.sourceJudgmentId} plan target no longer matches final target`)
    : expectedCount
}

const assertSetBasedJudgmentRowsDoNotDuplicate = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedJudgmentRowsSql({context, now, projectId})
  const [physicalDuplicate] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT MIN(source_judgment_id) AS sourceJudgmentId
    FROM (${rowsSql}) rows
    GROUP BY
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      delete_generation
    HAVING COUNT(*) > 1
    ORDER BY sourceJudgmentId ASC
    LIMIT 1
  `)
  const [visibleDuplicate] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT MIN(source_judgment_id) AS sourceJudgmentId
    FROM (${rowsSql}) rows
    GROUP BY
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    HAVING COUNT(*) > 1
    ORDER BY sourceJudgmentId ASC
    LIMIT 1
  `)

  if (physicalDuplicate) {
    return failCommitWriter(`duplicate judgment physical key after remap: ${physicalDuplicate.sourceJudgmentId}`)
  }

  return visibleDuplicate
    ? failCommitWriter(`duplicate judgment active review-visible key after remap: ${visibleDuplicate.sourceJudgmentId}`)
    : undefined
}

const assertSetBasedJudgmentTargetsCommitSafe = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedJudgmentRowsSql({context, now, projectId})
  await assertSetBasedJudgmentRowsDoNotDuplicate({context, now, projectId, tx})

  const [physicalConflict] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT rows.source_judgment_id AS sourceJudgmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment target
      ON target.deleted_at IS NULL
      AND target.article_id = rows.article_id
      AND target.prompt_id = rows.prompt_id
      AND target.model_id = rows.model_id
      AND target.use_title = rows.use_title
      AND target.use_abstract = rows.use_abstract
      AND target.use_fulltext = rows.use_fulltext
      AND target.use_fulltext_no_images = rows.use_fulltext_no_images
      AND target.delete_generation = rows.delete_generation
    WHERE rows.action = 'insert'
    ORDER BY rows.source_judgment_id ASC
    LIMIT 1
  `)
  const [visibleConflict] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT rows.source_judgment_id AS sourceJudgmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment target
      ON target.deleted_at IS NULL
      AND target.article_id = rows.article_id
      AND target.prompt_id = rows.prompt_id
      AND target.model_id = rows.model_id
      AND target.use_title = rows.use_title
      AND target.use_abstract = rows.use_abstract
      AND target.use_fulltext = rows.use_fulltext
      AND target.use_fulltext_no_images = rows.use_fulltext_no_images
    WHERE rows.action = 'insert'
    ORDER BY rows.source_judgment_id ASC
    LIMIT 1
  `)
  const [missingReuse] = await tx.queryJson<{id: string; sourceJudgmentId: string}>(`
    SELECT rows.id, rows.source_judgment_id AS sourceJudgmentId
    FROM (${rowsSql}) rows
    LEFT JOIN app.judgment target
      ON target.id = rows.id
      AND target.deleted_at IS NULL
      AND target.article_id = rows.article_id
      AND target.prompt_id = rows.prompt_id
      AND target.model_id = rows.model_id
      AND target.use_title = rows.use_title
      AND target.use_abstract = rows.use_abstract
      AND target.use_fulltext = rows.use_fulltext
      AND target.use_fulltext_no_images = rows.use_fulltext_no_images
      AND target.delete_generation = rows.delete_generation
    WHERE rows.action = 'reuse'
      AND target.id IS NULL
    ORDER BY rows.source_judgment_id ASC
    LIMIT 1
  `)
  const [extraVisibleReuse] = await tx.queryJson<{sourceJudgmentId: string}>(`
    SELECT rows.source_judgment_id AS sourceJudgmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment target
      ON target.deleted_at IS NULL
      AND target.article_id = rows.article_id
      AND target.prompt_id = rows.prompt_id
      AND target.model_id = rows.model_id
      AND target.use_title = rows.use_title
      AND target.use_abstract = rows.use_abstract
      AND target.use_fulltext = rows.use_fulltext
      AND target.use_fulltext_no_images = rows.use_fulltext_no_images
      AND target.id <> rows.id
    WHERE rows.action = 'reuse'
    ORDER BY rows.source_judgment_id ASC
    LIMIT 1
  `)
  const [mismatchedReuse] = await tx.queryJson<{id: string; sourceJudgmentId: string}>(`
    SELECT rows.id, rows.source_judgment_id AS sourceJudgmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment target
      ON target.id = rows.id
    WHERE rows.action = 'reuse'
      AND (
        COALESCE(target.is_answered, FALSE) <> TRUE
        OR target.answered_original IS DISTINCT FROM rows.answered_original
        OR COALESCE(target.answered_original_as_array, []::VARCHAR[]) IS DISTINCT FROM rows.answered_original_as_array
        OR COALESCE(target.confidence_original, 50) <> rows.confidence_original
        OR target.explanation IS DISTINCT FROM rows.explanation
        OR CAST(COALESCE(target.quotes, CAST('[]' AS JSON)) AS VARCHAR) <> CAST(rows.quotes AS VARCHAR)
      )
    ORDER BY rows.source_judgment_id ASC
    LIMIT 1
  `)

  if (physicalConflict) {
    return failCommitWriter(`target judgment physical key already exists for ${physicalConflict.sourceJudgmentId}`)
  }

  if (visibleConflict) {
    return failCommitWriter(`target judgment review-visible key already exists for ${visibleConflict.sourceJudgmentId}`)
  }

  if (missingReuse) {
    return failCommitWriter(
      `reused target judgment ${missingReuse.id} is missing or no longer matches ${missingReuse.sourceJudgmentId}`,
    )
  }

  if (extraVisibleReuse) {
    return failCommitWriter(
      `reused judgment ${extraVisibleReuse.sourceJudgmentId} has an active review-visible conflict`,
    )
  }

  return mismatchedReuse
    ? failCommitWriter(
        `reused target judgment ${mismatchedReuse.id} is not equivalent to ${mismatchedReuse.sourceJudgmentId}`,
      )
    : undefined
}

const insertJudgmentRowsSetBased = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await assertSetBasedJudgmentPlanRowsCommitSafe({context, now, projectId, tx})

  if (expectedCount === 0) {
    return undefined
  }

  await assertSetBasedJudgmentTargetsCommitSafe({context, now, projectId, tx})

  const rowsSql = getSetBasedJudgmentRowsSql({context, now, projectId})
  const expectedInsertCount = await getTableCount({sql: `SELECT id FROM (${rowsSql}) rows WHERE action = 'insert'`, tx})

  if (expectedInsertCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      snapshot_project_id,
      snapshot_project_model_name,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      is_answered,
      answered_original,
      answered_original_as_array,
      confidence_original,
      explanation,
      quotes,
      delete_generation,
      deleted_at,
      created_at,
      updated_at
    )
    SELECT
      id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      project_id,
      snapshot_project_model_name,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      TRUE,
      answered_original,
      answered_original_as_array,
      confidence_original,
      explanation,
      quotes,
      delete_generation,
      NULL,
      created_at,
      updated_at
    FROM (${rowsSql}) rows
    WHERE action = 'insert'
    RETURNING id
  `)

  return insertedRows.length === expectedInsertCount
    ? undefined
    : failCommitWriter(`judgment insert wrote ${insertedRows.length} of ${expectedInsertCount} staged rows`)
}

const insertJudgmentRows = async ({
  context,
  now,
  projectId,
  rows,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  projectId: string
  rows: readonly JudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return rows.length === 0 ? undefined : insertJudgmentRowsSetBased({context, now, projectId, tx})
  }

  await assertJudgmentTargetsCommitSafe({rows, tx})

  const insertRows = rows.filter((row) => {
    return row.action === 'insert'
  })

  return insertRows.length === 0
    ? undefined
    : runChunks(insertRows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment (
          id,
          article_id,
          prompt_id,
          model_id,
          project_id,
          snapshot_project_id,
          snapshot_project_model_name,
          use_title,
          use_abstract,
          use_fulltext,
          use_fulltext_no_images,
          chunking_strategy,
          is_answered,
          answered_original,
          answered_original_as_array,
          confidence_original,
          explanation,
          quotes,
          delete_generation,
          deleted_at,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.promptId)},
              ${getSqlLiteral(row.modelId)},
              ${getSqlLiteral(projectId)},
              ${getSqlLiteral(projectId)},
              ${getSqlLiteral(row.snapshotProjectModelName)},
              ${getSqlLiteral(row.useTitle)},
              ${getSqlLiteral(row.useAbstract)},
              ${getSqlLiteral(row.useFulltext)},
              ${getSqlLiteral(row.useFulltextNoImages)},
              ${getSqlLiteral(row.chunkingStrategy)},
              TRUE,
              ${getSqlLiteral(row.answeredOriginal)},
              ${getSqlLiteral(row.answeredOriginalAsArray)},
              ${getSqlLiteral(row.confidenceOriginal)},
              ${getSqlLiteral(row.explanation)},
              ${getJsonLiteral(row.quotes)},
              ${getSqlLiteral(row.deleteGeneration)},
              NULL,
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getJudgmentIdBySourceId = (rows: readonly JudgmentCommitRow[]) => {
  return rows.reduce<Record<string, string>>((mapped, row) => {
    mapped[row.sourceJudgmentId] = row.id

    return mapped
  }, {})
}

const getAssessmentSignature = (
  row: Pick<JudgmentAssessmentCommitRow, 'assessmentComment' | 'assessmentIsCorrect'>,
) => {
  return {assessmentComment: row.assessmentComment, assessmentIsCorrect: row.assessmentIsCorrect}
}

const getTargetAssessmentSignature = (row: TargetJudgmentAssessmentRow) => {
  return {assessmentComment: row.assessmentComment, assessmentIsCorrect: row.assessmentIsCorrect ?? false}
}

const getJudgmentAssessmentRows = ({
  assessmentPlan,
  assessments,
  commitIdMaps,
  judgmentIdBySourceId,
  now,
}: {
  assessmentPlan: readonly JudgmentAssessmentPlanEntry[]
  assessments: readonly ProjectTransferPayloadRecord[]
  commitIdMaps: ProjectTransferCommitIdMaps
  judgmentIdBySourceId: Record<string, string>
  now: Date
}) => {
  const planBySourceId = assessmentPlan.reduce<Record<string, JudgmentAssessmentPlanEntry>>((mapped, entry) => {
    mapped[entry.sourceJudgmentAssessmentId] = entry

    return mapped
  }, {})
  const assessmentBySourceId = getPayloadArrayBySourceId(assessments, 'sourceJudgmentAssessmentId')
  const extraPlanEntry = assessmentPlan.find((entry) => {
    return assessmentBySourceId[entry.sourceJudgmentAssessmentId] === undefined
  })

  if (extraPlanEntry) {
    return failCommitWriter(
      `judgment assessment plan references missing payload ${extraPlanEntry.sourceJudgmentAssessmentId}`,
    )
  }

  return assessments.map((assessment): JudgmentAssessmentCommitRow => {
    const sourceJudgmentAssessmentId = getRequiredString(
      getRecordField(assessment, 'sourceJudgmentAssessmentId'),
      'judgmentAssessment.sourceJudgmentAssessmentId',
    )
    const sourceJudgmentId = getRequiredString(
      getRecordField(assessment, 'sourceJudgmentId'),
      `judgmentAssessments.${sourceJudgmentAssessmentId}.sourceJudgmentId`,
    )
    const entry =
      planBySourceId[sourceJudgmentAssessmentId]
      ?? failCommitWriter(`missing judgment assessment plan for ${sourceJudgmentAssessmentId}`)
    const action =
      entry.action === 'insert' || entry.action === 'reuse'
        ? entry.action
        : failCommitWriter(`judgment assessment ${sourceJudgmentAssessmentId} is not commit-safe`)
    const judgmentId =
      judgmentIdBySourceId[sourceJudgmentId]
      ?? failCommitWriter(`missing target judgment for assessment ${sourceJudgmentAssessmentId}`)

    assertPlanTargetMatches({
      actual: judgmentId,
      label: `judgment assessment ${sourceJudgmentAssessmentId}`,
      planned: entry.targetJudgmentId,
    })

    return {
      action,
      assessmentComment: getNullableString(getRecordField(assessment, 'assessmentComment')),
      assessmentIsCorrect: getBoolean(getRecordField(assessment, 'assessmentIsCorrect'), false),
      createdAt: getDateOrDefault(getRecordField(assessment, 'createdAt'), now),
      id:
        action === 'insert'
          ? getMappedTargetId({
              label: 'judgment assessment',
              mapped: commitIdMaps.judgmentAssessmentIdBySourceId,
              sourceId: sourceJudgmentAssessmentId,
            })
          : (entry.targetAssessmentId
            ?? failCommitWriter(`reused assessment ${sourceJudgmentAssessmentId} has no target id`)),
      judgmentId,
      sourceJudgmentAssessmentId,
      updatedAt: getDateOrDefault(getRecordField(assessment, 'updatedAt'), now),
    }
  })
}

const getTargetAssessmentRows = async ({
  judgmentIds,
  tx,
}: {
  judgmentIds: readonly string[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const uniqueJudgmentIds = [...new Set(judgmentIds)]

  return uniqueJudgmentIds.length === 0
    ? []
    : queryChunks<string, TargetJudgmentAssessmentRow>(uniqueJudgmentIds, (judgmentIdChunk) => {
        return tx.queryJson<TargetJudgmentAssessmentRow>(`
        SELECT
          id,
          judgment_id AS judgmentId,
          assessment_is_correct AS assessmentIsCorrect,
          assessment_comment AS assessmentComment
        FROM app.judgment_assessment
        WHERE judgment_id IN (${getQuotedStringList([...judgmentIdChunk]).join(', ')})
        ORDER BY judgment_id ASC, id ASC
      `)
      })
}

const assertJudgmentAssessmentTargetsCommitSafe = async ({
  allJudgmentIds,
  rows,
  tx,
}: {
  allJudgmentIds: readonly string[]
  rows: readonly JudgmentAssessmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  assertNoDuplicateRows(
    'judgment_assessment',
    rows.map((row) => {
      return row.judgmentId
    }),
  )

  const targets = await getTargetAssessmentRows({judgmentIds: allJudgmentIds, tx})
  const targetByJudgmentId = targets.reduce<Record<string, TargetJudgmentAssessmentRow>>((mapped, target) => {
    mapped[target.judgmentId] = target

    return mapped
  }, {})
  const packageJudgmentIds = new Set(
    rows.map((row) => {
      return row.judgmentId
    }),
  )
  const extraTarget = targets.find((target) => {
    return !packageJudgmentIds.has(target.judgmentId)
  })

  if (extraTarget) {
    return failCommitWriter(`target judgment ${extraTarget.judgmentId} has assessment state missing from package`)
  }

  return rows.map((row) => {
    const target = targetByJudgmentId[row.judgmentId] ?? null

    if (row.action === 'insert' && target !== null) {
      return failCommitWriter(`target judgment ${row.judgmentId} already has assessment state`)
    }

    if (row.action === 'reuse' && target === null) {
      return failCommitWriter(`reused assessment ${row.id} is missing for ${row.sourceJudgmentAssessmentId}`)
    }

    if (row.action === 'reuse' && target !== null && target.id !== row.id) {
      return failCommitWriter(`reused assessment ${row.id} no longer points at ${row.judgmentId}`)
    }

    return row.action === 'reuse'
      && target !== null
      && !valuesEquivalent(getAssessmentSignature(row), getTargetAssessmentSignature(target))
      ? failCommitWriter(`reused assessment ${row.id} is not equivalent to ${row.sourceJudgmentAssessmentId}`)
      : undefined
  })
}

const getSetBasedJudgmentAssessmentRowsSql = ({
  context,
  now,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
}) => {
  return `
    SELECT
      plan.action,
      assessment_map.target_id AS id,
      judgment_map.target_id AS judgment_id,
      plan.source_judgment_assessment_id,
      plan.source_judgment_id,
      plan.target_assessment_id,
      plan.target_judgment_id,
      ${getJsonBooleanPathSql('payload.payload_json', '$.assessmentIsCorrect', false)} AS assessment_is_correct,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'assessmentComment')} AS assessment_comment,
      ${getJsonTimestampFieldSql('payload.payload_json', 'createdAt', now)} AS created_at,
      ${getJsonTimestampFieldSql('payload.payload_json', 'updatedAt', now)} AS updated_at
    FROM ${context.tempTables.judgmentAssessmentPlan} plan
    INNER JOIN ${context.operationTables.tableNames.judgmentAssessments} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentAssessmentId')}
        = plan.source_judgment_assessment_id
    INNER JOIN ${context.commitIdMapTables.idMap} assessment_map
      ON assessment_map.map_kind = 'judgmentAssessment'
      AND assessment_map.source_id = plan.source_judgment_assessment_id
    INNER JOIN ${context.commitIdMapTables.idMap} judgment_map
      ON judgment_map.map_kind = 'judgment'
      AND judgment_map.source_id = plan.source_judgment_id
    WHERE plan.action IN ('insert', 'reuse')
  `
}

const getSetBasedJudgmentTargetIdsSql = ({
  context,
  now,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
}) => {
  return `SELECT id AS judgment_id FROM (${getSetBasedJudgmentRowsSql({context, now, projectId})}) rows`
}

const assertSetBasedJudgmentAssessmentPlanRowsCommitSafe = async ({
  context,
  now,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedJudgmentAssessmentRowsSql({context, now})
  const [invalidAction] = await tx.queryJson<{sourceJudgmentAssessmentId: string}>(`
    SELECT source_judgment_assessment_id AS sourceJudgmentAssessmentId
    FROM ${context.tempTables.judgmentAssessmentPlan}
    WHERE action NOT IN ('insert', 'reuse')
    ORDER BY source_judgment_assessment_id ASC
    LIMIT 1
  `)
  const [extraPlan] = await tx.queryJson<{sourceJudgmentAssessmentId: string}>(`
    SELECT plan.source_judgment_assessment_id AS sourceJudgmentAssessmentId
    FROM ${context.tempTables.judgmentAssessmentPlan} plan
    LEFT JOIN ${context.operationTables.tableNames.judgmentAssessments} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentAssessmentId')}
        = plan.source_judgment_assessment_id
    WHERE payload.row_index IS NULL
    ORDER BY plan.source_judgment_assessment_id ASC
    LIMIT 1
  `)
  const [missingPlan] = await tx.queryJson<{sourceJudgmentAssessmentId: string}>(`
    SELECT ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentAssessmentId')} AS sourceJudgmentAssessmentId
    FROM ${context.operationTables.tableNames.judgmentAssessments} payload
    LEFT JOIN ${context.tempTables.judgmentAssessmentPlan} plan
      ON plan.source_judgment_assessment_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceJudgmentAssessmentId')}
    WHERE plan.source_judgment_assessment_id IS NULL
    ORDER BY sourceJudgmentAssessmentId ASC
    LIMIT 1
  `)
  const expectedCount = await getTableCount({
    sql: `SELECT row_index FROM ${context.operationTables.tableNames.judgmentAssessments}`,
    tx,
  })
  const mappedCount = await getTableCount({sql: rowsSql, tx})
  const [targetMismatch] = await tx.queryJson<{sourceJudgmentAssessmentId: string}>(`
    SELECT rows.source_judgment_assessment_id AS sourceJudgmentAssessmentId
    FROM (${rowsSql}) rows
    WHERE NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.judgment_id', plannedSql: 'rows.target_judgment_id'})}
      OR NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.id', plannedSql: 'rows.target_assessment_id'})}
    ORDER BY rows.source_judgment_assessment_id ASC
    LIMIT 1
  `)

  if (invalidAction) {
    return failCommitWriter(`judgment assessment ${invalidAction.sourceJudgmentAssessmentId} is not commit-safe`)
  }

  if (extraPlan) {
    return failCommitWriter(
      `judgment assessment plan references missing payload ${extraPlan.sourceJudgmentAssessmentId}`,
    )
  }

  if (missingPlan) {
    return failCommitWriter(`missing judgment assessment plan for ${missingPlan.sourceJudgmentAssessmentId}`)
  }

  if (mappedCount !== expectedCount) {
    return failCommitWriter(`judgment assessment rows mapped ${mappedCount} of ${expectedCount} staged rows`)
  }

  return targetMismatch
    ? failCommitWriter(
        `judgment assessment ${targetMismatch.sourceJudgmentAssessmentId} plan target no longer matches final target`,
      )
    : expectedCount
}

const assertSetBasedJudgmentAssessmentTargetsCommitSafe = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedJudgmentAssessmentRowsSql({context, now})
  const judgmentIdsSql = getSetBasedJudgmentTargetIdsSql({context, now, projectId})
  const [duplicate] = await tx.queryJson<{judgmentId: string}>(`
    SELECT judgment_id AS judgmentId
    FROM (${rowsSql}) rows
    GROUP BY judgment_id
    HAVING COUNT(*) > 1
    ORDER BY judgment_id ASC
    LIMIT 1
  `)
  const [extraTarget] = await tx.queryJson<{judgmentId: string}>(`
    SELECT target.judgment_id AS judgmentId
    FROM (${judgmentIdsSql}) judgment_ids
    INNER JOIN app.judgment_assessment target
      ON target.judgment_id = judgment_ids.judgment_id
    LEFT JOIN (${rowsSql}) rows
      ON rows.judgment_id = target.judgment_id
    WHERE rows.judgment_id IS NULL
    ORDER BY target.judgment_id ASC
    LIMIT 1
  `)
  const [insertConflict] = await tx.queryJson<{judgmentId: string}>(`
    SELECT rows.judgment_id AS judgmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment_assessment target
      ON target.judgment_id = rows.judgment_id
    WHERE rows.action = 'insert'
    ORDER BY rows.judgment_id ASC
    LIMIT 1
  `)
  const [missingReuse] = await tx.queryJson<{id: string; sourceJudgmentAssessmentId: string}>(`
    SELECT rows.id, rows.source_judgment_assessment_id AS sourceJudgmentAssessmentId
    FROM (${rowsSql}) rows
    LEFT JOIN app.judgment_assessment target
      ON target.judgment_id = rows.judgment_id
    WHERE rows.action = 'reuse'
      AND target.id IS NULL
    ORDER BY rows.source_judgment_assessment_id ASC
    LIMIT 1
  `)
  const [wrongReuseTarget] = await tx.queryJson<{id: string; judgmentId: string}>(`
    SELECT rows.id, rows.judgment_id AS judgmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment_assessment target
      ON target.judgment_id = rows.judgment_id
    WHERE rows.action = 'reuse'
      AND target.id <> rows.id
    ORDER BY rows.judgment_id ASC
    LIMIT 1
  `)
  const [mismatchedReuse] = await tx.queryJson<{id: string; sourceJudgmentAssessmentId: string}>(`
    SELECT rows.id, rows.source_judgment_assessment_id AS sourceJudgmentAssessmentId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment_assessment target
      ON target.id = rows.id
    WHERE rows.action = 'reuse'
      AND (
        COALESCE(target.assessment_is_correct, FALSE) <> rows.assessment_is_correct
        OR target.assessment_comment IS DISTINCT FROM rows.assessment_comment
      )
    ORDER BY rows.source_judgment_assessment_id ASC
    LIMIT 1
  `)

  if (duplicate) {
    return failCommitWriter(`duplicate judgment_assessment after remap: ${duplicate.judgmentId}`)
  }

  if (extraTarget) {
    return failCommitWriter(`target judgment ${extraTarget.judgmentId} has assessment state missing from package`)
  }

  if (insertConflict) {
    return failCommitWriter(`target judgment ${insertConflict.judgmentId} already has assessment state`)
  }

  if (missingReuse) {
    return failCommitWriter(
      `reused assessment ${missingReuse.id} is missing for ${missingReuse.sourceJudgmentAssessmentId}`,
    )
  }

  if (wrongReuseTarget) {
    return failCommitWriter(
      `reused assessment ${wrongReuseTarget.id} no longer points at ${wrongReuseTarget.judgmentId}`,
    )
  }

  return mismatchedReuse
    ? failCommitWriter(
        `reused assessment ${mismatchedReuse.id} is not equivalent to ${mismatchedReuse.sourceJudgmentAssessmentId}`,
      )
    : undefined
}

const insertJudgmentAssessmentRowsSetBased = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const expectedCount = await assertSetBasedJudgmentAssessmentPlanRowsCommitSafe({context, now, tx})

  await assertSetBasedJudgmentAssessmentTargetsCommitSafe({context, now, projectId, tx})

  if (expectedCount === 0) {
    return undefined
  }

  const rowsSql = getSetBasedJudgmentAssessmentRowsSql({context, now})
  const expectedInsertCount = await getTableCount({sql: `SELECT id FROM (${rowsSql}) rows WHERE action = 'insert'`, tx})

  if (expectedInsertCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.judgment_assessment (
      id,
      judgment_id,
      assessment_is_correct,
      assessment_comment,
      created_at,
      updated_at
    )
    SELECT
      id,
      judgment_id,
      assessment_is_correct,
      assessment_comment,
      created_at,
      updated_at
    FROM (${rowsSql}) rows
    WHERE action = 'insert'
    RETURNING id
  `)

  return insertedRows.length === expectedInsertCount
    ? undefined
    : failCommitWriter(`judgment assessment insert wrote ${insertedRows.length} of ${expectedInsertCount} staged rows`)
}

const insertJudgmentAssessmentRows = async ({
  allJudgmentIds,
  context,
  now,
  projectId,
  rows,
  tx,
}: {
  allJudgmentIds: readonly string[]
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  projectId: string
  rows: readonly JudgmentAssessmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return allJudgmentIds.length === 0 && rows.length === 0
      ? undefined
      : insertJudgmentAssessmentRowsSetBased({context, now, projectId, tx})
  }

  await assertJudgmentAssessmentTargetsCommitSafe({allJudgmentIds, rows, tx})

  const insertRows = rows.filter((row) => {
    return row.action === 'insert'
  })

  return insertRows.length === 0
    ? undefined
    : runChunks(insertRows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment_assessment (
          id,
          judgment_id,
          assessment_is_correct,
          assessment_comment,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.judgmentId)},
              ${getSqlLiteral(row.assessmentIsCorrect)},
              ${getSqlLiteral(row.assessmentComment)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getHumanReviewPlanByKey = (humanReviewPlan: readonly HumanReviewPlanEntry[]) => {
  return humanReviewPlan.reduce<Record<string, HumanReviewPlanEntry>>((mapped, entry) => {
    mapped[`${entry.kind}\u0000${entry.sourceId}`] = entry

    return mapped
  }, {})
}

const assertHumanReviewPlanEntry = ({
  entry,
  kind,
  sourceId,
}: {
  entry: HumanReviewPlanEntry | undefined
  kind: HumanReviewPlanEntry['kind']
  sourceId: string
}) => {
  return entry === undefined
    ? failCommitWriter(`missing ${kind} plan for ${sourceId}`)
    : entry.action === 'insert'
      ? entry
      : failCommitWriter(`${kind} ${sourceId} is not commit-safe`)
}

const getHumanJudgmentRows = ({
  articleIdBySourceId,
  commitIdMaps,
  humanJudgments,
  humanReviewPlan,
  now,
  projectId,
  promptIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  commitIdMaps: ProjectTransferCommitIdMaps
  humanJudgments: readonly ProjectTransferPayloadRecord[]
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  now: Date
  projectId: string
  promptIdBySourceId: Record<string, string>
}) => {
  const planByKey = getHumanReviewPlanByKey(humanReviewPlan)

  return humanJudgments.map((judgment): HumanJudgmentCommitRow => {
    const sourceHumanJudgmentId = getRequiredString(
      getRecordField(judgment, 'sourceHumanJudgmentId'),
      'humanJudgment.sourceHumanJudgmentId',
    )
    const sourceArticleId = getRequiredString(
      getRecordField(judgment, 'sourceArticleId'),
      `humanJudgments.${sourceHumanJudgmentId}.sourceArticleId`,
    )
    const sourcePromptId = getRequiredString(
      getRecordField(judgment, 'sourcePromptId'),
      `humanJudgments.${sourceHumanJudgmentId}.sourcePromptId`,
    )
    const entry = assertHumanReviewPlanEntry({
      entry: planByKey[`humanJudgment\u0000${sourceHumanJudgmentId}`],
      kind: 'humanJudgment',
      sourceId: sourceHumanJudgmentId,
    })
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})
    const promptId = getMappedTargetId({label: 'prompt', mapped: promptIdBySourceId, sourceId: sourcePromptId})

    assertPlanTargetMatches({
      actual: articleId,
      label: `human judgment ${sourceHumanJudgmentId} article`,
      planned: entry.targetArticleId,
    })
    assertPlanTargetMatches({
      actual: promptId,
      label: `human judgment ${sourceHumanJudgmentId} prompt`,
      planned: entry.targetPromptId,
    })

    return {
      answer: getNullableString(getRecordField(judgment, 'answer')),
      articleId,
      comment: getNullableString(getRecordField(judgment, 'comment')),
      createdAt: getDateOrDefault(getRecordField(judgment, 'createdAt'), now),
      id: getMappedTargetId({
        label: 'human judgment',
        mapped: commitIdMaps.humanJudgmentIdBySourceId,
        sourceId: sourceHumanJudgmentId,
      }),
      isAnswered: getBoolean(getRecordField(judgment, 'isAnswered'), false),
      projectId,
      promptId,
      sourceHumanJudgmentId,
      updatedAt: getDateOrDefault(getRecordField(judgment, 'updatedAt'), now),
    }
  })
}

const getHumanJudgmentSummaryRows = ({
  articleIdBySourceId,
  commitIdMaps,
  humanReviewPlan,
  humanSummaries,
  now,
  projectId,
}: {
  articleIdBySourceId: Record<string, string>
  commitIdMaps: ProjectTransferCommitIdMaps
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  humanSummaries: readonly ProjectTransferPayloadRecord[]
  now: Date
  projectId: string
}) => {
  const planByKey = getHumanReviewPlanByKey(humanReviewPlan)

  return humanSummaries.map((summary): HumanJudgmentSummaryCommitRow => {
    const sourceHumanJudgmentSummaryId = getRequiredString(
      getRecordField(summary, 'sourceHumanJudgmentSummaryId'),
      'humanJudgmentSummary.sourceHumanJudgmentSummaryId',
    )
    const sourceArticleId = getRequiredString(
      getRecordField(summary, 'sourceArticleId'),
      `humanJudgmentSummaries.${sourceHumanJudgmentSummaryId}.sourceArticleId`,
    )
    const entry = assertHumanReviewPlanEntry({
      entry: planByKey[`humanJudgmentSummary\u0000${sourceHumanJudgmentSummaryId}`],
      kind: 'humanJudgmentSummary',
      sourceId: sourceHumanJudgmentSummaryId,
    })
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})

    assertPlanTargetMatches({
      actual: articleId,
      label: `human summary ${sourceHumanJudgmentSummaryId} article`,
      planned: entry.targetArticleId,
    })

    return {
      answer: getNullableString(getRecordField(summary, 'answer')),
      articleId,
      createdAt: getDateOrDefault(getRecordField(summary, 'createdAt'), now),
      id: getMappedTargetId({
        label: 'human judgment summary',
        mapped: commitIdMaps.humanJudgmentSummaryIdBySourceId,
        sourceId: sourceHumanJudgmentSummaryId,
      }),
      origin: getRequiredString(
        getRecordField(summary, 'origin'),
        `humanJudgmentSummaries.${sourceHumanJudgmentSummaryId}.origin`,
      ),
      projectId,
      sourceHumanJudgmentSummaryId,
      updatedAt: getDateOrDefault(getRecordField(summary, 'updatedAt'), now),
    }
  })
}

const reviewSectionNames = [
  'title',
  'abstract',
  'intro',
  'method',
  'results',
  'discussion',
  'conclusion',
  'appendix',
  'other',
] as const

const getReviewSections = (value: unknown) => {
  const sections = isRecord(value) ? value : {}

  return reviewSectionNames.reduce<Record<string, {comment: string | null; reviewed: boolean}>>((mapped, section) => {
    const sectionValue = getRecordField(sections, section)
    const sectionRecord = isRecord(sectionValue) ? sectionValue : {}

    mapped[section] = {
      comment: getNullableString(getRecordField(sectionRecord, 'comment')),
      reviewed: getBoolean(getRecordField(sectionRecord, 'reviewed'), false),
    }

    return mapped
  }, {})
}

const getReviewRows = ({
  articleIdBySourceId,
  commitIdMaps,
  humanReviewPlan,
  now,
  projectId,
  reviews,
}: {
  articleIdBySourceId: Record<string, string>
  commitIdMaps: ProjectTransferCommitIdMaps
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  now: Date
  projectId: string
  reviews: readonly ProjectTransferPayloadRecord[]
}) => {
  const planByKey = getHumanReviewPlanByKey(humanReviewPlan)

  return reviews.map((review): ReviewCommitRow => {
    const sourceReviewId = getRequiredString(getRecordField(review, 'sourceReviewId'), 'review.sourceReviewId')
    const sourceArticleId = getRequiredString(
      getRecordField(review, 'sourceArticleId'),
      `reviews.${sourceReviewId}.sourceArticleId`,
    )
    const entry = assertHumanReviewPlanEntry({
      entry: planByKey[`review\u0000${sourceReviewId}`],
      kind: 'review',
      sourceId: sourceReviewId,
    })
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})

    assertPlanTargetMatches({
      actual: articleId,
      label: `review ${sourceReviewId} article`,
      planned: entry.targetArticleId,
    })

    return {
      articleId,
      createdAt: getDateOrDefault(getRecordField(review, 'createdAt'), now),
      id: getMappedTargetId({label: 'review', mapped: commitIdMaps.reviewIdBySourceId, sourceId: sourceReviewId}),
      opened: getBoolean(getRecordField(review, 'opened'), false),
      projectId,
      sections: getReviewSections(getRecordField(review, 'sections')),
      sourceReviewId,
      updatedAt: getDateOrDefault(getRecordField(review, 'updatedAt'), now),
    }
  })
}

const assertNoHumanReviewPlanExtras = ({
  humanReviewPlan,
  humanJudgments,
  humanSummaries,
  reviews,
}: {
  humanJudgments: readonly ProjectTransferPayloadRecord[]
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  humanSummaries: readonly ProjectTransferPayloadRecord[]
  reviews: readonly ProjectTransferPayloadRecord[]
}) => {
  const payloadKeys = new Set([
    ...humanJudgments.map((record) => {
      return `humanJudgment\u0000${getRequiredString(getRecordField(record, 'sourceHumanJudgmentId'), 'humanJudgment.sourceHumanJudgmentId')}`
    }),
    ...humanSummaries.map((record) => {
      return `humanJudgmentSummary\u0000${getRequiredString(getRecordField(record, 'sourceHumanJudgmentSummaryId'), 'humanJudgmentSummary.sourceHumanJudgmentSummaryId')}`
    }),
    ...reviews.map((record) => {
      return `review\u0000${getRequiredString(getRecordField(record, 'sourceReviewId'), 'review.sourceReviewId')}`
    }),
  ])
  const extraEntry = humanReviewPlan.find((entry) => {
    return !payloadKeys.has(`${entry.kind}\u0000${entry.sourceId}`)
  })

  return extraEntry
    ? failCommitWriter(`${extraEntry.kind} plan references missing payload ${extraEntry.sourceId}`)
    : undefined
}

const assertNoDuplicateHumanJudgmentRows = (rows: readonly HumanJudgmentCommitRow[]) => {
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}\u0000${row.promptId}`
  })

  return assertNoDuplicateRows('judgment_human', keys)
}

const assertNoExistingHumanSummaries = async ({
  rows,
  tx,
}: {
  rows: readonly HumanJudgmentSummaryCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}`
  })

  assertNoDuplicateRows('judgment_human_summary', keys)

  const existing =
    rows.length === 0
      ? []
      : await queryChunks<HumanJudgmentSummaryCommitRow, {articleId: string; projectId: string}>(rows, (rowChunk) => {
          return tx.queryJson<{articleId: string; projectId: string}>(`
          SELECT project_id AS projectId, article_id AS articleId
          FROM app.judgment_human_summary
          WHERE ${rowChunk
            .map((row) => {
              return `(project_id = ${getSqlLiteral(row.projectId)} AND article_id = ${getSqlLiteral(row.articleId)})`
            })
            .join(' OR ')}
          ORDER BY project_id ASC, article_id ASC
        `)
        })
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(
        `target judgment_human_summary already has remapped key ${conflict.projectId}:${conflict.articleId}`,
      )
    : undefined
}

const assertNoExistingReviews = async ({
  rows,
  tx,
}: {
  rows: readonly ReviewCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}`
  })

  assertNoDuplicateRows('review', keys)

  const existing =
    rows.length === 0
      ? []
      : await queryChunks<ReviewCommitRow, {articleId: string; projectId: string}>(rows, (rowChunk) => {
          return tx.queryJson<{articleId: string; projectId: string}>(`
          SELECT project_id AS projectId, article_id AS articleId
          FROM app.review
          WHERE ${rowChunk
            .map((row) => {
              return `(project_id = ${getSqlLiteral(row.projectId)} AND article_id = ${getSqlLiteral(row.articleId)})`
            })
            .join(' OR ')}
          ORDER BY project_id ASC, article_id ASC
        `)
        })
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(`target review already has remapped key ${conflict.projectId}:${conflict.articleId}`)
    : undefined
}

const assertSetBasedHumanReviewPlanRowsCommitSafe = async ({
  context,
  kind,
  payloadTableName,
  rowsSql,
  sourceField,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  kind: HumanReviewPlanEntry['kind']
  payloadTableName: string
  rowsSql: string
  sourceField: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const [invalidAction] = await tx.queryJson<{sourceId: string}>(`
    SELECT source_id AS sourceId
    FROM ${context.tempTables.humanReviewPlan}
    WHERE kind = ${getSqlLiteral(kind)}
      AND action <> 'insert'
    ORDER BY source_id ASC
    LIMIT 1
  `)
  const [extraPlan] = await tx.queryJson<{sourceId: string}>(`
    SELECT plan.source_id AS sourceId
    FROM ${context.tempTables.humanReviewPlan} plan
    LEFT JOIN ${payloadTableName} payload
      ON ${getJsonStringFieldSql('payload.payload_json', sourceField)} = plan.source_id
    WHERE plan.kind = ${getSqlLiteral(kind)}
      AND payload.row_index IS NULL
    ORDER BY plan.source_id ASC
    LIMIT 1
  `)
  const [missingPlan] = await tx.queryJson<{sourceId: string}>(`
    SELECT ${getJsonStringFieldSql('payload.payload_json', sourceField)} AS sourceId
    FROM ${payloadTableName} payload
    LEFT JOIN ${context.tempTables.humanReviewPlan} plan
      ON plan.kind = ${getSqlLiteral(kind)}
      AND plan.source_id = ${getJsonStringFieldSql('payload.payload_json', sourceField)}
    WHERE plan.source_id IS NULL
    ORDER BY sourceId ASC
    LIMIT 1
  `)
  const expectedCount = await getTableCount({sql: `SELECT row_index FROM ${payloadTableName}`, tx})
  const mappedCount = await getTableCount({sql: rowsSql, tx})

  if (invalidAction) {
    return failCommitWriter(`${kind} ${invalidAction.sourceId} is not commit-safe`)
  }

  if (extraPlan) {
    return failCommitWriter(`${kind} plan references missing payload ${extraPlan.sourceId}`)
  }

  if (missingPlan) {
    return failCommitWriter(`missing ${kind} plan for ${missingPlan.sourceId}`)
  }

  return mappedCount === expectedCount
    ? expectedCount
    : failCommitWriter(`${kind} rows mapped ${mappedCount} of ${expectedCount} staged rows`)
}

const getSetBasedHumanJudgmentRowsSql = ({
  context,
  now,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
}) => {
  return `
    SELECT
      human_map.target_id AS id,
      plan.source_id AS source_id,
      ${getSqlLiteral(projectId)} AS project_id,
      article_map.target_id AS article_id,
      prompt_map.target_id AS prompt_id,
      plan.target_article_id,
      plan.target_prompt_id,
      ${getJsonBooleanPathSql('payload.payload_json', '$.isAnswered', false)} AS is_answered,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'answer')} AS answer,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'comment')} AS comment,
      ${getJsonTimestampFieldSql('payload.payload_json', 'createdAt', now)} AS created_at,
      ${getJsonTimestampFieldSql('payload.payload_json', 'updatedAt', now)} AS updated_at
    FROM ${context.tempTables.humanReviewPlan} plan
    INNER JOIN ${context.operationTables.tableNames.humanJudgments} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceHumanJudgmentId')} = plan.source_id
    INNER JOIN ${context.commitIdMapTables.idMap} human_map
      ON human_map.map_kind = 'humanJudgment'
      AND human_map.source_id = plan.source_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceArticleId')}
    INNER JOIN ${context.commitIdMapTables.idMap} prompt_map
      ON prompt_map.map_kind = 'prompt'
      AND prompt_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourcePromptId')}
    WHERE plan.kind = 'humanJudgment'
      AND plan.action = 'insert'
  `
}

const insertHumanJudgmentRowsSetBased = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedHumanJudgmentRowsSql({context, now, projectId})
  const expectedCount = await assertSetBasedHumanReviewPlanRowsCommitSafe({
    context,
    kind: 'humanJudgment',
    payloadTableName: context.operationTables.tableNames.humanJudgments,
    rowsSql,
    sourceField: 'sourceHumanJudgmentId',
    tx,
  })
  const [targetMismatch] = await tx.queryJson<{sourceId: string}>(`
    SELECT rows.source_id AS sourceId
    FROM (${rowsSql}) rows
    WHERE NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.article_id', plannedSql: 'rows.target_article_id'})}
      OR NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.prompt_id', plannedSql: 'rows.target_prompt_id'})}
    ORDER BY rows.source_id ASC
    LIMIT 1
  `)
  const [duplicate] = await tx.queryJson<{articleId: string; projectId: string; promptId: string}>(`
    SELECT project_id AS projectId, article_id AS articleId, prompt_id AS promptId
    FROM (${rowsSql}) rows
    GROUP BY project_id, article_id, prompt_id
    HAVING COUNT(*) > 1
    ORDER BY project_id ASC, article_id ASC, prompt_id ASC
    LIMIT 1
  `)

  if (targetMismatch) {
    return failCommitWriter(`humanJudgment ${targetMismatch.sourceId} plan target no longer matches final target`)
  }

  if (duplicate) {
    return failCommitWriter(
      `duplicate judgment_human after remap: ${duplicate.projectId}\u0000${duplicate.articleId}\u0000${duplicate.promptId}`,
    )
  }

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.judgment_human (
      id,
      project_id,
      article_id,
      prompt_id,
      is_answered,
      answer,
      "comment",
      created_at,
      updated_at
    )
    SELECT
      id,
      project_id,
      article_id,
      prompt_id,
      is_answered,
      answer,
      comment,
      created_at,
      updated_at
    FROM (${rowsSql}) rows
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`human judgment insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const getSetBasedHumanSummaryRowsSql = ({
  context,
  now,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
}) => {
  return `
    SELECT
      summary_map.target_id AS id,
      plan.source_id AS source_id,
      ${getSqlLiteral(projectId)} AS project_id,
      article_map.target_id AS article_id,
      plan.target_article_id,
      ${getNullableJsonStringFieldSql('payload.payload_json', 'answer')} AS answer,
      ${getJsonStringFieldSql('payload.payload_json', 'origin')} AS origin,
      ${getJsonTimestampFieldSql('payload.payload_json', 'createdAt', now)} AS created_at,
      ${getJsonTimestampFieldSql('payload.payload_json', 'updatedAt', now)} AS updated_at
    FROM ${context.tempTables.humanReviewPlan} plan
    INNER JOIN ${context.operationTables.tableNames.humanJudgmentSummaries} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceHumanJudgmentSummaryId')} = plan.source_id
    INNER JOIN ${context.commitIdMapTables.idMap} summary_map
      ON summary_map.map_kind = 'humanJudgmentSummary'
      AND summary_map.source_id = plan.source_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceArticleId')}
    WHERE plan.kind = 'humanJudgmentSummary'
      AND plan.action = 'insert'
  `
}

const insertHumanJudgmentSummaryRowsSetBased = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedHumanSummaryRowsSql({context, now, projectId})
  const expectedCount = await assertSetBasedHumanReviewPlanRowsCommitSafe({
    context,
    kind: 'humanJudgmentSummary',
    payloadTableName: context.operationTables.tableNames.humanJudgmentSummaries,
    rowsSql,
    sourceField: 'sourceHumanJudgmentSummaryId',
    tx,
  })
  const [targetMismatch] = await tx.queryJson<{sourceId: string}>(`
    SELECT rows.source_id AS sourceId
    FROM (${rowsSql}) rows
    WHERE NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.article_id', plannedSql: 'rows.target_article_id'})}
    ORDER BY rows.source_id ASC
    LIMIT 1
  `)
  const [duplicate] = await tx.queryJson<{articleId: string; projectId: string}>(`
    SELECT project_id AS projectId, article_id AS articleId
    FROM (${rowsSql}) rows
    GROUP BY project_id, article_id
    HAVING COUNT(*) > 1
    ORDER BY project_id ASC, article_id ASC
    LIMIT 1
  `)
  const [existing] = await tx.queryJson<{articleId: string; projectId: string}>(`
    SELECT rows.project_id AS projectId, rows.article_id AS articleId
    FROM (${rowsSql}) rows
    INNER JOIN app.judgment_human_summary existing
      ON existing.project_id = rows.project_id
      AND existing.article_id = rows.article_id
    ORDER BY rows.project_id ASC, rows.article_id ASC
    LIMIT 1
  `)

  if (targetMismatch) {
    return failCommitWriter(
      `humanJudgmentSummary ${targetMismatch.sourceId} plan target no longer matches final target`,
    )
  }

  if (duplicate) {
    return failCommitWriter(
      `duplicate judgment_human_summary after remap: ${duplicate.projectId}\u0000${duplicate.articleId}`,
    )
  }

  if (existing) {
    return failCommitWriter(
      `target judgment_human_summary already has remapped key ${existing.projectId}:${existing.articleId}`,
    )
  }

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.judgment_human_summary (
      id,
      project_id,
      article_id,
      answer,
      origin,
      created_at,
      updated_at
    )
    SELECT
      id,
      project_id,
      article_id,
      answer,
      origin,
      created_at,
      updated_at
    FROM (${rowsSql}) rows
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`human judgment summary insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const getReviewSectionReviewedSql = (section: (typeof reviewSectionNames)[number]) => {
  return getJsonBooleanPathSql('payload.payload_json', `$.sections.${section}.reviewed`, false)
}

const getReviewSectionCommentSql = (section: (typeof reviewSectionNames)[number]) => {
  return getNullableJsonStringPathSql('payload.payload_json', `$.sections.${section}.comment`)
}

const getSetBasedReviewRowsSql = ({
  context,
  now,
  projectId,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
}) => {
  return `
    SELECT
      review_map.target_id AS id,
      plan.source_id AS source_id,
      ${getSqlLiteral(projectId)} AS project_id,
      article_map.target_id AS article_id,
      plan.target_article_id,
      ${getJsonBooleanPathSql('payload.payload_json', '$.opened', false)} AS opened,
      ${getReviewSectionReviewedSql('title')} AS reviewed_title,
      ${getReviewSectionCommentSql('title')} AS reviewed_title_comment,
      ${getReviewSectionReviewedSql('abstract')} AS reviewed_abstract,
      ${getReviewSectionCommentSql('abstract')} AS reviewed_abstract_comment,
      ${getReviewSectionReviewedSql('intro')} AS reviewed_intro,
      ${getReviewSectionCommentSql('intro')} AS reviewed_intro_comment,
      ${getReviewSectionReviewedSql('method')} AS reviewed_method,
      ${getReviewSectionCommentSql('method')} AS reviewed_method_comment,
      ${getReviewSectionReviewedSql('results')} AS reviewed_results,
      ${getReviewSectionCommentSql('results')} AS reviewed_results_comment,
      ${getReviewSectionReviewedSql('discussion')} AS reviewed_discussion,
      ${getReviewSectionCommentSql('discussion')} AS reviewed_discussion_comment,
      ${getReviewSectionReviewedSql('conclusion')} AS reviewed_conclusion,
      ${getReviewSectionCommentSql('conclusion')} AS reviewed_conclusion_comment,
      ${getReviewSectionReviewedSql('appendix')} AS reviewed_appendix,
      ${getReviewSectionCommentSql('appendix')} AS reviewed_appendix_comment,
      ${getReviewSectionReviewedSql('other')} AS reviewed_other,
      ${getReviewSectionCommentSql('other')} AS reviewed_other_comment,
      ${getJsonTimestampFieldSql('payload.payload_json', 'createdAt', now)} AS created_at,
      ${getJsonTimestampFieldSql('payload.payload_json', 'updatedAt', now)} AS updated_at
    FROM ${context.tempTables.humanReviewPlan} plan
    INNER JOIN ${context.operationTables.tableNames.reviews} payload
      ON ${getJsonStringFieldSql('payload.payload_json', 'sourceReviewId')} = plan.source_id
    INNER JOIN ${context.commitIdMapTables.idMap} review_map
      ON review_map.map_kind = 'review'
      AND review_map.source_id = plan.source_id
    INNER JOIN ${context.commitIdMapTables.idMap} article_map
      ON article_map.map_kind = 'article'
      AND article_map.source_id = ${getJsonStringFieldSql('payload.payload_json', 'sourceArticleId')}
    WHERE plan.kind = 'review'
      AND plan.action = 'insert'
  `
}

const insertReviewRowsSetBased = async ({
  context,
  now,
  projectId,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext
  now: Date
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rowsSql = getSetBasedReviewRowsSql({context, now, projectId})
  const expectedCount = await assertSetBasedHumanReviewPlanRowsCommitSafe({
    context,
    kind: 'review',
    payloadTableName: context.operationTables.tableNames.reviews,
    rowsSql,
    sourceField: 'sourceReviewId',
    tx,
  })
  const [targetMismatch] = await tx.queryJson<{sourceId: string}>(`
    SELECT rows.source_id AS sourceId
    FROM (${rowsSql}) rows
    WHERE NOT ${getPlannedTargetMatchesSql({actualSql: 'rows.article_id', plannedSql: 'rows.target_article_id'})}
    ORDER BY rows.source_id ASC
    LIMIT 1
  `)
  const [duplicate] = await tx.queryJson<{articleId: string; projectId: string}>(`
    SELECT project_id AS projectId, article_id AS articleId
    FROM (${rowsSql}) rows
    GROUP BY project_id, article_id
    HAVING COUNT(*) > 1
    ORDER BY project_id ASC, article_id ASC
    LIMIT 1
  `)
  const [existing] = await tx.queryJson<{articleId: string; projectId: string}>(`
    SELECT rows.project_id AS projectId, rows.article_id AS articleId
    FROM (${rowsSql}) rows
    INNER JOIN app.review existing
      ON existing.project_id = rows.project_id
      AND existing.article_id = rows.article_id
    ORDER BY rows.project_id ASC, rows.article_id ASC
    LIMIT 1
  `)

  if (targetMismatch) {
    return failCommitWriter(`review ${targetMismatch.sourceId} plan target no longer matches final target`)
  }

  if (duplicate) {
    return failCommitWriter(`duplicate review after remap: ${duplicate.projectId}\u0000${duplicate.articleId}`)
  }

  if (existing) {
    return failCommitWriter(`target review already has remapped key ${existing.projectId}:${existing.articleId}`)
  }

  if (expectedCount === 0) {
    return undefined
  }

  const insertedRows = await tx.queryJson<{id: string}>(`
    INSERT INTO app.review (
      id,
      project_id,
      article_id,
      opened,
      reviewed_title,
      reviewed_title_comment,
      reviewed_abstract,
      reviewed_abstract_comment,
      reviewed_intro,
      reviewed_intro_comment,
      reviewed_method,
      reviewed_method_comment,
      reviewed_results,
      reviewed_results_comment,
      reviewed_discussion,
      reviewed_discussion_comment,
      reviewed_conclusion,
      reviewed_conclusion_comment,
      reviewed_appendix,
      reviewed_appendix_comment,
      reviewed_other,
      reviewed_other_comment,
      created_at,
      updated_at
    )
    SELECT
      id,
      project_id,
      article_id,
      opened,
      reviewed_title,
      reviewed_title_comment,
      reviewed_abstract,
      reviewed_abstract_comment,
      reviewed_intro,
      reviewed_intro_comment,
      reviewed_method,
      reviewed_method_comment,
      reviewed_results,
      reviewed_results_comment,
      reviewed_discussion,
      reviewed_discussion_comment,
      reviewed_conclusion,
      reviewed_conclusion_comment,
      reviewed_appendix,
      reviewed_appendix_comment,
      reviewed_other,
      reviewed_other_comment,
      created_at,
      updated_at
    FROM (${rowsSql}) rows
    RETURNING id
  `)

  return insertedRows.length === expectedCount
    ? undefined
    : failCommitWriter(`review insert wrote ${insertedRows.length} of ${expectedCount} staged rows`)
}

const insertHumanJudgmentRows = async ({
  context,
  now,
  projectId,
  rows,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  projectId: string
  rows: readonly HumanJudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return rows.length === 0 ? undefined : insertHumanJudgmentRowsSetBased({context, now, projectId, tx})
  }

  assertNoDuplicateHumanJudgmentRows(rows)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment_human (
          id,
          project_id,
          article_id,
          prompt_id,
          is_answered,
          answer,
          "comment",
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.promptId)},
              ${getSqlLiteral(row.isAnswered)},
              ${getSqlLiteral(row.answer)},
              ${getSqlLiteral(row.comment)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const insertHumanJudgmentSummaryRows = async ({
  context,
  now,
  projectId,
  rows,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  projectId: string
  rows: readonly HumanJudgmentSummaryCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return rows.length === 0 ? undefined : insertHumanJudgmentSummaryRowsSetBased({context, now, projectId, tx})
  }

  await assertNoExistingHumanSummaries({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment_human_summary (
          id,
          project_id,
          article_id,
          answer,
          origin,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.answer)},
              ${getSqlLiteral(row.origin)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getReviewSection = (row: ReviewCommitRow, section: (typeof reviewSectionNames)[number]) => {
  return row.sections[section] ?? {comment: null, reviewed: false}
}

const insertReviewRows = async ({
  context,
  now,
  projectId,
  rows,
  tx,
}: {
  context: ProjectTransferCommitWriterSetBasedContext | null
  now: Date
  projectId: string
  rows: readonly ReviewCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  if (context !== null) {
    return rows.length === 0 ? undefined : insertReviewRowsSetBased({context, now, projectId, tx})
  }

  await assertNoExistingReviews({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.review (
          id,
          project_id,
          article_id,
          opened,
          reviewed_title,
          reviewed_title_comment,
          reviewed_abstract,
          reviewed_abstract_comment,
          reviewed_intro,
          reviewed_intro_comment,
          reviewed_method,
          reviewed_method_comment,
          reviewed_results,
          reviewed_results_comment,
          reviewed_discussion,
          reviewed_discussion_comment,
          reviewed_conclusion,
          reviewed_conclusion_comment,
          reviewed_appendix,
          reviewed_appendix_comment,
          reviewed_other,
          reviewed_other_comment,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            const title = getReviewSection(row, 'title')
            const abstract = getReviewSection(row, 'abstract')
            const intro = getReviewSection(row, 'intro')
            const method = getReviewSection(row, 'method')
            const results = getReviewSection(row, 'results')
            const discussion = getReviewSection(row, 'discussion')
            const conclusion = getReviewSection(row, 'conclusion')
            const appendix = getReviewSection(row, 'appendix')
            const other = getReviewSection(row, 'other')

            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.opened)},
              ${getSqlLiteral(title.reviewed)},
              ${getSqlLiteral(title.comment)},
              ${getSqlLiteral(abstract.reviewed)},
              ${getSqlLiteral(abstract.comment)},
              ${getSqlLiteral(intro.reviewed)},
              ${getSqlLiteral(intro.comment)},
              ${getSqlLiteral(method.reviewed)},
              ${getSqlLiteral(method.comment)},
              ${getSqlLiteral(results.reviewed)},
              ${getSqlLiteral(results.comment)},
              ${getSqlLiteral(discussion.reviewed)},
              ${getSqlLiteral(discussion.comment)},
              ${getSqlLiteral(conclusion.reviewed)},
              ${getSqlLiteral(conclusion.comment)},
              ${getSqlLiteral(appendix.reviewed)},
              ${getSqlLiteral(appendix.comment)},
              ${getSqlLiteral(other.reviewed)},
              ${getSqlLiteral(other.comment)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const writeProjectTransferCommitAppTablesTx = async ({
  commitId,
  now,
  operationTables,
  payloads,
  plan,
  promotion,
  schemaVersion,
  sessionId,
  tx,
}: Omit<ProjectTransferCommitWriterInput, 'database'> & {tx: ProjectTransferCommitWriterTx}) => {
  const project = payloads.project ?? failCommitWriter('project payload is required')
  const prompts = payloads.prompts ?? []
  const projectPrompts = payloads.projectPrompts ?? []
  const articles = payloads.articles ?? []
  const projectArticles = payloads.projectArticles ?? []
  const articleImportRoutes = payloads.articleImportRoutes ?? []
  const judgments = payloads.judgments ?? []
  const judgmentAssessments = payloads.judgmentAssessments ?? []
  const humanJudgments = payloads.humanJudgments ?? []
  const humanJudgmentSummaries = payloads.humanJudgmentSummaries ?? []
  const reviews = payloads.reviews ?? []
  const importedAt = now ?? new Date()
  const planWithCommitIdMaps = getProjectTransferPlanWithCommitIdMaps({
    commitId,
    now: importedAt,
    payloads,
    plan,
    promotion,
  })
  const dependencyMaterialization = await getPlanWithMaterializedImportedDependencies({
    commitIdMaps: planWithCommitIdMaps.commitIdMaps,
    payloads,
    plan: planWithCommitIdMaps,
    tx,
  })
  const activeSourcePromptIds = getActiveSourcePromptIds(dependencyMaterialization.plan.targetPlan.projectPromptPlan)

  assertPromptPlanHashes({promptPlan: dependencyMaterialization.plan.targetPlan.promptPlan, prompts})

  const promptMaterialization = await getPromptMaterializationPlanBySourceId({
    activeSourcePromptIds,
    commitIdMaps: dependencyMaterialization.plan.commitIdMaps,
    prompts,
    tx,
  })
  const materializedPlan = {...dependencyMaterialization.plan, commitIdMaps: promptMaterialization.commitIdMaps}
  const commitIdMapTables = await loadProjectTransferCommitIdMapTables({
    maps: materializedPlan.commitIdMaps,
    operationId: commitId,
    runner: tx,
  })
  const commitWriterTempTables =
    operationTables === undefined ? null : getCommitWriterTempTables(operationTables.operationId)

  try {
    if (operationTables !== undefined && commitWriterTempTables !== null) {
      await loadProjectTransferCommitWriterTempTables({
        articles,
        operationTables,
        plan: materializedPlan,
        promotion,
        tables: commitWriterTempTables,
        tx,
      })
    }

    const setBasedContext =
      operationTables === undefined || commitWriterTempTables === null
        ? null
        : {commitIdMapTables, operationTables, tempTables: commitWriterTempTables}
    const judgmentPlan = getRequiredPlanEntries(
      materializedPlan.targetPlan.judgmentPlan,
      'judgment plan',
      judgments.length,
    )
    const judgmentAssessmentPlan = getRequiredPlanEntries(
      materializedPlan.targetPlan.judgmentAssessmentPlan,
      'judgment assessment plan',
      judgmentAssessments.length,
    )
    const humanReviewPlan = getRequiredPlanEntries(
      materializedPlan.targetPlan.humanReviewPlan,
      'human review plan',
      humanJudgments.length + humanJudgmentSummaries.length + reviews.length,
    )

    await assertProjectTransferCommitGeneratedIdsAvailable({maps: materializedPlan.commitIdMaps, runner: tx})
    await materializeImportedProviderConnectionSnapshots({
      generatedProviderConnectionIds: dependencyMaterialization.generatedProviderConnectionIds,
      importedProviderBySourceId: dependencyMaterialization.importedProviderBySourceId,
      materializedProviderTargetBySourceId: materializedPlan.commitIdMaps.providerConnectionIdBySourceId,
      providerTargetBySourceId: dependencyMaterialization.sourceDependencyResolution.providerTargetBySourceId,
      tx,
    })
    await materializeImportedModelSnapshots({
      generatedModelIds: dependencyMaterialization.generatedModelIds,
      importedModelBySourceId: dependencyMaterialization.importedModelBySourceId,
      importedProviderBySourceId: dependencyMaterialization.importedProviderBySourceId,
      materializedModelTargetBySourceId: materializedPlan.commitIdMaps.modelIdBySourceId,
      materializedProviderTargetBySourceId: materializedPlan.commitIdMaps.providerConnectionIdBySourceId,
      modelTargetBySourceId: dependencyMaterialization.sourceDependencyResolution.modelTargetBySourceId,
      tx,
    })
    await materializePromptRows({
      activeSourcePromptIds,
      createPromptRows: promptMaterialization.createPromptRows,
      tx,
      unarchivePromptIds: promptMaterialization.unarchivePromptIds,
    })
    const sourceProjectId = getRequiredString(project.sourceProjectId, 'project.sourceProjectId')
    const createdProject = await insertImportedProject({
      models: payloads.models ?? [],
      now: importedAt,
      plan: materializedPlan,
      project,
      projectId: getMappedTargetId({
        label: 'project',
        mapped: materializedPlan.commitIdMaps.projectIdBySourceId,
        sourceId: sourceProjectId,
      }),
      tx,
    })
    const promptIdBySourceId = promptMaterialization.promptIdBySourceId
    const projectPromptRows = getProjectPromptRows({
      projectId: createdProject.id,
      projectPromptPlan: materializedPlan.targetPlan.projectPromptPlan,
      projectPrompts,
      promptIdBySourceId,
    })
    const articleIdBySourceId = getResolvedArticleIdBySourceId({
      articleMatches: materializedPlan.targetPlan.articleMatches,
      commitIdMaps: materializedPlan.commitIdMaps,
      promotion,
    })

    await assertNoArticleIdConflicts({articles, matches: materializedPlan.targetPlan.articleMatches, tx})
    await insertProjectPromptRows(tx, projectPromptRows, materializedPlan.commitIdMaps)
    await insertCreatedArticles({articleIdBySourceId, context: setBasedContext, now: importedAt, promotion, tx})
    const targetArticleById = await getFillTargetArticleRows({promotion, tx})
    await updateReusedArticles({context: setBasedContext, now: importedAt, promotion, targetArticleById, tx})
    await markUpdatedReusedArticlesDirty({promotion, tx})
    await insertArticleIdentifiers({
      articleIdBySourceId,
      articleMatches: materializedPlan.targetPlan.articleMatches,
      articles,
      commitIdMaps: materializedPlan.commitIdMaps,
      context: setBasedContext,
      now: importedAt,
      tx,
    })
    await insertProjectImportRoutes({
      commitIdMaps: materializedPlan.commitIdMaps,
      context: setBasedContext,
      projectId: createdProject.id,
      projectRoutePlan: materializedPlan.targetPlan.projectRoutePlan,
      tx,
    })
    const routeIdBySourceId = getRouteIdBySourceId(materializedPlan.targetPlan.projectRoutePlan)
    const articleImportRouteRows = getArticleImportRouteRows({
      articleIdBySourceId,
      articleImportRoutes,
      articleRoutePlan: materializedPlan.targetPlan.articleRoutePlan,
      routeIdBySourceId,
    })
    await insertArticleImportRoutes({
      commitIdMaps: materializedPlan.commitIdMaps,
      context: setBasedContext,
      rows: articleImportRouteRows,
      tx,
    })
    await insertProjectArticles({
      articleIdBySourceId,
      articleRoutePlan: materializedPlan.targetPlan.articleRoutePlan,
      commitIdMaps: materializedPlan.commitIdMaps,
      context: setBasedContext,
      projectArticles,
      projectId: createdProject.id,
      tx,
    })
    await markImportedProjectDirty({projectId: createdProject.id, tx})
    const judgmentRows = getJudgmentRows({
      articleIdBySourceId,
      commitIdMaps: materializedPlan.commitIdMaps,
      judgmentPlan,
      judgments,
      now: importedAt,
      plan: materializedPlan,
      promptIdBySourceId,
    })
    await insertJudgmentRows({
      context: setBasedContext,
      now: importedAt,
      projectId: createdProject.id,
      rows: judgmentRows,
      tx,
    })
    const judgmentIdBySourceId = getJudgmentIdBySourceId(judgmentRows)
    const judgmentAssessmentRows = getJudgmentAssessmentRows({
      assessmentPlan: judgmentAssessmentPlan,
      assessments: judgmentAssessments,
      commitIdMaps: materializedPlan.commitIdMaps,
      judgmentIdBySourceId,
      now: importedAt,
    })
    await insertJudgmentAssessmentRows({
      allJudgmentIds: Object.values(judgmentIdBySourceId),
      context: setBasedContext,
      now: importedAt,
      projectId: createdProject.id,
      rows: judgmentAssessmentRows,
      tx,
    })
    assertNoHumanReviewPlanExtras({humanJudgments, humanReviewPlan, humanSummaries: humanJudgmentSummaries, reviews})
    const humanJudgmentRows = getHumanJudgmentRows({
      articleIdBySourceId,
      commitIdMaps: materializedPlan.commitIdMaps,
      humanJudgments,
      humanReviewPlan,
      now: importedAt,
      projectId: createdProject.id,
      promptIdBySourceId,
    })
    const humanSummaryRows = getHumanJudgmentSummaryRows({
      articleIdBySourceId,
      commitIdMaps: materializedPlan.commitIdMaps,
      humanReviewPlan,
      humanSummaries: humanJudgmentSummaries,
      now: importedAt,
      projectId: createdProject.id,
    })
    const reviewRows = getReviewRows({
      articleIdBySourceId,
      commitIdMaps: materializedPlan.commitIdMaps,
      humanReviewPlan,
      now: importedAt,
      projectId: createdProject.id,
      reviews,
    })
    await insertHumanJudgmentRows({
      context: setBasedContext,
      now: importedAt,
      projectId: createdProject.id,
      rows: humanJudgmentRows,
      tx,
    })
    await insertHumanJudgmentSummaryRows({
      context: setBasedContext,
      now: importedAt,
      projectId: createdProject.id,
      rows: humanSummaryRows,
      tx,
    })
    await insertReviewRows({
      context: setBasedContext,
      now: importedAt,
      projectId: createdProject.id,
      rows: reviewRows,
      tx,
    })
    const importWarnings = getCommitImportWarnings({
      articleRoutePlan: materializedPlan.targetPlan.articleRoutePlan,
      judgmentPlan,
      plan: materializedPlan,
      projectRoutePlan: materializedPlan.targetPlan.projectRoutePlan,
    })
    const payloadCounts = getPayloadCounts(materializedPlan)
    const transferHistoryId = materializedPlan.commitIdMaps.transferHistoryId
    const completion = getCompletionPayload({
      finalCounts: getFinalCounts({
        articleIdBySourceId,
        humanJudgmentRows,
        humanSummaryRows,
        importWarnings,
        judgmentAssessmentRows,
        judgmentIdBySourceId,
        promptIdBySourceId,
        reviewRows,
        routeIdBySourceId,
      }),
      importWarnings,
      packageFingerprint: getRequiredString(materializedPlan.packageFingerprint, 'plan.packageFingerprint'),
      payloadCounts,
      projectId: createdProject.id,
      projectName: createdProject.name,
      transferHistoryId,
    })
    const historyWrite = await measureProjectTransferPhase('historyWrite', () => {
      return getProjectTransferHistoryRepository().createProjectTransferHistory({
        commitId,
        completionPayload: completion,
        direction: 'import',
        id: transferHistoryId,
        packageFingerprint:
          completion.packageFingerprint ?? failCommitWriter('completion package fingerprint is required'),
        payloadCounts,
        runner: tx,
        schemaVersion,
        sessionId,
        sourceProjectId: project.sourceProjectId,
        sourceProjectName: project.name,
        targetProjectId: createdProject.id,
        targetProjectName: createdProject.name,
      })
    })
    const history = historyWrite.value
    await advanceCommitTargetStateDirtyTokens({now: importedAt, tx})
    const performanceMetrics = getProjectTransferPerformanceMetrics({
      benchmark: {packageFingerprint: completion.packageFingerprint ?? undefined, schemaVersion},
      operation: 'import',
      phases: {historyWrite: historyWrite.timing},
      warnings: importWarnings,
    })

    return {
      articleIdBySourceId,
      commitIdMaps: materializedPlan.commitIdMaps,
      completion,
      history,
      importWarnings,
      performanceMetrics,
      projectId: createdProject.id,
      projectName: createdProject.name,
      promptIdBySourceId,
      routeIdBySourceId,
    }
  } finally {
    if (commitWriterTempTables !== null) {
      await dropProjectTransferCommitWriterTempTables({tables: commitWriterTempTables, tx}).catch(() => {
        return undefined
      })
    }
    await dropProjectTransferCommitIdMapTables({runner: tx, tables: commitIdMapTables})
  }
}

export const writeProjectTransferCommitAppTables = async ({
  database: inputDatabase,
  ...input
}: ProjectTransferCommitWriterInput): Promise<ProjectTransferCommitAppWriteResult> => {
  const database = inputDatabase ?? getAppDatabaseService()

  const transaction = await measureProjectTransferPhase('appTableWrites', () => {
    return database.transaction((tx) => {
      return writeProjectTransferCommitAppTablesTx({...input, tx})
    }) as Promise<ProjectTransferCommitAppWriteResult>
  })
  const transactionMetrics = getProjectTransferPerformanceMetrics({
    benchmark: {writerTransactionMs: transaction.timing.durationMs},
    operation: 'import',
    phases: {appTableWrites: transaction.timing},
    warnings: transaction.value.importWarnings,
    writerTransactionMs: transaction.timing.durationMs,
  })
  const performanceMetrics = mergeProjectTransferPerformanceMetrics(
    transaction.value.performanceMetrics ?? getProjectTransferPerformanceMetrics({operation: 'import'}),
    transactionMetrics,
  )

  return {...transaction.value, performanceMetrics}
}
