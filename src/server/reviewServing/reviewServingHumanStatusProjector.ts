import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'
import {
  getReviewServingProjectPromptConfigRows,
  getReviewServingProjectReviewSettings,
  getReviewServingPromptConfigHash,
  getReviewServingReviewConfigHash,
  type ReviewServingProjectPromptConfigRow,
} from './reviewServingReviewConfig.ts'

export type ReviewServingHumanStatusProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingHumanStatusInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  listModeKeys: readonly string[]
  projectId: string
  projectionIdentity: string
  status?: ReviewServingProjectionManifestStatus
}

type ProjectPromptConfigRow = ReviewServingProjectPromptConfigRow

type HumanStatusSourceRow = {
  answerSchemaHash: string | null
  articleId: string
  humanAnsweredValue: string | null
  humanStatusKey: string | null
  latestHumanUpdatedAt: Date | string | null
  payloadJson: unknown
  promptId: string | null
  promptOrSummaryKey: string
  promptOrder: number | null
  promptTextHash: string | null
  settingsVersion: string | null
  sourceOperation: string | null
  thresholdVersion: string | null
  tombstone: boolean
}

type HumanStatusArticleScopedRow = {
  articleId: string
  humanAnsweredValue: string | null
  promptId: string | null
  tombstone: boolean
  updatedAt: Date | string | null
}

const humanStatusProjectorName = 'human-status-projector'
const summaryPromptConfigRow: ProjectPromptConfigRow = {
  answerSchemaHash: null,
  promptId: 'summary',
  promptOrder: 0,
  promptTextHash: 'summary-human-judgment',
  settingsVersion: 'summary-v1',
  thresholdVersion: null,
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

const shouldRebuildProjectHumanStatus = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.some((claim) => {
    return claim.dirtyKind === 'project.reviewConfig.updated' && claim.scopeKind === 'project'
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

const parsePayloadJson = (value: unknown) => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch (_error) {
    return null
  }
}

const getPayloadAnswer = (payloadJson: unknown) => {
  const payload = parsePayloadJson(payloadJson)

  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'answer' in payload
    ? typeof payload.answer === 'string'
      ? payload.answer
      : null
    : undefined
}

const getPromptConfigHash = (
  row: Pick<
    ProjectPromptConfigRow,
    'answerSchemaHash' | 'promptId' | 'promptTextHash' | 'settingsVersion' | 'thresholdVersion'
  >,
) => {
  return getReviewServingPromptConfigHash(row)
}

const getPromptConfigRowByPromptId = (promptConfigRows: readonly ProjectPromptConfigRow[], promptId: string | null) => {
  return promptConfigRows.find((row) => {
    return row.promptId === promptId
  })
}

const getHumanStatusKey = (answer: string | null, tombstone: boolean) => {
  return tombstone ? null : answer === null || answer.trim().length === 0 ? 'unanswered' : 'answered'
}

const getPromptOrSummaryKey = (promptId: string | null) => {
  return promptId === null || promptId.trim().length === 0 ? 'summary' : promptId
}

const getJudgmentDeltaRows = async (
  input: ProjectReviewServingHumanStatusInput,
  database: ReviewServingHumanStatusProjectorDatabase,
  promptConfigRows: readonly ProjectPromptConfigRow[],
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const claimPredicates = input.claims.map((claim) => {
    return `(delta.source_partition = ${getSqlLiteral(claim.sourcePartition)} AND delta.source_high_water_mark >= ${claim.firstSourceHighWaterMark} AND delta.source_high_water_mark <= ${claim.latestSourceHighWaterMark})`
  })
  const rows =
    claimPredicates.length === 0 || articleIds.length === 0
      ? []
      : await database.queryJson<HumanStatusSourceRow>(`
          WITH ${getValuesCte('article_id', articleIds)}
          SELECT
            delta.article_id AS articleId,
            delta.prompt_id AS promptId,
            COALESCE(delta.prompt_id, 'summary') AS promptOrSummaryKey,
            delta.source_operation AS sourceOperation,
            delta.tombstone OR (
              delta.prompt_id IS NOT NULL
              AND (project_prompt.id IS NULL OR NOT project_prompt.enabled OR COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE))
            ) AS tombstone,
            delta.payload_json AS payloadJson,
            COALESCE(judgment_human.answer, judgment_human_summary.answer) AS humanAnsweredValue,
            CASE
              WHEN delta.tombstone THEN NULL
              WHEN NULLIF(TRIM(COALESCE(judgment_human.answer, judgment_human_summary.answer, '')), '') IS NULL THEN 'unanswered'
              ELSE 'answered'
            END AS humanStatusKey,
            COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at, delta.source_updated_at) AS latestHumanUpdatedAt,
            COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
            NULL AS answerSchemaHash,
            'prompt-v1' AS settingsVersion,
            NULL AS thresholdVersion,
            project_prompt.prompt_order AS promptOrder
          FROM app.review_change_delta delta
          INNER JOIN article_id_filter dirty
            ON dirty.article_id = delta.article_id
          LEFT JOIN app.prompt prompt
            ON prompt.id = delta.prompt_id
          LEFT JOIN app.project_prompt project_prompt
            ON project_prompt.project_id = delta.project_id
            AND project_prompt.prompt_id = delta.prompt_id
          LEFT JOIN app."judgment_human" judgment_human
            ON judgment_human.id = delta.human_judgment_key
            AND judgment_human.project_id IS NOT DISTINCT FROM delta.project_id
            AND judgment_human.article_id = delta.article_id
            AND judgment_human.prompt_id = delta.prompt_id
          LEFT JOIN app."judgment_human_summary" judgment_human_summary
            ON judgment_human_summary.id = delta.human_judgment_key
            AND judgment_human_summary.project_id = delta.project_id
            AND judgment_human_summary.article_id = delta.article_id
            AND delta.prompt_id IS NULL
          WHERE delta.project_id = ${getSqlLiteral(input.projectId)}
            AND delta.change_kind = 'judgment.human.updated'
            AND (${claimPredicates.join(' OR ')})
          ORDER BY delta.source_high_water_mark ASC, delta.delta_id ASC
        `)

  return rows.map((row) => {
    const promptConfigRow =
      row.promptId === 'summary' ? summaryPromptConfigRow : getPromptConfigRowByPromptId(promptConfigRows, row.promptId)
    const humanAnsweredValue = getPayloadAnswer(row.payloadJson) ?? row.humanAnsweredValue

    return {
      ...row,
      ...(row.promptId === null || row.promptId === 'summary' ? summaryPromptConfigRow : (promptConfigRow ?? row)),
      humanAnsweredValue,
      humanStatusKey: getHumanStatusKey(humanAnsweredValue, row.tombstone),
      promptOrSummaryKey: getPromptOrSummaryKey(row.promptOrSummaryKey),
    }
  })
}

const getPromptScopedRows = async (
  input: ProjectReviewServingHumanStatusInput,
  database: ReviewServingHumanStatusProjectorDatabase,
) => {
  const promptIds = getClaimPromptIds(input.claims)

  return promptIds.length === 0
    ? []
    : database.queryJson<HumanStatusSourceRow>(`
        WITH ${getValuesCte('prompt_id', promptIds)}
        SELECT
          scope.article_id AS articleId,
          dirty_prompt.prompt_id AS promptId,
          dirty_prompt.prompt_id AS promptOrSummaryKey,
          'update' AS sourceOperation,
          project_prompt.prompt_id IS NULL AS tombstone,
          NULL AS payloadJson,
          judgment_human.answer AS humanAnsweredValue,
          CASE
            WHEN NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NULL THEN 'unanswered'
            ELSE 'answered'
          END AS humanStatusKey,
          COALESCE(judgment_human.updated_at, scope.article_updated_at, scope.source_updated_at, scope.article_created_at) AS latestHumanUpdatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion,
          project_prompt.prompt_order AS promptOrder
        FROM prompt_id_filter dirty_prompt
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
        INNER JOIN app.prompt prompt
          ON prompt.id = dirty_prompt.prompt_id
        LEFT JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = ${getSqlLiteral(input.projectId)}
          AND project_prompt.prompt_id = dirty_prompt.prompt_id
          AND project_prompt.enabled = TRUE
          AND COALESCE(project_prompt.archived, FALSE) = FALSE
          AND COALESCE(prompt.archived, FALSE) = FALSE
        LEFT JOIN app."judgment_human" judgment_human
          ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
          AND judgment_human.article_id = scope.article_id
          AND judgment_human.prompt_id = dirty_prompt.prompt_id
        ORDER BY dirty_prompt.prompt_id ASC, scope.article_id ASC
      `)
}

const getArticleScopedRows = async (
  input: ProjectReviewServingHumanStatusInput,
  database: ReviewServingHumanStatusProjectorDatabase,
  promptConfigRows: readonly ProjectPromptConfigRow[],
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const promptConfigRowsWithSummary = [...promptConfigRows, summaryPromptConfigRow]

  if (articleIds.length === 0 || promptConfigRowsWithSummary.length === 0) {
    return []
  }

  const rows = await database.queryJson<HumanStatusArticleScopedRow>(`
    WITH ${getValuesCte('article_id', articleIds)},
    prompt_config(prompt_id) AS (
      SELECT * FROM (VALUES ${promptConfigRowsWithSummary
        .map((row) => {
          return `(${getSqlLiteral(row.promptId)})`
        })
        .join(', ')})
    ), article_prompt AS (
      SELECT dirty.article_id, prompt_config.prompt_id
      FROM article_id_filter dirty
      CROSS JOIN prompt_config
    )
    SELECT
      article_prompt.article_id AS articleId,
      article_prompt.prompt_id AS promptId,
      scope.article_id IS NULL AS tombstone,
      COALESCE(judgment_human.answer, judgment_human_summary.answer) AS humanAnsweredValue,
      COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at, scope.article_updated_at, scope.source_updated_at, scope.article_created_at) AS updatedAt
    FROM article_prompt
    LEFT JOIN mart.project_scope_article scope
      ON scope.project_id = ${getSqlLiteral(input.projectId)}
      AND scope.article_id = article_prompt.article_id
      AND (scope.in_curated_scope OR scope.in_route_scope)
    LEFT JOIN app."judgment_human" judgment_human
      ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND judgment_human.article_id = article_prompt.article_id
      AND judgment_human.prompt_id = article_prompt.prompt_id
      AND article_prompt.prompt_id <> 'summary'
    LEFT JOIN app."judgment_human_summary" judgment_human_summary
      ON judgment_human_summary.project_id = ${getSqlLiteral(input.projectId)}
      AND judgment_human_summary.article_id = article_prompt.article_id
      AND article_prompt.prompt_id = 'summary'
    ORDER BY article_prompt.article_id ASC, article_prompt.prompt_id ASC
  `)

  return rows.map((row): HumanStatusSourceRow => {
    const promptConfigRow =
      getPromptConfigRowByPromptId(promptConfigRowsWithSummary, row.promptId) ?? summaryPromptConfigRow
    const humanAnsweredValue = row.tombstone ? null : row.humanAnsweredValue

    return {
      ...promptConfigRow,
      articleId: row.articleId,
      humanAnsweredValue,
      humanStatusKey: getHumanStatusKey(humanAnsweredValue, row.tombstone),
      latestHumanUpdatedAt: row.updatedAt,
      payloadJson: null,
      promptId: row.promptId,
      promptOrSummaryKey: getPromptOrSummaryKey(row.promptId),
      sourceOperation: 'update',
      tombstone: row.tombstone,
    }
  })
}

const getProjectScopedRows = async (
  input: ProjectReviewServingHumanStatusInput,
  database: ReviewServingHumanStatusProjectorDatabase,
  promptConfigRows: readonly ProjectPromptConfigRow[],
) => {
  const promptConfigRowsWithSummary = [...promptConfigRows, summaryPromptConfigRow]
  const activePromptValues = promptConfigRowsWithSummary
    .map((row) => {
      return `(${getSqlLiteral(row.promptId)}, ${getSqlLiteral(row.promptOrder)}, ${getSqlLiteral(row.promptTextHash)}, ${getSqlLiteral(row.answerSchemaHash)}, ${getSqlLiteral(row.settingsVersion)}, ${getSqlLiteral(row.thresholdVersion)}, TRUE)`
    })
    .join(', ')

  if (!shouldRebuildProjectHumanStatus(input.claims) || promptConfigRowsWithSummary.length === 0) {
    return []
  }

  return database.queryJson<HumanStatusSourceRow>(`
    WITH active_prompt_config(prompt_id, prompt_order, prompt_text_hash, answer_schema_hash, settings_version, threshold_version, active) AS (
      SELECT * FROM (VALUES ${activePromptValues})
    ), existing_prompt_config AS (
      SELECT DISTINCT
        human.prompt_id,
        NULL::INTEGER AS prompt_order,
        human.prompt_id AS prompt_text_hash,
        NULL AS answer_schema_hash,
        'prompt-v1' AS settings_version,
        NULL AS threshold_version,
        FALSE AS active
      FROM mart.review_human_status_patch_v4 human
      WHERE human.project_id = ${getSqlLiteral(input.projectId)}
        AND human.base_generation = ${getSqlLiteral(input.baseGeneration)}
        AND human.prompt_id IS NOT NULL
        AND human.prompt_id <> 'summary'
        AND NOT EXISTS (
          SELECT 1
          FROM active_prompt_config active
          WHERE active.prompt_id = human.prompt_id
        )
    ), prompt_config AS (
      SELECT * FROM active_prompt_config
      UNION ALL
      SELECT * FROM existing_prompt_config
    ), article_prompt AS (
      SELECT scope.article_id, prompt_config.*
      FROM mart.project_scope_article scope
      CROSS JOIN prompt_config
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
    )
    SELECT
      article_prompt.article_id AS articleId,
      article_prompt.prompt_id AS promptId,
      article_prompt.prompt_id AS promptOrSummaryKey,
      'update' AS sourceOperation,
      NOT article_prompt.active AS tombstone,
      NULL AS payloadJson,
      COALESCE(judgment_human.answer, judgment_human_summary.answer) AS humanAnsweredValue,
      CASE
        WHEN NOT article_prompt.active THEN NULL
        WHEN NULLIF(TRIM(COALESCE(judgment_human.answer, judgment_human_summary.answer, '')), '') IS NULL THEN 'unanswered'
        ELSE 'answered'
      END AS humanStatusKey,
      COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at) AS latestHumanUpdatedAt,
      article_prompt.prompt_text_hash AS promptTextHash,
      article_prompt.answer_schema_hash AS answerSchemaHash,
      article_prompt.settings_version AS settingsVersion,
      article_prompt.threshold_version AS thresholdVersion,
      article_prompt.prompt_order AS promptOrder
    FROM article_prompt
    LEFT JOIN app."judgment_human" judgment_human
      ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND judgment_human.article_id = article_prompt.article_id
      AND judgment_human.prompt_id = article_prompt.prompt_id
      AND article_prompt.prompt_id <> 'summary'
      AND article_prompt.active
    LEFT JOIN app."judgment_human_summary" judgment_human_summary
      ON judgment_human_summary.project_id = ${getSqlLiteral(input.projectId)}
      AND judgment_human_summary.article_id = article_prompt.article_id
      AND article_prompt.prompt_id = 'summary'
      AND article_prompt.active
    ORDER BY article_prompt.article_id ASC, article_prompt.prompt_id ASC
  `)
}

const getApplyHumanStatusServingStatement = (input: {
  baseGeneration: number
  currentSummaryReviewConfigHash: string | null
  currentReviewConfigHash: string | null
  patchWatermark: number
  projectId: string
  projectionIdentity: string
  recordRows: readonly {
    articleId: string
    humanStatusKey: string | null
    listModeKey: string
    promptConfigHash: string
    promptId: string | null
    reviewConfigHash: string | null
    tombstone: boolean
  }[]
}) => {
  const values = input.recordRows
    .map((row) => {
      return `(${getSqlLiteral(row.listModeKey)}, ${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.reviewConfigHash)}, ${getSqlLiteral(row.promptConfigHash)}, ${getSqlLiteral(row.promptId)}, ${getSqlLiteral(row.humanStatusKey)}, ${getSqlLiteral(row.tombstone)})`
    })
    .join(', ')

  return values.length === 0
    ? null
    : `WITH changed(list_mode_key, article_id, review_config_hash, prompt_config_hash, prompt_id, human_status_key, tombstone) AS (
        SELECT * FROM (VALUES ${values})
      ), changed_article AS (
        SELECT DISTINCT list_mode_key, article_id
        FROM changed
      ), candidate_prompt AS (
        SELECT
          changed.list_mode_key,
          changed.article_id,
          changed.review_config_hash,
          changed.prompt_config_hash,
          changed.prompt_id,
          changed.human_status_key,
          changed.tombstone,
          ${getSqlLiteral(input.patchWatermark)} AS patch_watermark
        FROM changed
        GROUP BY changed.list_mode_key, changed.article_id, changed.review_config_hash, changed.prompt_config_hash, changed.prompt_id, changed.human_status_key, changed.tombstone
        UNION ALL
        SELECT
          human.list_mode_key,
          human.article_id,
          ${getSqlLiteral(input.currentReviewConfigHash)} AS review_config_hash,
          human.prompt_config_hash,
          human.prompt_id,
          human.human_status_key,
          human.tombstone,
          human.patch_watermark
        FROM mart.review_human_status_patch_v4 human
        INNER JOIN changed_article changed
          ON changed.list_mode_key = human.list_mode_key
          AND changed.article_id = human.article_id
        WHERE human.project_id = ${getSqlLiteral(input.projectId)}
          AND human.base_generation = ${getSqlLiteral(input.baseGeneration)}
          AND human.patch_watermark <= ${getSqlLiteral(input.patchWatermark)}
      ), latest_prompt AS (
        SELECT candidate.*
        FROM candidate_prompt candidate
        WHERE candidate.patch_watermark = (
          SELECT MAX(newer.patch_watermark)
          FROM candidate_prompt newer
          WHERE newer.list_mode_key = candidate.list_mode_key
            AND newer.article_id = candidate.article_id
            AND newer.review_config_hash IS NOT DISTINCT FROM candidate.review_config_hash
            AND newer.prompt_id IS NOT DISTINCT FROM candidate.prompt_id
        )
      ), article_status AS (
        SELECT
          list_mode_key,
          article_id,
          review_config_hash,
          COUNT(*) FILTER (WHERE NOT tombstone AND prompt_id IS NOT NULL AND prompt_id <> 'summary' AND human_status_key = 'answered') AS human_answered_prompt_count,
          COUNT(*) FILTER (WHERE NOT tombstone AND prompt_id = 'summary' AND human_status_key = 'answered') AS human_answered_summary_count
        FROM latest_prompt
        GROUP BY list_mode_key, article_id, review_config_hash
      )
      UPDATE mart.review_article_serving_v4 serving
      SET
        human_answered_prompt_count = CAST(article_status.human_answered_prompt_count AS INTEGER),
        human_status_key = CASE
          WHEN serving.enabled_prompt_count = 0 THEN NULL
          WHEN serving.review_config_hash = ${getSqlLiteral(input.currentSummaryReviewConfigHash)} AND article_status.human_answered_summary_count > 0 THEN 'answered'
          WHEN serving.review_config_hash IS DISTINCT FROM ${getSqlLiteral(input.currentSummaryReviewConfigHash)} AND serving.enabled_prompt_count = article_status.human_answered_prompt_count THEN 'answered'
          ELSE 'unanswered'
        END,
        patch_watermark = GREATEST(serving.patch_watermark, ${getSqlLiteral(input.patchWatermark)}),
        serving_updated_at = current_timestamp
      FROM article_status
      WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
        AND serving.human_status_identity = ${getSqlLiteral(input.projectionIdentity)}
        AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
        AND serving.review_config_hash IS NOT DISTINCT FROM article_status.review_config_hash
        AND serving.list_mode_key = article_status.list_mode_key
        AND serving.article_id = article_status.article_id
        AND EXISTS (
          SELECT 1
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id = serving.project_id
            AND snapshot.snapshot_id = serving.snapshot_id
            AND snapshot.snapshot_status IN ('candidate', 'active')
        )`
}

const getHumanStatusPatchRecord = (input: {
  baseGeneration: number
  listModeKey: string
  patchWatermark: number
  projectId: string
  row: HumanStatusSourceRow
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'prompt_config_hash',
      'base_generation',
      'patch_watermark',
      'list_mode_key',
      'article_id',
      'prompt_id',
    ],
    table: 'mart.review_human_status_patch_v4',
    values: {
      article_id: input.row.articleId,
      base_generation: input.baseGeneration,
      human_answered_value: input.row.tombstone ? null : input.row.humanAnsweredValue,
      human_status_key: input.row.tombstone ? null : input.row.humanStatusKey,
      latest_human_updated_at: input.row.tombstone ? null : input.row.latestHumanUpdatedAt,
      list_mode_key: input.listModeKey,
      patch_updated_at: new Date(),
      patch_watermark: input.patchWatermark,
      project_id: input.projectId,
      prompt_config_hash: getPromptConfigHash({...input.row, promptId: getPromptOrSummaryKey(input.row.promptId)}),
      prompt_id: input.row.promptOrSummaryKey,
      tombstone: input.row.tombstone,
    },
  }
}

const getHumanStatusPatchManifest = (
  input: ProjectReviewServingHumanStatusInput,
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
    projectionComponent: 'humanStatus',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

export const projectReviewServingHumanStatusPatches = async (
  input: ProjectReviewServingHumanStatusInput,
  database: ReviewServingHumanStatusProjectorDatabase = getAppDatabaseService() as ReviewServingHumanStatusProjectorDatabase,
) => {
  const promptConfigRows = await getReviewServingProjectPromptConfigRows(input.projectId, database)
  const projectSettings = await getReviewServingProjectReviewSettings(input.projectId, database)
  const currentSummaryReviewConfigHash =
    projectSettings === null
      ? null
      : getReviewServingReviewConfigHash({...projectSettings, humanJudgmentMode: 'summary', promptConfigRows})
  const currentReviewConfigHash =
    projectSettings === null ? null : getReviewServingReviewConfigHash({...projectSettings, promptConfigRows})
  const [judgmentRows, promptRows, articleRows, projectRows] = await Promise.all([
    getJudgmentDeltaRows(input, database, promptConfigRows),
    getPromptScopedRows(input, database),
    getArticleScopedRows(input, database, promptConfigRows),
    getProjectScopedRows(input, database, promptConfigRows),
  ])
  const patchWatermark = getPatchWatermark(input.claims)
  const rows = [...judgmentRows, ...promptRows, ...articleRows, ...projectRows]
  const recordRows = rows.flatMap((row) => {
    const promptConfigHash = getPromptConfigHash({...row, promptId: getPromptOrSummaryKey(row.promptId)})

    return input.listModeKeys.map((listModeKey) => {
      return {
        articleId: row.articleId,
        humanStatusKey: row.humanStatusKey,
        listModeKey,
        promptConfigHash,
        promptId: getPromptOrSummaryKey(row.promptId),
        reviewConfigHash: currentReviewConfigHash,
        tombstone: row.tombstone,
      }
    })
  })
  const records = rows.flatMap((row) => {
    return input.listModeKeys.map((listModeKey) => {
      return getHumanStatusPatchRecord({
        baseGeneration: input.baseGeneration,
        listModeKey,
        patchWatermark,
        projectId: input.projectId,
        row,
      })
    })
  })

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
      component: 'humanStatus',
      projectionManifests: input.claims.length === 0 ? [] : [getHumanStatusPatchManifest(input)],
      records,
      statements: [
        getApplyHumanStatusServingStatement({
          baseGeneration: input.baseGeneration,
          currentSummaryReviewConfigHash,
          currentReviewConfigHash,
          patchWatermark,
          projectId: input.projectId,
          projectionIdentity: input.projectionIdentity,
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
              projectionComponent: 'humanStatus',
              projectorName: humanStatusProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
    },
    database,
  )

  return {patchRowCount: records.length, patchWatermark}
}
