import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingCountAvailability,
} from './reviewServingContracts.ts'
import {
  getReviewServingContributionRecord,
  prepareReviewServingContributionDiff,
  type ReviewServingContributionDiff,
  type ReviewServingContributionRow,
} from './reviewServingContributionService.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorRecordValue,
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

type ExistingCountRow = {countKind: string; countValue: number | null; filterKey: string; listModeKey: string}

type ExistingFacetRow = {countValue: number | null; facetKey: string; facetValue: string; summaryIdentity: string}

const summaryProjectorName = 'summary-projector'
const dynamicFilteredTotalFilterKey = 'filter:dynamic'

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

const getExpectedArticleIds = (
  claims: readonly ReviewServingDirtyWorkClaim[],
  rows: readonly SummaryContributionSourceRow[],
  priorArticleIds: readonly string[],
) => {
  const claimArticleIds = getClaimArticleIds(claims)

  return claimArticleIds.length > 0
    ? claimArticleIds
    : [
        ...new Set([
          ...priorArticleIds,
          ...rows.map((row) => {
            return row.articleId
          }),
        ]),
      ]
}

const getPriorContributionArticleIds = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  return getClaimArticleIds(input.claims).length > 0
    ? []
    : database.queryJson<{articleId: string}>(`
        SELECT DISTINCT contribution.article_id AS articleId
        FROM mart.review_article_summary_contribution_v4 contribution
        WHERE contribution.project_id = ${getSqlLiteral(input.projectId)}
          AND contribution.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND contribution.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND contribution.component_kind = 'count'
          AND contribution.summary_definition_version = 'review-serving-summary:v1'
          ${getArticleRangePredicate({alias: 'contribution', ...input})}
      `)
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
          SELECT serving.*
          FROM article_id_filter dirty
          INNER JOIN mart.review_article_serving_v4 serving
            ON serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND serving.article_id = dirty.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = serving.list_mode_key
        ),
        selected_article AS (
          SELECT DISTINCT
            serving.article_id,
            serving.selected_import_route_id AS import_route_id,
            serving.publication_year,
            serving.duplicate_flag,
            serving.conflict_flag
          FROM scoped_serving serving
        ),
        llm_detail AS (
          SELECT detail.*
          FROM article_id_filter dirty
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind = 'llm'
            AND detail.article_id = dirty.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = detail.list_mode_key
        ),
        human_detail AS (
          SELECT detail.*
          FROM article_id_filter dirty
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind = 'human'
            AND detail.article_id = dirty.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = detail.list_mode_key
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
          FROM mart.review_unassessed_queue_serving_v4 queue
          INNER JOIN article_id_filter dirty ON dirty.article_id = queue.article_id
          INNER JOIN selected_article selected ON selected.article_id = queue.article_id
          CROSS JOIN list_mode_key_filter list_mode_key
          WHERE queue.project_id = ${getSqlLiteral(input.projectId)} AND queue.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND queue.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND queue.queue_kind = 'unassessed' AND queue.prompt_id IS NOT NULL
          UNION ALL
          SELECT queue.article_id AS articleId, 'count' AS summaryKind, 'review.queue.unassessedReady' AS countKind, 'queue:ready' AS filterKey, list_mode_key.list_mode_key AS listModeKey, 'review.queue.unassessedReady' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, queue.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM mart.review_unassessed_queue_serving_v4 queue
          INNER JOIN article_id_filter dirty ON dirty.article_id = queue.article_id
          INNER JOIN selected_article selected ON selected.article_id = queue.article_id
          CROSS JOIN list_mode_key_filter list_mode_key
          WHERE queue.project_id = ${getSqlLiteral(input.projectId)} AND queue.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND queue.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND queue.queue_kind = 'unassessed'
        ),
        human_counts AS (
          SELECT human.article_id AS articleId, 'count' AS summaryKind, 'review.human.reviewedByPrompt' AS countKind, concat('prompt:', human.prompt_id) AS filterKey, human.list_mode_key AS listModeKey, 'review.human.reviewedByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, human.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM human_detail human
          INNER JOIN selected_article selected ON selected.article_id = human.article_id
          CROSS JOIN project_settings
          WHERE human.list_mode_key IN ('human', 'both') AND human.answered_original IS NOT NULL
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
          WHERE llm.list_mode_key = 'llm' AND llm.answered_original IS NOT NULL AND llm.answered_original_as_array IS NULL
          UNION ALL
          SELECT llm.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.promptAnswer' AS summaryIdentity, 'review' AS facetKind, 'promptAnswer' AS facetKey, answer.answer_value AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, answer.answer_value AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM llm_detail llm
          INNER JOIN selected_article selected ON selected.article_id = llm.article_id
          CROSS JOIN UNNEST(llm.answered_original_as_array) AS answer(answer_value)
          WHERE llm.list_mode_key = 'llm' AND llm.answered_original_as_array IS NOT NULL
          UNION ALL
          SELECT human.article_id AS articleId, 'facet' AS summaryKind, 'review.human.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.promptAnswer' AS summaryIdentity, 'human' AS facetKind, 'promptAnswer' AS facetKey, human.answered_original AS facetValue, human.prompt_id AS promptId, NULL AS answerId, human.answered_original AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM human_detail human
          INNER JOIN selected_article selected ON selected.article_id = human.article_id
          CROSS JOIN project_settings
          WHERE human.list_mode_key = 'human' AND human.prompt_id <> 'summary' AND human.answered_original IS NOT NULL
            AND project_settings.human_judgment_mode <> 'summary'
          UNION ALL
          SELECT human.article_id AS articleId, 'facet' AS summaryKind, 'review.human.filter.summaryAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.summaryAnswer' AS summaryIdentity, 'human' AS facetKind, 'summaryAnswer' AS facetKey, human.answered_original AS facetValue, human.prompt_id AS promptId, NULL AS answerId, human.answered_original AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM human_detail human
          INNER JOIN selected_article selected ON selected.article_id = human.article_id
          CROSS JOIN project_settings
          WHERE human.list_mode_key = 'human' AND human.prompt_id = 'summary' AND human.answered_original IS NOT NULL
            AND project_settings.human_judgment_mode = 'summary'
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

const getExistingCountRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  return database.queryJson<ExistingCountRow>(`
    SELECT count_kind AS countKind, filter_key AS filterKey, list_mode_key AS listModeKey, CAST(count_value AS DOUBLE) AS countValue
    FROM mart.review_article_count_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
  `)
}

const getExistingFacetRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  return database.queryJson<ExistingFacetRow>(`
    SELECT summary_identity AS summaryIdentity, facet_key AS facetKey, facet_value AS facetValue, CAST(count_value AS DOUBLE) AS countValue
    FROM mart.review_filter_facet_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
  `)
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
          count_updated_at: new Date(),
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
          facet_updated_at: new Date(),
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

const getCountExistingKey = (row: Pick<ExistingCountRow, 'countKind' | 'filterKey' | 'listModeKey'>) => {
  return getStableReviewServingJson({countKind: row.countKind, filterKey: row.filterKey, listModeKey: row.listModeKey})
}

const getFacetExistingKey = (row: Pick<ExistingFacetRow, 'facetKey' | 'facetValue' | 'summaryIdentity'>) => {
  return getStableReviewServingJson({
    facetKey: row.facetKey,
    facetValue: row.facetValue,
    summaryIdentity: row.summaryIdentity,
  })
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

const getSummaryRecords = async (input: {
  database: ReviewServingSummaryProjectorDatabase
  diffs: readonly ReviewServingContributionDiff[]
  projectorInput: ProjectReviewServingSummariesInput
}) => {
  const [countRows, facetRows] = await Promise.all([
    getExistingCountRows(input.projectorInput, input.database),
    getExistingFacetRows(input.projectorInput, input.database),
  ])
  const existingValues = new Map<string, number>([
    ...countRows.map((row) => {
      return [getCountExistingKey(row), row.countValue ?? 0] as const
    }),
    ...facetRows.map((row) => {
      return [getFacetExistingKey(row), row.countValue ?? 0] as const
    }),
  ])
  const aggregatedDiffs = input.diffs.reduce((acc, diff) => {
    const identity = parseSummaryContributionKey(diff.contributionKey)

    if (identity === null) {
      return acc
    }

    const existingKey = getIdentityExistingValueKey(identity)
    const current = acc.get(existingKey)
    acc.set(existingKey, {delta: (current?.delta ?? 0) + diff.delta, identity})

    return acc
  }, new Map<string, {delta: number; identity: SummaryContributionIdentity}>())

  return Array.from(aggregatedDiffs.entries()).flatMap(([existingKey, diff]) => {
    const existingValue = existingValues.get(existingKey) ?? 0
    const record = getSummaryRecord({
      countValue: Math.max(0, existingValue + diff.delta),
      identity: diff.identity,
      projectId: input.projectorInput.projectId,
      reviewConfigHash: input.projectorInput.reviewConfigHash,
      snapshotId: input.projectorInput.snapshotId,
    })

    return record === null ? [] : [record]
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
    getDeleteReviewServingProjectorRowsStatement({predicates, table: 'mart.review_article_summary_contribution_v4'}),
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

const getNullableSummaryRecordString = (value: ReviewServingProjectorRecordValue | undefined) => {
  return typeof value === 'string' ? value : null
}

const getDirectFullSummaryPartialRecord = (input: {
  chunkId: string
  record: ReviewServingProjectorRecord
  requestId: string
}) => {
  const values = input.record.values
  const summaryKind = input.record.table === 'mart.review_article_count_serving_v4' ? 'count' : 'facet'
  const servingKey = getStableReviewServingJson({
    countKind: getNullableSummaryRecordString(values.count_kind),
    facetKey: getNullableSummaryRecordString(values.facet_key),
    facetValue: getNullableSummaryRecordString(values.facet_value),
    filterKey: getNullableSummaryRecordString(values.filter_key),
    listModeKey: getNullableSummaryRecordString(values.list_mode_key),
    summaryIdentity: getNullableSummaryRecordString(values.summary_identity),
    summaryKind,
  })

  return {
    keyColumns: ['request_id', 'chunk_id', 'project_id', 'review_config_hash', 'snapshot_id', 'serving_key'],
    table: 'mart.review_article_summary_rebuild_partial_v4',
    values: {
      answer_id: values.answer_id ?? null,
      answer_value: values.answer_value ?? null,
      availability: values.availability ?? 'ready',
      chunk_id: input.chunkId,
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
      serving_key: servingKey,
      snapshot_id: values.snapshot_id,
      stale_reason: values.stale_reason ?? null,
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

const getDirectFullSummaryContributionPartialRecord = (input: {
  chunkId: string
  record: ReviewServingProjectorRecord
  requestId: string
}) => {
  return {
    keyColumns: [
      'request_id',
      'chunk_id',
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'article_id',
      'component_kind',
      'summary_definition_version',
      'contribution_key',
    ],
    table: 'mart.review_article_summary_contribution_rebuild_partial_v4',
    values: {
      ...input.record.values,
      chunk_id: input.chunkId,
      contribution_updated_at: new Date(),
      request_id: input.requestId,
    },
  } satisfies ReviewServingProjectorRecord
}

const getDirectFullSummaryContributionPartialRecords = (input: {
  chunkId: string
  contributionRecords: readonly ReviewServingProjectorRecord[]
  requestId: string
}) => {
  return input.contributionRecords.map((record) => {
    return getDirectFullSummaryContributionPartialRecord({...input, record})
  })
}

const getDirectFullSummaryPartialDeleteStatements = (input: ProjectReviewServingSummariesInput) => {
  return [
    getDeleteReviewServingProjectorRowsStatement({
      predicates: {
        chunk_id: getRequiredSummaryRebuildChunkId(input),
        project_id: input.projectId,
        request_id: getRequiredSummaryRebuildRequestId(input),
        review_config_hash: input.reviewConfigHash,
        snapshot_id: input.snapshotId,
      },
      table: 'mart.review_article_summary_rebuild_partial_v4',
    }),
    getDeleteReviewServingProjectorRowsStatement({
      predicates: {
        chunk_id: getRequiredSummaryRebuildChunkId(input),
        project_id: input.projectId,
        request_id: getRequiredSummaryRebuildRequestId(input),
        review_config_hash: input.reviewConfigHash,
        snapshot_id: input.snapshotId,
      },
      table: 'mart.review_article_summary_contribution_rebuild_partial_v4',
    }),
  ]
}

const summaryRebuildPartialAccumulatorChunkIdPrefix = '__summary_rebuild_partial_accumulator__:'
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

const getCompletedSummaryRebuildPartialChunkJoin = (partialAlias: string) => {
  return `INNER JOIN app.review_rebuild_chunk_manifest chunk
      ON chunk.request_id = ${partialAlias}.request_id
      AND chunk.chunk_id = ${partialAlias}.chunk_id
      AND chunk.project_id = ${partialAlias}.project_id
      AND chunk.projection_component = 'summary'
      AND chunk.status = 'completed'`
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
    SELECT partial.chunk_id AS chunkId
    FROM mart.review_article_summary_rebuild_partial_v4 partial
    ${getCompletedSummaryRebuildPartialChunkJoin('partial')}
    WHERE ${getSummaryRebuildPartialScopePredicate({...input, alias: 'partial'})}
      AND partial.chunk_id NOT LIKE ${getSqlLiteral(`${summaryRebuildPartialAccumulatorChunkIdPrefix}%`)}
    UNION
    SELECT partial_contribution.chunk_id AS chunkId
    FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial_contribution
    ${getCompletedSummaryRebuildPartialChunkJoin('partial_contribution')}
    WHERE ${getSummaryRebuildPartialScopePredicate({...input, alias: 'partial_contribution'})}
      AND partial_contribution.chunk_id NOT LIKE ${getSqlLiteral(`${summaryRebuildPartialAccumulatorChunkIdPrefix}%`)}
    UNION
    SELECT chunk.chunk_id AS chunkId
    FROM app.review_rebuild_chunk_manifest chunk
    WHERE chunk.request_id = ${getSqlLiteral(input.requestId)}
      AND chunk.project_id = ${getSqlLiteral(input.projectId)}
      AND chunk.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND chunk.projection_component = 'summary'
    ORDER BY chunk.chunk_id
  `)
  const digest = createHash('sha256')
    .update(
      rows
        .map((row) => {
          return row.chunkId
        })
        .join('\0'),
    )
    .digest('hex')
    .slice(0, 16)

  return {
    accumulatorChunkId: `${summaryRebuildPartialAccumulatorChunkIdPrefix}${digest}`,
    hasManifestChunks: rows.length > 0,
  }
}

const getNextSummaryRebuildPartialReductionChunkIds = async (
  input: {
    accumulatorChunkId: string
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const scopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'partial'})

  return database.queryJson<{chunkId: string}>(`
    SELECT partial.chunk_id AS chunkId
    FROM mart.review_article_summary_rebuild_partial_v4 partial
    ${getCompletedSummaryRebuildPartialChunkJoin('partial')}
    WHERE ${scopePredicate}
      AND partial.chunk_id NOT LIKE ${getSqlLiteral(`${summaryRebuildPartialAccumulatorChunkIdPrefix}%`)}
    GROUP BY partial.chunk_id
    ORDER BY partial.chunk_id
    LIMIT ${summaryRebuildPartialReductionBatchSize}
  `)
}

const getSummaryRebuildAccumulatorPartialCount = async (
  input: {
    accumulatorChunkId: string
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const scopePredicate = getSummaryRebuildPartialScopePredicate(input)
  const rows = await database.queryJson<{partialCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS partialCount
    FROM mart.review_article_summary_rebuild_partial_v4
    WHERE ${scopePredicate}
      AND chunk_id = ${getSqlLiteral(input.accumulatorChunkId)}
  `)

  return Number(rows[0]?.partialCount ?? 0)
}

const getRefreshSummaryRebuildAccumulatorCountsStatement = (input: {
  accumulatorChunkId: string
  projectId: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  const contributionScopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'partial_contribution'})

  return `
    UPDATE mart.review_article_summary_rebuild_partial_v4 accumulator
    SET
      count_value = CASE
        WHEN accumulator.availability = 'ready'
        THEN COALESCE(contribution_counts.count_value, accumulator.count_value)
        ELSE NULL
      END,
      partial_updated_at = now()
    FROM (
      SELECT
        deduplicated.project_id,
        deduplicated.review_config_hash,
        deduplicated.snapshot_id,
        json_extract_string(deduplicated.contribution_key, '$.summaryKind') AS summary_kind,
        json_extract_string(deduplicated.contribution_key, '$.summaryIdentity') AS summary_identity,
        COALESCE(json_extract_string(deduplicated.contribution_key, '$.listModeKey'), 'global') AS list_mode_key,
        json_extract_string(deduplicated.contribution_key, '$.countKind') AS count_kind,
        json_extract_string(deduplicated.contribution_key, '$.filterKey') AS filter_key,
        json_extract_string(deduplicated.contribution_key, '$.facetKind') AS facet_kind,
        json_extract_string(deduplicated.contribution_key, '$.facetKey') AS facet_key,
        json_extract_string(deduplicated.contribution_key, '$.facetValue') AS facet_value,
        SUM(COALESCE(deduplicated.contribution_value, 0)) AS count_value
      FROM (
        SELECT
          partial_contribution.project_id,
          partial_contribution.review_config_hash,
          partial_contribution.snapshot_id,
          partial_contribution.article_id,
          partial_contribution.component_kind,
          partial_contribution.summary_definition_version,
          partial_contribution.contribution_key,
          ANY_VALUE(partial_contribution.contribution_value) AS contribution_value
        FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial_contribution
        ${getCompletedSummaryRebuildPartialChunkJoin('partial_contribution')}
        WHERE ${contributionScopePredicate}
          AND partial_contribution.component_kind = 'count'
        GROUP BY
          partial_contribution.project_id,
          partial_contribution.review_config_hash,
          partial_contribution.snapshot_id,
          partial_contribution.article_id,
          partial_contribution.component_kind,
          partial_contribution.summary_definition_version,
          partial_contribution.contribution_key
      ) deduplicated
      GROUP BY
        deduplicated.project_id,
        deduplicated.review_config_hash,
        deduplicated.snapshot_id,
        json_extract_string(deduplicated.contribution_key, '$.summaryKind'),
        json_extract_string(deduplicated.contribution_key, '$.summaryIdentity'),
        COALESCE(json_extract_string(deduplicated.contribution_key, '$.listModeKey'), 'global'),
        json_extract_string(deduplicated.contribution_key, '$.countKind'),
        json_extract_string(deduplicated.contribution_key, '$.filterKey'),
        json_extract_string(deduplicated.contribution_key, '$.facetKind'),
        json_extract_string(deduplicated.contribution_key, '$.facetKey'),
        json_extract_string(deduplicated.contribution_key, '$.facetValue')
    ) contribution_counts
    WHERE accumulator.request_id = ${getSqlLiteral(input.requestId)}
      AND accumulator.chunk_id = ${getSqlLiteral(input.accumulatorChunkId)}
      AND accumulator.project_id = contribution_counts.project_id
      AND accumulator.review_config_hash = contribution_counts.review_config_hash
      AND accumulator.snapshot_id = contribution_counts.snapshot_id
      AND accumulator.summary_kind = contribution_counts.summary_kind
      AND accumulator.summary_identity = contribution_counts.summary_identity
      AND COALESCE(accumulator.list_mode_key, 'global') = contribution_counts.list_mode_key
      AND (accumulator.summary_kind = 'facet' OR accumulator.count_kind IS NOT DISTINCT FROM contribution_counts.count_kind)
      AND accumulator.filter_key IS NOT DISTINCT FROM contribution_counts.filter_key
      AND accumulator.facet_kind IS NOT DISTINCT FROM contribution_counts.facet_kind
      AND accumulator.facet_key IS NOT DISTINCT FROM contribution_counts.facet_key
      AND accumulator.facet_value IS NOT DISTINCT FROM contribution_counts.facet_value
  `
}

const getDeleteSummaryContributionRowsForRebuildStatement = (input: {
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  return `
    DELETE FROM mart.review_article_summary_contribution_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
  `
}

const getInsertSummaryContributionRowsFromRebuildPartialsStatement = (input: {
  projectId: string
  requestId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  const scopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'partial_contribution'})

  return `
    INSERT INTO mart.review_article_summary_contribution_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      article_id,
      component_kind,
      summary_definition_version,
      contribution_key,
      contribution_value,
      contribution_updated_at
    )
    SELECT
      partial_contribution.project_id,
      partial_contribution.review_config_hash,
      partial_contribution.snapshot_id,
      partial_contribution.article_id,
      partial_contribution.component_kind,
      partial_contribution.summary_definition_version,
      partial_contribution.contribution_key,
      ANY_VALUE(partial_contribution.contribution_value) AS contribution_value,
      current_timestamp AS contribution_updated_at
    FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial_contribution
    ${getCompletedSummaryRebuildPartialChunkJoin('partial_contribution')}
    WHERE ${scopePredicate}
    GROUP BY
      partial_contribution.project_id,
      partial_contribution.review_config_hash,
      partial_contribution.snapshot_id,
      partial_contribution.article_id,
      partial_contribution.component_kind,
      partial_contribution.summary_definition_version,
      partial_contribution.contribution_key
  `
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
  const scopePredicate = getSummaryRebuildPartialScopePredicate({...input, alias: 'partial'})
  const chunkIdPredicate = getSummaryRebuildPartialChunkIdPredicate(input.chunkIds)

  await database.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO mart.review_article_summary_rebuild_partial_v4 (
        request_id,
        chunk_id,
        project_id,
        review_config_hash,
        snapshot_id,
        serving_key,
        summary_kind,
        summary_identity,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        facet_kind,
        facet_key,
        facet_value,
        prompt_id,
        answer_id,
        answer_value,
        availability,
        stale_reason,
        count_value,
        partial_updated_at
      )
      SELECT
        partial.request_id,
        ${getSqlLiteral(input.accumulatorChunkId)} AS chunk_id,
        partial.project_id,
        partial.review_config_hash,
        partial.snapshot_id,
        partial.serving_key,
        partial.summary_kind,
        partial.summary_identity,
        ANY_VALUE(partial.list_mode_key) AS list_mode_key,
        ANY_VALUE(partial.count_kind) AS count_kind,
        ANY_VALUE(partial.summary_definition_version) AS summary_definition_version,
        ANY_VALUE(partial.filter_key) AS filter_key,
        ANY_VALUE(partial.facet_kind) AS facet_kind,
        ANY_VALUE(partial.facet_key) AS facet_key,
        ANY_VALUE(partial.facet_value) AS facet_value,
        ANY_VALUE(partial.prompt_id) AS prompt_id,
        ANY_VALUE(partial.answer_id) AS answer_id,
        ANY_VALUE(partial.answer_value) AS answer_value,
        ANY_VALUE(partial.availability) AS availability,
        ANY_VALUE(partial.stale_reason) AS stale_reason,
        CASE WHEN ANY_VALUE(partial.availability) = 'ready' THEN SUM(COALESCE(partial.count_value, 0)) ELSE NULL END AS count_value,
        current_timestamp AS partial_updated_at
      FROM mart.review_article_summary_rebuild_partial_v4 partial
      ${getCompletedSummaryRebuildPartialChunkJoin('partial')}
      WHERE ${scopePredicate}
        AND partial.${chunkIdPredicate}
      GROUP BY partial.request_id, partial.project_id, partial.review_config_hash, partial.snapshot_id, partial.serving_key, partial.summary_kind, partial.summary_identity
      ON CONFLICT(request_id, chunk_id, project_id, review_config_hash, snapshot_id, serving_key) DO UPDATE SET
        count_value = CASE
          WHEN excluded.availability = 'ready' AND availability = 'ready'
          THEN COALESCE(count_value, 0) + COALESCE(excluded.count_value, 0)
          ELSE NULL
        END,
        partial_updated_at = now()
    `)
    await tx.run(getRefreshSummaryRebuildAccumulatorCountsStatement(input))
    await tx.run(`
      DELETE FROM mart.review_article_summary_rebuild_partial_v4
      WHERE ${getSummaryRebuildPartialScopePredicate(input)}
        AND ${chunkIdPredicate}
    `)
  })
}

const reduceSummaryRebuildPartialBatchesIntoAccumulator = async (
  input: {
    accumulatorChunkId: string
    projectId: string
    requestId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingSummaryProjectorDatabase,
): Promise<void> => {
  const chunkRows = await getNextSummaryRebuildPartialReductionChunkIds(input, database)
  const chunkIds = chunkRows.map((row) => {
    return row.chunkId
  })

  if (chunkIds.length === 0) {
    return
  }

  await reduceSummaryRebuildPartialChunkBatchIntoAccumulator({...input, chunkIds}, database)
  await reduceSummaryRebuildPartialBatchesIntoAccumulator(input, database)
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
  const {accumulatorChunkId} = await getSummaryRebuildPartialAccumulatorState(input, database)
  const scopedInput = {...input, accumulatorChunkId}

  await reduceSummaryRebuildPartialBatchesIntoAccumulator(scopedInput, database)

  const accumulatorPartialCount = await getSummaryRebuildAccumulatorPartialCount(scopedInput, database)

  if (accumulatorPartialCount === 0 && input.hasSummaryRebuildChunks !== true) {
    return
  }

  await database.transaction(async (tx) => {
    const scopePredicate = getSummaryRebuildPartialScopePredicate(input)
    await tx.run(getRefreshSummaryRebuildAccumulatorCountsStatement(scopedInput))
    await tx.run(`
      DELETE FROM mart.review_article_count_serving_v4
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
    `)
    await tx.run(`
      DELETE FROM mart.review_filter_facet_serving_v4
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
    `)
    await tx.run(getDeleteSummaryContributionRowsForRebuildStatement(input))
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
        stale_reason,
        count_updated_at
      )
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        COALESCE(list_mode_key, 'global') AS list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        CASE WHEN ANY_VALUE(availability) = 'ready' THEN SUM(COALESCE(count_value, 0)) ELSE NULL END AS count_value,
        ANY_VALUE(availability) AS availability,
        ANY_VALUE(stale_reason) AS stale_reason,
        current_timestamp AS count_updated_at
      FROM mart.review_article_summary_rebuild_partial_v4
      WHERE ${scopePredicate}
        AND chunk_id = ${getSqlLiteral(accumulatorChunkId)}
        AND summary_kind = 'count'
      GROUP BY project_id, review_config_hash, snapshot_id, summary_identity, COALESCE(list_mode_key, 'global'), count_kind, summary_definition_version, filter_key
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
        availability,
        facet_updated_at
      )
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        ANY_VALUE(prompt_id) AS prompt_id,
        ANY_VALUE(answer_id) AS answer_id,
        ANY_VALUE(answer_value) AS answer_value,
        summary_definition_version,
        CASE WHEN ANY_VALUE(availability) = 'ready' THEN SUM(COALESCE(count_value, 0)) ELSE NULL END AS count_value,
        ANY_VALUE(availability) AS availability,
        current_timestamp AS facet_updated_at
      FROM mart.review_article_summary_rebuild_partial_v4
      WHERE ${scopePredicate}
        AND chunk_id = ${getSqlLiteral(accumulatorChunkId)}
        AND summary_kind = 'facet'
      GROUP BY project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version
    `)
    await tx.run(getInsertSummaryContributionRowsFromRebuildPartialsStatement(input))
    await tx.run(`
      DELETE FROM mart.review_article_summary_rebuild_partial_v4
      WHERE ${scopePredicate}
        AND chunk_id <> ${getSqlLiteral(accumulatorChunkId)}
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
  const contributionRecords = input.measureSync('contributionRecordBuildMs', () => {
    return contributionRows.map((row) => {
      return getReviewServingContributionRecord({
        componentKind: 'count',
        projectId: input.projectorInput.projectId,
        reviewConfigHash: input.projectorInput.reviewConfigHash,
        row,
        snapshotId: input.projectorInput.snapshotId,
        summaryDefinitionVersion: 'review-serving-summary:v1',
      })
    })
  })
  const writerResult = await input.measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'summary',
        records: [...summaryRecords, ...contributionRecords],
        statements: getDirectFullSummaryDeleteStatements(input.projectorInput),
      },
      input.database,
    )
  })

  return {
    contributionRowCount: contributionRecords.length,
    diagnosticsJson: {
      phaseTimings: input.phaseTimings,
      summaryProjector: {
        contributionDiffCount: 0,
        contributionRecordCount: contributionRecords.length,
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
  const contributionRecords = input.measureSync('contributionRecordBuildMs', () => {
    return contributionRows.map((row) => {
      return getReviewServingContributionRecord({
        componentKind: 'count',
        projectId: input.projectorInput.projectId,
        reviewConfigHash: input.projectorInput.reviewConfigHash,
        row,
        snapshotId: input.projectorInput.snapshotId,
        summaryDefinitionVersion: 'review-serving-summary:v1',
      })
    })
  })
  const writerResult = await input.measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'summary',
        records: [
          ...partialRecords,
          ...getDirectFullSummaryContributionPartialRecords({
            chunkId: getRequiredSummaryRebuildChunkId(input.projectorInput),
            contributionRecords,
            requestId: getRequiredSummaryRebuildRequestId(input.projectorInput),
          }),
        ],
        statements: getDirectFullSummaryPartialDeleteStatements(input.projectorInput),
      },
      input.database,
    )
  })

  return {
    contributionRowCount: contributionRecords.length,
    diagnosticsJson: {
      phaseTimings: input.phaseTimings,
      summaryProjector: {
        contributionDiffCount: 0,
        contributionRecordCount: contributionRecords.length,
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

  const [sourceRows, priorArticleRows] = await measure('sourceQueryMs', async () => {
    return Promise.all([getSummaryContributionRows(input, database), getPriorContributionArticleIds(input, database)])
  })
  const newRows = measureSync('contributionTransformMs', () => {
    return getRowsAsContributionRows(sourceRows)
  })
  const contributionDiff = await measure('contributionDiffMs', async () => {
    return prepareReviewServingContributionDiff(
      {
        claims: input.claims,
        componentKind: 'count',
        expectedArticleIds: getExpectedArticleIds(
          input.claims,
          sourceRows,
          priorArticleRows.map((row) => {
            return row.articleId
          }),
        ),
        newRows,
        projectId: input.projectId,
        projectionComponent: 'summary',
        projectionIdentity: input.projectionIdentity,
        repairDirtyKind: 'project.reviewConfig.updated',
        reviewConfigHash: input.reviewConfigHash,
        snapshotId: input.snapshotId,
        summaryDefinitionVersion: 'review-serving-summary:v1',
      },
      database,
    )
  })
  const summaryRecords = await measure('summaryRecordBuildMs', async () => {
    return getSummaryRecords({database, diffs: contributionDiff.diffs, projectorInput: input})
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
        records: [...summaryRecords, ...contributionDiff.contributionRecords],
        repairDirtyWork: contributionDiff.repairDirtyWork,
        statements:
          contributionDiff.deleteContributionStateStatement === null
            ? []
            : [contributionDiff.deleteContributionStateStatement],
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
    contributionRowCount: contributionDiff.contributionRecords.length,
    diagnosticsJson: {
      phaseTimings,
      summaryProjector: {
        contributionDiffCount: contributionDiff.diffs.length,
        contributionRecordCount: contributionDiff.contributionRecords.length,
        priorArticleRowCount: priorArticleRows.length,
        sourceRowCount: sourceRows.length,
        writer: writerResult.diagnostics,
      },
    },
    repairRequired: contributionDiff.repairRequired,
    summaryRowCount: summaryRecords.length,
    summaryValues: summaryRecords.map((record) => {
      return record.values
    }),
  }
}
