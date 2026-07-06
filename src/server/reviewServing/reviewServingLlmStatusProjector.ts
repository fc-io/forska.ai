import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  buildPromptConfigHash,
  buildReviewConfigHash,
  type ReviewServingIdentityValue,
} from './reviewProjectionIdentity.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorWriterDatabase,
  type ReviewServingProjectorWriterDiagnostics,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingLlmStatusProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingLlmStatusInput = {
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  emitPatchRows?: boolean
  listModeKeys: readonly string[]
  projectId: string
  projectionIdentity: string
  status?: ReviewServingProjectionManifestStatus
}

type ProjectPromptConfigRow = {
  answerSchemaHash: string | null
  promptId: string
  promptOrder: number | null
  promptTextHash: string | null
  settingsVersion: string | null
  thresholdVersion: string | null
}

type LlmStatusSourceRow = {
  answerSchemaHash: string | null
  answeredOriginal: string | null
  answeredOriginalAsArray: readonly string[] | null
  articleId: string
  isAnswered: boolean | null
  latestLlmCreatedAt: Date | string | null
  humanJudgmentMode: 'prompt' | 'summary'
  modelExecutionOptions: string | null
  modelId: string
  modelProviderBaseUrl: string | null
  modelProviderConnectionId: string | null
  modelProviderKind: string | null
  modelRemoteModelId: string | null
  modelVariant: string | null
  promptId: string
  promptTextHash: string | null
  settingsVersion: string | null
  sourceOperation: string | null
  thresholdVersion: string | null
  tombstone: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

const llmStatusProjectorName = 'llm-status-projector'

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getTimedProjector = () => {
  const phaseTimings: Record<string, number> = {}
  const measure = async <T>(phase: string, operation: () => Promise<T>) => {
    const startedAtMs = Date.now()
    const result = await operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }
  const measureSync = <T>(phase: string, operation: () => T) => {
    const startedAtMs = Date.now()
    const result = operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }

  return {measure, measureSync, phaseTimings}
}

const getLlmStatusDiagnosticsJson = (input: {
  phaseTimings: Record<string, number>
  sourceRowCount: number
  writer: ReviewServingProjectorWriterDiagnostics
}) => {
  return {
    phaseTimings: input.phaseTimings,
    llmStatusProjector: {sourceRowCount: input.sourceRowCount, writer: input.writer},
  }
}

const withDiagnosticsJson = <T extends object>(result: T, diagnosticsJson: unknown): T => {
  return Object.defineProperty(result, 'diagnosticsJson', {enumerable: false, value: diagnosticsJson})
}

const getPatchWatermark = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const getPatchRangeStart = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.min(
    ...claims.map((claim) => {
      return claim.firstSourceHighWaterMark
    }),
  )
}

const getClaimSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims[0]?.sourcePartition ?? 'review-change'
}

const getClaimKinds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyKind
      }),
    ),
  ].join(',')
}

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.articleId ?? (claim.scopeKind === 'article' ? (claim.scopeId.split(':').at(-1) ?? null) : null)
        })
        .filter((articleId) => {
          return articleId !== null && articleId.trim().length > 0
        }) as string[],
    ),
  ]
}

const getClaimPromptIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.scopeKind === 'prompt' ? (claim.scopeId.split(':').at(-1) ?? null) : null
        })
        .filter((promptId) => {
          return promptId !== null && promptId.trim().length > 0
        }) as string[],
    ),
  ]
}

const hasProjectReviewConfigClaim = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.some((claim) => {
    return claim.dirtyKind === 'project.reviewConfig.updated' && claim.scopeKind === 'project'
  })
}

const hasArticleScopeClaim = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.some((claim) => {
    return (
      claim.scopeKind === 'article'
      && [
        'importRoute.article.added',
        'importRoute.article.removed',
        'article.judgmentInput.updated',
        'projectScope.article.added',
        'projectScope.article.removed',
        'judgment.llm.created',
        'judgment.llm.updated',
        'judgment.llm.deleted',
      ].includes(claim.dirtyKind)
    )
  })
}

const getValuesCte = (columnName: string, values: readonly string[]) => {
  return values.length === 0
    ? ''
    : `${columnName}_filter(${columnName}) AS (SELECT * FROM (VALUES ${values
        .map((value) => {
          return `(${getSqlLiteral(value)})`
        })
        .join(', ')}))`
}

const hasChunkArticleRange = (input: {chunkEndArticleId?: string | null; chunkStartArticleId?: string | null}) => {
  return input.chunkStartArticleId !== undefined || input.chunkEndArticleId !== undefined
}

const getArticleRangePredicate = (input: {
  alias: string
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
}) => {
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND ${input.alias}.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND ${input.alias}.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
          ${endPredicate}`
}

const getProjectPromptConfigRows = async (
  projectId: string,
  database: Pick<ReviewServingLlmStatusProjectorDatabase, 'queryJson'>,
) => {
  return database.queryJson<ProjectPromptConfigRow>(`
    SELECT
      prompt.id AS promptId,
      project_prompt.prompt_order AS promptOrder,
      COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
      NULL AS answerSchemaHash,
      'prompt-v1' AS settingsVersion,
      NULL AS thresholdVersion
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    ORDER BY COALESCE(project_prompt.prompt_order, 0) ASC, prompt.id ASC
  `)
}

const getPromptConfigHash = (
  row: Pick<
    ProjectPromptConfigRow,
    'answerSchemaHash' | 'promptId' | 'promptTextHash' | 'settingsVersion' | 'thresholdVersion'
  >,
) => {
  return buildPromptConfigHash({
    answerSchemaHash: row.answerSchemaHash,
    promptId: row.promptId,
    promptTextHash: row.promptTextHash ?? row.promptId,
    settingsVersion: row.settingsVersion ?? 'prompt-v1',
    thresholdVersion: row.thresholdVersion,
  })
}

const getReviewConfigHash = (input: {
  humanJudgmentMode: 'prompt' | 'summary'
  modelExecutionOptions: string | null
  modelId: string
  modelProviderBaseUrl: string | null
  modelProviderConnectionId: string | null
  modelProviderKind: string | null
  modelRemoteModelId: string | null
  modelVariant: string | null
  promptConfigRows: readonly ProjectPromptConfigRow[]
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}) => {
  return buildReviewConfigHash({
    humanJudgmentMode: input.humanJudgmentMode,
    modelExecutionIdentity: {
      modelExecutionOptions: getJsonValue(input.modelExecutionOptions) as ReviewServingIdentityValue,
      modelId: input.modelId,
      providerBaseUrl: input.modelProviderBaseUrl,
      providerConnectionId: input.modelProviderConnectionId,
      providerKind: input.modelProviderKind,
      remoteModelId: input.modelRemoteModelId,
      variant: input.modelVariant,
    },
    modelId: input.modelId,
    promptConfigs: input.promptConfigRows.map((row, index) => {
      return {promptConfigHash: getPromptConfigHash(row), promptId: row.promptId, promptOrder: row.promptOrder ?? index}
    }),
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  })
}

const getJudgmentDeltaRows = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const claimPredicates = input.claims.map((claim) => {
    return `(delta.source_partition = ${getSqlLiteral(claim.sourcePartition)} AND delta.source_high_water_mark >= ${claim.firstSourceHighWaterMark} AND delta.source_high_water_mark <= ${claim.latestSourceHighWaterMark})`
  })

  return claimPredicates.length === 0 || articleIds.length === 0
    ? []
    : database.queryJson<LlmStatusSourceRow>(`
        WITH ${getValuesCte('article_id', articleIds)}
        SELECT
          delta.article_id AS articleId,
          delta.prompt_id AS promptId,
          delta.model_id AS modelId,
          model.provider_connection_id AS modelProviderConnectionId,
          provider_connection.provider_kind AS modelProviderKind,
          provider_connection.base_url AS modelProviderBaseUrl,
          model.remote_model_id AS modelRemoteModelId,
          model.variant AS modelVariant,
          TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
          delta.use_title AS useTitle,
          delta.use_abstract AS useAbstract,
          delta.use_fulltext AS useFulltext,
          delta.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
          delta.source_operation AS sourceOperation,
          project_prompt.id IS NULL OR NOT project_prompt.enabled OR COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE) AS tombstone,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.created_at AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM app.review_change_delta delta
        INNER JOIN article_id_filter dirty
          ON dirty.article_id = delta.article_id
        INNER JOIN app.project project
          ON project.id = delta.project_id
        LEFT JOIN app.model model
          ON model.id = delta.model_id
        LEFT JOIN app.provider_connection provider_connection
          ON provider_connection.id = model.provider_connection_id
        INNER JOIN app.prompt prompt
          ON prompt.id = delta.prompt_id
        LEFT JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = delta.project_id
          AND project_prompt.prompt_id = delta.prompt_id
        LEFT JOIN app."judgment" judgment
          ON judgment.article_id = delta.article_id
          AND judgment.prompt_id = delta.prompt_id
          AND judgment.model_id = delta.model_id
          AND judgment.use_title = delta.use_title
          AND judgment.use_abstract = delta.use_abstract
          AND judgment.use_fulltext = delta.use_fulltext
          AND judgment.use_fulltext_no_images = delta.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM app."judgment" newer_judgment
            WHERE newer_judgment.article_id = judgment.article_id
              AND newer_judgment.prompt_id = judgment.prompt_id
              AND newer_judgment.model_id = judgment.model_id
              AND newer_judgment.use_title = judgment.use_title
              AND newer_judgment.use_abstract = judgment.use_abstract
              AND newer_judgment.use_fulltext = judgment.use_fulltext
              AND newer_judgment.use_fulltext_no_images = judgment.use_fulltext_no_images
              AND newer_judgment.deleted_at IS NULL
              AND (
                newer_judgment.created_at > judgment.created_at
                OR (newer_judgment.created_at = judgment.created_at AND newer_judgment.id > judgment.id)
              )
          )
        WHERE delta.project_id = ${getSqlLiteral(input.projectId)}
          AND delta.change_kind IN ('judgment.llm.created', 'judgment.llm.updated', 'judgment.llm.deleted')
          AND (${claimPredicates.join(' OR ')})
        ORDER BY delta.source_high_water_mark ASC, delta.delta_id ASC
      `)
}

const getPromptScopedRows = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase,
) => {
  const promptIds = getClaimPromptIds(input.claims)

  return promptIds.length === 0
    ? []
    : database.queryJson<LlmStatusSourceRow>(`
        WITH ${getValuesCte('prompt_id', promptIds)}
        SELECT
          scope.article_id AS articleId,
          dirty_prompt.prompt_id AS promptId,
          project.model_id AS modelId,
          model.provider_connection_id AS modelProviderConnectionId,
          provider_connection.provider_kind AS modelProviderKind,
          provider_connection.base_url AS modelProviderBaseUrl,
          model.remote_model_id AS modelRemoteModelId,
          model.variant AS modelVariant,
          TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
          project.use_title AS useTitle,
          project.use_abstract AS useAbstract,
          project.use_fulltext AS useFulltext,
          project.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
          'update' AS sourceOperation,
          project_prompt.id IS NULL OR NOT project_prompt.enabled OR COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE) AS tombstone,
          NULL AS isAnswered,
          NULL AS answeredOriginal,
          NULL AS answeredOriginalAsArray,
          NULL AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM prompt_id_filter dirty_prompt
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
        LEFT JOIN app.model model
          ON model.id = project.model_id
        LEFT JOIN app.provider_connection provider_connection
          ON provider_connection.id = model.provider_connection_id
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
          ${getArticleRangePredicate({alias: 'scope', ...input})}
        LEFT JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = project.id
          AND project_prompt.prompt_id = dirty_prompt.prompt_id
        INNER JOIN app.prompt prompt
          ON prompt.id = dirty_prompt.prompt_id
        ORDER BY dirty_prompt.prompt_id ASC, scope.article_id ASC
      `)
}

const getProjectScopedPromptFilterSql = (input: ProjectReviewServingLlmStatusInput) => {
  const currentEnabledPromptSql = `
    SELECT project_prompt.prompt_id
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
  `

  return currentEnabledPromptSql
}

const getProjectScopedRows = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase,
) => {
  return !hasProjectReviewConfigClaim(input.claims) && !hasChunkArticleRange(input)
    ? []
    : database.queryJson<LlmStatusSourceRow>(`
        WITH prompt_id_filter(prompt_id) AS (
          ${getProjectScopedPromptFilterSql(input)}
        ), scoped_article AS (
          SELECT scope.article_id
          FROM mart.project_scope_article scope
          WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
            AND (scope.in_curated_scope OR scope.in_route_scope)
            ${getArticleRangePredicate({alias: 'scope', ...input})}
        ), latest_judgment AS (
          SELECT
            judgment.*,
            ROW_NUMBER() OVER (
              PARTITION BY judgment.article_id, judgment.prompt_id, judgment.model_id, judgment.use_title, judgment.use_abstract, judgment.use_fulltext, judgment.use_fulltext_no_images
              ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC
            ) AS judgment_rank
          FROM app."judgment" judgment
          INNER JOIN scoped_article scoped_judgment
            ON scoped_judgment.article_id = judgment.article_id
          INNER JOIN prompt_id_filter dirty_judgment_prompt
            ON dirty_judgment_prompt.prompt_id = judgment.prompt_id
          INNER JOIN app.project project_judgment
            ON project_judgment.id = ${getSqlLiteral(input.projectId)}
            AND project_judgment.model_id = judgment.model_id
            AND project_judgment.use_title = judgment.use_title
            AND project_judgment.use_abstract = judgment.use_abstract
            AND project_judgment.use_fulltext = judgment.use_fulltext
            AND project_judgment.use_fulltext_no_images = judgment.use_fulltext_no_images
          WHERE judgment.deleted_at IS NULL
        )
        SELECT
          scope.article_id AS articleId,
          dirty_prompt.prompt_id AS promptId,
          project.model_id AS modelId,
          model.provider_connection_id AS modelProviderConnectionId,
          provider_connection.provider_kind AS modelProviderKind,
          provider_connection.base_url AS modelProviderBaseUrl,
          model.remote_model_id AS modelRemoteModelId,
          model.variant AS modelVariant,
          TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
          project.use_title AS useTitle,
          project.use_abstract AS useAbstract,
          project.use_fulltext AS useFulltext,
          project.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
          'update' AS sourceOperation,
          project_prompt.id IS NULL OR NOT project_prompt.enabled OR COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE) AS tombstone,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.created_at AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM app.project project
        LEFT JOIN app.model model
          ON model.id = project.model_id
        LEFT JOIN app.provider_connection provider_connection
          ON provider_connection.id = model.provider_connection_id
        INNER JOIN scoped_article scope
          ON TRUE
        INNER JOIN prompt_id_filter dirty_prompt
          ON TRUE
        LEFT JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = project.id
          AND project_prompt.prompt_id = dirty_prompt.prompt_id
        INNER JOIN app.prompt prompt
          ON prompt.id = dirty_prompt.prompt_id
        LEFT JOIN latest_judgment judgment
          ON judgment.article_id = scope.article_id
          AND judgment.prompt_id = dirty_prompt.prompt_id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.judgment_rank = 1
        WHERE project.id = ${getSqlLiteral(input.projectId)}
        ORDER BY scope.article_id ASC, dirty_prompt.prompt_id ASC
      `)
}

const getArticleScopedRows = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return !hasArticleScopeClaim(input.claims) || articleIds.length === 0
    ? []
    : database.queryJson<LlmStatusSourceRow>(`
        WITH ${getValuesCte('article_id', articleIds)},
        latest_judgment AS (
          SELECT
            judgment.*,
            ROW_NUMBER() OVER (
              PARTITION BY judgment.article_id, judgment.prompt_id, judgment.model_id, judgment.use_title, judgment.use_abstract, judgment.use_fulltext, judgment.use_fulltext_no_images
              ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC
            ) AS judgment_rank
          FROM app."judgment" judgment
          INNER JOIN article_id_filter dirty_judgment
            ON dirty_judgment.article_id = judgment.article_id
          INNER JOIN app.project project_judgment
            ON project_judgment.id = ${getSqlLiteral(input.projectId)}
            AND project_judgment.model_id = judgment.model_id
            AND project_judgment.use_title = judgment.use_title
            AND project_judgment.use_abstract = judgment.use_abstract
            AND project_judgment.use_fulltext = judgment.use_fulltext
            AND project_judgment.use_fulltext_no_images = judgment.use_fulltext_no_images
          WHERE judgment.deleted_at IS NULL
        )
        SELECT
          dirty.article_id AS articleId,
          prompt.id AS promptId,
          project.model_id AS modelId,
          model.provider_connection_id AS modelProviderConnectionId,
          provider_connection.provider_kind AS modelProviderKind,
          provider_connection.base_url AS modelProviderBaseUrl,
          model.remote_model_id AS modelRemoteModelId,
          model.variant AS modelVariant,
          TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
          project.use_title AS useTitle,
          project.use_abstract AS useAbstract,
          project.use_fulltext AS useFulltext,
          project.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
          'update' AS sourceOperation,
          NOT (COALESCE(scope.in_curated_scope, FALSE) OR COALESCE(scope.in_route_scope, FALSE)) AS tombstone,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.created_at AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM article_id_filter dirty
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
        LEFT JOIN app.model model
          ON model.id = project.model_id
        LEFT JOIN app.provider_connection provider_connection
          ON provider_connection.id = model.provider_connection_id
        INNER JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = project.id
          AND project_prompt.enabled
          AND NOT project_prompt.archived
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
          AND COALESCE(prompt.archived, FALSE) = FALSE
        LEFT JOIN mart.project_scope_article scope
          ON scope.project_id = project.id
          AND scope.article_id = dirty.article_id
        LEFT JOIN latest_judgment judgment
          ON judgment.article_id = dirty.article_id
          AND judgment.prompt_id = prompt.id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.judgment_rank = 1
        ORDER BY dirty.article_id ASC, project_prompt.prompt_order ASC NULLS LAST, prompt.id ASC
      `)
}

const getLlmStatusKey = (row: LlmStatusSourceRow) => {
  return row.tombstone
    ? null
    : row.isAnswered || row.answeredOriginal !== null || (row.answeredOriginalAsArray?.length ?? 0) > 0
      ? 'answered'
      : 'unanswered'
}

const getLlmStatusPatchManifest = (
  input: ProjectReviewServingLlmStatusInput,
): ReviewServingProjectionIdentityManifestInput => {
  const patchWatermark = getPatchWatermark(input.claims)

  return {
    baseGeneration: input.baseGeneration,
    definitionVersion: input.definitionVersion,
    inputDigest: getClaimKinds(input.claims),
    inputWatermark: patchWatermark,
    inputWatermarks: getReviewServingSourcePartitionWatermarks(input.claims),
    invalidationReason: getClaimKinds(input.claims),
    patchRangeEnd: patchWatermark,
    patchRangeStart: getPatchRangeStart(input.claims),
    patchWatermark,
    projectId: input.projectId,
    projectionComponent: 'llmStatus',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

const getApplyLlmStatusServingStatement = (input: {
  baseGeneration: number
  includeExistingPatchRows: boolean
  patchWatermark: number
  projectId: string
  projectionIdentity: string
  recordRows: readonly {
    articleId: string
    listModeKey: string
    llmStatusKey: string | null
    promptConfigHash: string
    promptId: string
    reviewConfigHash: string
    tombstone: boolean
  }[]
}) => {
  const values = input.recordRows
    .map((row) => {
      return `(${getSqlLiteral(row.reviewConfigHash)}, ${getSqlLiteral(row.listModeKey)}, ${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.promptConfigHash)}, ${getSqlLiteral(row.promptId)}, ${getSqlLiteral(row.llmStatusKey)}, ${getSqlLiteral(row.tombstone)})`
    })
    .join(', ')

  return input.recordRows.length === 0
    ? null
    : `WITH changed(review_config_hash, list_mode_key, article_id, prompt_config_hash, prompt_id, llm_status_key, tombstone) AS (
        SELECT * FROM (VALUES ${values})
      ), changed_article AS (
        SELECT DISTINCT review_config_hash, list_mode_key, article_id
        FROM changed
      ), candidate_prompt AS (
        SELECT
          changed.review_config_hash,
          changed.list_mode_key,
          changed.article_id,
          changed.prompt_config_hash,
          changed.prompt_id,
          changed.llm_status_key,
          changed.tombstone,
          ${getSqlLiteral(input.patchWatermark)} AS patch_watermark
        FROM changed
        GROUP BY changed.review_config_hash, changed.list_mode_key, changed.article_id, changed.prompt_config_hash, changed.prompt_id, changed.llm_status_key, changed.tombstone
      ), latest_prompt AS (
        SELECT candidate.*
        FROM candidate_prompt candidate
        WHERE candidate.patch_watermark = (
          SELECT MAX(newer.patch_watermark)
          FROM candidate_prompt newer
          WHERE newer.review_config_hash = candidate.review_config_hash
            AND newer.list_mode_key = candidate.list_mode_key
            AND newer.article_id = candidate.article_id
            AND newer.prompt_id = candidate.prompt_id
        )
      ), article_status AS (
        SELECT
          review_config_hash,
          list_mode_key,
          article_id,
          COUNT(*) FILTER (WHERE NOT tombstone) AS enabled_prompt_count,
          COUNT(*) FILTER (WHERE NOT tombstone AND llm_status_key = 'answered') AS llm_judged_prompt_count
        FROM latest_prompt
        GROUP BY review_config_hash, list_mode_key, article_id
      )
      UPDATE mart.review_article_serving_v4 serving
      SET
        enabled_prompt_count = CAST(article_status.enabled_prompt_count AS INTEGER),
        llm_judged_prompt_count = CAST(article_status.llm_judged_prompt_count AS INTEGER),
        llm_status_key = CASE
          WHEN article_status.enabled_prompt_count = 0 THEN NULL
          WHEN article_status.enabled_prompt_count = article_status.llm_judged_prompt_count THEN 'answered'
          ELSE 'unanswered'
        END,
        patch_watermark = GREATEST(serving.patch_watermark, ${getSqlLiteral(input.patchWatermark)}),
        serving_updated_at = current_timestamp
      FROM article_status
      WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
        AND serving.llm_status_identity = ${getSqlLiteral(input.projectionIdentity)}
        AND serving.review_config_hash = article_status.review_config_hash
        AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
        AND serving.list_mode_key = article_status.list_mode_key
        AND serving.article_id = article_status.article_id
        AND EXISTS (
          SELECT 1
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id = serving.project_id
            AND snapshot.snapshot_id = serving.snapshot_id
            AND snapshot.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
            AND snapshot.snapshot_status IN ('candidate', 'active')
        )`
}

const getResetEmptyLlmStatusServingStatement = (input: {
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  listModeKeys: readonly string[]
  patchWatermark: number
  projectId: string
  projectionIdentity: string
}) => {
  const listModePredicate =
    input.listModeKeys.length === 0
      ? ''
      : `AND serving.list_mode_key IN (${input.listModeKeys.map(getSqlLiteral).join(', ')})`

  return `UPDATE mart.review_article_serving_v4 serving
    SET
      enabled_prompt_count = 0,
      llm_judged_prompt_count = 0,
      llm_status_key = NULL,
      patch_watermark = GREATEST(serving.patch_watermark, ${getSqlLiteral(input.patchWatermark)}),
      serving_updated_at = current_timestamp
    WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
      AND serving.llm_status_identity = ${getSqlLiteral(input.projectionIdentity)}
      AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
      ${listModePredicate}
      ${getArticleRangePredicate({alias: 'serving', ...input})}
      AND EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_manifest snapshot
        WHERE snapshot.project_id = serving.project_id
          AND snapshot.snapshot_id = serving.snapshot_id
          AND snapshot.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
          AND snapshot.snapshot_status IN ('candidate', 'active')
      )`
}

export const projectReviewServingLlmStatusPatches = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase = getAppDatabaseService() as ReviewServingLlmStatusProjectorDatabase,
) => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const promptConfigRows = await measure('promptConfigQueryMs', async () => {
    return getProjectPromptConfigRows(input.projectId, database)
  })
  const [judgmentRows, promptRows, projectRows, articleRows] = await measure('sourceQueryMs', async () => {
    return Promise.all([
      getJudgmentDeltaRows(input, database),
      getPromptScopedRows(input, database),
      getProjectScopedRows(input, database),
      getArticleScopedRows(input, database),
    ])
  })
  const patchWatermark = getPatchWatermark(input.claims)
  const rows = [...judgmentRows, ...promptRows, ...projectRows, ...articleRows]
  const recordRows = measureSync('recordTransformMs', () => {
    return rows.flatMap((row) => {
      const promptConfigHash = getPromptConfigHash(row)
      const reviewConfigHash = getReviewConfigHash({...row, promptConfigRows})

      return input.listModeKeys.map((listModeKey) => {
        return {
          articleId: row.articleId,
          listModeKey,
          llmStatusKey: getLlmStatusKey(row),
          promptConfigHash,
          promptId: row.promptId,
          reviewConfigHash,
          tombstone: row.tombstone,
        }
      })
    })
  })
  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: input.claims,
        component: 'llmStatus',
        projectionManifests: input.claims.length === 0 ? [] : [getLlmStatusPatchManifest(input)],
        records: [],
        statements: [
          getApplyLlmStatusServingStatement({
            baseGeneration: input.baseGeneration,
            includeExistingPatchRows: false,
            patchWatermark,
            projectId: input.projectId,
            projectionIdentity: input.projectionIdentity,
            recordRows,
          }),
          input.claims.length === 0 && recordRows.length === 0 && promptConfigRows.length === 0
            ? getResetEmptyLlmStatusServingStatement({
                baseGeneration: input.baseGeneration,
                chunkEndArticleId: input.chunkEndArticleId,
                chunkStartArticleId: input.chunkStartArticleId,
                listModeKeys: input.listModeKeys,
                patchWatermark,
                projectId: input.projectId,
                projectionIdentity: input.projectionIdentity,
              })
            : null,
        ].flatMap((statement) => {
          return statement === null ? [] : [statement]
        }),
        watermark:
          input.claims.length === 0
            ? undefined
            : {
                projectId: input.projectId,
                projectionComponent: 'llmStatus',
                projectorName: llmStatusProjectorName,
                sourceHighWaterMark: patchWatermark,
                sourcePartition: getClaimSourcePartition(input.claims),
              },
      },
      database,
    )
  })

  return withDiagnosticsJson(
    {patchRowCount: 0, patchWatermark},
    getLlmStatusDiagnosticsJson({phaseTimings, sourceRowCount: rows.length, writer: writer.diagnostics}),
  )
}
