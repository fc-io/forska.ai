import {createHash, randomUUID} from 'node:crypto'

import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'
import type {AppReadOnlyDatabaseService} from './appReadOnlyDatabaseService.ts'

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
    FROM snapshot_request
    INNER JOIN app.judgment_job jj ON jj.id = snapshot_request.job_id
    INNER JOIN app.project p ON p.id = jj.project_id
    INNER JOIN app.model m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    LEFT JOIN app.prompt pr ON pr.id = snapshot_request.prompt_id
    LEFT JOIN app.project_prompt pp ON pp.project_id = p.id AND pp.prompt_id = pr.id
    LEFT JOIN app.article a ON a.id = snapshot_request.article_id
    ORDER BY snapshot_request.request_order ASC
  `)
}

const getSnapshotPayload = (row: JudgmentExecutionSnapshotRow) => {
  const articleId = row.articleId ?? row.requestedArticleId
  const promptId = row.promptId ?? row.requestedPromptId

  return {
    article: {
      articleCreatedAt: getDateIsoValue(row.articleCreatedAt),
      articleId: row.externalArticleId,
      articleSummary: row.articleSummary,
      articleTitle: row.articleTitle,
      articleUpdatedAt: getDateIsoValue(row.articleUpdatedAt),
      articleVersion: row.articleVersion,
      contentHash: row.contentHash,
      doi: row.doi,
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
      importRoute: row.articleImportRoute,
      fullTextOriginalFormat: row.fullTextOriginalFormat,
      fullTextPdf: row.fullTextPdf,
      fullTextSource: row.fullTextSource,
      id: articleId,
      originalData: getJsonValue(row.originalData),
      publicationStatus: row.publicationStatus,
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
    snapshotVersion: 1,
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

const getSnapshotByClaim = async ({
  claimId,
  jobId,
  queueRecordId,
}: {
  claimId: string
  jobId: string
  queueRecordId: string
}) => {
  const [row] = await getAppDatabaseService().queryJson<StoredSnapshotRow>(`
    ${getSnapshotSelectSql()}
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND queue_record_id = ${getSqlLiteral(queueRecordId)}
      AND claim_id = ${getSqlLiteral(claimId)}
    LIMIT 1
  `)

  return row ? toSnapshotRecord(row) : null
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

const getSnapshotByRequest = async ({claimId, jobId, queueRecordId}: JudgmentExecutionSnapshotClaimInput) => {
  return getSnapshotByClaim({claimId, jobId, queueRecordId})
}

const getSnapshotIdentity = (snapshot: JudgmentExecutionSnapshotRecord): JudgmentExecutionSnapshotClaim => {
  return {
    executionSnapshotHash: snapshot.executionSnapshotHash,
    executionSnapshotId: snapshot.executionSnapshotId,
    executionSnapshotPayload: snapshot.payload,
    modelId: snapshot.modelId,
    projectId: snapshot.projectId,
    useAbstract: snapshot.useAbstract,
    useFulltext: snapshot.useFulltext,
    useFulltextNoImages: snapshot.useFulltextNoImages,
    useTitle: snapshot.useTitle,
  }
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
  if (requests.length === 0) {
    return []
  }

  const sourceRows = await getSnapshotRows(requests, {includeFulltext: shouldIncludeFulltext(requests)})
  const snapshotInputs = sourceRows.map((row) => {
    const payload = getSnapshotPayload(row)
    return {
      executionSnapshotHash: getJudgmentExecutionSnapshotHash(payload),
      executionSnapshotId: randomUUID(),
      payload,
      row,
    }
  })
  const insertedRows = await getAppDatabaseService().queryJson<StoredSnapshotRow>(`
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
    ) VALUES ${snapshotInputs
      .map((input) => {
        return getSnapshotInsertValueSql(input)
      })
      .join(', ')}
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
      TO_JSON(payload_json) AS payloadJson,
      created_by AS createdBy,
      created_at AS createdAt
  `)
  const insertedByClaim = new Map(
    insertedRows.map((row) => {
      return [`${row.jobId}:${row.queueRecordId}:${row.claimId}`, toSnapshotRecord(row)] as const
    }),
  )
  const snapshots = await Promise.all(
    requests.map(async (request) => {
      return (
        insertedByClaim.get(`${request.jobId}:${request.queueRecordId}:${request.claimId}`)
        ?? (await getSnapshotByRequest(request))
      )
    }),
  )

  return snapshots.map((snapshot, index) => {
    if (!snapshot) {
      throw new Error(
        `Failed to persist judgment execution snapshot for claim ${requests[index]?.claimId ?? 'unknown'}`,
      )
    }

    return getSnapshotIdentity(snapshot)
  })
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
