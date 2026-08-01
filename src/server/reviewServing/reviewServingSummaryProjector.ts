import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingCountAvailability,
} from './reviewServingContracts.ts'
import {type ReviewServingContributionRow} from './reviewServingContributionService.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingSummaryProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ReviewServingSummarySnapshotReductionInput = {
  requestId: string
  snapshots: readonly {
    hasSummaryRebuildChunks?: boolean
    projectId: string
    reviewConfigHash: string | null
    snapshotId: string
  }[]
}

export type ProjectReviewServingSummariesInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  chunkId?: string | null
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims: readonly ReviewServingDirtyWorkClaim[]
  listModeKeys: readonly string[]
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  requestId?: string | null
  reviewConfigHash: string
  selectedImportSnapshotId: string
  snapshotId: string
}

type SummaryContributionSourceRow = {
  answerId: number | null
  answerValue: string | null
  articleId: string
  availability: ReviewServingCountAvailability
  countKind: NamedReviewFastCountKey | null
  facetKind: string | null
  facetKey: string | null
  facetValue: string | null
  filterKey: string | null
  listModeKey: string | null
  promptId: string | null
  staleReason: string | null
  summaryIdentity: string
  summaryKind: 'count' | 'facet'
}

type SummaryContributionIdentity = Omit<SummaryContributionSourceRow, 'articleId'>

const summaryProjectorName = 'summary-projector'
const dynamicFilteredTotalFilterKey = 'filter:dynamic'
const promptDerivedSummaryStaleReason =
  'prompt-derived summary/facet buckets are built lazily by the matching filtered read'

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

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
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

const isDirectFullSummarySnapshotInput = (input: ProjectReviewServingSummariesInput) => {
  return input.claims.length === 0 && input.chunkStartArticleId == null && input.chunkEndArticleId == null
}

const isPartialFullSummarySnapshotInput = (input: ProjectReviewServingSummariesInput) => {
  return (
    input.claims.length === 0
    && !isDirectFullSummarySnapshotInput(input)
    && input.requestId !== null
    && input.requestId !== undefined
    && input.chunkId !== null
    && input.chunkId !== undefined
  )
}

const shouldProjectPromptDerivedSummaryBuckets = (input: ProjectReviewServingSummariesInput) => {
  return !isDirectFullSummarySnapshotInput(input) && !isPartialFullSummarySnapshotInput(input)
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

const getValuesCte = (columnName: string, values: readonly string[]) => {
  return values.length === 0
    ? ''
    : `${columnName}_filter(${columnName}) AS (SELECT * FROM (VALUES ${values
        .map((value) => {
          return `(${getSqlLiteral(value)})`
        })
        .join(', ')}))`
}

const getListModeCte = (listModeKeys: readonly string[]) => {
  return getValuesCte('list_mode_key', listModeKeys)
}

const getListModeFlagExpansionJoinSql = (stateAlias: string, listModeAlias: string) => {
  return `
          INNER JOIN list_mode_key_filter ${listModeAlias}_filter ON TRUE
          INNER JOIN LATERAL (
            VALUES
              ('llm', ${stateAlias}.has_llm_list_mode),
              ('human', ${stateAlias}.has_human_list_mode),
              ('both', ${stateAlias}.has_both_list_mode),
              ('unassessed', ${stateAlias}.has_unassessed_list_mode)
          ) ${listModeAlias}(list_mode_key, has_list_mode)
            ON ${listModeAlias}_filter.list_mode_key = ${listModeAlias}.list_mode_key
            AND ${listModeAlias}.has_list_mode IS TRUE`
}

const getDirtyArticleCte = (input: ProjectReviewServingSummariesInput, articleIds: readonly string[]) => {
  return articleIds.length > 0
    ? getValuesCte('article_id', articleIds)
    : `article_id_filter(article_id) AS (
        SELECT scope.article_id
        FROM mart.project_scope_article scope
        WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
          ${getArticleRangePredicate({alias: 'scope', ...input})}
      )`
}

const getSummaryDefinitionVersion = (identity: Pick<SummaryContributionIdentity, 'countKind'>) => {
  return identity.countKind === null
    ? null
    : namedReviewFastCountDefinitions[identity.countKind].summaryDefinitionVersion
}

const getSummaryContributionKey = (row: SummaryContributionIdentity) => {
  return getStableReviewServingJson(row as unknown as ReviewServingIdentityValue)
}

const parseSummaryContributionKey = (contributionKey: string): SummaryContributionIdentity | null => {
  try {
    return JSON.parse(contributionKey) as SummaryContributionIdentity
  } catch (_error) {
    return null
  }
}

const getSummaryContributionRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return getFullRebuildSummaryContributionRows(input, database, articleIds)
}

const getFullRebuildSummaryContributionRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
  articleIds: readonly string[] = [],
) => {
  return input.listModeKeys.length === 0
    ? []
    : database.queryJson<SummaryContributionSourceRow>(`
        WITH ${getDirtyArticleCte(input, articleIds)},
        ${getListModeCte(input.listModeKeys)},
        project_settings AS (
          SELECT COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = ${getSqlLiteral(input.projectId)}), 'prompt') AS human_judgment_mode
        ),
        scoped_serving AS (
          SELECT
            serving.article_id,
            list_mode_key.list_mode_key,
            list_mode_state.duplicate_flag,
            list_mode_state.conflict_flag,
            list_mode_state.human_status,
            list_mode_state.llm_status
          FROM article_id_filter dirty
          INNER JOIN mart.review_article_serving_base_v4 serving
            ON serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND serving.article_id = dirty.article_id
          INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
            ON list_mode_state.project_id = serving.project_id
            AND list_mode_state.review_config_hash = serving.review_config_hash
            AND list_mode_state.snapshot_id = serving.snapshot_id
            AND list_mode_state.article_id = serving.article_id
          ${getListModeFlagExpansionJoinSql('list_mode_state', 'list_mode_key')}
        ),
        selected_article AS (
          SELECT DISTINCT
            serving.article_id,
            CASE WHEN selected_base.tombstone THEN NULL ELSE selected_base.import_route_id END AS import_route_id,
            selected_hot.publication_year,
            CASE
              WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
              ELSE COALESCE(serving.duplicate_flag, FALSE)
            END AS duplicate_flag,
            CASE
              WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
              ELSE COALESCE(serving.conflict_flag, FALSE)
            END AS conflict_flag
          FROM scoped_serving serving
          LEFT JOIN mart.review_selected_article_import_current_v4 selected_base
            ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected_base.article_id = serving.article_id
          LEFT JOIN app.review_import_article_hot_field selected_hot
            ON selected_hot.import_route_id = selected_base.import_route_id
            AND selected_hot.article_id = selected_base.article_id
            AND selected_hot.source_record_key = selected_base.source_record_key
            AND NOT selected_hot.tombstone
        ),
        judgment_detail_source AS (
          SELECT
            detail.article_id,
            detail.payload_kind,
            detail.prompt_id,
            detail.is_answered,
            detail.answered_original,
            detail.answered_original_as_array
          FROM mart.review_article_judgment_detail_serving_v4 detail
          INNER JOIN article_id_filter dirty
            ON dirty.article_id = detail.article_id
          WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind IN ('llm', 'human')
        ),
        llm_detail AS (
          SELECT
            detail.article_id,
            detail.prompt_id,
            serving.list_mode_key,
            detail.answered_original,
            detail.answered_original_as_array
          FROM judgment_detail_source detail
          INNER JOIN scoped_serving serving
            ON serving.article_id = detail.article_id
            AND serving.list_mode_key IN ('llm', 'both')
          WHERE detail.payload_kind = 'llm'
        ),
        human_detail AS (
          SELECT
            detail.article_id,
            detail.prompt_id,
            serving.list_mode_key,
            detail.is_answered,
            detail.answered_original
          FROM judgment_detail_source detail
          INNER JOIN scoped_serving serving
            ON serving.article_id = detail.article_id
            AND serving.list_mode_key IN ('human', 'both')
          WHERE detail.payload_kind = 'human'
        ),
        queue_source AS (
          SELECT
            queue.article_id,
            queue.prompt_ids
          FROM mart.review_unassessed_queue_serving_v4 queue
          INNER JOIN article_id_filter dirty
            ON dirty.article_id = queue.article_id
          WHERE queue.project_id = ${getSqlLiteral(input.projectId)}
            AND queue.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND queue.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND queue.queue_kind = 'unassessed'
        ),
        queue_article_source AS (
          SELECT
            queue.article_id
          FROM mart.review_unassessed_queue_article_rank_serving_v4 queue
          INNER JOIN article_id_filter dirty
            ON dirty.article_id = queue.article_id
          WHERE queue.project_id = ${getSqlLiteral(input.projectId)}
            AND queue.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND queue.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND queue.queue_kind = 'unassessed'
        ),
        queue_prompt_source AS (
          SELECT
            queue.article_id,
            expanded_prompt.prompt_id
          FROM queue_source queue
          CROSS JOIN UNNEST(queue.prompt_ids) AS expanded_prompt(prompt_id)
        ),
        base_counts AS (
          SELECT serving.article_id AS articleId, 'count' AS summaryKind, 'review.list.total' AS countKind, 'list:all' AS filterKey, serving.list_mode_key AS listModeKey, 'review.list.total' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM scoped_serving serving
          UNION ALL
          SELECT serving.article_id AS articleId, 'count' AS summaryKind, 'review.list.filteredTotal' AS countKind, ${getSqlLiteral(dynamicFilteredTotalFilterKey)} AS filterKey, serving.list_mode_key AS listModeKey, 'review.list.filteredTotal' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'unavailable' AS availability, 'dynamic filter/search scopes require a precomputed filter signature' AS staleReason
          FROM scoped_serving serving
        ),
        selected_facets AS (
          SELECT selected.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.duplicateFlag' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.duplicateFlag' AS summaryIdentity, 'review' AS facetKind, 'duplicateFlag' AS facetKey, CAST(selected.duplicate_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL AS answerId, CAST(selected.duplicate_flag AS VARCHAR) AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_article selected WHERE selected.duplicate_flag IS NOT NULL
          UNION ALL
          SELECT selected.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.importRoute' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.importRoute' AS summaryIdentity, 'review' AS facetKind, 'importRoute' AS facetKey, selected.import_route_id AS facetValue, NULL AS promptId, NULL AS answerId, selected.import_route_id AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_article selected WHERE selected.import_route_id IS NOT NULL
          UNION ALL
          SELECT selected.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.publicationYear' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.publicationYear' AS summaryIdentity, 'review' AS facetKind, 'publicationYear' AS facetKey, CAST(selected.publication_year AS VARCHAR) AS facetValue, NULL AS promptId, NULL AS answerId, CAST(selected.publication_year AS VARCHAR) AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_article selected WHERE selected.publication_year IS NOT NULL
        ),
        llm_counts AS (
          SELECT llm.article_id AS articleId, 'count' AS summaryKind, 'review.llm.assessedByPrompt' AS countKind, concat('prompt:', llm.prompt_id) AS filterKey, llm.list_mode_key AS listModeKey, 'review.llm.assessedByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM llm_detail llm
          INNER JOIN selected_article selected ON selected.article_id = llm.article_id
          WHERE llm.list_mode_key IN ('llm', 'both') AND (llm.answered_original IS NOT NULL OR COALESCE(LENGTH(llm.answered_original_as_array), 0) > 0)
          UNION ALL
          SELECT queue.article_id AS articleId, 'count' AS summaryKind, 'review.llm.unassessedByPrompt' AS countKind, concat('prompt:', queue.prompt_id) AS filterKey, list_mode_key.list_mode_key AS listModeKey, 'review.llm.unassessedByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, queue.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM queue_prompt_source queue
          INNER JOIN selected_article selected ON selected.article_id = queue.article_id
          INNER JOIN scoped_serving list_mode_key ON list_mode_key.article_id = queue.article_id
          WHERE queue.prompt_id IS NOT NULL
          UNION ALL
          SELECT queue.article_id AS articleId, 'count' AS summaryKind, 'review.queue.unassessedReady' AS countKind, 'queue:ready' AS filterKey, list_mode_key.list_mode_key AS listModeKey, 'review.queue.unassessedReady' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM queue_article_source queue
          INNER JOIN selected_article selected ON selected.article_id = queue.article_id
          INNER JOIN scoped_serving list_mode_key
            ON list_mode_key.article_id = queue.article_id
            AND list_mode_key.list_mode_key = 'unassessed'
        ),
        human_counts AS (
          SELECT human.article_id AS articleId, 'count' AS summaryKind, 'review.human.reviewedByPrompt' AS countKind, concat('prompt:', human.prompt_id) AS filterKey, human.list_mode_key AS listModeKey, 'review.human.reviewedByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, human.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM human_detail human
          INNER JOIN selected_article selected ON selected.article_id = human.article_id
          CROSS JOIN project_settings
          WHERE human.list_mode_key IN ('human', 'both')
            AND COALESCE(human.is_answered, human.answered_original IS NOT NULL, FALSE)
            AND (
              (project_settings.human_judgment_mode = 'summary' AND human.prompt_id = 'summary')
              OR (project_settings.human_judgment_mode <> 'summary' AND human.prompt_id <> 'summary')
            )
        ),
        conflict_counts AS (
          SELECT llm.article_id AS articleId, 'count' AS summaryKind, 'review.both.conflictByPrompt' AS countKind, concat('prompt:', llm.prompt_id) AS filterKey, 'both' AS listModeKey, 'review.both.conflictByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM llm_detail llm
          INNER JOIN human_detail human
            ON human.article_id = llm.article_id
            AND human.prompt_id = llm.prompt_id
            AND human.list_mode_key = llm.list_mode_key
            AND human.answered_original IS NOT NULL
          INNER JOIN selected_article selected ON selected.article_id = llm.article_id
          WHERE llm.list_mode_key = 'both' AND llm.answered_original IS NOT NULL AND llm.answered_original IS DISTINCT FROM human.answered_original
        ),
        answer_facets AS (
          SELECT llm.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.promptAnswer' AS summaryIdentity, 'review' AS facetKind, 'promptAnswer' AS facetKey, llm.answered_original AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, llm.answered_original AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM llm_detail llm
          INNER JOIN selected_article selected ON selected.article_id = llm.article_id
          WHERE ${shouldProjectPromptDerivedSummaryBuckets(input)}
            AND llm.list_mode_key = 'llm' AND llm.answered_original IS NOT NULL AND llm.answered_original_as_array IS NULL
          UNION ALL
          SELECT llm.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.promptAnswer' AS summaryIdentity, 'review' AS facetKind, 'promptAnswer' AS facetKey, answer.answer_value AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, answer.answer_value AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM llm_detail llm
          INNER JOIN selected_article selected ON selected.article_id = llm.article_id
          CROSS JOIN UNNEST(llm.answered_original_as_array) AS answer(answer_value)
          WHERE ${shouldProjectPromptDerivedSummaryBuckets(input)}
            AND llm.list_mode_key = 'llm' AND llm.answered_original_as_array IS NOT NULL
          UNION ALL
          SELECT human.article_id AS articleId, 'facet' AS summaryKind, 'review.human.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.promptAnswer' AS summaryIdentity, 'human' AS facetKind, 'promptAnswer' AS facetKey, human.answered_original AS facetValue, human.prompt_id AS promptId, NULL AS answerId, human.answered_original AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM human_detail human
          INNER JOIN selected_article selected ON selected.article_id = human.article_id
          CROSS JOIN project_settings
          WHERE ${shouldProjectPromptDerivedSummaryBuckets(input)}
            AND human.list_mode_key = 'human' AND human.prompt_id <> 'summary' AND human.answered_original IS NOT NULL
            AND project_settings.human_judgment_mode <> 'summary'
          UNION ALL
          SELECT human.article_id AS articleId, 'facet' AS summaryKind, 'review.human.filter.summaryAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.summaryAnswer' AS summaryIdentity, 'human' AS facetKind, 'summaryAnswer' AS facetKey, human.answered_original AS facetValue, human.prompt_id AS promptId, NULL AS answerId, human.answered_original AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM human_detail human
          INNER JOIN selected_article selected ON selected.article_id = human.article_id
          CROSS JOIN project_settings
          WHERE ${shouldProjectPromptDerivedSummaryBuckets(input)}
            AND human.list_mode_key = 'human' AND human.prompt_id = 'summary' AND human.answered_original IS NOT NULL
            AND project_settings.human_judgment_mode = 'summary'
          UNION ALL
          SELECT NULL AS articleId, 'facet' AS summaryKind, 'review.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.promptAnswer' AS summaryIdentity, 'review' AS facetKind, 'promptAnswer' AS facetKey, '__lazy_prompt_answer__' AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'unavailable' AS availability, ${getSqlLiteral(promptDerivedSummaryStaleReason)} AS staleReason
          WHERE NOT ${shouldProjectPromptDerivedSummaryBuckets(input)}
          UNION ALL
          SELECT NULL AS articleId, 'facet' AS summaryKind, 'review.human.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.promptAnswer' AS summaryIdentity, 'human' AS facetKind, 'promptAnswer' AS facetKey, '__lazy_prompt_answer__' AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'unavailable' AS availability, ${getSqlLiteral(promptDerivedSummaryStaleReason)} AS staleReason
          WHERE NOT ${shouldProjectPromptDerivedSummaryBuckets(input)}
          UNION ALL
          SELECT NULL AS articleId, 'facet' AS summaryKind, 'review.human.filter.summaryAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.summaryAnswer' AS summaryIdentity, 'human' AS facetKind, 'summaryAnswer' AS facetKey, '__lazy_prompt_answer__' AS facetValue, 'summary' AS promptId, NULL AS answerId, NULL AS answerValue, 'unavailable' AS availability, ${getSqlLiteral(promptDerivedSummaryStaleReason)} AS staleReason
          WHERE NOT ${shouldProjectPromptDerivedSummaryBuckets(input)}
        ),
        summary_union AS (
          SELECT * FROM base_counts
          UNION ALL SELECT * FROM selected_facets
          UNION ALL SELECT * FROM llm_counts
          UNION ALL SELECT * FROM human_counts
          UNION ALL SELECT * FROM conflict_counts
          UNION ALL SELECT * FROM answer_facets
        )
        SELECT * FROM summary_union
      `)
}

const getRowsAsContributionRows = (rows: readonly SummaryContributionSourceRow[]) => {
  return rows.map((row): ReviewServingContributionRow => {
    return {
      articleId: row.articleId,
      contributionKey: getSummaryContributionKey({
        answerId: row.answerId,
        answerValue: row.answerValue,
        availability: row.availability,
        countKind: row.countKind,
        facetKind: row.facetKind,
        facetKey: row.facetKey,
        facetValue: row.facetValue,
        filterKey: row.filterKey,
        listModeKey: row.listModeKey,
        promptId: row.promptId,
        staleReason: row.staleReason,
        summaryIdentity: row.summaryIdentity,
        summaryKind: row.summaryKind,
      }),
      contributionValue: 1,
    }
  })
}

const getCountRecord = (input: {
  countValue: number | null
  identity: SummaryContributionIdentity
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}): ReviewServingProjectorRecord | null => {
  const summaryDefinitionVersion = getSummaryDefinitionVersion(input.identity)

  return input.identity.countKind === null || input.identity.filterKey === null || summaryDefinitionVersion === null
    ? null
    : {
        keyColumns: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'list_mode_key',
          'count_kind',
          'summary_definition_version',
          'filter_key',
        ],
        table: 'mart.review_article_count_serving_v4',
        values: {
          availability: input.identity.availability,
          count_kind: input.identity.countKind,
          count_value: input.identity.availability === 'ready' ? input.countValue : null,
          filter_key: input.identity.filterKey,
          list_mode_key: input.identity.listModeKey ?? 'global',
          project_id: input.projectId,
          review_config_hash: input.reviewConfigHash,
          snapshot_id: input.snapshotId,
          stale_reason: input.identity.staleReason,
          summary_definition_version: summaryDefinitionVersion,
          summary_identity: input.identity.summaryIdentity,
        },
      }
}

const getFacetRecord = (input: {
  countValue: number | null
  identity: SummaryContributionIdentity
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}): ReviewServingProjectorRecord | null => {
  const summaryDefinitionVersion = getSummaryDefinitionVersion(input.identity)

  return input.identity.countKind === null
    || input.identity.facetKind === null
    || input.identity.facetKey === null
    || input.identity.facetValue === null
    || summaryDefinitionVersion === null
    ? null
    : {
        keyColumns: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'summary_identity',
          'facet_kind',
          'facet_key',
          'facet_value',
          'summary_definition_version',
        ],
        table: 'mart.review_filter_facet_serving_v4',
        values: {
          answer_id: input.identity.answerId,
          answer_value: input.identity.answerValue,
          availability: input.identity.availability,
          count_value: input.identity.availability === 'ready' ? input.countValue : null,
          facet_key: input.identity.facetKey,
          facet_kind: input.identity.facetKind,
          facet_value: input.identity.facetValue,
          project_id: input.projectId,
          prompt_id: input.identity.promptId,
          review_config_hash: input.reviewConfigHash,
          snapshot_id: input.snapshotId,
          summary_definition_version: summaryDefinitionVersion,
          summary_identity: input.identity.summaryIdentity,
        },
      }
}

const getSummaryRecord = (input: {
  countValue: number | null
  identity: SummaryContributionIdentity
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  return input.identity.summaryKind === 'count' ? getCountRecord(input) : getFacetRecord(input)
}

const getIdentityExistingValueKey = (identity: SummaryContributionIdentity) => {
  return identity.summaryKind === 'count'
    ? getStableReviewServingJson({
        countKind: identity.countKind,
        filterKey: identity.filterKey,
        listModeKey: identity.listModeKey ?? 'global',
      })
    : getStableReviewServingJson({
        facetKey: identity.facetKey,
        facetValue: identity.facetValue,
        summaryIdentity: identity.summaryIdentity,
      })
}

const getDirectFullSummaryRecords = (input: {
  projectId: string
  reviewConfigHash: string
  rows: readonly ReviewServingContributionRow[]
  snapshotId: string
}) => {
  const aggregatedRows = input.rows.reduce((acc, row) => {
    const identity = parseSummaryContributionKey(row.contributionKey)

    if (identity === null) {
      return acc
    }

    const servingKey = getIdentityExistingValueKey(identity)
    const current = acc.get(servingKey)
    acc.set(servingKey, {countValue: (current?.countValue ?? 0) + row.contributionValue, identity})

    return acc
  }, new Map<string, {countValue: number; identity: SummaryContributionIdentity}>())

  return Array.from(aggregatedRows.values()).flatMap((row) => {
    const record = getSummaryRecord({
      countValue: row.countValue,
      identity: row.identity,
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
    })

    return record === null ? [] : [record]
  })
}

const getDirectFullSummaryDeleteStatements = (input: ProjectReviewServingSummariesInput) => {
  const predicates = {
    project_id: input.projectId,
    review_config_hash: input.reviewConfigHash,
    snapshot_id: input.snapshotId,
  }

  return [
    getDeleteReviewServingProjectorRowsStatement({predicates, table: 'mart.review_article_count_serving_v4'}),
    getDeleteReviewServingProjectorRowsStatement({predicates, table: 'mart.review_filter_facet_serving_v4'}),
  ]
}

const getRequiredSummaryRebuildRequestId = (input: ProjectReviewServingSummariesInput) => {
  if (input.requestId === null || input.requestId === undefined) {
    throw new Error('cannot write chunked full summary partials without a rebuild request id')
  }

  return input.requestId
}

const getRequiredSummaryRebuildChunkId = (input: ProjectReviewServingSummariesInput) => {
  if (input.chunkId === null || input.chunkId === undefined) {
    throw new Error('cannot write chunked full summary partials without a rebuild chunk id')
  }

  return input.chunkId
}

const summaryRebuildPartialKeyColumns = [
  'request_id',
  'project_id',
  'review_config_hash',
  'snapshot_id',
  'summary_kind',
  'summary_identity',
  'list_mode_key',
  'count_kind',
  'filter_key',
  'facet_kind',
  'facet_key',
  'facet_value',
] as const

const getSummaryRebuildAccumulatorScalarKeyPredicate = (input: {leftAlias: string; rightAlias: string}) => {
  return `
        AND (${input.leftAlias}.request_id || '') = (${input.rightAlias}.request_id || '')
        AND (${input.leftAlias}.project_id || '') = (${input.rightAlias}.project_id || '')
        AND (${input.leftAlias}.review_config_hash || '') = (${input.rightAlias}.review_config_hash || '')
        AND (${input.leftAlias}.snapshot_id || '') = (${input.rightAlias}.snapshot_id || '')
        AND (${input.leftAlias}.summary_kind || '') = (${input.rightAlias}.summary_kind || '')
        AND (${input.leftAlias}.summary_identity || '') = (${input.rightAlias}.summary_identity || '')
        AND COALESCE(${input.leftAlias}.list_mode_key, 'global') = COALESCE(${input.rightAlias}.list_mode_key, 'global')
        AND COALESCE(${input.leftAlias}.count_kind, '') = COALESCE(${input.rightAlias}.count_kind, '')
        AND COALESCE(${input.leftAlias}.filter_key, '') = COALESCE(${input.rightAlias}.filter_key, '')
        AND COALESCE(${input.leftAlias}.facet_kind, '') = COALESCE(${input.rightAlias}.facet_kind, '')
        AND COALESCE(${input.leftAlias}.facet_key, '') = COALESCE(${input.rightAlias}.facet_key, '')
        AND COALESCE(${input.leftAlias}.facet_value, '') = COALESCE(${input.rightAlias}.facet_value, '')`
}

const getSummaryRebuildAccumulatorMembershipPredicate = (input: {
  accumulatorAlias: string
  chunkIdSql: string
  membershipAlias: string
}) => {
  return `EXISTS (
        SELECT 1
        FROM mart.review_article_summary_rebuild_accumulator_chunk_v4 ${input.membershipAlias}
        WHERE ${input.membershipAlias}.chunk_id = ${input.chunkIdSql}
          ${getSummaryRebuildAccumulatorScalarKeyPredicate({
            leftAlias: input.membershipAlias,
            rightAlias: input.accumulatorAlias,
          })}
      )`
}

const getDirectFullSummaryPartialRecord = (input: {
  chunkId: string
  record: ReviewServingProjectorRecord
  requestId: string
}) => {
  const values = input.record.values
  const summaryKind = input.record.table === 'mart.review_article_count_serving_v4' ? 'count' : 'facet'

  return {
    keyColumns: summaryRebuildPartialKeyColumns,
    table: 'mart.review_article_summary_rebuild_accumulator_v4',
    values: {
      answer_id: values.answer_id ?? null,
      answer_value: values.answer_value ?? null,
      availability: values.availability ?? 'ready',
      count_kind: values.count_kind ?? null,
      count_value: values.count_value ?? null,
      facet_key: values.facet_key ?? null,
      facet_kind: values.facet_kind ?? null,
      facet_value: values.facet_value ?? null,
      filter_key: values.filter_key ?? null,
      list_mode_key: values.list_mode_key ?? null,
      partial_updated_at: new Date(),
      project_id: values.project_id,
      prompt_id: values.prompt_id ?? null,
      request_id: input.requestId,
      review_config_hash: values.review_config_hash,
      snapshot_id: values.snapshot_id,
      stale_reason: values.stale_reason ?? null,
      source_chunk_ids_key: '',
      summary_definition_version: values.summary_definition_version,
      summary_identity: values.summary_identity,
      summary_kind: summaryKind,
    },
  } satisfies ReviewServingProjectorRecord
}

const getDirectFullSummaryPartialRecords = (input: {
  chunkId: string
  requestId: string
  summaryRecords: readonly ReviewServingProjectorRecord[]
}) => {
  return input.summaryRecords.map((record) => {
    return getDirectFullSummaryPartialRecord({...input, record})
  })
}

const getDirectFullSummaryPartialDeleteStatements = (input: ProjectReviewServingSummariesInput) => {
  getRequiredSummaryRebuildChunkId(input)
  getRequiredSummaryRebuildRequestId(input)

  return []
}

const summaryRebuildPartialReductionBatchSize = 256

const getSummaryRebuildPartialScopePredicate = (input: {
  alias?: string
  projectId: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  const qualifier = input.alias === undefined ? '' : `${input.alias}.`

  return `${qualifier}request_id = ${getSqlLiteral(input.requestId)}
    AND ${qualifier}project_id = ${getSqlLiteral(input.projectId)}
    AND ${qualifier}review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
    AND ${qualifier}snapshot_id = ${getSqlLiteral(input.snapshotId)}`
}

const getCompletedSummaryRebuildAccumulatorChunkJoin = (accumulatorAlias: string) => {
  return `INNER JOIN app.review_rebuild_chunk_manifest chunk
      ON chunk.request_id = ${accumulatorAlias}.request_id
      AND chunk.project_id = ${accumulatorAlias}.project_id
      AND chunk.snapshot_id = ${accumulatorAlias}.snapshot_id
      AND chunk.projection_component = 'summary'
      AND chunk.status = 'completed'
      AND (
        contains(${accumulatorAlias}.source_chunk_ids_key, '\n' || chunk.chunk_id || '\n')
        OR ${getSummaryRebuildAccumulatorMembershipPredicate({
          accumulatorAlias,
          chunkIdSql: 'chunk.chunk_id',
          membershipAlias: 'accumulator_chunk',
        })}
      )`
}

const getCompletedSummaryRebuildAccumulatorExistsPredicate = (accumulatorAlias: string) => {
  return `EXISTS (
      SELECT 1
      FROM app.review_rebuild_chunk_manifest chunk
      WHERE chunk.request_id = ${accumulatorAlias}.request_id
        AND chunk.project_id = ${accumulatorAlias}.project_id
        AND chunk.snapshot_id = ${accumulatorAlias}.snapshot_id
        AND chunk.projection_component = 'summary'
        AND chunk.status = 'completed'
        AND (
          contains(${accumulatorAlias}.source_chunk_ids_key, '\n' || chunk.chunk_id || '\n')
          OR ${getSummaryRebuildAccumulatorMembershipPredicate({
            accumulatorAlias,
            chunkIdSql: 'chunk.chunk_id',
            membershipAlias: 'accumulator_chunk',
          })}
        )
    )`
}

const getSummaryRebuildPartialChunkIdPredicate = (chunkIds: readonly string[]) => {
  return `chunk_id IN (${chunkIds
    .map((chunkId) => {
      return getSqlLiteral(chunkId)
    })
    .join(', ')})`
}

const getSummaryRebuildPartialAccumulatorState = async (
  input: {projectId: string; requestId: string; reviewConfigHash: string; snapshotId: string},
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const rows = await database.queryJson<{chunkId: string}>(`
    SELECT chunk.chunk_id AS chunkId
    FROM app.review_rebuild_chunk_manifest chunk
    WHERE chunk.request_id = ${getSqlLiteral(input.requestId)}
      AND chunk.project_id = ${getSqlLiteral(input.projectId)}
      AND chunk.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND chunk.projection_component = 'summary'
    ORDER BY chunk.chunk_id
  `)

  return {
    chunkIds: rows.map((row) => {
      return row.chunkId
    }),
    hasManifestChunks: rows.length > 0,
  }
}

const getNextSummaryRebuildPartialReductionChunkIds = (
  input: {
    chunkIds: readonly string[]
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  offset: number,
) => {
  return input.chunkIds.slice(offset, offset + summaryRebuildPartialReductionBatchSize)
}

const getSummaryRebuildAccumulatorPartialCount = async (
  input: {
    chunkIds: readonly string[]
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const scopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'accumulator'})
  const rows = await database.queryJson<{partialCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS partialCount
    FROM mart.review_article_summary_rebuild_accumulator_v4 accumulator
    WHERE ${scopePredicate}
      AND ${getCompletedSummaryRebuildAccumulatorExistsPredicate('accumulator')}
  `)

  return Number(rows[0]?.partialCount ?? 0)
}

const summaryRebuildAccumulatorWriteBatchSize = 64

const getSummaryRebuildAccumulatorRecordBatches = (records: readonly ReviewServingProjectorRecord[]) => {
  const batches: ReviewServingProjectorRecord[][] = []
  for (let offset = 0; offset < records.length; offset += summaryRebuildAccumulatorWriteBatchSize) {
    batches.push(records.slice(offset, offset + summaryRebuildAccumulatorWriteBatchSize))
  }

  return batches
}

const getInsertSummaryRebuildAccumulatorChunkStatement = (input: {
  chunkId: string
  records: readonly ReviewServingProjectorRecord[]
  projectId: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  if (input.records.length === 0) {
    return null
  }

  const columns = [
    'request_id',
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_kind',
    'summary_identity',
    'list_mode_key',
    'count_kind',
    'summary_definition_version',
    'filter_key',
    'facet_kind',
    'facet_key',
    'facet_value',
    'prompt_id',
    'answer_id',
    'answer_value',
    'availability',
    'stale_reason',
    'count_value',
    'source_chunk_ids_key',
  ] as const
  const valuesSql = input.records
    .map((record) => {
      return `(${columns
        .map((column) => {
          return getSqlLiteral(record.values[column] ?? null)
        })
        .join(', ')})`
    })
    .join(',\n        ')
  const chunkMarker = `\n${input.chunkId}\n`
  const accumulatorScopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'accumulator'})
  const existingScopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'existing'})
  const membershipScopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'accumulator_chunk'})

  return `
    DROP TABLE IF EXISTS temp_summary_rebuild_accumulator_chunk;

    CREATE TEMPORARY TABLE temp_summary_rebuild_accumulator_chunk (
      request_id VARCHAR NOT NULL,
      project_id VARCHAR NOT NULL,
      review_config_hash VARCHAR NOT NULL,
      snapshot_id VARCHAR NOT NULL,
      summary_kind VARCHAR NOT NULL,
      summary_identity VARCHAR NOT NULL,
      list_mode_key VARCHAR,
      count_kind VARCHAR,
      summary_definition_version VARCHAR NOT NULL,
      filter_key VARCHAR,
      facet_kind VARCHAR,
      facet_key VARCHAR,
      facet_value VARCHAR,
      prompt_id VARCHAR,
      answer_id INTEGER,
      answer_value VARCHAR,
      availability VARCHAR NOT NULL,
      stale_reason VARCHAR,
      count_value BIGINT,
      source_chunk_ids_key VARCHAR NOT NULL
    );

    INSERT INTO temp_summary_rebuild_accumulator_chunk (${columns.join(', ')})
    SELECT ${columns.join(', ')}
    FROM (VALUES
        ${valuesSql}
    ) AS incoming(${columns.join(', ')});

    UPDATE mart.review_article_summary_rebuild_accumulator_v4 accumulator
    SET
      count_value = CASE
        WHEN accumulator.availability = 'ready' AND incoming.availability = 'ready'
        THEN COALESCE(accumulator.count_value, 0) + COALESCE(incoming.count_value, 0)
        ELSE NULL
      END,
      accumulator_updated_at = now()
    FROM temp_summary_rebuild_accumulator_chunk incoming
    WHERE ${accumulatorScopePredicate}
      AND NOT contains(accumulator.source_chunk_ids_key, ${getSqlLiteral(chunkMarker)})
      AND NOT ${getSummaryRebuildAccumulatorMembershipPredicate({
        accumulatorAlias: 'accumulator',
        chunkIdSql: getSqlLiteral(input.chunkId),
        membershipAlias: 'accumulator_chunk',
      })}
      ${getSummaryRebuildAccumulatorScalarKeyPredicate({leftAlias: 'accumulator', rightAlias: 'incoming'})};

    INSERT INTO mart.review_article_summary_rebuild_accumulator_v4 (
      ${columns.join(',\n      ')},
      accumulator_updated_at
    )
    SELECT
      ${columns.join(',\n      ')},
      current_timestamp
    FROM temp_summary_rebuild_accumulator_chunk incoming
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_article_summary_rebuild_accumulator_v4 existing
      WHERE ${existingScopePredicate}
        ${getSummaryRebuildAccumulatorScalarKeyPredicate({leftAlias: 'existing', rightAlias: 'incoming'})}
    );

    INSERT INTO mart.review_article_summary_rebuild_accumulator_chunk_v4 (
      request_id,
      project_id,
      review_config_hash,
      snapshot_id,
      summary_kind,
      summary_identity,
      list_mode_key,
      count_kind,
      filter_key,
      facet_kind,
      facet_key,
      facet_value,
      chunk_id,
      membership_created_at
    )
    SELECT
      incoming.request_id,
      incoming.project_id,
      incoming.review_config_hash,
      incoming.snapshot_id,
      incoming.summary_kind,
      incoming.summary_identity,
      incoming.list_mode_key,
      incoming.count_kind,
      incoming.filter_key,
      incoming.facet_kind,
      incoming.facet_key,
      incoming.facet_value,
      ${getSqlLiteral(input.chunkId)} AS chunk_id,
      current_timestamp
    FROM temp_summary_rebuild_accumulator_chunk incoming
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_article_summary_rebuild_accumulator_chunk_v4 accumulator_chunk
      WHERE ${membershipScopePredicate}
        AND accumulator_chunk.chunk_id = ${getSqlLiteral(input.chunkId)}
        ${getSummaryRebuildAccumulatorScalarKeyPredicate({leftAlias: 'accumulator_chunk', rightAlias: 'incoming'})}
    );

    DROP TABLE IF EXISTS temp_summary_rebuild_accumulator_chunk
  `
}

const getInsertSummaryRebuildAccumulatorChunkStatements = (input: {
  chunkId: string
  records: readonly ReviewServingProjectorRecord[]
  projectId: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  return getSummaryRebuildAccumulatorRecordBatches(input.records)
    .map((records) => {
      return getInsertSummaryRebuildAccumulatorChunkStatement({...input, records})
    })
    .filter((statement): statement is string => {
      return statement !== null
    })
}

const reduceSummaryRebuildPartialChunkBatchIntoAccumulator = async (
  input: {
    accumulatorChunkId: string
    chunkIds: readonly string[]
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const scopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'accumulator'})
  const chunkIdPredicate = getSummaryRebuildPartialChunkIdPredicate(input.chunkIds)

  await database.run(`
    SELECT 1
    FROM mart.review_article_summary_rebuild_accumulator_v4 accumulator
    ${getCompletedSummaryRebuildAccumulatorChunkJoin('accumulator')}
    WHERE ${scopePredicate}
      AND chunk.${chunkIdPredicate}
  `)
}

const reduceSummaryRebuildPartialBatchesIntoAccumulator = async (
  input: {
    accumulatorChunkId: string
    chunkIds: readonly string[]
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
): Promise<void> => {
  for (let offset = 0; offset < input.chunkIds.length; offset += summaryRebuildPartialReductionBatchSize) {
    const chunkIds = getNextSummaryRebuildPartialReductionChunkIds(input, offset)
    if (chunkIds.length > 0) {
      await reduceSummaryRebuildPartialChunkBatchIntoAccumulator({...input, chunkIds}, database)
    }
  }
}

const reduceSummaryRebuildPartialsForRequestSnapshot = async (
  input: {
    hasSummaryRebuildChunks?: boolean
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const {chunkIds} = await getSummaryRebuildPartialAccumulatorState(input, database)
  const scopedInput = {...input, chunkIds}

  await reduceSummaryRebuildPartialBatchesIntoAccumulator(scopedInput, database)

  const accumulatorPartialCount = await getSummaryRebuildAccumulatorPartialCount(scopedInput, database)

  if (accumulatorPartialCount === 0 && input.hasSummaryRebuildChunks !== true) {
    return
  }

  await database.transaction(async (tx) => {
    const scopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'accumulator'})
    await tx.run(`
      DROP TABLE IF EXISTS temp_summary_rebuild_count_publication
    `)
    await tx.run(`
      CREATE TEMPORARY TABLE temp_summary_rebuild_count_publication AS
      SELECT
        accumulator.project_id,
        accumulator.review_config_hash,
        accumulator.snapshot_id,
        ANY_VALUE(summary_identity) AS summary_identity,
        COALESCE(list_mode_key, 'global') AS list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        CASE WHEN ANY_VALUE(availability) = 'ready' THEN SUM(COALESCE(count_value, 0)) ELSE NULL END AS count_value,
        ANY_VALUE(availability) AS availability,
        ANY_VALUE(stale_reason) AS stale_reason
      FROM mart.review_article_summary_rebuild_accumulator_v4 accumulator
      WHERE ${scopePredicate}
        AND ${getCompletedSummaryRebuildAccumulatorExistsPredicate('accumulator')}
        AND summary_kind = 'count'
      GROUP BY accumulator.project_id, accumulator.review_config_hash, accumulator.snapshot_id, COALESCE(list_mode_key, 'global'), count_kind, summary_definition_version, filter_key
    `)
    await tx.run(`
      DELETE FROM mart.review_article_count_serving_v4 serving
      USING temp_summary_rebuild_count_publication replacement
      WHERE serving.project_id = replacement.project_id
        AND serving.review_config_hash = replacement.review_config_hash
        AND serving.snapshot_id = replacement.snapshot_id
        AND serving.list_mode_key = replacement.list_mode_key
        AND serving.count_kind = replacement.count_kind
        AND serving.summary_definition_version = replacement.summary_definition_version
        AND serving.filter_key IS NOT DISTINCT FROM replacement.filter_key
    `)
    await tx.run(`
      INSERT INTO mart.review_article_count_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        count_value,
        availability,
        stale_reason
      )
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        count_value,
        availability,
        stale_reason
      FROM temp_summary_rebuild_count_publication
    `)
    await tx.run(`
      DROP TABLE IF EXISTS temp_summary_rebuild_facet_publication
    `)
    await tx.run(`
      CREATE TEMPORARY TABLE temp_summary_rebuild_facet_publication AS
      SELECT
        accumulator.project_id,
        accumulator.review_config_hash,
        accumulator.snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        ANY_VALUE(prompt_id) AS prompt_id,
        ANY_VALUE(answer_id) AS answer_id,
        ANY_VALUE(answer_value) AS answer_value,
        summary_definition_version,
        CASE WHEN ANY_VALUE(availability) = 'ready' THEN SUM(COALESCE(count_value, 0)) ELSE NULL END AS count_value,
        ANY_VALUE(availability) AS availability
      FROM mart.review_article_summary_rebuild_accumulator_v4 accumulator
      WHERE ${scopePredicate}
        AND ${getCompletedSummaryRebuildAccumulatorExistsPredicate('accumulator')}
        AND summary_kind = 'facet'
      GROUP BY accumulator.project_id, accumulator.review_config_hash, accumulator.snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version
    `)
    await tx.run(`
      DELETE FROM mart.review_filter_facet_serving_v4 serving
      USING temp_summary_rebuild_facet_publication replacement
      WHERE serving.project_id = replacement.project_id
        AND serving.review_config_hash = replacement.review_config_hash
        AND serving.snapshot_id = replacement.snapshot_id
        AND serving.summary_identity = replacement.summary_identity
        AND serving.facet_kind = replacement.facet_kind
        AND serving.facet_key = replacement.facet_key
        AND serving.facet_value = replacement.facet_value
        AND serving.summary_definition_version = replacement.summary_definition_version
    `)
    await tx.run(`
      INSERT INTO mart.review_filter_facet_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        prompt_id,
        answer_id,
        answer_value,
        summary_definition_version,
        count_value,
        availability
      )
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        prompt_id,
        answer_id,
        answer_value,
        summary_definition_version,
        count_value,
        availability
      FROM temp_summary_rebuild_facet_publication
    `)
    await tx.run(`
      DROP TABLE IF EXISTS temp_summary_rebuild_count_publication
    `)
    await tx.run(`
      DROP TABLE IF EXISTS temp_summary_rebuild_facet_publication
    `)
  })
}

export const reduceReviewServingSummaryRebuildPartialsForRequestSnapshots = async (
  input: ReviewServingSummarySnapshotReductionInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  await input.snapshots.reduce<Promise<void>>(async (previous, row) => {
    await previous

    if (row.reviewConfigHash === null && row.hasSummaryRebuildChunks === true) {
      throw new Error(
        `cannot reduce summary rebuild partials without review config hash for snapshot ${row.snapshotId}`,
      )
    }

    if (row.reviewConfigHash === null) {
      return
    }

    await reduceSummaryRebuildPartialsForRequestSnapshot(
      {
        hasSummaryRebuildChunks: row.hasSummaryRebuildChunks,
        projectId: row.projectId,
        requestId: input.requestId,
        reviewConfigHash: row.reviewConfigHash,
        snapshotId: row.snapshotId,
      },
      database,
    )
  }, Promise.resolve())
}

const projectDirectFullReviewServingSummaries = async (input: {
  database: ReviewServingSummaryProjectorDatabase
  measure: <T>(phase: string, operation: () => Promise<T>) => Promise<T>
  measureSync: <T>(phase: string, operation: () => T) => T
  phaseTimings: Record<string, number>
  projectorInput: ProjectReviewServingSummariesInput
}) => {
  const sourceRows = await input.measure('sourceQueryMs', async () => {
    return getSummaryContributionRows(input.projectorInput, input.database)
  })
  const contributionRows = input.measureSync('contributionTransformMs', () => {
    return getRowsAsContributionRows(sourceRows)
  })
  const summaryRecords = input.measureSync('summaryRecordBuildMs', () => {
    return getDirectFullSummaryRecords({
      projectId: input.projectorInput.projectId,
      reviewConfigHash: input.projectorInput.reviewConfigHash,
      rows: contributionRows,
      snapshotId: input.projectorInput.snapshotId,
    })
  })
  const writerResult = await input.measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'summary',
        records: summaryRecords,
        statements: getDirectFullSummaryDeleteStatements(input.projectorInput),
      },
      input.database,
    )
  })

  return {
    contributionRowCount: 0,
    diagnosticsJson: {
      phaseTimings: input.phaseTimings,
      summaryProjector: {
        contributionDiffCount: 0,
        contributionRecordCount: 0,
        directFullSnapshot: true,
        priorArticleRowCount: 0,
        sourceRowCount: sourceRows.length,
        writer: writerResult.diagnostics,
      },
    },
    repairRequired: false,
    summaryRowCount: summaryRecords.length,
    summaryValues: summaryRecords.map((record) => {
      return record.values
    }),
  }
}

const projectPartialFullReviewServingSummaries = async (input: {
  database: ReviewServingSummaryProjectorDatabase
  measure: <T>(phase: string, operation: () => Promise<T>) => Promise<T>
  measureSync: <T>(phase: string, operation: () => T) => T
  phaseTimings: Record<string, number>
  projectorInput: ProjectReviewServingSummariesInput
}) => {
  const sourceRows = await input.measure('sourceQueryMs', async () => {
    return getSummaryContributionRows(input.projectorInput, input.database)
  })
  const contributionRows = input.measureSync('contributionTransformMs', () => {
    return getRowsAsContributionRows(sourceRows)
  })
  const summaryRecords = input.measureSync('summaryRecordBuildMs', () => {
    return getDirectFullSummaryRecords({
      projectId: input.projectorInput.projectId,
      reviewConfigHash: input.projectorInput.reviewConfigHash,
      rows: contributionRows,
      snapshotId: input.projectorInput.snapshotId,
    })
  })
  const partialRecords = input.measureSync('partialRecordBuildMs', () => {
    return getDirectFullSummaryPartialRecords({
      chunkId: getRequiredSummaryRebuildChunkId(input.projectorInput),
      requestId: getRequiredSummaryRebuildRequestId(input.projectorInput),
      summaryRecords,
    })
  })
  const accumulatorStatements = getInsertSummaryRebuildAccumulatorChunkStatements({
    chunkId: getRequiredSummaryRebuildChunkId(input.projectorInput),
    projectId: input.projectorInput.projectId,
    records: partialRecords,
    requestId: getRequiredSummaryRebuildRequestId(input.projectorInput),
    reviewConfigHash: input.projectorInput.reviewConfigHash,
    snapshotId: input.projectorInput.snapshotId,
  })
  const writerResult = await input.measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'summary',
        records: [],
        statements: [...getDirectFullSummaryPartialDeleteStatements(input.projectorInput), ...accumulatorStatements],
      },
      input.database,
    )
  })

  return {
    contributionRowCount: contributionRows.length,
    diagnosticsJson: {
      phaseTimings: input.phaseTimings,
      summaryProjector: {
        contributionDiffCount: 0,
        contributionRecordCount: 0,
        directFullSnapshot: true,
        partialFullSnapshot: true,
        partialRowCount: partialRecords.length,
        priorArticleRowCount: 0,
        sourceRowCount: sourceRows.length,
        writer: writerResult.diagnostics,
      },
    },
    repairRequired: false,
    summaryRowCount: partialRecords.length,
    summaryValues: summaryRecords.map((record) => {
      return record.values
    }),
  }
}

export const projectReviewServingSummaries = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase = getAppDatabaseService() as ReviewServingSummaryProjectorDatabase,
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

  if (isDirectFullSummarySnapshotInput(input)) {
    return projectDirectFullReviewServingSummaries({
      database,
      measure,
      measureSync,
      phaseTimings,
      projectorInput: input,
    })
  }

  if (isPartialFullSummarySnapshotInput(input)) {
    return projectPartialFullReviewServingSummaries({
      database,
      measure,
      measureSync,
      phaseTimings,
      projectorInput: input,
    })
  }

  const sourceRows = await measure('sourceQueryMs', async () => {
    return getSummaryContributionRows(input, database)
  })
  const contributionRows = measureSync('contributionTransformMs', () => {
    return getRowsAsContributionRows(sourceRows)
  })
  const summaryRecords = measureSync('summaryRecordBuildMs', () => {
    return getDirectFullSummaryRecords({
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      rows: contributionRows,
      snapshotId: input.snapshotId,
    })
  })
  const patchWatermark = getPatchWatermark(input.claims)
  const shouldPublishManifest = input.acknowledgeClaims !== false && input.claims.length > 0

  const writerResult = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
        component: 'summary',
        projectionManifests: !shouldPublishManifest
          ? []
          : [
              {
                baseGeneration: input.baseGeneration,
                definitionVersion: 'review-serving-summary:v1',
                inputDigest: getClaimKinds(input.claims),
                inputWatermark: patchWatermark,
                inputWatermarks: getReviewServingSourcePartitionWatermarks(input.claims),
                invalidationReason: getClaimKinds(input.claims),
                patchRangeEnd: patchWatermark,
                patchRangeStart: getPatchRangeStart(input.claims),
                patchWatermark,
                projectId: input.projectId,
                projectionComponent: 'summary',
                projectionIdentity: input.projectionIdentity,
                reviewConfigHash: input.reviewConfigHash,
                status: 'candidate',
              },
            ],
        records: summaryRecords,
        statements: getDirectFullSummaryDeleteStatements(input),
        watermark: !shouldPublishManifest
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'summary',
              projectorName: summaryProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
      },
      database,
    )
  })

  return {
    contributionRowCount: 0,
    diagnosticsJson: {
      phaseTimings,
      summaryProjector: {
        contributionDiffCount: 0,
        contributionRecordCount: 0,
        directServingRecompute: true,
        priorArticleRowCount: 0,
        sourceRowCount: sourceRows.length,
        writer: writerResult.diagnostics,
      },
    },
    repairRequired: false,
    summaryRowCount: summaryRecords.length,
    summaryValues: summaryRecords.map((record) => {
      return record.values
    }),
  }
}
