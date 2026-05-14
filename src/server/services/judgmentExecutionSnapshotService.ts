import {createHash, randomUUID} from 'node:crypto'

import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'
import type {AppReadOnlyDatabaseService} from './appReadOnlyDatabaseService.ts'
import {getScopedArticleCompatibilityValues} from './scopedArticleReadAdapter.ts'

type JudgmentExecutionSnapshotRow = {
  articleCreatedAt: unknown
  articleId: string | null
  articleImportRoute: string | null
  articleImportId: string | null
  articleSummary: string | null
  articleTitle: string | null
  articleUpdatedAt: unknown
  articleVersion: number | null
  claimId: string
  contentHash: string | null
  dateFrom: unknown
  dateTo: unknown
  doi: string | null
  externalArticleId: string | null
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
  jobId: string
  modelDisplayName: string | null
  modelId: string
  modelMetadataJson: unknown
  modelName: string | null
  modelRemoteModelId: string | null
  modelSecretRef: string | null
  modelSource: string | null
  modelUpdatedAt: unknown
  modelVariant: string | null
  originalData: unknown
  projectId: string
  projectName: string
  promptArchived: boolean | null
  promptContentHash: string | null
  promptHeading: string | null
  promptId: string | null
  promptOrder: number | null
  promptOriginalText: string | null
  promptTransformedText: string | null
  promptType: string | null
  promptUpdatedAt: unknown
  providerAuthMode: string | null
  providerBaseUrl: string | null
  providerConfigJson: unknown
  providerConnectionId: string | null
  providerEnabled: boolean | null
  providerKind: string | null
  providerLabel: string | null
  providerMaxInflightRequests: number | null
  providerSecretRef: string | null
  publicationStatus: string | null
  queueRecordId: string
  requestedArticleId: string
  requestedPromptId: string
  scopedImportMetadata: unknown
  scopedRawPayload: unknown
  selectedExternalArticleId: string | null
  selectedImportRecordId: string | null
  selectedImportRoute: string | null
  selectedImportRouteId: string | null
  selectedSourceKind: string | null
  selectedSourceRecordKey: string | null
  sourceMetadata: unknown
  url: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type StoredSnapshotRow = {
  articleId: string
  claimId: string
  createdAt: unknown
  createdBy: string | null
  executionSnapshotHash: string
  executionSnapshotId: string
  jobId: string
  modelId: string
  payloadJson: unknown
  projectId: string
  promptId: string
  queueRecordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type StoredSnapshotIdentityRow = Omit<StoredSnapshotRow, 'payloadJson'>

type SnapshotIdentityInput = {
  articleId: string
  claimId: string
  executionSnapshotHash: string
  executionSnapshotId: string
  jobId: string
  modelId: string
  projectId: string
  promptId: string
  queueRecordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type SnapshotQueryService = Pick<ReturnType<typeof getAppDatabaseService> | AppReadOnlyDatabaseService, 'queryJson'>

export type JudgmentExecutionSnapshotRecord = {
  articleId: string
  claimId: string
  createdAt: Date | null
  createdBy: string | null
  executionSnapshotHash: string
  executionSnapshotId: string
  jobId: string
  modelId: string
  payload: unknown
  projectId: string
  promptId: string
  queueRecordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type JudgmentExecutionSnapshotClaim = {
  executionSnapshotHash: string
  executionSnapshotId: string
  executionSnapshotPayload?: unknown
  modelId: string
  projectId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type JudgmentExecutionSnapshotClaimInput = {
  articleId: string
  claimId: string
  claimedBy: string
  jobId: string
  promptId: string
  queueRecordId: string
  useFulltext?: boolean
  useFulltextNoImages?: boolean
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStableJsonValue = (value: unknown): string => {
  return Array.isArray(value)
    ? `[${value
        .map((entry) => {
          return getStableJsonValue(entry)
        })
        .join(',')}]`
    : isObjectRecord(value)
      ? `{${Object.keys(value)
          .sort((left, right) => {
            return left.localeCompare(right)
          })
          .map((key) => {
            return `${JSON.stringify(key)}:${getStableJsonValue(value[key])}`
          })
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null')
}

export const getJudgmentExecutionSnapshotHash = (payload: unknown): string => {
  return createHash('sha256').update(getStableJsonValue(payload)).digest('hex')
}

const getDateIsoValue = (value: unknown): string | null => {
  return getDateValue(value)?.toISOString() ?? null
}

const getSnapshotRequestValuesSql = (requests: JudgmentExecutionSnapshotClaimInput[]): string => {
  return requests
    .map((request, index) => {
      return `(${index}, ${getSqlLiteral(request.articleId)}, ${getSqlLiteral(request.claimId)}, ${getSqlLiteral(request.jobId)}, ${getSqlLiteral(request.promptId)}, ${getSqlLiteral(request.queueRecordId)})`
    })
    .join(', ')
}

const getSnapshotTextColumnSelect = ({
  includeFulltext,
  selectSql,
}: {
  includeFulltext: boolean
  selectSql: string
}): string => {
  return includeFulltext ? selectSql : 'NULL'
}

const getSnapshotRows = async (
  requests: JudgmentExecutionSnapshotClaimInput[],
  {includeFulltext}: {includeFulltext: boolean},
  database: SnapshotQueryService = getAppDatabaseService(),
): Promise<JudgmentExecutionSnapshotRow[]> => {
  if (requests.length === 0) {
    return []
  }

  return database.queryJson<JudgmentExecutionSnapshotRow>(`
    WITH snapshot_request(request_order, article_id, claim_id, job_id, prompt_id, queue_record_id) AS (
      VALUES ${getSnapshotRequestValuesSql(requests)}
    ),
    snapshot_request_project AS (
      SELECT
        snapshot_request.*,
        judgment_job.project_id AS snapshot_project_id
      FROM snapshot_request
      INNER JOIN app.judgment_job judgment_job ON judgment_job.id = snapshot_request.job_id
    ),
    ranked_snapshot_article_resolution AS (
      SELECT
        request_order,
        article_id,
        canonical_article_id,
        ROW_NUMBER() OVER (
          PARTITION BY request_order
          ORDER BY resolution_rank ASC, canonical_article_id ASC
        ) AS resolution_order
      FROM (
        SELECT
          snapshot_request_project.request_order,
          snapshot_request_project.article_id,
          article.id AS canonical_article_id,
          0 AS resolution_rank
        FROM snapshot_request_project
        INNER JOIN app.article article ON article.id = snapshot_request_project.article_id

        UNION ALL

        SELECT
          snapshot_request_project.request_order,
          snapshot_request_project.article_id,
          legacy.article_id AS canonical_article_id,
          1 AS resolution_rank
        FROM snapshot_request_project
        INNER JOIN app.article_legacy_id_lookup legacy
          ON legacy.legacy_article_id = snapshot_request_project.article_id

        UNION ALL

        SELECT
          snapshot_request_project.request_order,
          snapshot_request_project.article_id,
          current_import.article_id AS canonical_article_id,
          2 AS resolution_rank
        FROM snapshot_request_project
        INNER JOIN app.project_import_route project_import_route
          ON project_import_route.project_id = snapshot_request_project.snapshot_project_id
        INNER JOIN app.article_import_route current_import
          ON current_import.import_route_id = project_import_route.import_route_id
         AND current_import.external_article_id = snapshot_request_project.article_id

        UNION ALL

        SELECT
          snapshot_request_project.request_order,
          snapshot_request_project.article_id,
          source_record.article_id AS canonical_article_id,
          3 AS resolution_rank
        FROM snapshot_request_project
        INNER JOIN app.project_import_route project_import_route
          ON project_import_route.project_id = snapshot_request_project.snapshot_project_id
        INNER JOIN app.article_import_route_source_record source_record
          ON source_record.import_route_id = project_import_route.import_route_id
         AND source_record.external_article_id = snapshot_request_project.article_id
      ) snapshot_article_resolution_candidates
    ),
    snapshot_article_resolution AS (
      SELECT request_order, canonical_article_id
      FROM ranked_snapshot_article_resolution
      WHERE resolution_order = 1
    ),
    selected_scoped_article_import AS (
      SELECT
        request_order,
        article_id,
        external_article_id,
        id,
        import_metadata,
        import_route,
        import_route_id,
        raw_payload,
        source_kind,
        source_record_key
      FROM (
        SELECT
          snapshot_request_project.request_order,
          current_import.article_id,
          current_import.external_article_id,
          current_import.id,
          current_import.import_metadata,
          import_route.route AS import_route,
          current_import.import_route_id,
          current_import.raw_payload,
          current_import.source_kind,
          current_import.source_record_key,
          ROW_NUMBER() OVER (
            PARTITION BY snapshot_request_project.request_order
            ORDER BY project_import_route.project_id ASC, current_import.import_route_id ASC, current_import.id ASC
          ) AS selected_rank
        FROM snapshot_request_project
        INNER JOIN snapshot_article_resolution
          ON snapshot_article_resolution.request_order = snapshot_request_project.request_order
        INNER JOIN app.project_import_route project_import_route
          ON project_import_route.project_id = snapshot_request_project.snapshot_project_id
        INNER JOIN app.article_import_route current_import
          ON current_import.import_route_id = project_import_route.import_route_id
         AND current_import.article_id = snapshot_article_resolution.canonical_article_id
        LEFT JOIN app.import_route import_route ON import_route.id = current_import.import_route_id
      ) ranked_scoped_article_import
      WHERE selected_rank = 1
    )
    SELECT
      jj.id AS jobId,
      jj.project_id AS projectId,
      snapshot_request.queue_record_id AS queueRecordId,
      snapshot_request.claim_id AS claimId,
      snapshot_request.article_id AS requestedArticleId,
      snapshot_request.prompt_id AS requestedPromptId,
      p.name AS projectName,
      p.model_id AS modelId,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages,
      p.date_from AS dateFrom,
      p.date_to AS dateTo,
      pr.id AS promptId,
      pr.original_text AS promptOriginalText,
      pr.transformed_text AS promptTransformedText,
      pr.prompt_heading AS promptHeading,
      pr.type AS promptType,
      pr.content_hash AS promptContentHash,
      pr.archived AS promptArchived,
      pr.updated_at AS promptUpdatedAt,
      pp.prompt_order AS promptOrder,
      a.id AS articleId,
      a.article_id AS externalArticleId,
      a.article_title AS articleTitle,
      a.article_summary AS articleSummary,
      a.import_route AS articleImportRoute,
      a.article_version AS articleVersion,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt,
      a.doi AS doi,
      a.url AS url,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text'})} AS fullText,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_html'})} AS fullTextHtml,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_pdf'})} AS fullTextPdf,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_source'})} AS fullTextSource,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_original_format'})} AS fullTextOriginalFormat,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_fetched_at'})} AS fullTextFetchedAt,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'TO_JSON(a.full_text_assets)'})} AS fullTextAssets,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_conversion_status'})} AS fullTextConversionStatus,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_conversion_error'})} AS fullTextConversionError,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_conversion_attempts'})} AS fullTextConversionAttempts,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_conversion_model_id'})} AS fullTextConversionModelId,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'TO_JSON(a.full_text_conversion_metadata)'})} AS fullTextConversionMetadata,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'a.full_text_char_count'})} AS fullTextCharCount,
      a.content_hash AS contentHash,
      ${getSnapshotTextColumnSelect({includeFulltext, selectSql: 'TO_JSON(a.original_data)'})} AS originalData,
      a.publication_status AS publicationStatus,
      TO_JSON(a.source_metadata) AS sourceMetadata,
      TO_JSON(scoped_import.import_metadata) AS scopedImportMetadata,
      TO_JSON(scoped_import.raw_payload) AS scopedRawPayload,
      scoped_import.external_article_id AS selectedExternalArticleId,
      scoped_import.id AS selectedImportRecordId,
      scoped_import.import_route AS selectedImportRoute,
      scoped_import.import_route_id AS selectedImportRouteId,
      scoped_import.source_kind AS selectedSourceKind,
      scoped_import.source_record_key AS selectedSourceRecordKey,
      m.name AS modelName,
      m.remote_model_id AS modelRemoteModelId,
      m.display_name AS modelDisplayName,
      m.variant AS modelVariant,
      m.source AS modelSource,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      m.updated_at AS modelUpdatedAt,
      pc.id AS providerConnectionId,
      pc.provider_kind AS providerKind,
      pc.label AS providerLabel,
      pc.enabled AS providerEnabled,
      pc.auth_mode AS providerAuthMode,
      pc.base_url AS providerBaseUrl,
      pc.max_inflight_requests AS providerMaxInflightRequests,
      TO_JSON(pc.config_json) AS providerConfigJson,
      pc.secret_ref AS providerSecretRef,
      pc.secret_ref AS modelSecretRef
    FROM snapshot_request_project snapshot_request
    INNER JOIN app.judgment_job jj ON jj.id = snapshot_request.job_id
    INNER JOIN app.project p ON p.id = jj.project_id
    INNER JOIN app.model m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    LEFT JOIN app.prompt pr ON pr.id = snapshot_request.prompt_id
    LEFT JOIN app.project_prompt pp ON pp.project_id = p.id AND pp.prompt_id = pr.id
    LEFT JOIN snapshot_article_resolution article_resolution
      ON article_resolution.request_order = snapshot_request.request_order
    LEFT JOIN app.article a ON a.id = article_resolution.canonical_article_id
    LEFT JOIN selected_scoped_article_import scoped_import
      ON scoped_import.request_order = snapshot_request.request_order
    ORDER BY snapshot_request.request_order ASC
  `)
}

const getSnapshotPayload = (row: JudgmentExecutionSnapshotRow) => {
  const articleId = row.articleId ?? row.requestedArticleId
  const promptId = row.promptId ?? row.requestedPromptId
  const canonicalOriginalData = getJsonValue(row.originalData)
  const canonicalSourceMetadata = getJsonValue(row.sourceMetadata)
  const scopedImportMetadata = getJsonValue(row.scopedImportMetadata)
  const scopedRawPayload = getJsonValue(row.scopedRawPayload)
  const compatibilityValues = getScopedArticleCompatibilityValues({
    canonicalArticleId: row.externalArticleId,
    canonicalImportRoute: row.articleImportRoute,
    canonicalOriginalData,
    canonicalSourceMetadata,
    scopedImportMetadata,
    scopedRawPayload,
    selectedExternalArticleId: row.selectedExternalArticleId,
    selectedImportRoute: row.selectedImportRoute,
  })

  return {
    article: {
      articleCreatedAt: getDateIsoValue(row.articleCreatedAt),
      articleId: compatibilityValues.articleId,
      articleSummary: row.articleSummary,
      articleTitle: row.articleTitle,
      articleUpdatedAt: getDateIsoValue(row.articleUpdatedAt),
      articleVersion: row.articleVersion,
      canonicalArticleId: row.externalArticleId,
      canonicalImportRoute: row.articleImportRoute,
      canonicalOriginalData,
      canonicalSourceMetadata,
      contentHash: row.contentHash,
      doi: row.doi,
      externalArticleId: compatibilityValues.articleId,
      fullText: row.fullText,
      fullTextAssets: getJsonValue(row.fullTextAssets),
      fullTextCharCount: row.fullTextCharCount,
      fullTextConversionAttempts: row.fullTextConversionAttempts,
      fullTextConversionError: row.fullTextConversionError,
      fullTextConversionMetadata: getJsonValue(row.fullTextConversionMetadata),
      fullTextConversionModelId: row.fullTextConversionModelId,
      fullTextConversionStatus: row.fullTextConversionStatus,
      fullTextFetchedAt: getDateIsoValue(row.fullTextFetchedAt),
      fullTextHtml: row.fullTextHtml,
      importRoute: compatibilityValues.importRoute,
      fullTextOriginalFormat: row.fullTextOriginalFormat,
      fullTextPdf: row.fullTextPdf,
      fullTextSource: row.fullTextSource,
      id: articleId,
      originalData: compatibilityValues.originalData,
      publicationStatus: row.publicationStatus,
      scopedImportMetadata,
      scopedRawPayload,
      selectedExternalArticleId: row.selectedExternalArticleId,
      selectedImportRecordId: row.selectedImportRecordId,
      selectedImportRoute: row.selectedImportRoute,
      selectedImportRouteId: row.selectedImportRouteId,
      selectedSourceKind: row.selectedSourceKind,
      selectedSourceRecordKey: row.selectedSourceRecordKey,
      sourceMetadata: compatibilityValues.sourceMetadata,
      url: row.url,
    },
    contentSettings: {
      useAbstract: row.useAbstract,
      useFulltext: row.useFulltext,
      useFulltextNoImages: row.useFulltextNoImages,
      useTitle: row.useTitle,
    },
    identity: {
      articleId,
      claimId: row.claimId,
      jobId: row.jobId,
      modelId: row.modelId,
      projectId: row.projectId,
      promptId,
      queueRecordId: row.queueRecordId,
    },
    model: {
      displayName: row.modelDisplayName,
      id: row.modelId,
      metadataJson: getJsonValue(row.modelMetadataJson),
      name: row.modelName,
      remoteModelId: row.modelRemoteModelId,
      source: row.modelSource,
      updatedAt: getDateIsoValue(row.modelUpdatedAt),
      variant: row.modelVariant,
    },
    project: {
      dateFrom: getDateIsoValue(row.dateFrom),
      dateTo: getDateIsoValue(row.dateTo),
      id: row.projectId,
      name: row.projectName,
    },
    prompt: {
      archived: row.promptArchived,
      contentHash: row.promptContentHash,
      id: promptId,
      originalText: row.promptOriginalText,
      order: row.promptOrder,
      promptHeading: row.promptHeading,
      transformedText: row.promptTransformedText,
      type: row.promptType,
      updatedAt: getDateIsoValue(row.promptUpdatedAt),
    },
    provider: {
      authMode: row.providerAuthMode,
      baseUrl: row.providerBaseUrl,
      configJson: getJsonValue(row.providerConfigJson),
      enabled: row.providerEnabled,
      id: row.providerConnectionId,
      kind: row.providerKind,
      label: row.providerLabel,
      maxInflightRequests: row.providerMaxInflightRequests,
      secretRef: row.providerSecretRef,
    },
    snapshotVersion: 2,
  }
}

const toSnapshotRecord = (row: StoredSnapshotRow): JudgmentExecutionSnapshotRecord => {
  return {
    articleId: row.articleId,
    claimId: row.claimId,
    createdAt: getDateValue(row.createdAt),
    createdBy: row.createdBy,
    executionSnapshotHash: row.executionSnapshotHash,
    executionSnapshotId: row.executionSnapshotId,
    jobId: row.jobId,
    modelId: row.modelId,
    payload: getJsonValue(row.payloadJson),
    projectId: row.projectId,
    promptId: row.promptId,
    queueRecordId: row.queueRecordId,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useTitle: row.useTitle,
  }
}

const toSnapshotIdentity = (row: SnapshotIdentityInput): JudgmentExecutionSnapshotClaim => {
  return {
    executionSnapshotHash: row.executionSnapshotHash,
    executionSnapshotId: row.executionSnapshotId,
    modelId: row.modelId,
    projectId: row.projectId,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useTitle: row.useTitle,
  }
}

const getSnapshotSelectSql = () => {
  return `
    SELECT
      id AS executionSnapshotId,
      job_id AS jobId,
      project_id AS projectId,
      queue_record_id AS queueRecordId,
      claim_id AS claimId,
      article_id AS articleId,
      prompt_id AS promptId,
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      payload_hash AS executionSnapshotHash,
      TO_JSON(payload_json) AS payloadJson,
      created_by AS createdBy,
      created_at AS createdAt
    FROM app.judgment_execution_snapshot
  `
}

const getSnapshotIdentitySelectSql = () => {
  return `
    SELECT
      id AS executionSnapshotId,
      job_id AS jobId,
      project_id AS projectId,
      queue_record_id AS queueRecordId,
      claim_id AS claimId,
      article_id AS articleId,
      prompt_id AS promptId,
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      payload_hash AS executionSnapshotHash,
      created_by AS createdBy,
      created_at AS createdAt
    FROM app.judgment_execution_snapshot
  `
}

const getSnapshotInsertValueSql = ({
  claimedBy,
  executionSnapshotHash,
  executionSnapshotId,
  payload,
  row,
}: {
  claimedBy: string
  executionSnapshotHash: string
  executionSnapshotId: string
  payload: unknown
  row: JudgmentExecutionSnapshotRow
}) => {
  const promptIdForRecord = row.promptId ?? row.requestedPromptId
  const articleIdForRecord = row.articleId ?? row.requestedArticleId

  return `(
    ${getSqlLiteral(executionSnapshotId)},
    ${getSqlLiteral(row.jobId)},
    ${getSqlLiteral(row.projectId)},
    ${getSqlLiteral(row.queueRecordId)},
    ${getSqlLiteral(row.claimId)},
    ${getSqlLiteral(articleIdForRecord)},
    ${getSqlLiteral(promptIdForRecord)},
    ${getSqlLiteral(row.modelId)},
    ${getSqlLiteral(row.useTitle)},
    ${getSqlLiteral(row.useAbstract)},
    ${getSqlLiteral(row.useFulltext)},
    ${getSqlLiteral(row.useFulltextNoImages)},
    ${getSqlLiteral(executionSnapshotHash)},
    ${getSqlLiteral(JSON.stringify(payload))}::JSON,
    ${getSqlLiteral(claimedBy)}
  )`
}

const getSnapshotIdentityByRequest = async ({claimId, jobId, queueRecordId}: JudgmentExecutionSnapshotClaimInput) => {
  const [row] = await getAppDatabaseService().queryJson<StoredSnapshotIdentityRow>(`
    ${getSnapshotIdentitySelectSql()}
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND queue_record_id = ${getSqlLiteral(queueRecordId)}
      AND claim_id = ${getSqlLiteral(claimId)}
    LIMIT 1
  `)

  return row ? toSnapshotIdentity(row) : null
}

const shouldIncludeFulltext = (requests: JudgmentExecutionSnapshotClaimInput[]): boolean => {
  return requests.every((request) => {
    return typeof request.useFulltext === 'boolean' && typeof request.useFulltextNoImages === 'boolean'
  })
    ? requests.some((request) => {
        return request.useFulltext === true || request.useFulltextNoImages === true
      })
    : true
}

const getSnapshotIdentityForTransientRow = (row: JudgmentExecutionSnapshotRow): JudgmentExecutionSnapshotClaim => {
  const payload = getSnapshotPayload(row)

  return {
    executionSnapshotHash: getJudgmentExecutionSnapshotHash(payload),
    executionSnapshotId: randomUUID(),
    executionSnapshotPayload: payload,
    modelId: row.modelId,
    projectId: row.projectId,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useTitle: row.useTitle,
  }
}

export const createTransientJudgmentExecutionSnapshotsForClaims = async (
  requests: JudgmentExecutionSnapshotClaimInput[],
  database: SnapshotQueryService,
): Promise<JudgmentExecutionSnapshotClaim[]> => {
  if (requests.length === 0) {
    return []
  }

  const sourceRows = await getSnapshotRows(requests, {includeFulltext: shouldIncludeFulltext(requests)}, database)

  return sourceRows.map((row) => {
    return getSnapshotIdentityForTransientRow(row)
  })
}

export const createJudgmentExecutionSnapshotsForClaims = async (
  requests: JudgmentExecutionSnapshotClaimInput[],
): Promise<JudgmentExecutionSnapshotClaim[]> => {
  const [request, ...remainingRequests] = requests

  if (!request) {
    return []
  }

  const [row] = await getSnapshotRows([request], {includeFulltext: shouldIncludeFulltext([request])})

  if (!row) {
    throw new Error(`Failed to build judgment execution snapshot for claim ${request.claimId}`)
  }

  const payload = getSnapshotPayload(row)
  const snapshotInput = {
    executionSnapshotHash: getJudgmentExecutionSnapshotHash(payload),
    executionSnapshotId: randomUUID(),
    payload,
    row,
  }
  const [insertedRow] = await getAppDatabaseService().queryJson<StoredSnapshotIdentityRow>(`
    INSERT INTO app.judgment_execution_snapshot (
      id,
      job_id,
      project_id,
      queue_record_id,
      claim_id,
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      payload_hash,
      payload_json,
      created_by
    ) VALUES ${getSnapshotInsertValueSql(snapshotInput)}
    ON CONFLICT(job_id, queue_record_id, claim_id) DO NOTHING
    RETURNING
      id AS executionSnapshotId,
      job_id AS jobId,
      project_id AS projectId,
      queue_record_id AS queueRecordId,
      claim_id AS claimId,
      article_id AS articleId,
      prompt_id AS promptId,
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      payload_hash AS executionSnapshotHash,
      created_by AS createdBy,
      created_at AS createdAt
  `)
  const snapshot = insertedRow ? toSnapshotIdentity(insertedRow) : await getSnapshotIdentityByRequest(request)

  if (!snapshot) {
    throw new Error(`Failed to persist judgment execution snapshot for claim ${request.claimId}`)
  }

  return [snapshot, ...(await createJudgmentExecutionSnapshotsForClaims(remainingRequests))]
}

export const createJudgmentExecutionSnapshotForClaim = async ({
  articleId,
  claimId,
  claimedBy,
  jobId,
  promptId,
  queueRecordId,
}: {
  articleId: string
  claimId: string
  claimedBy: string
  jobId: string
  promptId: string
  queueRecordId: string
}): Promise<JudgmentExecutionSnapshotClaim> => {
  const [snapshot] = await createJudgmentExecutionSnapshotsForClaims([
    {articleId, claimId, claimedBy, jobId, promptId, queueRecordId},
  ])

  if (!snapshot) {
    throw new Error(`Failed to persist judgment execution snapshot for claim ${claimId}`)
  }

  return snapshot
}

export const getJudgmentExecutionSnapshot = async ({
  executionSnapshotHash,
  executionSnapshotId,
}: {
  executionSnapshotHash: string
  executionSnapshotId: string
}): Promise<JudgmentExecutionSnapshotRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<StoredSnapshotRow>(`
    ${getSnapshotSelectSql()}
    WHERE id = ${getSqlLiteral(executionSnapshotId)}
      AND payload_hash = ${getSqlLiteral(executionSnapshotHash)}
    LIMIT 1
  `)

  return row ? toSnapshotRecord(row) : null
}

export const isJudgmentExecutionSnapshotIdentityValid = async (input: SnapshotIdentityInput): Promise<boolean> => {
  const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment_execution_snapshot
    WHERE id = ${getSqlLiteral(input.executionSnapshotId)}
      AND payload_hash = ${getSqlLiteral(input.executionSnapshotHash)}
      AND job_id = ${getSqlLiteral(input.jobId)}
      AND project_id = ${getSqlLiteral(input.projectId)}
      AND queue_record_id = ${getSqlLiteral(input.queueRecordId)}
      AND claim_id = ${getSqlLiteral(input.claimId)}
      AND article_id = ${getSqlLiteral(input.articleId)}
      AND prompt_id = ${getSqlLiteral(input.promptId)}
      AND model_id = ${getSqlLiteral(input.modelId)}
      AND use_title = ${getSqlLiteral(input.useTitle)}
      AND use_abstract = ${getSqlLiteral(input.useAbstract)}
      AND use_fulltext = ${getSqlLiteral(input.useFulltext)}
      AND use_fulltext_no_images = ${getSqlLiteral(input.useFulltextNoImages)}
    LIMIT 1
  `)

  return Boolean(row)
}
