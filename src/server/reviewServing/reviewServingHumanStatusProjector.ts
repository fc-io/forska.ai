import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
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
import {
  getReviewServingProjectPromptConfigRows,
  getReviewServingProjectReviewSettings,
  getReviewServingPromptConfigHash,
  getReviewServingReviewConfigHash,
  type ReviewServingProjectPromptConfigRow,
} from './reviewServingReviewConfig.ts'

export type ReviewServingHumanStatusProjectorDatabase = ReviewServingProjectorWriterDatabase

const getListModeMembershipPredicate = (stateAlias: string, listModeExpression: string) => {
  return `CASE ${listModeExpression}
          WHEN 'llm' THEN ${stateAlias}.has_llm_list_mode
          WHEN 'human' THEN ${stateAlias}.has_human_list_mode
          WHEN 'both' THEN ${stateAlias}.has_both_list_mode
          WHEN 'unassessed' THEN ${stateAlias}.has_unassessed_list_mode
          ELSE FALSE
        END IS TRUE`
}

export type ProjectReviewServingHumanStatusInput = {
  acknowledgeClaims?: boolean
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

export type ProjectReviewServingHumanStatusRangesInput = {ranges: readonly ProjectReviewServingHumanStatusInput[]}

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
  summaryOrigin: string | null
  sourceOperation: string | null
  thresholdVersion: string | null
  tombstone: boolean
}

type HumanStatusArticleScopedRow = {
  articleId: string
  humanAnsweredValue: string | null
  promptId: string | null
  summaryOrigin: string | null
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

const getHumanStatusDiagnosticsJson = (input: {
  phaseTimings: Record<string, number>
  sourceRowCount: number
  writer: ReviewServingProjectorWriterDiagnostics
}) => {
  return {
    phaseTimings: input.phaseTimings,
    humanStatusProjector: {sourceRowCount: input.sourceRowCount, writer: input.writer},
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

const getRangeValuesCte = (ranges: readonly ProjectReviewServingHumanStatusInput[]) => {
  return `article_range_filter(chunk_start_article_id, chunk_end_article_id) AS (
        SELECT * FROM (VALUES ${ranges
          .map((range) => {
            return `(${getSqlLiteral(range.chunkStartArticleId ?? null)}, ${getSqlLiteral(range.chunkEndArticleId ?? null)})`
          })
          .join(', ')})
      )`
}

const assertCompatibleHumanStatusRanges = (ranges: readonly ProjectReviewServingHumanStatusInput[]) => {
  const firstRange = ranges[0]

  if (firstRange === undefined) {
    return
  }

  ranges.forEach((range) => {
    const matchesListModes =
      range.listModeKeys.length === firstRange.listModeKeys.length
      && range.listModeKeys.every((listModeKey, index) => {
        return listModeKey === firstRange.listModeKeys[index]
      })

    if (
      range.claims.length !== 0
      || range.baseGeneration !== firstRange.baseGeneration
      || range.projectId !== firstRange.projectId
      || range.projectionIdentity !== firstRange.projectionIdentity
      || !matchesListModes
    ) {
      throw new Error('cannot batch incompatible human status rebuild ranges')
    }
  })
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

const getSourceHumanStatusKey = (
  row: Pick<HumanStatusSourceRow, 'humanAnsweredValue' | 'promptOrSummaryKey' | 'summaryOrigin' | 'tombstone'>,
) => {
  return getHumanStatusKey(row.humanAnsweredValue, row.tombstone)
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
            judgment_human_summary.origin AS summaryOrigin,
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
      humanStatusKey: getSourceHumanStatusKey({...row, humanAnsweredValue}),
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
          NULL AS summaryOrigin,
          NULL AS payloadJson,
          judgment_human.answer AS humanAnsweredValue,
          CASE
            WHEN NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NULL THEN 'unanswered'
            ELSE 'answered'
          END AS humanStatusKey,
          COALESCE(judgment_human.updated_at, scope.article_updated_at, scope.article_created_at) AS latestHumanUpdatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion,
          project_prompt.prompt_order AS promptOrder
        FROM prompt_id_filter dirty_prompt
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
          ${getArticleRangePredicate({alias: 'scope', ...input})}
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
      judgment_human_summary.origin AS summaryOrigin,
      COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at, scope.article_updated_at, scope.article_created_at) AS updatedAt
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
      humanStatusKey: getSourceHumanStatusKey({
        humanAnsweredValue,
        promptOrSummaryKey: getPromptOrSummaryKey(row.promptId),
        summaryOrigin: row.summaryOrigin,
        tombstone: row.tombstone,
      }),
      latestHumanUpdatedAt: row.updatedAt,
      payloadJson: null,
      promptId: row.promptId,
      promptOrSummaryKey: getPromptOrSummaryKey(row.promptId),
      sourceOperation: 'update',
      summaryOrigin: row.summaryOrigin,
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
  const promptConfigCteSql = `prompt_config AS (
      SELECT * FROM active_prompt_config
    )`

  if (
    (!shouldRebuildProjectHumanStatus(input.claims) && !hasChunkArticleRange(input))
    || promptConfigRowsWithSummary.length === 0
  ) {
    return []
  }

  return database.queryJson<HumanStatusSourceRow>(`
    WITH active_prompt_config(prompt_id, prompt_order, prompt_text_hash, answer_schema_hash, settings_version, threshold_version, active) AS (
      SELECT * FROM (VALUES ${activePromptValues})
    ), ${promptConfigCteSql}, article_prompt AS (
      SELECT scope.article_id, prompt_config.*
      FROM mart.project_scope_article scope
      CROSS JOIN prompt_config
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        ${getArticleRangePredicate({alias: 'scope', ...input})}
    )
    SELECT
      article_prompt.article_id AS articleId,
      article_prompt.prompt_id AS promptId,
      article_prompt.prompt_id AS promptOrSummaryKey,
      'update' AS sourceOperation,
      judgment_human_summary.origin AS summaryOrigin,
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
  includeExistingPatchRows: boolean
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
          latest_prompt.list_mode_key,
          latest_prompt.article_id,
          latest_prompt.review_config_hash,
          CASE
            WHEN COUNT(DISTINCT latest_prompt.prompt_id) FILTER (WHERE NOT latest_prompt.tombstone) = 0 THEN NULL
            WHEN COUNT(DISTINCT latest_prompt.prompt_id) FILTER (
              WHERE NOT latest_prompt.tombstone AND latest_prompt.human_status_key = 'answered'
            ) = COUNT(DISTINCT latest_prompt.prompt_id) FILTER (WHERE NOT latest_prompt.tombstone) THEN 'answered'
            ELSE 'unanswered'
          END AS human_status
        FROM latest_prompt
        GROUP BY latest_prompt.list_mode_key, latest_prompt.article_id, latest_prompt.review_config_hash
      )
      UPDATE mart.review_article_serving_list_mode_state_v4 state
      SET
        human_status = article_status.human_status,
        human_patch_watermark = CASE
          WHEN article_status.list_mode_key = 'human'
            THEN GREATEST(COALESCE(state.human_patch_watermark, 0), ${getSqlLiteral(input.patchWatermark)})
          ELSE state.human_patch_watermark
        END,
        both_patch_watermark = CASE
          WHEN article_status.list_mode_key = 'both'
            THEN GREATEST(COALESCE(state.both_patch_watermark, 0), ${getSqlLiteral(input.patchWatermark)})
          ELSE state.both_patch_watermark
        END
      FROM article_status
      WHERE state.project_id = ${getSqlLiteral(input.projectId)}
        AND state.review_config_hash IS NOT DISTINCT FROM article_status.review_config_hash
        AND state.article_id = article_status.article_id
        AND ${getListModeMembershipPredicate('state', 'article_status.list_mode_key')}
        AND EXISTS (
          SELECT 1
          FROM mart.review_article_serving_base_v4 serving
          INNER JOIN app.review_serving_snapshot_manifest snapshot
            ON snapshot.project_id = serving.project_id
           AND snapshot.snapshot_id = serving.snapshot_id
          WHERE serving.project_id = state.project_id
            AND serving.review_config_hash IS NOT DISTINCT FROM state.review_config_hash
            AND serving.snapshot_id = state.snapshot_id
            AND serving.article_id = state.article_id
            AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND json_extract_string(snapshot.composed_identity_json, '$.humanStatus.projectionIdentity') = ${getSqlLiteral(input.projectionIdentity)}
            AND snapshot.snapshot_status IN ('candidate', 'active')
      )`
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

const getApplyHumanStatusServingRangeReplacementStatements = (input: {
  ranges: readonly ProjectReviewServingHumanStatusInput[]
}) => {
  const firstRange = input.ranges[0]

  if (firstRange === undefined) {
    return []
  }

  assertCompatibleHumanStatusRanges(input.ranges)

  if (firstRange.listModeKeys.length === 0) {
    return []
  }

  const setClauses = [
    firstRange.listModeKeys.includes('human')
      ? 'human_patch_watermark = GREATEST(COALESCE(state.human_patch_watermark, 0), 0)'
      : null,
    firstRange.listModeKeys.includes('both')
      ? 'both_patch_watermark = GREATEST(COALESCE(state.both_patch_watermark, 0), 0)'
      : null,
  ].filter((clause): clause is string => {
    return clause !== null
  })

  return setClauses.length === 0
    ? []
    : [
        `WITH ${getRangeValuesCte(input.ranges)},
     enabled_prompt_count AS (
       SELECT
         project_prompt.project_id,
         COUNT(DISTINCT prompt.id) AS prompt_count
       FROM app.project_prompt project_prompt
       INNER JOIN app.prompt prompt
         ON prompt.id = project_prompt.prompt_id
       WHERE project_prompt.enabled
         AND NOT project_prompt.archived
         AND COALESCE(prompt.archived, FALSE) = FALSE
       GROUP BY project_prompt.project_id
     ),
     article_status AS (
       SELECT
         serving.project_id,
         serving.review_config_hash,
         serving.snapshot_id,
         serving.article_id,
         CASE
           WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
             AND BOOL_OR(NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL) THEN 'answered'
           WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary' THEN 'unanswered'
           WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
           WHEN enabled_prompt_count.prompt_count = COUNT(DISTINCT prompt.id) FILTER (
             WHERE judgment_human.id IS NOT NULL
           ) THEN 'answered'
           ELSE 'unanswered'
         END AS human_status
       FROM mart.review_article_serving_base_v4 serving
       INNER JOIN article_range_filter range
         ON (range.chunk_start_article_id IS NULL OR serving.article_id >= range.chunk_start_article_id)
        AND (range.chunk_end_article_id IS NULL OR serving.article_id <= range.chunk_end_article_id)
       INNER JOIN app.project project
         ON project.id = serving.project_id
       LEFT JOIN enabled_prompt_count
         ON enabled_prompt_count.project_id = serving.project_id
       LEFT JOIN app.project_prompt project_prompt
         ON project_prompt.project_id = project.id
        AND project_prompt.enabled
        AND NOT project_prompt.archived
       LEFT JOIN app.prompt prompt
         ON prompt.id = project_prompt.prompt_id
        AND COALESCE(prompt.archived, FALSE) = FALSE
       LEFT JOIN app."judgment_human" judgment_human
         ON judgment_human.project_id IS NOT DISTINCT FROM serving.project_id
        AND judgment_human.article_id = serving.article_id
        AND judgment_human.prompt_id = prompt.id
        AND COALESCE(project.human_judgment_mode, 'prompt') <> 'summary'
       LEFT JOIN app."judgment_human_summary" judgment_human_summary
         ON judgment_human_summary.project_id = serving.project_id
        AND judgment_human_summary.article_id = serving.article_id
        AND COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
       WHERE serving.project_id = ${getSqlLiteral(firstRange.projectId)}
         AND serving.base_generation = ${getSqlLiteral(firstRange.baseGeneration)}
         AND EXISTS (
           SELECT 1
           FROM app.review_serving_snapshot_manifest snapshot
           WHERE snapshot.project_id = serving.project_id
             AND snapshot.snapshot_id = serving.snapshot_id
             AND snapshot.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
             AND json_extract_string(snapshot.composed_identity_json, '$.humanStatus.projectionIdentity') = ${getSqlLiteral(firstRange.projectionIdentity)}
             AND snapshot.snapshot_status IN ('candidate', 'active')
         )
       GROUP BY serving.project_id, serving.review_config_hash, serving.snapshot_id, serving.article_id, project.human_judgment_mode, enabled_prompt_count.prompt_count
     )
     UPDATE mart.review_article_serving_list_mode_state_v4 state
     SET ${['human_status = article_status.human_status', ...setClauses].join(', ')}
     FROM article_status
     WHERE state.project_id = article_status.project_id
       AND state.review_config_hash IS NOT DISTINCT FROM article_status.review_config_hash
       AND state.snapshot_id = article_status.snapshot_id
       AND state.article_id = article_status.article_id`,
      ]
}

const projectReviewServingHumanStatusClaimlessRanges = async (
  input: ProjectReviewServingHumanStatusRangesInput,
  database: ReviewServingHumanStatusProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: [],
        component: 'humanStatus',
        projectionManifests: [],
        records: [],
        repairDirtyWork: [],
        statements: getApplyHumanStatusServingRangeReplacementStatements(input),
      },
      database,
    )
  })

  return withDiagnosticsJson(
    {patchRowCount: 0, patchWatermark: 0},
    {
      phaseTimings,
      humanStatusProjector: {
        fullRebuildMode: 'range-serving-set-based',
        rangeCount: input.ranges.length,
        sourceRowCount: 0,
        writer: writer.diagnostics,
      },
    },
  )
}

export const projectReviewServingHumanStatusRanges = async (
  input: ProjectReviewServingHumanStatusRangesInput,
  database: ReviewServingHumanStatusProjectorDatabase = getAppDatabaseService() as ReviewServingHumanStatusProjectorDatabase,
) => {
  return projectReviewServingHumanStatusClaimlessRanges(input, database)
}

export const projectReviewServingHumanStatusPatches = async (
  input: ProjectReviewServingHumanStatusInput,
  database: ReviewServingHumanStatusProjectorDatabase = getAppDatabaseService() as ReviewServingHumanStatusProjectorDatabase,
) => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const patchWatermark = getPatchWatermark(input.claims)

  if (input.claims.length === 0) {
    return projectReviewServingHumanStatusClaimlessRanges({ranges: [input]}, database)
  }

  const promptConfigRows = await measure('promptConfigQueryMs', async () => {
    return getReviewServingProjectPromptConfigRows(input.projectId, database)
  })
  const projectSettings = await measure('projectSettingsQueryMs', async () => {
    return getReviewServingProjectReviewSettings(input.projectId, database)
  })
  const currentSummaryReviewConfigHash =
    projectSettings === null
      ? null
      : getReviewServingReviewConfigHash({...projectSettings, humanJudgmentMode: 'summary', promptConfigRows})
  const currentReviewConfigHash =
    projectSettings === null ? null : getReviewServingReviewConfigHash({...projectSettings, promptConfigRows})
  const [judgmentRows, promptRows, articleRows, projectRows] = await measure('sourceQueryMs', async () => {
    return Promise.all([
      getJudgmentDeltaRows(input, database, promptConfigRows),
      getPromptScopedRows(input, database),
      getArticleScopedRows(input, database, promptConfigRows),
      getProjectScopedRows(input, database, promptConfigRows),
    ])
  })
  const rows = [...judgmentRows, ...promptRows, ...articleRows, ...projectRows]
  const recordRows = measureSync('recordTransformMs', () => {
    return rows.flatMap((row) => {
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
  })
  const writer = await measure('writerMs', async () => {
    const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false
    const servingStatements = [
      getApplyHumanStatusServingStatement({
        baseGeneration: input.baseGeneration,
        currentSummaryReviewConfigHash,
        currentReviewConfigHash,
        includeExistingPatchRows: false,
        patchWatermark,
        projectId: input.projectId,
        projectionIdentity: input.projectionIdentity,
        recordRows,
      }),
    ].flatMap((statement) => {
      return statement === null ? [] : [statement]
    })

    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
        component: 'humanStatus',
        projectionManifests: shouldAcknowledgeClaims ? [getHumanStatusPatchManifest(input)] : [],
        records: [],
        statements: servingStatements,
        watermark: !shouldAcknowledgeClaims
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
  })

  return withDiagnosticsJson(
    {patchRowCount: 0, patchWatermark},
    getHumanStatusDiagnosticsJson({phaseTimings, sourceRowCount: rows.length, writer: writer.diagnostics}),
  )
}
