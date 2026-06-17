import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {namedReviewFastCountDefinitions} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingFilterOptionProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingFilterOptionsInput = {
  acknowledgeClaims?: boolean
  claims: readonly ReviewServingDirtyWorkClaim[]
  filterOptionIdentity: string
  listModeKeys: readonly string[]
  optionMode: 'human' | 'review'
  projectId: string
  projectionIdentity: string
  reviewConfigHash: string
  searchIdentity: string
  searchTitle?: string | null
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
  optionPayloadJson: Record<string, unknown> | string | null
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
  filterKeys: readonly string[]
  listModeKeys: readonly string[]
  optionMode: 'human' | 'review'
  searchIdentity: string
  summaryDefinitionVersions?: Record<string, string>
}) => {
  return getStableReviewServingJson({
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

const getSearchPredicate = (searchTitle: string | null | undefined) => {
  const trimmedSearch = searchTitle?.trim() ?? ''

  return trimmedSearch.length === 0
    ? ''
    : `AND LOWER(COALESCE(serving.article_title, '')) LIKE LOWER(${getSqlLiteral(`%${trimmedSearch}%`)})`
}

const getOptionModePredicate = (input: ProjectReviewServingFilterOptionsInput) => {
  return input.optionMode === 'human' ? "AND detail.payload_kind = 'human'" : "AND detail.payload_kind = 'llm'"
}

const getPromptAnswerFacetKey = (input: ProjectReviewServingFilterOptionsInput) => {
  return input.optionMode === 'human' ? 'humanPromptAnswer' : 'promptAnswer'
}

const getNumericFacetKey = (input: ProjectReviewServingFilterOptionsInput) => {
  return input.optionMode === 'human' ? 'humanNumericPromptAnswer' : 'numericPromptAnswer'
}

const getAnswerValueExpression = () => {
  return `CASE
    WHEN detail.answered_original_as_array IS NOT NULL AND array_length(detail.answered_original_as_array) > 0
      THEN unnest(detail.answered_original_as_array)
    ELSE detail.answered_original
  END`
}

const getFilterOptionSourceRows = async (
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
            ${getSearchPredicate(input.searchTitle)}
        ),
        review_facet_options AS (
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'duplicateFlag' AS facetKey, CAST(serving.duplicate_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':duplicateFlag:', CAST(serving.duplicate_flag AS VARCHAR)) AS optionValueKey, json_object('filterType', 'enum', 'facetKey', 'duplicateFlag', 'value', CAST(serving.duplicate_flag AS VARCHAR)) AS optionPayloadJson, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${aggregateBySql} serving.duplicate_flag
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'conflictFlag' AS facetKey, CAST(serving.conflict_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':conflictFlag:', CAST(serving.conflict_flag AS VARCHAR)) AS optionValueKey, json_object('filterType', 'enum', 'facetKey', 'conflictFlag', 'value', CAST(serving.conflict_flag AS VARCHAR)) AS optionPayloadJson, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${aggregateBySql} serving.conflict_flag
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'importRoute' AS facetKey, serving.selected_import_route_id AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':importRoute:', serving.selected_import_route_id) AS optionValueKey, json_object('filterType', 'enum', 'facetKey', 'importRoute', 'value', serving.selected_import_route_id) AS optionPayloadJson, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.selected_import_route_id IS NOT NULL
          ${aggregateBySql} serving.selected_import_route_id
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'publicationYear' AS facetKey, CAST(serving.publication_year AS VARCHAR) AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':publicationYear:', CAST(serving.publication_year AS VARCHAR)) AS optionValueKey, json_object('filterType', 'enum', 'facetKey', 'publicationYear', 'value', CAST(serving.publication_year AS VARCHAR)) AS optionPayloadJson, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.publication_year IS NOT NULL
          ${aggregateBySql} serving.publication_year
          UNION ALL
          SELECT 'review' AS filterKind, 'llmStatus' AS facetKey, serving.llm_status_key AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat('review:llmStatus:', serving.llm_status_key) AS optionValueKey, json_object('filterType', 'enum', 'facetKey', 'llmStatus', 'value', serving.llm_status_key) AS optionPayloadJson, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} = 'review' AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.llm_status_key IS NOT NULL
          ${aggregateBySql} serving.llm_status_key
          UNION ALL
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, 'humanStatus' AS facetKey, serving.human_status_key AS facetValue, NULL AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':humanStatus:', serving.human_status_key) AS optionValueKey, json_object('filterType', 'enum', 'facetKey', 'humanStatus', 'value', serving.human_status_key) AS optionPayloadJson, COUNT(DISTINCT serving.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM mart.review_article_serving_v4 serving
          INNER JOIN active_article active ON active.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = serving.list_mode_key
          WHERE ${getSqlLiteral(input.optionMode)} IN ('review', 'human') AND serving.project_id = ${getSqlLiteral(input.projectId)} AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)} AND serving.human_status_key IS NOT NULL
          ${aggregateBySql} serving.human_status_key
        ),
        answer_values AS (
          SELECT detail.article_id, detail.prompt_id, ${getAnswerValueExpression()} AS answerValue
          FROM mart.review_article_judgment_detail_serving_v4 detail
          INNER JOIN active_article active ON active.article_id = detail.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = detail.list_mode_key
          WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            ${getOptionModePredicate(input)}
        ),
        prompt_answer_options AS (
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, ${getSqlLiteral(getPromptAnswerFacetKey(input))} AS facetKey, answer.answerValue AS facetValue, answer.prompt_id AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':', ${getSqlLiteral(getPromptAnswerFacetKey(input))}, ':', answer.prompt_id, ':', answer.answerValue) AS optionValueKey, json_object('filterType', 'enum', 'promptId', answer.prompt_id, 'value', answer.answerValue) AS optionPayloadJson, COUNT(DISTINCT answer.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM answer_values answer
          WHERE NULLIF(TRIM(COALESCE(answer.answerValue, '')), '') IS NOT NULL
            AND (${getSqlLiteral(input.optionMode)} <> 'human' OR answer.prompt_id <> 'summary')
          ${aggregateBySql} answer.prompt_id, answer.answerValue
        ),
        human_summary_options AS (
          SELECT 'human' AS filterKind, 'summaryAnswer' AS facetKey, answer.answerValue AS facetValue, 'summary' AS promptId, NULL::INTEGER AS answerId, concat('human:summaryAnswer:summary:', answer.answerValue) AS optionValueKey, json_object('filterType', 'enum', 'promptId', 'summary', 'summaryMode', true, 'value', answer.answerValue) AS optionPayloadJson, COUNT(DISTINCT answer.article_id) AS countValue, NULL::DOUBLE AS numericMin, NULL::DOUBLE AS numericMax
          FROM answer_values answer
          WHERE ${getSqlLiteral(input.optionMode)} = 'human'
            AND answer.prompt_id = 'summary'
            AND NULLIF(TRIM(COALESCE(answer.answerValue, '')), '') IS NOT NULL
          ${aggregateBySql} answer.answerValue
        ),
        numeric_options AS (
          SELECT ${getSqlLiteral(input.optionMode)} AS filterKind, ${getSqlLiteral(getNumericFacetKey(input))} AS facetKey, NULL AS facetValue, answer.prompt_id AS promptId, NULL::INTEGER AS answerId, concat(${getSqlLiteral(input.optionMode)}, ':', ${getSqlLiteral(getNumericFacetKey(input))}, ':', answer.prompt_id) AS optionValueKey, json_object('filterType', 'numeric', 'promptId', answer.prompt_id) AS optionPayloadJson, COUNT(DISTINCT answer.article_id) AS countValue, MIN(CAST(answer.answerValue AS DOUBLE)) AS numericMin, MAX(CAST(answer.answerValue AS DOUBLE)) AS numericMax
          FROM answer_values answer
          WHERE regexp_full_match(TRIM(COALESCE(answer.answerValue, '')), '^[-+]?[0-9]+$')
            AND (${getSqlLiteral(input.optionMode)} <> 'human' OR answer.prompt_id <> 'summary')
          ${aggregateBySql} answer.prompt_id
        )
        SELECT * FROM review_facet_options WHERE facetValue IS NOT NULL
        UNION ALL SELECT * FROM prompt_answer_options
        UNION ALL SELECT * FROM human_summary_options
        UNION ALL SELECT * FROM numeric_options
      `)
}

const getOptionPayload = (row: FilterOptionSourceRow) => {
  return typeof row.optionPayloadJson === 'string' ? row.optionPayloadJson : (row.optionPayloadJson ?? {})
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
      option_payload_json: getOptionPayload(input.row),
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
  database: ReviewServingFilterOptionProjectorDatabase = getAppDatabaseService(),
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

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
      component: 'summary',
      records,
      statements: [getDeleteFilterOptionRowsStatement(input)],
      watermark:
        input.claims.length === 0
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

  return {
    optionRowCount: records.length,
    optionValues: records.map((record) => {
      return record.values
    }),
  }
}
