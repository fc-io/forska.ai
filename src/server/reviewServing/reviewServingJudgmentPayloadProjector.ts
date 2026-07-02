import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {type ReviewServingListMode} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {getReviewServingPayloadPatchManifest} from './reviewServingDisplayPayloadProjector.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingJudgmentPayloadProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingJudgmentPayloadInput = {
  acknowledgeClaims?: boolean
  baseGeneration?: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims?: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion?: string
  listModeKeys: readonly ReviewServingListMode[]
  modelId: string
  projectId: string
  projectionIdentity?: string
  reviewConfigHash: string
  snapshotId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type JudgmentPayloadKind = 'human' | 'llm'

type LlmJudgmentPayloadRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: readonly string[] | null
  articleId: string
  assessmentComment: string | null
  assessmentCreatedAt: Date | string | null
  assessmentId: string | null
  assessmentIsCorrect: boolean | null
  assessmentUpdatedAt: Date | string | null
  chunkingStrategy: string | null
  confidenceOriginal: number | null
  explanation: string | null
  isAnswered: boolean | null
  judgmentCreatedAt: Date | string | null
  judgmentId: string | null
  judgmentUpdatedAt: Date | string | null
  modelId: string | null
  placeholderKind: string | null
  promptCriteriaDisposition: string | null
  promptHeading: string | null
  promptId: string
  promptOrder: number | null
  promptOriginalText: string
  promptType: string | null
  quotes: ReviewServingIdentityValue | string | null
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  modelDisplayName: string | null
  modelMetadataJson: ReviewServingIdentityValue | string | null
  modelProvider: string | null
  modelThinking: string | null
  modelVersion: string | null
}

type HumanJudgmentPayloadRow = {
  answer: string | null
  articleId: string
  comment: string | null
  humanJudgmentCreatedAt: Date | string | null
  humanJudgmentId: string | null
  humanJudgmentUpdatedAt: Date | string | null
  isAnswered: boolean | null
  payloadReferenceKind: 'human_prompt' | 'human_summary'
  promptCriteriaDisposition: string | null
  promptHeading: string | null
  promptId: string
  promptOrder: number | null
  promptOriginalText: string | null
  promptType: string | null
}

const rowNumberSql = ['row', 'number'].join('_')

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[] = []) => {
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
  alias?: string
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
}) => {
  const columnPrefix = input.alias === undefined ? '' : `${input.alias}.`
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND ${columnPrefix}article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND ${columnPrefix}article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
          ${endPredicate}`
}

const getActiveArticleCte = (input: ProjectReviewServingJudgmentPayloadInput) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyArticleCte = getValuesCte('article_id', articleIds)
  const dirtyJoinSql =
    articleIds.length === 0 ? '' : 'INNER JOIN article_id_filter dirty ON dirty.article_id = scope.article_id'

  return `${dirtyArticleCte}${dirtyArticleCte.length > 0 ? ',' : ''}
    active_article AS (
      SELECT scope.article_id
      FROM mart.project_scope_article scope
      ${dirtyJoinSql}
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        ${getArticleRangePredicate({alias: 'scope', ...input})}
    )`
}

const parseJsonValue = (value: ReviewServingIdentityValue | string | null) => {
  if (typeof value !== 'string') {
    return value ?? null
  }

  try {
    return JSON.parse(value) as ReviewServingIdentityValue
  } catch (_error) {
    return value
  }
}

const getPayloadTimestamp = (value: Date | string | null) => {
  return value instanceof Date ? value.toISOString() : value
}

const getLlmListModeKeys = (listModeKeys: readonly ReviewServingListMode[]) => {
  return listModeKeys.filter((listModeKey) => {
    return listModeKey === 'llm' || listModeKey === 'both'
  })
}

const getHumanListModeKeys = (listModeKeys: readonly ReviewServingListMode[]) => {
  return listModeKeys.filter((listModeKey) => {
    return listModeKey === 'human' || listModeKey === 'both'
  })
}

const getRequestedPayloadKinds = (listModeKeys: readonly ReviewServingListMode[]) => {
  return [
    getLlmListModeKeys(listModeKeys).length > 0 ? 'llm' : null,
    getHumanListModeKeys(listModeKeys).length > 0 ? 'human' : null,
  ].filter((payloadKind): payloadKind is JudgmentPayloadKind => {
    return payloadKind !== null
  })
}

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getPayloadManifestInputs = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return claims.length === 0
    || input.acknowledgeClaims === false
    || input.baseGeneration === undefined
    || input.definitionVersion === undefined
    || input.projectionIdentity === undefined
    ? []
    : [
        getReviewServingPayloadPatchManifest(
          {
            baseGeneration: input.baseGeneration,
            claims,
            definitionVersion: input.definitionVersion,
            projectId: input.projectId,
            projectionIdentity: input.projectionIdentity,
          },
          'payload',
        ),
      ]
}

const getPayloadWatermark = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  const sourceHighWaterMark = Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )

  return getPayloadManifestInputs(input, claims).length === 0
    ? undefined
    : {
        projectId: input.projectId,
        projectionComponent: 'payload' as const,
        projectorName: 'review-serving-judgment-payload-projector',
        sourceHighWaterMark,
        sourcePartition: claims[0]?.sourcePartition ?? 'review-change',
      }
}

const getPayloadAcknowledgements = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return claims.length > 0 && input.acknowledgeClaims !== false ? claims : []
}

const getPayloadProjectionManifests = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return getPayloadManifestInputs(input, claims)
}

const getLlmJudgmentRows = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  return getLlmListModeKeys(input.listModeKeys).length === 0
    ? []
    : database.queryJson<LlmJudgmentPayloadRow>(`
        WITH ${getActiveArticleCte(input)},
        enabled_prompt AS (
          SELECT
            prompt.id AS prompt_id,
            project_prompt.prompt_order,
            prompt.original_text AS prompt_original_text,
            prompt.prompt_heading,
            prompt.type AS prompt_type,
            project_prompt.criteria_disposition AS prompt_criteria_disposition
          FROM app.project_prompt project_prompt
          INNER JOIN app.prompt prompt
            ON prompt.id = project_prompt.prompt_id
          WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
            AND project_prompt.enabled
            AND NOT project_prompt.archived
            AND COALESCE(prompt.archived, FALSE) = FALSE
        ),
        latest_judgment AS (
          SELECT
            judgment.*,
            ${rowNumberSql}() OVER (PARTITION BY judgment.article_id, judgment.prompt_id ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC) AS judgment_rank
          FROM app."judgment" judgment
          INNER JOIN active_article active
            ON active.article_id = judgment.article_id
          WHERE judgment.model_id = ${getSqlLiteral(input.modelId)}
            AND judgment.use_title = ${getSqlLiteral(input.useTitle)}
            AND judgment.use_abstract = ${getSqlLiteral(input.useAbstract)}
            AND judgment.use_fulltext = ${getSqlLiteral(input.useFulltext)}
            AND judgment.use_fulltext_no_images = ${getSqlLiteral(input.useFulltextNoImages)}
            AND judgment.deleted_at IS NULL
        )
        SELECT
          active.article_id AS articleId,
          prompt.prompt_id AS promptId,
          prompt.prompt_order AS promptOrder,
          judgment.id AS judgmentId,
          judgment.model_id AS modelId,
          judgment.created_at AS judgmentCreatedAt,
          judgment.updated_at AS judgmentUpdatedAt,
          judgment.chunking_strategy AS chunkingStrategy,
          judgment.is_answered AS isAnswered,
          judgment.answered_original AS answeredOriginal,
          judgment.answered_original_as_array AS answeredOriginalAsArray,
          judgment.confidence_original AS confidenceOriginal,
          judgment.explanation,
          judgment.quotes,
          judgment.snapshot_project_id AS snapshotProjectId,
          judgment.snapshot_project_model_name AS snapshotProjectModelName,
          COALESCE(model.display_name, model.name, judgment.snapshot_project_model_name) AS modelDisplayName,
          model.metadata_json AS modelMetadataJson,
          provider_connection.provider_kind AS modelProvider,
          json_extract_string(model.metadata_json, '$.options.thinking') AS modelThinking,
          model.variant AS modelVersion,
          prompt.prompt_original_text AS promptOriginalText,
          prompt.prompt_heading AS promptHeading,
          prompt.prompt_type AS promptType,
          prompt.prompt_criteria_disposition AS promptCriteriaDisposition,
          assessment.id AS assessmentId,
          assessment.assessment_is_correct AS assessmentIsCorrect,
          assessment.assessment_comment AS assessmentComment,
          assessment.created_at AS assessmentCreatedAt,
          assessment.updated_at AS assessmentUpdatedAt,
          CASE WHEN judgment.id IS NULL THEN 'llm.unanswered' ELSE NULL END AS placeholderKind
        FROM active_article active
        CROSS JOIN enabled_prompt prompt
        LEFT JOIN latest_judgment judgment
          ON judgment.article_id = active.article_id
          AND judgment.prompt_id = prompt.prompt_id
          AND judgment.judgment_rank = 1
        LEFT JOIN app.model model
          ON model.id = COALESCE(judgment.model_id, ${getSqlLiteral(input.modelId)})
        LEFT JOIN app.provider_connection provider_connection
          ON provider_connection.id = model.provider_connection_id
        LEFT JOIN app."judgment_assessment" assessment
          ON assessment.judgment_id = judgment.id
        ORDER BY active.article_id ASC, prompt.prompt_order ASC NULLS LAST, prompt.prompt_id ASC
      `)
}

const getHumanJudgmentRows = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  return getHumanListModeKeys(input.listModeKeys).length === 0
    ? []
    : database.queryJson<HumanJudgmentPayloadRow>(`
        WITH ${getActiveArticleCte(input)},
        enabled_prompt AS (
          SELECT
            prompt.id AS prompt_id,
            project_prompt.prompt_order,
            prompt.original_text AS prompt_original_text,
            prompt.prompt_heading,
            prompt.type AS prompt_type,
            project_prompt.criteria_disposition AS prompt_criteria_disposition
          FROM app.project_prompt project_prompt
          INNER JOIN app.prompt prompt
            ON prompt.id = project_prompt.prompt_id
          WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
            AND project_prompt.enabled
            AND NOT project_prompt.archived
            AND COALESCE(prompt.archived, FALSE) = FALSE
        )
        SELECT
          active.article_id AS articleId,
          prompt.prompt_id AS promptId,
          prompt.prompt_order AS promptOrder,
          judgment_human.id AS humanJudgmentId,
          judgment_human.is_answered AS isAnswered,
          judgment_human.answer,
          judgment_human.comment,
          judgment_human.created_at AS humanJudgmentCreatedAt,
          judgment_human.updated_at AS humanJudgmentUpdatedAt,
          'human_prompt' AS payloadReferenceKind,
          prompt.prompt_original_text AS promptOriginalText,
          prompt.prompt_heading AS promptHeading,
          prompt.prompt_type AS promptType,
          prompt.prompt_criteria_disposition AS promptCriteriaDisposition
        FROM active_article active
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
          AND COALESCE(project.human_judgment_mode, 'prompt') = 'prompt'
        INNER JOIN app."judgment_human" judgment_human
          ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
          AND judgment_human.article_id = active.article_id
        INNER JOIN enabled_prompt prompt
          ON prompt.prompt_id = judgment_human.prompt_id
        UNION ALL
        SELECT
          active.article_id AS articleId,
          'summary' AS promptId,
          -1 AS promptOrder,
          judgment_human_summary.id AS humanJudgmentId,
          judgment_human_summary.answer IS NOT NULL AS isAnswered,
          judgment_human_summary.answer,
          NULL AS comment,
          judgment_human_summary.created_at AS humanJudgmentCreatedAt,
          judgment_human_summary.updated_at AS humanJudgmentUpdatedAt,
          'human_summary' AS payloadReferenceKind,
          'Overall human screening decision' AS promptOriginalText,
          NULL AS promptHeading,
          'summary' AS promptType,
          NULL AS promptCriteriaDisposition
        FROM active_article active
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
          AND COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
        INNER JOIN app."judgment_human_summary" judgment_human_summary
          ON judgment_human_summary.project_id = ${getSqlLiteral(input.projectId)}
          AND judgment_human_summary.article_id = active.article_id
        ORDER BY articleId ASC, promptOrder ASC NULLS LAST, promptId ASC
      `)
}

const getAssessmentPayload = (row: LlmJudgmentPayloadRow) => {
  return row.assessmentId === null
    ? []
    : [
        {
          assessmentComment: row.assessmentComment,
          assessmentIsCorrect: row.assessmentIsCorrect ?? false,
          createdAt: getPayloadTimestamp(row.assessmentCreatedAt),
          id: row.assessmentId,
          judgmentId: row.judgmentId,
          updatedAt: getPayloadTimestamp(row.assessmentUpdatedAt),
        },
      ]
}

const getPromptDisplayPayload = (row: {
  promptCriteriaDisposition: string | null
  promptHeading: string | null
  promptId: string
  promptOrder: number | null
  promptOriginalText: string | null
  promptType: string | null
}): ReviewServingIdentityValue => {
  return {
    criteriaDisposition: row.promptCriteriaDisposition,
    id: row.promptId,
    order: row.promptOrder,
    originalText: row.promptOriginalText ?? '',
    promptHeading: row.promptHeading,
    type: row.promptType,
  }
}

const getModelDisplayPayload = (row: LlmJudgmentPayloadRow): ReviewServingIdentityValue => {
  return {
    id: row.modelId,
    metadataJson: parseJsonValue(row.modelMetadataJson),
    name: row.modelDisplayName,
    provider: row.modelProvider,
    thinking: row.modelThinking,
    version: row.modelVersion,
  }
}

const getLlmJudgmentPayload = (row: LlmJudgmentPayloadRow): ReviewServingIdentityValue => {
  return {
    assessments: getAssessmentPayload(row),
    chunkingStrategy: row.chunkingStrategy,
    confidenceOriginal: row.confidenceOriginal,
    createdAt: getPayloadTimestamp(row.judgmentCreatedAt),
    explanation: row.explanation,
    id: row.judgmentId ?? `placeholder:${row.promptId}`,
    isAnswered: row.isAnswered ?? false,
    model: getModelDisplayPayload(row),
    payloadReference: {kind: row.placeholderKind === null ? 'llm_judgment' : 'placeholder', judgmentId: row.judgmentId},
    placeholderKind: row.placeholderKind,
    prompt: getPromptDisplayPayload(row),
    quotes: parseJsonValue(row.quotes),
    snapshotProjectId: row.snapshotProjectId,
    snapshotProjectModelName: row.snapshotProjectModelName,
    updatedAt: getPayloadTimestamp(row.judgmentUpdatedAt),
  }
}

const getHumanJudgmentPayload = (row: HumanJudgmentPayloadRow): ReviewServingIdentityValue => {
  return {
    answer: row.answer,
    comment: row.comment,
    createdAt: getPayloadTimestamp(row.humanJudgmentCreatedAt),
    id: row.humanJudgmentId,
    isAnswered: row.isAnswered ?? false,
    payloadReference: {humanJudgmentId: row.humanJudgmentId, kind: row.payloadReferenceKind},
    prompt: getPromptDisplayPayload(row),
    updatedAt: getPayloadTimestamp(row.humanJudgmentUpdatedAt),
  }
}

const getLlmJudgmentRecord = (input: {
  input: ProjectReviewServingJudgmentPayloadInput
  listModeKey: ReviewServingListMode
  row: LlmJudgmentPayloadRow
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'payload_kind',
      'article_id',
      'prompt_id',
    ],
    table: 'mart.review_article_judgment_detail_serving_v4',
    values: {
      answered_original: input.row.answeredOriginal,
      answered_original_as_array: input.row.answeredOriginalAsArray,
      article_id: input.row.articleId,
      detail_updated_at: input.row.judgmentUpdatedAt ?? new Date(),
      judgment_id: input.row.judgmentId,
      judgment_payload_json: getLlmJudgmentPayload(input.row),
      list_mode_key: input.listModeKey,
      model_id: input.row.modelId,
      payload_kind: 'llm',
      placeholder_kind: input.row.placeholderKind,
      project_id: input.input.projectId,
      prompt_id: input.row.promptId,
      prompt_order: input.row.promptOrder,
      review_config_hash: input.input.reviewConfigHash,
      snapshot_id: input.input.snapshotId,
    },
  }
}

const getHumanJudgmentRecord = (input: {
  input: ProjectReviewServingJudgmentPayloadInput
  listModeKey: ReviewServingListMode
  row: HumanJudgmentPayloadRow
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'payload_kind',
      'article_id',
      'prompt_id',
    ],
    table: 'mart.review_article_judgment_detail_serving_v4',
    values: {
      answered_original: input.row.answer,
      answered_original_as_array: input.row.answer === null ? null : [input.row.answer],
      article_id: input.row.articleId,
      detail_updated_at: input.row.humanJudgmentUpdatedAt ?? new Date(),
      judgment_id: input.row.humanJudgmentId,
      judgment_payload_json: getHumanJudgmentPayload(input.row),
      list_mode_key: input.listModeKey,
      model_id: null,
      payload_kind: 'human',
      placeholder_kind: null,
      project_id: input.input.projectId,
      prompt_id: input.row.promptId,
      prompt_order: input.row.promptOrder,
      review_config_hash: input.input.reviewConfigHash,
      snapshot_id: input.input.snapshotId,
    },
  }
}

const getReplacementDeleteStatements = (
  input: ProjectReviewServingJudgmentPayloadInput,
  payloadKinds: readonly JudgmentPayloadKind[],
) => {
  const claims = input.claims ?? []
  const articleIds = getClaimArticleIds(claims)
  const shouldReplaceBroadScope = claims.some((claim) => {
    return claim.scopeKind === 'project' || claim.scopeKind === 'prompt'
  })
  const shouldReplaceChunkRange = hasChunkArticleRange(input)

  return articleIds.length === 0 && !shouldReplaceBroadScope && !shouldReplaceChunkRange
    ? []
    : payloadKinds.flatMap((payloadKind) => {
        const listModeKeys =
          payloadKind === 'llm' ? getLlmListModeKeys(input.listModeKeys) : getHumanListModeKeys(input.listModeKeys)

        return listModeKeys.map((listModeKey) => {
          const articlePredicate = articleIds.length === 0 ? {} : {article_id: articleIds}

          if (shouldReplaceChunkRange && articleIds.length === 0) {
            return `DELETE FROM mart.review_article_judgment_detail_serving_v4
              WHERE project_id = ${getSqlLiteral(input.projectId)}
                AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
                AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
                AND list_mode_key = ${getSqlLiteral(listModeKey)}
                AND payload_kind = ${getSqlLiteral(payloadKind)}
                ${getArticleRangePredicate(input)}`
          }

          return getDeleteReviewServingProjectorRowsStatement({
            predicates: {
              ...articlePredicate,
              list_mode_key: listModeKey,
              payload_kind: payloadKind,
              project_id: input.projectId,
              review_config_hash: input.reviewConfigHash,
              snapshot_id: input.snapshotId,
            },
            table: 'mart.review_article_judgment_detail_serving_v4',
          })
        })
      })
}

export const projectReviewServingJudgmentPayloadRows = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase = getAppDatabaseService(),
) => {
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
  const [llmRows, humanRows] = await measure('sourceQueryMs', async () => {
    return Promise.all([getLlmJudgmentRows(input, database), getHumanJudgmentRows(input, database)])
  })
  const {humanRecords, llmRecords} = measureSync('recordTransformMs', () => {
    const nextLlmRecords = llmRows.flatMap((row) => {
      return getLlmListModeKeys(input.listModeKeys).map((listModeKey) => {
        return getLlmJudgmentRecord({input, listModeKey, row})
      })
    })
    const nextHumanRecords = humanRows.flatMap((row) => {
      return getHumanListModeKeys(input.listModeKeys).map((listModeKey) => {
        return getHumanJudgmentRecord({input, listModeKey, row})
      })
    })

    return {humanRecords: nextHumanRecords, llmRecords: nextLlmRecords}
  })
  const claims = input.claims ?? []

  const writerResult = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: getPayloadAcknowledgements(input, claims),
        component: 'payload',
        projectionManifests: getPayloadProjectionManifests(input, claims),
        records: [...llmRecords, ...humanRecords],
        statements: getReplacementDeleteStatements(input, getRequestedPayloadKinds(input.listModeKeys)),
        watermark: getPayloadWatermark(input, claims),
      },
      database,
    )
  })

  return {
    diagnosticsJson: {
      judgmentPayloadProjector: {
        humanSourceRowCount: humanRows.length,
        llmSourceRowCount: llmRows.length,
        writer: writerResult.diagnostics,
      },
      phaseTimings,
    },
    humanRowCount: humanRecords.length,
    llmRowCount: llmRecords.length,
  }
}
