import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {buildPromptConfigHash} from './reviewProjectionIdentity.ts'
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

export type ReviewServingHumanStatusProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingHumanStatusInput = {
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

const getProjectPromptConfigRows = async (
  projectId: string,
  database: Pick<ReviewServingHumanStatusProjectorDatabase, 'queryJson'>,
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
            delta.tombstone OR delta.source_operation = 'delete' AS tombstone,
            delta.payload_json AS payloadJson,
            COALESCE(judgment_human.answer, judgment_human_summary.answer) AS humanAnsweredValue,
            CASE
              WHEN delta.tombstone OR delta.source_operation = 'delete' THEN NULL
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
          judgment_human.prompt_id AS promptId,
          judgment_human.prompt_id AS promptOrSummaryKey,
          'update' AS sourceOperation,
          project_prompt.prompt_id IS NULL AS tombstone,
          NULL AS payloadJson,
          judgment_human.answer AS humanAnsweredValue,
          CASE
            WHEN NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NULL THEN 'unanswered'
            ELSE 'answered'
          END AS humanStatusKey,
          judgment_human.updated_at AS latestHumanUpdatedAt,
          COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
          NULL AS answerSchemaHash,
          'prompt-v1' AS settingsVersion,
          NULL AS thresholdVersion,
          project_prompt.prompt_order AS promptOrder
        FROM prompt_id_filter dirty_prompt
        INNER JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
        INNER JOIN app."judgment_human" judgment_human
          ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
          AND judgment_human.article_id = scope.article_id
          AND judgment_human.prompt_id = dirty_prompt.prompt_id
        LEFT JOIN app.prompt prompt
          ON prompt.id = judgment_human.prompt_id
        LEFT JOIN app.project_prompt project_prompt
          ON project_prompt.project_id = ${getSqlLiteral(input.projectId)}
          AND project_prompt.prompt_id = judgment_human.prompt_id
          AND project_prompt.enabled = TRUE
          AND COALESCE(prompt.archived, FALSE) = FALSE
        ORDER BY judgment_human.prompt_id ASC, scope.article_id ASC
      `)
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
      prompt_config_hash: getPromptConfigHash(input.row),
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
  database: ReviewServingHumanStatusProjectorDatabase = getAppDatabaseService(),
) => {
  const promptConfigRows = await getProjectPromptConfigRows(input.projectId, database)
  const [judgmentRows, promptRows] = await Promise.all([
    getJudgmentDeltaRows(input, database, promptConfigRows),
    getPromptScopedRows(input, database),
  ])
  const patchWatermark = getPatchWatermark(input.claims)
  const rows = [...judgmentRows, ...promptRows]
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
      acknowledgements: input.claims,
      component: 'humanStatus',
      projectionManifests: input.claims.length === 0 ? [] : [getHumanStatusPatchManifest(input)],
      records,
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
