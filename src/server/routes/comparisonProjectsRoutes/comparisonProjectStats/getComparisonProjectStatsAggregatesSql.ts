import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getComparisonProjectStatsConflictResolutionProvenanceSql} from './comparisonProjectStatsConflictResolutionProvenanceSql.ts'
import {
  comparisonProjectConflictResolutionTable,
  getComparisonProjectStatsArticleCategorySql,
  getInClause,
} from './comparisonProjectStatsSql.ts'
import type {
  ComparisonProjectStatsAggregateGroup,
  ComparisonProjectStatsConflictResolutionProvenanceParams,
} from './comparisonProjectStatsTypes.ts'
import {getComparisonProjectStatsGroupValuesSql} from './getComparisonProjectStatsAggregatesSql/getComparisonProjectStatsGroupValuesSql.ts'
import {
  getComparisonProjectStatsNonCurrentResolutionCteSql,
  getComparisonProjectStatsNonCurrentResolutionPairFilterSql,
} from './getComparisonProjectStatsAggregatesSql/getComparisonProjectStatsNonCurrentResolutionSql.ts'
import {getHasComparisonProjectStatsAnswerFilterGroups} from './getComparisonProjectStatsAggregatesSql/getHasComparisonProjectStatsAnswerFilterGroups.ts'

export const getComparisonProjectStatsAggregatesSql = (
  params: ComparisonProjectStatsConflictResolutionProvenanceParams & {
    columnIds: readonly string[]
    comparisonProjectId: string
    generation: number
    groups: readonly ComparisonProjectStatsAggregateGroup[]
  },
) => {
  const hasAnswerFilterGroups = getHasComparisonProjectStatsAnswerFilterGroups(params.groups)

  return `
    WITH comparison_group(comparison_id, comparison_kind, left_column_id, right_column_id${hasAnswerFilterGroups ? ', filter_column_id, filter_answer_value' : ''}) AS (
      VALUES
      ${getComparisonProjectStatsGroupValuesSql(params.groups)}
    ),
    scoped_cell AS (
      SELECT
        cell.article_id,
        ${getComparisonProjectStatsArticleCategorySql('article.article_category')} AS article_category,
        cell.column_id,
        cell.normalized_answers
      FROM mart.comparison_cell_serving cell
      INNER JOIN mart.comparison_article_serving article
        ON article.comparison_project_id = cell.comparison_project_id
        AND article.generation = cell.generation
        AND article.article_id = cell.article_id
      WHERE cell.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND cell.generation = ${getSqlLiteral(params.generation)}
        AND cell.column_id IN (${getInClause(params.columnIds)})
        AND cell.normalized_answers IS NOT NULL
        AND ARRAY_LENGTH(cell.normalized_answers) > 0
    ),
    normalized_cell_answer AS (
      SELECT
        scoped_cell.article_id,
        scoped_cell.article_category,
        scoped_cell.column_id,
        LOWER(TRIM(answer.answer_value)) AS answer_value,
        CASE
          WHEN LOWER(TRIM(answer.answer_value)) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(TRIM(answer.answer_value)) = 'no' THEN 'exclude'
          ELSE NULL
        END AS binary_decision
      FROM scoped_cell,
        UNNEST(scoped_cell.normalized_answers) AS answer(answer_value)
      WHERE NULLIF(TRIM(answer.answer_value), '') IS NOT NULL
    ),
    normalized_cell AS (
      SELECT article_id, article_category, column_id
      FROM normalized_cell_answer
      GROUP BY article_id, article_category, column_id
    )${
      hasAnswerFilterGroups
        ? `,
    answer_filter_cell AS (
      SELECT article_id, column_id, answer_value
      FROM normalized_cell_answer
      GROUP BY article_id, column_id, answer_value
    )`
        : ''
    },
    normalized_conflict_resolution_answer AS (
      SELECT
        article_id,
        LOWER(TRIM(answer_value)) AS answer_value,
        CASE
          WHEN LOWER(TRIM(answer_value)) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(TRIM(answer_value)) = 'no' THEN 'exclude'
          ELSE NULL
        END AS binary_decision
      FROM ${comparisonProjectConflictResolutionTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND answer_value IS NOT NULL
        AND NULLIF(TRIM(answer_value), '') IS NOT NULL
        ${getComparisonProjectStatsConflictResolutionProvenanceSql(params)}
    ),${getComparisonProjectStatsNonCurrentResolutionCteSql(params)}
    comparison_pair AS (
      SELECT
        comparison_group.comparison_id,
        comparison_group.comparison_kind,
        comparison_group.left_column_id,
        comparison_group.right_column_id,
        left_cell.article_id,
        left_cell.article_category
      FROM comparison_group
      INNER JOIN normalized_cell left_cell ON left_cell.column_id = comparison_group.left_column_id
      INNER JOIN normalized_cell right_cell
        ON right_cell.column_id = comparison_group.right_column_id
        AND right_cell.article_id = left_cell.article_id
      ${
        hasAnswerFilterGroups
          ? `INNER JOIN answer_filter_cell filter_cell
        ON filter_cell.column_id = comparison_group.filter_column_id
        AND filter_cell.article_id = left_cell.article_id
        AND filter_cell.answer_value = comparison_group.filter_answer_value`
          : ''
      }
      ${getComparisonProjectStatsNonCurrentResolutionPairFilterSql(params)}
    ),
    pair_answer_value AS (
      SELECT
        comparison_pair.comparison_id,
        comparison_pair.comparison_kind,
        comparison_pair.article_id,
        comparison_pair.article_category,
        'left' AS answer_side,
        CASE
          WHEN comparison_pair.comparison_kind IN ('human-vs-conflict-resolution', 'llm-vs-conflict-resolution-no-fallback') THEN conflict_resolution.answer_value
          WHEN comparison_pair.comparison_kind = 'llm-vs-conflict-resolution' THEN COALESCE(conflict_resolution.answer_value, normalized_cell_answer.answer_value)
          ELSE normalized_cell_answer.answer_value
        END AS answer_value,
        CASE
          WHEN comparison_pair.comparison_kind IN ('human-vs-conflict-resolution', 'llm-vs-conflict-resolution-no-fallback') THEN conflict_resolution.binary_decision
          WHEN comparison_pair.comparison_kind = 'llm-vs-conflict-resolution' THEN
            CASE
              WHEN conflict_resolution.answer_value IS NOT NULL THEN conflict_resolution.binary_decision
              ELSE normalized_cell_answer.binary_decision
            END
          ELSE normalized_cell_answer.binary_decision
        END AS binary_decision
      FROM comparison_pair
      INNER JOIN normalized_cell_answer
        ON normalized_cell_answer.article_id = comparison_pair.article_id
        AND normalized_cell_answer.column_id = comparison_pair.left_column_id
      LEFT JOIN normalized_conflict_resolution_answer conflict_resolution
        ON conflict_resolution.article_id = comparison_pair.article_id
        AND comparison_pair.comparison_kind IN ('llm-vs-conflict-resolution', 'llm-vs-conflict-resolution-no-fallback', 'human-vs-conflict-resolution')
      UNION ALL
      SELECT
        comparison_pair.comparison_id,
        comparison_pair.comparison_kind,
        comparison_pair.article_id,
        comparison_pair.article_category,
        'right' AS answer_side,
        normalized_cell_answer.answer_value,
        normalized_cell_answer.binary_decision
      FROM comparison_pair
      INNER JOIN normalized_cell_answer
        ON normalized_cell_answer.article_id = comparison_pair.article_id
        AND normalized_cell_answer.column_id = comparison_pair.right_column_id
    ),
    pair_stats AS (
      SELECT
        comparison_id,
        comparison_kind,
        article_id,
        article_category,
        COUNT(DISTINCT answer_value) AS answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'left' AND answer_value IS NOT NULL
        ) AS left_answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'right' AND answer_value IS NOT NULL
        ) AS right_answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'left' AND answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS left_non_binary_answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'right' AND answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS right_non_binary_answer_value_count,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE answer_side = 'left' AND binary_decision IS NOT NULL
        ) AS left_binary_decision_count,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE answer_side = 'right' AND binary_decision IS NOT NULL
        ) AS right_binary_decision_count,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS all_binary_decision_count,
        MIN(binary_decision) FILTER (
          WHERE answer_side = 'left' AND binary_decision IS NOT NULL
        ) AS left_binary_decision,
        MIN(binary_decision) FILTER (
          WHERE answer_side = 'right' AND binary_decision IS NOT NULL
        ) AS right_binary_decision
      FROM pair_answer_value
      GROUP BY comparison_id, comparison_kind, article_id, article_category
    ),
    eligible_pair_stats AS (
      SELECT
        *,
        (
          comparison_kind NOT IN ('human-vs-conflict-resolution', 'llm-vs-conflict-resolution-no-fallback')
          OR (
            left_answer_value_count > 0
            AND right_answer_value_count > 0
            AND left_binary_decision_count = 1
            AND right_binary_decision_count = 1
            AND left_non_binary_answer_value_count = 0
            AND right_non_binary_answer_value_count = 0
          )
        ) AS is_included_pair,
        (
          left_binary_decision_count = 1
          AND right_binary_decision_count = 1
          AND (
            comparison_kind NOT IN ('human-vs-conflict-resolution', 'llm-vs-conflict-resolution-no-fallback')
            OR (
              left_non_binary_answer_value_count = 0
              AND right_non_binary_answer_value_count = 0
            )
          )
        ) AS is_binary_pair
      FROM pair_stats
    ),
    aggregate_pair_stats AS (
      SELECT
        comparison_id,
        article_category,
        is_included_pair,
        answer_value_count,
        left_binary_decision_count,
        right_binary_decision_count,
        all_binary_decision_count,
        is_binary_pair,
        left_binary_decision,
        right_binary_decision
      FROM eligible_pair_stats
      UNION ALL
      SELECT
        comparison_id,
        NULL AS article_category,
        is_included_pair,
        answer_value_count,
        left_binary_decision_count,
        right_binary_decision_count,
        all_binary_decision_count,
        is_binary_pair,
        left_binary_decision,
        right_binary_decision
      FROM eligible_pair_stats
    )
    SELECT
      comparison_id AS comparisonId,
      article_category AS articleCategory,
      CAST(COUNT(*) FILTER (WHERE is_included_pair) AS INTEGER) AS overlapCount,
      CAST(SUM(CASE WHEN is_included_pair AND answer_value_count > 1 THEN 1 ELSE 0 END) AS INTEGER) AS conflictCount,
      CAST(SUM(CASE
        WHEN is_included_pair AND left_binary_decision_count > 0 AND right_binary_decision_count > 0 AND all_binary_decision_count > 1 THEN 1
        ELSE 0
      END) AS INTEGER) AS trueConflictCount,
      CAST(SUM(CASE WHEN is_binary_pair THEN 1 ELSE 0 END) AS INTEGER) AS binaryPairCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = right_binary_decision THEN 1
        ELSE 0
      END) AS INTEGER) AS agreementCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'include' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftIncludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'include' AND right_binary_decision = 'include' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftIncludeRightIncludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'exclude' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftExcludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'exclude' AND right_binary_decision = 'exclude' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftExcludeRightExcludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND right_binary_decision = 'include' THEN 1
        ELSE 0
      END) AS INTEGER) AS rightIncludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND right_binary_decision = 'exclude' THEN 1
        ELSE 0
      END) AS INTEGER) AS rightExcludeCount
    FROM aggregate_pair_stats
    GROUP BY comparison_id, article_category
    ORDER BY comparisonId ASC, articleCategory ASC
  `
}
