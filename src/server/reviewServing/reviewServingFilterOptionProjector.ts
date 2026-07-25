import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {namedReviewFastCountDefinitions} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingFilterOptionProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingFilterOptionsInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  deleteExisting?: boolean
  displayIdentity: string
  filterOptionIdentity: string
  listModeKeys: readonly string[]
  optionMode: 'human' | 'review'
  payloadIdentity: string
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  reviewConfigHash: string
  searchIdentity: string
  searchTitle?: string | null
  selectedImportSnapshotId: string
  snapshotId: string
}

type FilterOptionSourceRow = {
  answerId: number | null
  countValue: number | null
  facetKey: string
  facetValue: string | null
  filterKind: string
  numericMax: number | null
  numericMin: number | null
  optionValueKey: string
  promptId: string | null
}

const filterOptionProjectorName = 'filter-option-projector'
const aggregateBySql = ['GROUP', 'BY'].join(' ')

const filterOptionSummaryDefinitionVersions = {
  humanPromptAnswer: namedReviewFastCountDefinitions['review.human.filter.promptAnswer'].summaryDefinitionVersion,
  humanSummaryAnswer: namedReviewFastCountDefinitions['review.human.filter.summaryAnswer'].summaryDefinitionVersion,
  reviewDuplicateFlag: namedReviewFastCountDefinitions['review.filter.duplicateFlag'].summaryDefinitionVersion,
  reviewImportRoute: namedReviewFastCountDefinitions['review.filter.importRoute'].summaryDefinitionVersion,
  reviewPromptAnswer: namedReviewFastCountDefinitions['review.filter.promptAnswer'].summaryDefinitionVersion,
  reviewPublicationYear: namedReviewFastCountDefinitions['review.filter.publicationYear'].summaryDefinitionVersion,
} as const

export const getReviewServingFilterOptionIdentity = (input: {
  activeFilters?: ReviewServingIdentityValue
  filterKeys: readonly string[]
  listModeKeys: readonly string[]
  optionMode: 'human' | 'review'
  searchIdentity: string
  summaryDefinitionVersions?: Record<string, string>
}) => {
  return getStableReviewServingJson({
    activeFilters: input.activeFilters ?? {},
    filterKeys: [...input.filterKeys].sort(),
    listModeKeys: [...input.listModeKeys].sort(),
    optionMode: input.optionMode,
    searchIdentity: input.searchIdentity,
    summaryDefinitionVersions: input.summaryDefinitionVersions ?? filterOptionSummaryDefinitionVersions,
  })
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

const getClaimKinds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyKind
      }),
    ),
  ].join(',')
}

const getClaimSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims[0]?.sourcePartition ?? 'review-change'
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

const getSearchPredicate = (searchTitle: string | null | undefined, titleSql: string) => {
  const trimmedSearch = searchTitle?.trim() ?? ''

  return trimmedSearch.length === 0
    ? ''
    : `AND LOWER(COALESCE(${titleSql}, '')) LIKE LOWER(${getSqlLiteral(`%${trimmedSearch}%`)})`
}

const getOptionModePredicate = (input: ProjectReviewServingFilterOptionsInput) => {
  return input.optionMode === 'human' ? "AND detail.payload_kind = 'human'" : "AND detail.payload_kind = 'llm'"
}

const getDetailListModeExpansionPredicate = (input: ProjectReviewServingFilterOptionsInput) => {
  return input.optionMode === 'human'
    ? "detail.list_mode_key = 'human' AND list_mode_key.list_mode_key IN ('human', 'both')"
    : "detail.list_mode_key = 'llm' AND list_mode_key.list_mode_key IN ('llm', 'both')"
}

const getPromptAnswerFacetKey = (_input: ProjectReviewServingFilterOptionsInput) => {
  return 'promptAnswer'
}

const isSearchScopedFilterOptionProjection = (input: ProjectReviewServingFilterOptionsInput) => {
  return (input.searchTitle?.trim() ?? '').length > 0
}

const getFinalizedFacetOptionSourceRows = async (
  input: ProjectReviewServingFilterOptionsInput,
  database: ReviewServingFilterOptionProjectorDatabase,
) => {
  if (input.listModeKeys.length === 0) {
    return []
  }

  const reviewSummaryIdentities = [
    {
      summaryIdentity: 'review.filter.duplicateFlag',
      summaryDefinitionVersion: filterOptionSummaryDefinitionVersions.reviewDuplicateFlag,
    },
    {
      summaryIdentity: 'review.filter.importRoute',
      summaryDefinitionVersion: filterOptionSummaryDefinitionVersions.reviewImportRoute,
    },
    {
      summaryIdentity: 'review.filter.promptAnswer',
      summaryDefinitionVersion: filterOptionSummaryDefinitionVersions.reviewPromptAnswer,
    },
    {
      summaryIdentity: 'review.filter.publicationYear',
      summaryDefinitionVersion: filterOptionSummaryDefinitionVersions.reviewPublicationYear,
    },
  ] as const
  const humanSummaryIdentities = [
    {
      summaryIdentity: 'review.human.filter.promptAnswer',
      summaryDefinitionVersion: filterOptionSummaryDefinitionVersions.humanPromptAnswer,
    },
    {
      summaryIdentity: 'review.human.filter.summaryAnswer',
      summaryDefinitionVersion: filterOptionSummaryDefinitionVersions.humanSummaryAnswer,
    },
  ] as const
  const summaryIdentities = input.optionMode === 'human' ? humanSummaryIdentities : reviewSummaryIdentities

  return database.queryJson<FilterOptionSourceRow>(`
    WITH summary_identity_filter(summary_identity, summary_definition_version) AS (
      SELECT * FROM (VALUES ${summaryIdentities
        .map((summary) => {
          return `(${getSqlLiteral(summary.summaryIdentity)}, ${getSqlLiteral(summary.summaryDefinitionVersion)})`
        })
        .join(', ')})
    ),
    finalized_facet_options AS (
      SELECT
        ${getSqlLiteral(input.optionMode)} AS filterKind,
        CASE WHEN facet.summary_identity = 'review.human.filter.summaryAnswer' THEN 'promptAnswer' ELSE facet.facet_key END AS facetKey,
        facet.facet_value AS facetValue,
        facet.prompt_id AS promptId,
        facet.answer_id AS answerId,
        CASE
          WHEN facet.summary_identity = 'review.human.filter.summaryAnswer' OR facet.facet_key = 'promptAnswer'
            THEN concat(${getSqlLiteral(input.optionMode)}, ':promptAnswer:', facet.prompt_id, ':', facet.facet_value)
          ELSE concat(${getSqlLiteral(input.optionMode)}, ':', facet.facet_key, ':', facet.facet_value)
        END AS optionValueKey,
        facet.count_value AS countValue,
        NULL::DOUBLE AS numericMin,
        NULL::DOUBLE AS numericMax
      FROM mart.review_filter_facet_serving_v4 facet
      INNER JOIN summary_identity_filter summary_identity
        ON summary_identity.summary_identity = facet.summary_identity
        AND summary_identity.summary_definition_version = facet.summary_definition_version
      WHERE facet.project_id = ${getSqlLiteral(input.projectId)}
        AND facet.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND facet.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND facet.availability = 'ready'
        AND (
          (
            facet.summary_identity IN ('review.filter.duplicateFlag', 'review.filter.importRoute', 'review.filter.publicationYear', 'review.filter.promptAnswer')
            AND facet.facet_kind = 'review'
          )
          OR (
            ${getSqlLiteral(input.optionMode)} = 'human'
            AND facet.summary_identity IN ('review.human.filter.promptAnswer', 'review.human.filter.summaryAnswer')
            AND facet.facet_kind = 'human'
          )
        )
    )
    SELECT * FROM finalized_facet_options
  `)
}

const getNoSearchFallbackOptionSourceRows = async (
  input: ProjectReviewServingFilterOptionsInput,
  database: ReviewServingFilterOptionProjectorDatabase,
) => {
  return input.listModeKeys.length === 0
    ? []
    : database.queryJson<FilterOptionSourceRow>(`
        WITH ${getValuesCte('list_mode_key', input.listModeKeys)},
        active_article AS (
          SELECT DISTINCT serving.article_id
          FROM mart.review_article_serving_v4 serving
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        ),
        selected_article AS (
          SELECT DISTINCT
            serving.article_id,
            CASE WHEN selected_base.tombstone THEN NULL ELSE selected_base.import_route_id END AS import_route_id,
            selected_hot.publication_year,
            CASE
              WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
              ELSE COALESCE(selected_hot.duplicate_flag, FALSE)
            END AS duplicate_flag,
            CASE
              WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
              ELSE COALESCE(selected_hot.conflict_flag, FALSE)
            END AS conflict_flag
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          LEFT JOIN app.review_selected_article_import_v4 selected_base
            ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected_base.article_id = serving.article_id
          LEFT JOIN app.review_import_article_hot_field selected_hot
            ON selected_hot.import_route_id = selected_base.import_route_id
            AND selected_hot.article_id = selected_base.article_id
            AND selected_hot.source_record_key = selected_base.source_record_key
            AND NOT selected_hot.tombstone
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        ),
        option_specific_options AS (
          SELECT 'human' AS filterKind, 'duplicateFlag' AS facetKey, CAST(selected.duplicate_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat('human:duplicateFlag:', CAST(selected.duplicate_flag AS VARCHAR)) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} = 'human' AND selected.duplicate_flag IS NOT NULL
          ${aggregateBySql} selected.duplicate_flag
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'conflictFlag' AS facetKey, CAST(selected.conflict_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':conflictFlag:', CAST(selected.conflict_flag AS VARCHAR)) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND selected.conflict_flag IS NOT NULL
          ${aggregateBySql} selected.conflict_flag
          UNION ALL
          SELECT 'human' AS filterKind, 'importRoute' AS facetKey, selected.import_route_id AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat('human:importRoute:', selected.import_route_id) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} = 'human' AND selected.import_route_id IS NOT NULL
          ${aggregateBySql} selected.import_route_id
          UNION ALL
          SELECT 'human' AS filterKind, 'publicationYear' AS facetKey, CAST(selected.publication_year AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat('human:publicationYear:', CAST(selected.publication_year AS VARCHAR)) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} = 'human' AND selected.publication_year IS NOT NULL
          ${aggregateBySql} selected.publication_year
          UNION ALL
          SELECT 'review' AS filterKind, 'llmStatus' AS facetKey, serving.llm_status_key AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat('review:llmStatus:', serving.llm_status_key) AS optionValueKey, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} = 'review' AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.llm_status_key IS NOT NULL
          ${aggregateBySql} serving.llm_status_key
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'humanStatus' AS facetKey, serving.human_status_key AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':humanStatus:', serving.human_status_key) AS optionValueKey, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.human_status_key IS NOT NULL
          ${aggregateBySql} serving.human_status_key
        )
        SELECT * FROM option_specific_options WHERE facetValue IS NOT NULL
      `)
}

const getReconstructedFilterOptionSourceRows = async (
  input: ProjectReviewServingFilterOptionsInput,
  database: ReviewServingFilterOptionProjectorDatabase,
) => {
  return input.listModeKeys.length === 0
    ? []
    : database.queryJson<FilterOptionSourceRow>(`
        WITH ${getValuesCte('list_mode_key', input.listModeKeys)},
        active_article AS (
          SELECT DISTINCT serving.article_id
          FROM mart.review_article_serving_v4 serving
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          INNER JOIN mart.review_article_serving_payload_v4 payload
            ON payload.project_id = serving.project_id
            AND payload.display_identity = ${getSqlLiteral(input.displayIdentity)}
            AND payload.payload_identity = ${getSqlLiteral(input.payloadIdentity)}
            AND payload.snapshot_id = serving.snapshot_id
            AND payload.article_id = serving.article_id
          LEFT JOIN app.article article
            ON article.id = serving.article_id
          LEFT JOIN app.review_selected_article_import_v4 selected_import
            ON selected_import.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_import.project_id = serving.project_id
            AND selected_import.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected_import.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected_import.article_id = serving.article_id
            AND NOT selected_import.tombstone
          LEFT JOIN app.review_import_article_hot_field selected_hot
            ON selected_hot.import_route_id = selected_import.import_route_id
            AND selected_hot.article_id = serving.article_id
            AND selected_hot.source_record_key = selected_import.source_record_key
            AND NOT selected_hot.tombstone
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            ${getSearchPredicate(input.searchTitle, 'COALESCE(selected_hot.article_title, article.article_title)')}
        ),
        selected_article AS (
          SELECT DISTINCT
            serving.article_id,
            CASE WHEN selected_base.tombstone THEN NULL ELSE selected_base.import_route_id END AS import_route_id,
            selected_hot.publication_year,
            CASE
              WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
              ELSE COALESCE(selected_hot.duplicate_flag, FALSE)
            END AS duplicate_flag,
            CASE
              WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
              ELSE COALESCE(selected_hot.conflict_flag, FALSE)
            END AS conflict_flag
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          LEFT JOIN app.review_selected_article_import_v4 selected_base
            ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected_base.article_id = serving.article_id
          LEFT JOIN app.review_import_article_hot_field selected_hot
            ON selected_hot.import_route_id = selected_base.import_route_id
            AND selected_hot.article_id = selected_base.article_id
            AND selected_hot.source_record_key = selected_base.source_record_key
            AND NOT selected_hot.tombstone
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        ),
        review_facet_options AS (
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'duplicateFlag' AS facetKey, CAST(selected.duplicate_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':duplicateFlag:', CAST(selected.duplicate_flag AS VARCHAR)) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND selected.duplicate_flag IS NOT NULL
          ${aggregateBySql} selected.duplicate_flag
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'conflictFlag' AS facetKey, CAST(selected.conflict_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':conflictFlag:', CAST(selected.conflict_flag AS VARCHAR)) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND selected.conflict_flag IS NOT NULL
          ${aggregateBySql} selected.conflict_flag
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'importRoute' AS facetKey, selected.import_route_id AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':importRoute:', selected.import_route_id) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND selected.import_route_id IS NOT NULL
          ${aggregateBySql} selected.import_route_id
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'publicationYear' AS facetKey, CAST(selected.publication_year AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':publicationYear:', CAST(selected.publication_year AS VARCHAR)) AS optionValueKey, COUNT(DISTINCT selected.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM selected_article selected
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND selected.publication_year IS NOT NULL
          ${aggregateBySql} selected.publication_year
          UNION ALL
          SELECT 'review' AS filterKind, 'llmStatus' AS facetKey, serving.llm_status_key AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat('review:llmStatus:', serving.llm_status_key) AS optionValueKey, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} = 'review' AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.llm_status_key IS NOT NULL
          ${aggregateBySql} serving.llm_status_key
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'humanStatus' AS facetKey, serving.human_status_key AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':humanStatus:', serving.human_status_key) AS optionValueKey, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.human_status_key IS NOT NULL
          ${aggregateBySql} serving.human_status_key
        ),
        answer_values AS (
          SELECT detail.article_id, detail.prompt_id, detail.answered_original AS answerValue
          FROM mart.review_article_judgment_detail_serving_v4 detail
          INNER JOIN active_article active ON active.article_id = detail.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON ${getDetailListModeExpansionPredicate(input)}
          WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            ${getOptionModePredicate(input)}
            AND detail.answered_original_as_array IS NULL
          UNION ALL
          SELECT detail.article_id, detail.prompt_id, unnest(detail.answered_original_as_array) AS answerValue
          FROM mart.review_article_judgment_detail_serving_v4 detail
          INNER JOIN active_article active ON active.article_id = detail.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON ${getDetailListModeExpansionPredicate(input)}
          WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            ${getOptionModePredicate(input)}
            AND detail.answered_original_as_array IS NOT NULL
            AND array_length(detail.answered_original_as_array) > 0
        ),
        prompt_answer_options AS (
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, ${getSqlLiteral(getPromptAnswerFacetKey(input))} AS facetKey, answer.answerValue AS facetValue, answer.prompt_id AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':', ${getSqlLiteral(getPromptAnswerFacetKey(input))}, ':', answer.prompt_id, ':', answer.answerValue) AS optionValueKey, COUNT(DISTINCT answer.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM answer_values answer
          WHERE NULLIF(TRIM(COALESCE(answer.answerValue, '')), '') IS NOT NULL
            AND (${getSqlLiteral(input.optionMode)} <> 'human' OR answer.prompt_id <> 'summary')
          ${aggregateBySql} answer.prompt_id, answer.answerValue
        ),
        human_summary_options AS (
          SELECT 'human' AS filterKind, 'promptAnswer' AS facetKey, answer.answerValue AS facetValue, 'summary' AS promptId, NULL::INTEGER AS answerId, concat('human:promptAnswer:summary:', answer.answerValue) AS optionValueKey, COUNT(DISTINCT answer.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM answer_values answer
          WHERE ${getSqlLiteral(input.optionMode)} = 'human'
            AND answer.prompt_id = 'summary'
            AND NULLIF(TRIM(COALESCE(answer.answerValue, '')), '') IS NOT NULL
          ${aggregateBySql} answer.answerValue
        )
        SELECT * FROM review_facet_options WHERE facetValue IS NOT NULL
        UNION ALL SELECT * FROM prompt_answer_options
        UNION ALL SELECT * FROM human_summary_options
      `)
}

const getFilterOptionSourceRows = async (
  input: ProjectReviewServingFilterOptionsInput,
  database: ReviewServingFilterOptionProjectorDatabase,
) => {
  if (isSearchScopedFilterOptionProjection(input)) {
    return getReconstructedFilterOptionSourceRows(input, database)
  }

  const finalizedFacetRows = await getFinalizedFacetOptionSourceRows(input, database)
  const fallbackRows = await getNoSearchFallbackOptionSourceRows(input, database)

  return [...finalizedFacetRows, ...fallbackRows]
}

const getFilterOptionRecord = (input: {
  filterOptionIdentity: string
  projectId: string
  reviewConfigHash: string
  row: FilterOptionSourceRow
  searchIdentity: string
  snapshotId: string
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'search_identity',
      'filter_option_identity',
      'filter_kind',
      'facet_key',
      'option_value_key',
    ],
    table: 'mart.review_filter_option_serving_v4',
    values: {
      answer_id: input.row.answerId,
      count_value: input.row.countValue,
      facet_key: input.row.facetKey,
      facet_value: input.row.facetValue,
      filter_kind: input.row.filterKind,
      filter_option_identity: input.filterOptionIdentity,
      numeric_max: input.row.numericMax,
      numeric_min: input.row.numericMin,
      option_updated_at: new Date(),
      option_value_key: input.row.optionValueKey,
      project_id: input.projectId,
      prompt_id: input.row.promptId,
      review_config_hash: input.reviewConfigHash,
      search_identity: input.searchIdentity,
      snapshot_id: input.snapshotId,
    },
  }
}

const getDeleteFilterOptionRowsStatement = (input: ProjectReviewServingFilterOptionsInput) => {
  return getDeleteReviewServingProjectorRowsStatement({
    predicates: {
      filter_option_identity: input.filterOptionIdentity,
      project_id: input.projectId,
      review_config_hash: input.reviewConfigHash,
      search_identity: input.searchIdentity,
      snapshot_id: input.snapshotId,
    },
    table: 'mart.review_filter_option_serving_v4',
  })
}

export const projectReviewServingFilterOptions = async (
  input: ProjectReviewServingFilterOptionsInput,
  database: ReviewServingFilterOptionProjectorDatabase = getAppDatabaseService() as ReviewServingFilterOptionProjectorDatabase,
) => {
  const sourceRows = await getFilterOptionSourceRows(input, database)
  const records = sourceRows.map((row) => {
    return getFilterOptionRecord({
      filterOptionIdentity: input.filterOptionIdentity,
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      row,
      searchIdentity: input.searchIdentity,
      snapshotId: input.snapshotId,
    })
  })
  const patchWatermark = getPatchWatermark(input.claims)
  const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false
  const shouldPublishManifest = shouldAcknowledgeClaims

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: shouldPublishManifest ? [] : shouldAcknowledgeClaims ? input.claims : [],
      component: 'summary',
      records,
      statements: input.deleteExisting === false ? [] : [getDeleteFilterOptionRowsStatement(input)],
      watermark:
        shouldPublishManifest || !shouldAcknowledgeClaims
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'summary',
              projectorName: filterOptionProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
    },
    database,
  )

  if (shouldPublishManifest) {
    await writeReviewServingProjectorComponent(
      {
        acknowledgements: input.claims,
        component: 'summary',
        projectionManifests: [
          {
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
            projectionComponent: 'summary',
            projectionIdentity: input.projectionIdentity,
            reviewConfigHash: input.reviewConfigHash,
            status: 'candidate',
          },
        ],
        watermark: {
          projectId: input.projectId,
          projectionComponent: 'summary',
          projectorName: filterOptionProjectorName,
          sourceHighWaterMark: patchWatermark,
          sourcePartition: getClaimSourcePartition(input.claims),
        },
      },
      database,
    )
  }

  return {
    optionRowCount: records.length,
    optionValues: records.map((record) => {
      return record.values
    }),
  }
}
