import type {ArticleIdentifierInput, ArticleIdentifierInputKind} from '../../../utils/articleIdentifierNormalization.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from '../appQueryHelpers.ts'
import type {AppQueryDatabaseService} from '../appQueryServiceCore.ts'
import type {ProjectTransferArticleIdentifierSource} from './projectTransferIdentifierNormalization.ts'
import {getProjectTransferStrongIdentifierComparisonKeys} from './projectTransferIdentifierNormalization.ts'
import {
  assertProjectTransferPayload,
  normalizeProjectTransferModelVariant,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
  serializeProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import type {ProjectTransferManifestWarning, ProjectTransferPayloadKey} from './projectTransferSchemas.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'

type ProjectTransferExportQueryOptions = {database?: AppQueryDatabaseService}

export type ProjectTransferExportSourceProjectSettings = {
  archived: boolean
  createdAt: Date | null
  dateFrom: Date | null
  dateTo: Date | null
  description: string | null
  humanJudgmentMode: 'prompt' | 'summary' | null
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
}

type ProjectTransferExportContext = {
  ambiguousJudgmentWarnings: ProjectTransferManifestWarning[]
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
}

type ProjectTransferExportArticlePayloadRecord = ProjectTransferPayloadRecord
  & ProjectTransferArticleIdentifierSource & {
    articleTitle: string
    identifierInputs: ArticleIdentifierInput[]
    sourceArticleId: string
  }

export type ProjectTransferExportPayloadAssembly = {
  payloads: ProjectTransferPayloadByKey
  warnings: ProjectTransferManifestWarning[]
}

export type ProjectTransferExportSerializedPayloads = Record<ProjectTransferPayloadKey, string>

const providerSecretRedaction = {
  code: 'providerSecretRedacted' as const,
  field: 'secretRef',
  reason: 'Provider authentication secrets are machine-local and are never exported.',
}

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
      WHERE ${getProjectTransferExportJudgmentCandidateWhereSql()}
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
    humanJudgmentMode: row.humanJudgmentMode,
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

const getProjectTransferExportArticleRows = async (projectId: string, database: AppQueryDatabaseService) => {
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
          air.import_metadata,
          ir.route AS import_route,
          air.import_route_id,
          air.raw_payload,
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
      a.full_text AS fullText,
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
      a.original_data AS canonicalOriginalData,
      COALESCE(selected_import.raw_payload, a.original_data) AS originalData,
      a.source_metadata AS canonicalSourceMetadata,
      selected_import.import_metadata AS scopedImportMetadata,
      selected_import.raw_payload AS scopedRawPayload,
      selected_import.external_article_id AS selectedExternalArticleId,
      selected_import.id AS selectedImportRecordId,
      selected_import.import_route_id AS selectedImportRouteId,
      selected_import.import_route AS selectedImportRoute,
      selected_import.source_kind AS selectedSourceKind,
      selected_import.source_record_key AS selectedSourceRecordKey,
      selected_import.source_record_hash AS selectedSourceRecordHash,
      CASE
        WHEN a.source_metadata IS NULL
          AND selected_import.import_metadata IS NULL
          THEN NULL
        ELSE json_merge_patch(
          COALESCE(a.source_metadata, CAST('{}' AS JSON)),
          COALESCE(selected_import.import_metadata, CAST('{}' AS JSON))
        )
      END AS sourceMetadata,
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

const getProjectTransferExportArticleImportRouteRows = async (projectId: string, database: AppQueryDatabaseService) => {
  return database.queryJson<ProjectTransferExportArticleImportRouteRow>(`
    WITH
    ${getProjectTransferExportScopedArticleCteSql(projectId)}
    SELECT
      air.id AS sourceArticleImportRouteId,
      air.article_id AS articleId,
      air.import_route_id AS importRouteId,
      air.external_article_id AS externalArticleId,
      air.source_kind AS sourceKind,
      TO_JSON(air.import_metadata) AS importMetadata,
      TO_JSON(air.match_metadata) AS matchMetadata,
      air.import_run_id AS importRunId,
      air.source_record_key AS sourceRecordKey,
      air.source_record_hash AS sourceRecordHash,
      TO_JSON(air.raw_payload) AS rawPayload,
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
    WHERE ${getProjectTransferExportJudgmentCandidateWhereSql()}
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
      code: 'ambiguousJudgmentVisibleKey',
      details: {
        sourceArticleId: row.articleId,
        sourceJudgmentIds: getStringArrayValue(row.sourceJudgmentIds),
        sourceModelId: row.modelId,
        sourcePromptId: row.promptId,
        visibleRowCount: Number(row.visibleRowCount ?? 0),
      },
      message: 'Omitted active source judgments with an ambiguous review-visible natural key.',
      path: projectTransferPayloadPathByKey.judgments,
      payloadKey: 'judgments',
      severity: 'warning',
    }
  })
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
    WHERE ${getProjectTransferExportJudgmentCandidateWhereSql()}
      AND j.is_answered = TRUE
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
      WHERE ${getProjectTransferExportJudgmentCandidateWhereSql()}
        AND j.is_answered = TRUE
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

  return {
    displayName: getProjectTransferExportModelDisplayName(row),
    modelName: getProjectTransferExportModelName(row),
    name: row.name,
    providerConnectionSignature: getProjectTransferExportProviderConnectionSignature(providerConnectionRow),
    remoteModelId: row.remoteModelId,
    variant,
    version: variant,
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
  return {humanJudgmentMode: project.humanJudgmentMode, ...getProjectTransferExportContentSettings(project)}
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

  return {...record, signature: getProjectTransferExportArticleSignature(record)}
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

const getProjectTransferExportCollectionPayload = <TRecord extends ProjectTransferPayloadRecord>(params: {
  records: TRecord[]
  signatures: unknown[]
  sourceProjectId: string
}) => {
  return {
    provenance: {sourceProjectId: params.sourceProjectId},
    records: params.records,
    signature: {records: params.signatures},
  }
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

  return assertProjectTransferPayload(
    'prompts',
    getProjectTransferExportCollectionPayload({
      records,
      signatures: records.map((record) => {
        return record.signature
      }),
      sourceProjectId: context.project.sourceProjectId,
    }),
  )
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

  return assertProjectTransferPayload(
    'projectPrompts',
    getProjectTransferExportCollectionPayload({
      records,
      signatures: records.map((record) => {
        return record.signature
      }),
      sourceProjectId: context.project.sourceProjectId,
    }),
  )
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

  return assertProjectTransferPayload(
    'importRoutes',
    getProjectTransferExportCollectionPayload({
      records,
      signatures: records.map((record) => {
        return record.signature
      }),
      sourceProjectId: context.project.sourceProjectId,
    }),
  )
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

  return assertProjectTransferPayload(
    'projectImportRoutes',
    getProjectTransferExportCollectionPayload({
      records,
      signatures: records.map((record) => {
        return record.signature
      }),
      sourceProjectId: context.project.sourceProjectId,
    }),
  )
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
  const promptSignatureById = getProjectTransferExportPromptSignatureById(context.projectPromptRows)
  const modelSignatureById = getProjectTransferExportModelSignatureById(
    context.modelRows,
    context.providerConnectionRows,
  )

  return assertProjectTransferPayload(
    'judgments',
    context.judgmentRows.map((row) => {
      const contentSettings = getProjectTransferExportContentSettings(row)

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
  const promptSignatureById = getProjectTransferExportPromptSignatureById(context.projectPromptRows)
  const projectHumanMode = context.project.humanJudgmentMode ?? 'prompt'

  return assertProjectTransferPayload(
    'humanJudgments',
    context.humanJudgmentRows.map((row) => {
      return {
        answer: row.answer,
        comment: row.comment,
        createdAt: getIsoDateValue(row.createdAt),
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
  const projectHumanMode = context.project.humanJudgmentMode ?? 'prompt'

  return assertProjectTransferPayload(
    'humanJudgmentSummaries',
    context.humanJudgmentSummaryRows.map((row) => {
      return {
        answer: row.answer,
        createdAt: getIsoDateValue(row.createdAt),
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

  return assertProjectTransferPayload(
    'reviews',
    context.reviewRows.map((row) => {
      const sections = getProjectTransferExportReviewSections(row)

      return {
        createdAt: getIsoDateValue(row.createdAt),
        opened: row.opened ?? false,
        provenance: {sourceArticleId: row.articleId, sourceProjectId: row.sourceProjectId},
        sections,
        signature: {
          articleSignature: articleSignatureById[row.articleId],
          sections: getProjectTransferExportReviewSectionSignature(sections),
        },
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
      redactions: [providerSecretRedaction],
      secretRef: null,
      signature,
      sourceProviderConnectionId: row.providerConnectionId,
      updatedAt: getIsoDateValue(row.updatedAt),
      warnings: row.secretRef
        ? [{code: 'providerSecretRedacted' as const, field: 'secretRef', message: 'Provider secret was redacted.'}]
        : [{code: 'providerSecretRedacted' as const, field: 'secretRef', message: 'Provider secret was redacted.'}],
    }
  })

  return assertProjectTransferPayload(
    'providerConnections',
    getProjectTransferExportCollectionPayload({
      records,
      signatures: records.map((record) => {
        return record.signature
      }),
      sourceProjectId: context.project.sourceProjectId,
    }),
  )
}

const getProjectTransferExportModelsPayloadFromContext = (context: ProjectTransferExportContext) => {
  const providerConnectionById = getRowsById(context.providerConnectionRows, 'providerConnectionId')
  const records = context.modelRows.map((row) => {
    const providerConnectionRow = providerConnectionById[row.providerConnectionId]
    const variant = normalizeProjectTransferModelVariant(row.variant)
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
      version: variant,
    }
  })

  return assertProjectTransferPayload(
    'models',
    getProjectTransferExportCollectionPayload({
      records,
      signatures: records.map((record) => {
        return record.signature
      }),
      sourceProjectId: context.project.sourceProjectId,
    }),
  )
}

const getProjectTransferExportAssetManifestPayloadFromContext = (context: ProjectTransferExportContext) => {
  return assertProjectTransferPayload('assetManifest', {
    assets: [],
    provenance: {sourceProjectId: context.project.sourceProjectId},
    signature: {assets: []},
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
  const [
    projectPromptRows,
    importRouteRows,
    projectImportRouteRows,
    articleRows,
    articleImportRouteRows,
    projectArticleRows,
    ambiguousJudgmentWarnings,
    judgmentRows,
    judgmentAssessmentRows,
    humanJudgmentRows,
    humanJudgmentSummaryRows,
    reviewRows,
  ] = await Promise.all([
    getProjectTransferExportProjectPromptRows(projectId, database),
    getProjectTransferExportImportRouteRows(projectId, database),
    getProjectTransferExportProjectImportRouteRows(projectId, database),
    getProjectTransferExportArticleRows(projectId, database),
    getProjectTransferExportArticleImportRouteRows(projectId, database),
    getProjectTransferExportProjectArticleRows(projectId, database),
    getProjectTransferExportAmbiguousJudgmentWarnings(projectId, database),
    getProjectTransferExportJudgmentRows(projectId, database),
    getProjectTransferExportJudgmentAssessmentRows(projectId, database),
    getProjectTransferExportHumanJudgmentRows(projectId, database),
    getProjectTransferExportHumanJudgmentSummaryRows(projectId, database),
    getProjectTransferExportReviewRows(projectId, database),
  ])
  const requiredModelIds = getUniqueValues([
    project.modelId,
    ...judgmentRows.map((row) => {
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
    ambiguousJudgmentWarnings,
    articleImportRouteRows,
    articleRows,
    humanJudgmentRows,
    humanJudgmentSummaryRows,
    importRouteRows,
    judgmentAssessmentRows,
    judgmentRows,
    modelRows,
    project,
    projectArticleRows,
    projectImportRouteRows,
    projectPromptRows,
    providerConnectionRows,
    reviewRows,
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

export const getProjectTransferExportPayloads = async (
  projectId: string,
  options: ProjectTransferExportQueryOptions = {},
): Promise<ProjectTransferExportPayloadAssembly> => {
  const context = await getProjectTransferExportContext(projectId, options)
  const payloads = {
    articleImportRoutes: getProjectTransferExportArticleImportRoutesPayloadFromContext(context),
    articles: assertProjectTransferPayload('articles', context.articleRows),
    assetManifest: getProjectTransferExportAssetManifestPayloadFromContext(context),
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

  return {payloads, warnings: context.ambiguousJudgmentWarnings}
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
