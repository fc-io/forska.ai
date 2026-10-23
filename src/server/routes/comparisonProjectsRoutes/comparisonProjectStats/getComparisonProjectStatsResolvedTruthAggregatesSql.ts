import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getComparisonProjectStatsConflictResolutionProvenanceSql} from './comparisonProjectStatsConflictResolutionProvenanceSql.ts'
import {
  comparisonProjectConflictResolutionTable,
  getComparisonProjectStatsArticleCategorySql,
  getInClause,
} from './comparisonProjectStatsSql.ts'
import type {
  ComparisonProjectStatsConflictResolutionProvenanceParams,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
} from './comparisonProjectStatsTypes.ts'

const getComparisonProjectStatsResolvedTruthGroupValuesSql = (
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[],
) => {
  return groups
    .map((group) => {
      return `(${getSqlLiteral(group.id)}, ${getSqlLiteral(group.humanColumnId)}, ${getSqlLiteral(group.llmColumnId)})`
    })
    .join(',\n      ')
}

export const getComparisonProjectStatsResolvedTruthAggregatesSql = (
  params: ComparisonProjectStatsConflictResolutionProvenanceParams & {
    columnIds: readonly string[]
    comparisonProjectId: string
    generation: number
    groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[]
  },
) => {
  return `
    WITH resolved_truth_group(comparison_id, human_column_id, llm_column_id) AS (
      VALUES
      ${getComparisonProjectStatsResolvedTruthGroupValuesSql(params.groups)}
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
    normalized_cell_decision AS (
      SELECT
        article_id,
        article_category,
        column_id,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS non_binary_answer_value_count,
        MIN(binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision
      FROM normalized_cell_answer
      GROUP BY article_id, article_category, column_id
    ),
    eligible_cell_decision AS (
      SELECT article_id, article_category, column_id, binary_decision
      FROM normalized_cell_decision
      WHERE binary_decision_count = 1
        AND non_binary_answer_value_count = 0
    ),
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
    ),
    normalized_conflict_resolution_decision AS (
      SELECT
        article_id,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS non_binary_answer_value_count,
        MIN(binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision
      FROM normalized_conflict_resolution_answer
      GROUP BY article_id
    ),
    eligible_conflict_resolution_decision AS (
      SELECT article_id, binary_decision
      FROM normalized_conflict_resolution_decision
      WHERE binary_decision_count = 1
        AND non_binary_answer_value_count = 0
    ),
    comparison_decision AS (
      SELECT
        resolved_truth_group.comparison_id,
        human_decision.article_category,
        truth_decision.binary_decision AS truth_decision,
        human_decision.binary_decision AS human_decision,
        llm_decision.binary_decision AS llm_decision
      FROM resolved_truth_group
      INNER JOIN eligible_cell_decision human_decision
        ON human_decision.column_id = resolved_truth_group.human_column_id
      INNER JOIN eligible_cell_decision llm_decision
        ON llm_decision.column_id = resolved_truth_group.llm_column_id
        AND llm_decision.article_id = human_decision.article_id
      INNER JOIN eligible_conflict_resolution_decision truth_decision
        ON truth_decision.article_id = human_decision.article_id
    ),
    aggregate_comparison_decision AS (
      SELECT
        comparison_id,
        article_category,
        truth_decision,
        human_decision,
        llm_decision
      FROM comparison_decision
      UNION ALL
      SELECT
        comparison_id,
        NULL AS article_category,
        truth_decision,
        human_decision,
        llm_decision
      FROM comparison_decision
    )
    SELECT
      comparison_id AS comparisonId,
      article_category AS articleCategory,
      CAST(COUNT(*) AS INTEGER) AS resolvedCount,
      CAST(SUM(CASE WHEN human_decision = truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS humanCorrectVsTruthCount,
      CAST(SUM(CASE WHEN human_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS humanErrorsVsTruthCount,
      CAST(SUM(CASE WHEN llm_decision = truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS llmCorrectVsTruthCount,
      CAST(SUM(CASE WHEN llm_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS llmErrorsVsTruthCount,
      CAST(SUM(CASE WHEN human_decision = truth_decision AND llm_decision = truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS bothCorrectCount,
      CAST(SUM(CASE WHEN human_decision <> truth_decision AND llm_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS bothWrongCount,
      CAST(SUM(CASE WHEN human_decision = truth_decision AND llm_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS humanOnlyCorrectCount,
      CAST(SUM(CASE WHEN llm_decision = truth_decision AND human_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS llmOnlyCorrectCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND human_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS humanTruePositiveCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND human_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS humanFalseNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND human_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS humanTrueNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND human_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS humanFalsePositiveCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND llm_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS llmTruePositiveCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND llm_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS llmFalseNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND llm_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS llmTrueNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND llm_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS llmFalsePositiveCount
    FROM aggregate_comparison_decision
    GROUP BY comparison_id, article_category
    ORDER BY comparisonId ASC, articleCategory ASC
  `
}
