import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingListMode} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {getReviewServingPayloadPatchManifest} from './reviewServingDisplayPayloadProjector.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
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

const getListModeValuesSql = (listModeKeys: readonly ReviewServingListMode[]) => {
  return listModeKeys
    .map((listModeKey) => {
      return `(${getSqlLiteral(listModeKey)})`
    })
    .join(', ')
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

const getSqlPromptDisplayPayload = (alias: string) => {
  return `json_object(
    'criteriaDisposition', ${alias}.prompt_criteria_disposition,
    'id', ${alias}.prompt_id,
    'order', ${alias}.prompt_order,
    'originalText', COALESCE(${alias}.prompt_original_text, ''),
    'promptHeading', ${alias}.prompt_heading,
    'type', ${alias}.prompt_type
  )`
}

const getSqlLlmJudgmentPayload = (alias: string) => {
  return `json_object(
    'assessments', CASE WHEN ${alias}.assessment_id IS NULL THEN [] ELSE [json_object(
      'assessmentComment', ${alias}.assessment_comment,
      'assessmentIsCorrect', COALESCE(${alias}.assessment_is_correct, FALSE),
      'createdAt', ${alias}.assessment_created_at,
      'id', ${alias}.assessment_id,
      'judgmentId', ${alias}.judgment_id,
      'updatedAt', ${alias}.assessment_updated_at
    )] END,
    'chunkingStrategy', ${alias}.chunking_strategy,
    'confidenceOriginal', ${alias}.confidence_original,
    'createdAt', ${alias}.judgment_created_at,
    'explanation', ${alias}.explanation,
    'id', COALESCE(${alias}.judgment_id, concat('placeholder:', ${alias}.prompt_id)),
    'isAnswered', COALESCE(${alias}.is_answered, FALSE),
    'model', json_object(
      'id', ${alias}.model_id,
      'metadataJson', ${alias}.model_metadata_json,
      'name', ${alias}.model_display_name,
      'provider', ${alias}.model_provider,
      'thinking', ${alias}.model_thinking,
      'version', ${alias}.model_version
    ),
    'payloadReference', json_object('kind', CASE WHEN ${alias}.placeholder_kind IS NULL THEN 'llm_judgment' ELSE 'placeholder' END, 'judgmentId', ${alias}.judgment_id),
    'placeholderKind', ${alias}.placeholder_kind,
    'prompt', ${getSqlPromptDisplayPayload(alias)},
    'quotes', ${alias}.quotes,
    'snapshotProjectId', ${alias}.snapshot_project_id,
    'snapshotProjectModelName', ${alias}.snapshot_project_model_name,
    'updatedAt', ${alias}.judgment_updated_at
  )`
}

const getSqlHumanJudgmentPayload = (alias: string) => {
  return `json_object(
    'answer', ${alias}.answer,
    'comment', ${alias}.comment,
    'createdAt', ${alias}.human_judgment_created_at,
    'id', ${alias}.human_judgment_id,
    'isAnswered', COALESCE(${alias}.is_answered, FALSE),
    'payloadReference', json_object('humanJudgmentId', ${alias}.human_judgment_id, 'kind', ${alias}.payload_reference_kind),
    'prompt', ${getSqlPromptDisplayPayload(alias)},
    'updatedAt', ${alias}.human_judgment_updated_at
  )`
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

const getLlmJudgmentDirectInsertStatement = (input: ProjectReviewServingJudgmentPayloadInput) => {
  const listModeKeys = getLlmListModeKeys(input.listModeKeys)

  return listModeKeys.length === 0
    ? null
    : `
      INSERT INTO mart.review_article_judgment_detail_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        list_mode_key,
        payload_kind,
        article_id,
        prompt_id,
        prompt_order,
        judgment_id,
        model_id,
        answered_original,
        answered_original_as_array,
        judgment_payload_json,
        placeholder_kind,
        detail_updated_at
      )
      WITH ${getActiveArticleCte(input)},
      list_mode(list_mode_key) AS (SELECT * FROM (VALUES ${getListModeValuesSql(listModeKeys)})),
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
      ),
      payload AS (
        SELECT
          active.article_id,
          prompt.prompt_id,
          prompt.prompt_order,
          judgment.id AS judgment_id,
          judgment.model_id,
          judgment.created_at AS judgment_created_at,
          judgment.updated_at AS judgment_updated_at,
          judgment.chunking_strategy,
          judgment.is_answered,
          judgment.answered_original,
          judgment.answered_original_as_array,
          judgment.confidence_original,
          judgment.explanation,
          judgment.quotes,
          judgment.snapshot_project_id,
          judgment.snapshot_project_model_name,
          COALESCE(model.display_name, model.name, judgment.snapshot_project_model_name) AS model_display_name,
          model.metadata_json AS model_metadata_json,
          provider_connection.provider_kind AS model_provider,
          json_extract_string(model.metadata_json, '$.options.thinking') AS model_thinking,
          model.variant AS model_version,
          prompt.prompt_original_text,
          prompt.prompt_heading,
          prompt.prompt_type,
          prompt.prompt_criteria_disposition,
          assessment.id AS assessment_id,
          assessment.assessment_is_correct,
          assessment.assessment_comment,
          assessment.created_at AS assessment_created_at,
          assessment.updated_at AS assessment_updated_at,
          CASE WHEN judgment.id IS NULL THEN 'llm.unanswered' ELSE NULL END AS placeholder_kind
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
      )
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        list_mode.list_mode_key,
        'llm' AS payload_kind,
        payload.article_id,
        payload.prompt_id,
        payload.prompt_order,
        payload.judgment_id,
        payload.model_id,
        payload.answered_original,
        payload.answered_original_as_array,
        ${getSqlLlmJudgmentPayload('payload')} AS judgment_payload_json,
        payload.placeholder_kind,
        COALESCE(payload.judgment_updated_at, current_timestamp) AS detail_updated_at
      FROM payload
      CROSS JOIN list_mode
      ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id) DO UPDATE SET
        prompt_order = excluded.prompt_order,
        judgment_id = excluded.judgment_id,
        model_id = excluded.model_id,
        answered_original = excluded.answered_original,
        answered_original_as_array = excluded.answered_original_as_array,
        judgment_payload_json = excluded.judgment_payload_json,
        placeholder_kind = excluded.placeholder_kind,
        detail_updated_at = excluded.detail_updated_at
    `
}

const getHumanJudgmentDirectInsertStatement = (input: ProjectReviewServingJudgmentPayloadInput) => {
  const listModeKeys = getHumanListModeKeys(input.listModeKeys)

  return listModeKeys.length === 0
    ? null
    : `
      INSERT INTO mart.review_article_judgment_detail_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        list_mode_key,
        payload_kind,
        article_id,
        prompt_id,
        prompt_order,
        judgment_id,
        model_id,
        answered_original,
        answered_original_as_array,
        judgment_payload_json,
        placeholder_kind,
        detail_updated_at
      )
      WITH ${getActiveArticleCte(input)},
      list_mode(list_mode_key) AS (SELECT * FROM (VALUES ${getListModeValuesSql(listModeKeys)})),
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
      payload AS (
        SELECT
          active.article_id,
          prompt.prompt_id,
          prompt.prompt_order,
          judgment_human.id AS human_judgment_id,
          judgment_human.is_answered,
          judgment_human.answer,
          judgment_human.comment,
          judgment_human.created_at AS human_judgment_created_at,
          judgment_human.updated_at AS human_judgment_updated_at,
          'human_prompt' AS payload_reference_kind,
          prompt.prompt_original_text,
          prompt.prompt_heading,
          prompt.prompt_type,
          prompt.prompt_criteria_disposition
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
          active.article_id,
          'summary' AS prompt_id,
          -1 AS prompt_order,
          judgment_human_summary.id AS human_judgment_id,
          judgment_human_summary.answer IS NOT NULL AS is_answered,
          judgment_human_summary.answer,
          NULL AS comment,
          judgment_human_summary.created_at AS human_judgment_created_at,
          judgment_human_summary.updated_at AS human_judgment_updated_at,
          'human_summary' AS payload_reference_kind,
          'Overall human screening decision' AS prompt_original_text,
          NULL AS prompt_heading,
          'summary' AS prompt_type,
          NULL AS prompt_criteria_disposition
        FROM active_article active
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
          AND COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
        INNER JOIN app."judgment_human_summary" judgment_human_summary
          ON judgment_human_summary.project_id = ${getSqlLiteral(input.projectId)}
          AND judgment_human_summary.article_id = active.article_id
      )
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        list_mode.list_mode_key,
        'human' AS payload_kind,
        payload.article_id,
        payload.prompt_id,
        payload.prompt_order,
        payload.human_judgment_id AS judgment_id,
        NULL AS model_id,
        payload.answer AS answered_original,
        CASE WHEN payload.answer IS NULL THEN NULL ELSE [payload.answer] END AS answered_original_as_array,
        ${getSqlHumanJudgmentPayload('payload')} AS judgment_payload_json,
        NULL AS placeholder_kind,
        COALESCE(payload.human_judgment_updated_at, current_timestamp) AS detail_updated_at
      FROM payload
      CROSS JOIN list_mode
      ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id) DO UPDATE SET
        prompt_order = excluded.prompt_order,
        judgment_id = excluded.judgment_id,
        model_id = excluded.model_id,
        answered_original = excluded.answered_original,
        answered_original_as_array = excluded.answered_original_as_array,
        judgment_payload_json = excluded.judgment_payload_json,
        placeholder_kind = excluded.placeholder_kind,
        detail_updated_at = excluded.detail_updated_at
    `
}

const getDirectJudgmentPayloadCount = async (
  input: ProjectReviewServingJudgmentPayloadInput & {payloadKind: JudgmentPayloadKind},
  database: ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  const listModeKeys =
    input.payloadKind === 'llm' ? getLlmListModeKeys(input.listModeKeys) : getHumanListModeKeys(input.listModeKeys)
  const articleIds = getClaimArticleIds(input.claims)
  const articlePredicate =
    articleIds.length === 0
      ? ''
      : `AND detail.article_id IN (${articleIds
          .map((articleId) => {
            return getSqlLiteral(articleId)
          })
          .join(', ')})`
  const [row] = await database.queryJson<{rowCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
    FROM mart.review_article_judgment_detail_serving_v4 detail
    WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
      AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND detail.payload_kind = ${getSqlLiteral(input.payloadKind)}
      AND detail.list_mode_key IN (${listModeKeys
        .map((listModeKey) => {
          return getSqlLiteral(listModeKey)
        })
        .join(', ')})
      ${articlePredicate}
      ${getArticleRangePredicate({alias: 'detail', ...input})}
  `)

  return row?.rowCount ?? 0
}

const projectReviewServingJudgmentPayloadRowsDirect = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase,
  measure: <T>(phase: string, operation: () => Promise<T>) => Promise<T>,
) => {
  const requestedPayloadKinds = getRequestedPayloadKinds(input.listModeKeys)
  const claims = input.claims ?? []
  const insertStatements = [
    getLlmJudgmentDirectInsertStatement(input),
    getHumanJudgmentDirectInsertStatement(input),
  ].filter((statement): statement is string => {
    return statement !== null
  })
  const writerResult = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: getPayloadAcknowledgements(input, claims),
        component: 'payload',
        projectionManifests: getPayloadProjectionManifests(input, claims),
        records: [],
        statements: [...getReplacementDeleteStatements(input, requestedPayloadKinds), ...insertStatements],
        watermark: getPayloadWatermark(input, claims),
      },
      database,
    )
  })
  const [llmRowCount, humanRowCount] = await measure('postWriteCountMs', async () => {
    return Promise.all([
      getLlmListModeKeys(input.listModeKeys).length === 0
        ? 0
        : getDirectJudgmentPayloadCount({...input, payloadKind: 'llm'}, database),
      getHumanListModeKeys(input.listModeKeys).length === 0
        ? 0
        : getDirectJudgmentPayloadCount({...input, payloadKind: 'human'}, database),
    ])
  })

  return {
    diagnosticsJson: {
      judgmentPayloadProjector: {
        directSqlWriter: true,
        humanMaterializedRecordCount: 0,
        humanSourceRowCount: 0,
        llmMaterializedRecordCount: 0,
        llmSourceRowCount: 0,
        materializedRecordCount: 0,
        writer: writerResult.diagnostics,
      },
    },
    humanRowCount,
    llmRowCount,
  }
}

export const projectReviewServingJudgmentPayloadRows = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  const phaseTimings: Record<string, number> = {}
  const measure = async <T>(phase: string, operation: () => Promise<T>) => {
    const startedAtMs = Date.now()
    const result = await operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }
  const result = await projectReviewServingJudgmentPayloadRowsDirect(input, database, measure)

  return {
    diagnosticsJson: {...result.diagnosticsJson, phaseTimings},
    humanRowCount: result.humanRowCount,
    llmRowCount: result.llmRowCount,
  }
}
