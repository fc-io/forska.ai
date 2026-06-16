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
          delta.tombstone OR delta.source_operation = 'delete' OR judgment.id IS NULL AS tombstone,
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
          judgment.prompt_id AS promptId,
          judgment.model_id AS modelId,
          judgment.use_title AS useTitle,
          judgment.use_abstract AS useAbstract,
          judgment.use_fulltext AS useFulltext,
          judgment.use_fulltext_no_images AS useFulltextNoImages,
          'update' AS sourceOperation,
          FALSE AS tombstone,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.created_at AS latestLlmCreatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion
        FROM prompt_id_filter dirty_prompt
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
        INNER JOIN app."judgment" judgment
          ON judgment.article_id = scope.article_id
          AND judgment.prompt_id = dirty_prompt.prompt_id
          AND judgment.deleted_at IS NULL
        INNER JOIN app.prompt prompt
          ON prompt.id = judgment.prompt_id
        ORDER BY judgment.prompt_id ASC, scope.article_id ASC
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

export const projectReviewServingLlmStatusPatches = async (
  input: ProjectReviewServingLlmStatusInput,
  database: ReviewServingLlmStatusProjectorDatabase = getAppDatabaseService(),
) => {
  const promptConfigRows = await getProjectPromptConfigRows(input.projectId, database)
  const [judgmentRows, promptRows] = await Promise.all([
    getJudgmentDeltaRows(input, database),
    getPromptScopedRows(input, database),
  ])
  const patchWatermark = getPatchWatermark(input.claims)
  const rows = [...judgmentRows, ...promptRows]
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
