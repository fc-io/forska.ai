import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {buildPromptConfigHash, buildReviewConfigHash} from './reviewProjectionIdentity.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingLlmStatusProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingLlmStatusInput = {
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
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
  modelId: string
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
        'projectScope.article.added',
        'projectScope.article.removed',
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
  modelId: string
  promptConfigRows: readonly ProjectPromptConfigRow[]
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}) => {
  return buildReviewConfigHash({
    humanJudgmentMode: 'prompt',
    modelExecutionIdentity: {modelId: input.modelId},
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
          delta.use_title AS useTitle,
          delta.use_abstract AS useAbstract,
          delta.use_fulltext AS useFulltext,
          delta.use_fulltext_no_images AS useFulltextNoImages,
          delta.source_operation AS sourceOperation,
          delta.tombstone AS tombstone,
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
        INNER JOIN app.prompt prompt
          ON prompt.id = delta.prompt_id
        LEFT JOIN app."judgment" judgment
          ON judgment.id = delta.judgment_id
          AND judgment.model_id = delta.model_id
          AND judgment.use_title = delta.use_title
          AND judgment.use_abstract = delta.use_abstract
          AND judgment.use_fulltext = delta.use_fulltext
          AND judgment.use_fulltext_no_images = delta.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
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
          project.use_title AS useTitle,
          project.use_abstract AS useAbstract,
          project.use_fulltext AS useFulltext,
          project.use_fulltext_no_images AS useFulltextNoImages,
          'update' AS sourceOperation,
          project_prompt.id IS NULL OR NOT project_prompt.enabled OR project_prompt.archived AS tombstone,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.created_at AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM prompt_id_filter dirty_prompt
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
        LEFT JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = project.id
          AND project_prompt.prompt_id = dirty_prompt.prompt_id
        INNER JOIN app.prompt prompt
          ON prompt.id = dirty_prompt.prompt_id
        LEFT JOIN app."judgment" judgment
          ON judgment.article_id = scope.article_id
          AND judgment.prompt_id = dirty_prompt.prompt_id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
        ORDER BY dirty_prompt.prompt_id ASC, scope.article_id ASC
      `)
}

const getProjectScopedRows = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase,
) => {
  return !hasProjectReviewConfigClaim(input.claims)
    ? []
    : database.queryJson<LlmStatusSourceRow>(`
        SELECT
          scope.article_id AS articleId,
          project_prompt.prompt_id AS promptId,
          project.model_id AS modelId,
          project.use_title AS useTitle,
          project.use_abstract AS useAbstract,
          project.use_fulltext AS useFulltext,
          project.use_fulltext_no_images AS useFulltextNoImages,
          'update' AS sourceOperation,
          project_prompt.id IS NULL OR NOT project_prompt.enabled OR project_prompt.archived AS tombstone,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.created_at AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM app.project project
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = project.id
          AND (scope.in_curated_scope OR scope.in_route_scope)
        INNER JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = project.id
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        LEFT JOIN app."judgment" judgment
          ON judgment.article_id = scope.article_id
          AND judgment.prompt_id = project_prompt.prompt_id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
        WHERE project.id = ${getSqlLiteral(input.projectId)}
        ORDER BY scope.article_id ASC, project_prompt.prompt_id ASC
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
        WITH ${getValuesCte('article_id', articleIds)}
        SELECT
          dirty.article_id AS articleId,
          prompt.id AS promptId,
          project.model_id AS modelId,
          project.use_title AS useTitle,
          project.use_abstract AS useAbstract,
          project.use_fulltext AS useFulltext,
          project.use_fulltext_no_images AS useFulltextNoImages,
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
        INNER JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = project.id
          AND project_prompt.enabled
          AND NOT project_prompt.archived
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        LEFT JOIN mart.project_scope_article scope
          ON scope.project_id = project.id
          AND scope.article_id = dirty.article_id
        LEFT JOIN app."judgment" judgment
          ON judgment.article_id = dirty.article_id
          AND judgment.prompt_id = prompt.id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
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

const getLlmStatusPatchRecord = (input: {
  baseGeneration: number
  listModeKey: string
  patchWatermark: number
  promptConfigRows: readonly ProjectPromptConfigRow[]
  projectId: string
  row: LlmStatusSourceRow
}): ReviewServingProjectorRecord => {
  const promptConfigHash = getPromptConfigHash(input.row)

  return {
    keyColumns: [
      'project_id',
      'review_config_hash',
      'prompt_config_hash',
      'base_generation',
      'patch_watermark',
      'list_mode_key',
      'article_id',
      'prompt_id',
    ],
    table: 'mart.review_llm_status_patch_v4',
    values: {
      answered_original: input.row.tombstone ? null : input.row.answeredOriginal,
      answered_original_as_array: input.row.tombstone ? null : input.row.answeredOriginalAsArray,
      article_id: input.row.articleId,
      base_generation: input.baseGeneration,
      latest_llm_created_at: input.row.tombstone ? null : input.row.latestLlmCreatedAt,
      list_mode_key: input.listModeKey,
      llm_status_key: getLlmStatusKey(input.row),
      patch_updated_at: new Date(),
      patch_watermark: input.patchWatermark,
      project_id: input.projectId,
      prompt_config_hash: promptConfigHash,
      prompt_id: input.row.promptId,
      review_config_hash: getReviewConfigHash({...input.row, promptConfigRows: input.promptConfigRows}),
      tombstone: input.row.tombstone,
    },
  }
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
  patchWatermark: number
  projectId: string
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
        UNION ALL
        SELECT
          llm.review_config_hash,
          llm.list_mode_key,
          llm.article_id,
          llm.prompt_config_hash,
          llm.prompt_id,
          llm.llm_status_key,
          llm.tombstone,
          llm.patch_watermark
        FROM mart.review_llm_status_patch_v4 llm
        INNER JOIN changed
          ON changed.review_config_hash = llm.review_config_hash
          AND changed.list_mode_key = llm.list_mode_key
          AND changed.article_id = llm.article_id
        WHERE llm.project_id = ${getSqlLiteral(input.projectId)}
          AND llm.base_generation = ${getSqlLiteral(input.baseGeneration)}
          AND llm.patch_watermark <= ${getSqlLiteral(input.patchWatermark)}
      ), latest_prompt AS (
        SELECT candidate.*
        FROM candidate_prompt candidate
        WHERE candidate.patch_watermark = (
          SELECT MAX(newer.patch_watermark)
          FROM candidate_prompt newer
          WHERE newer.review_config_hash = candidate.review_config_hash
            AND newer.prompt_config_hash = candidate.prompt_config_hash
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
        AND serving.review_config_hash = article_status.review_config_hash
        AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
        AND serving.list_mode_key = article_status.list_mode_key
        AND serving.article_id = article_status.article_id`
}

export const projectReviewServingLlmStatusPatches = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase = getAppDatabaseService(),
) => {
  const promptConfigRows = await getProjectPromptConfigRows(input.projectId, database)
  const [judgmentRows, promptRows, projectRows, articleRows] = await Promise.all([
    getJudgmentDeltaRows(input, database),
    getPromptScopedRows(input, database),
    getProjectScopedRows(input, database),
    getArticleScopedRows(input, database),
  ])
  const patchWatermark = getPatchWatermark(input.claims)
  const rows = [...judgmentRows, ...promptRows, ...projectRows, ...articleRows]
  const recordRows = rows.flatMap((row) => {
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
  const records = rows.flatMap((row) => {
    return input.listModeKeys.map((listModeKey) => {
      return getLlmStatusPatchRecord({
        baseGeneration: input.baseGeneration,
        listModeKey,
        patchWatermark,
        promptConfigRows,
        projectId: input.projectId,
        row,
      })
    })
  })

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.claims,
      component: 'llmStatus',
      projectionManifests: input.claims.length === 0 ? [] : [getLlmStatusPatchManifest(input)],
      records,
      statements: [
        getApplyLlmStatusServingStatement({
          baseGeneration: input.baseGeneration,
          patchWatermark,
          projectId: input.projectId,
          recordRows,
        }),
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

  return {patchRowCount: records.length, patchWatermark}
}
