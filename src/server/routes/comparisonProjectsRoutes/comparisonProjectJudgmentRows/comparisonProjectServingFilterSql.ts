import {
  type ComparisonProjectDifferenceColumn,
  type ComparisonProjectDifferenceFilter,
  getIsComparisonProjectConflictResolutionDifferenceFilter,
} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectFilterSelection} from '../../../../utils/comparisonProjectFilterSelection.ts'
import type {ComparisonProjectRowFilter} from '../../../../utils/comparisonProjectRowFilter.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {
  type ComparisonProjectConflictResolutionProvenanceFilter,
  getComparisonProjectConflictResolutionProvenanceFilterPredicateSql,
} from '../comparisonProjectConflictResolutionProvenance.ts'
import {
  type ComparisonProjectSearchQuery,
  getComparisonProjectSearchArticleSourceSql,
  getComparisonProjectSearchPredicateSql,
} from '../comparisonProjectJudgmentSearch.ts'
import type {
  ComparisonProjectArticleCategoryFilterSelection,
  ComparisonProjectConflictResolutionFilterSelection,
  ComparisonProjectDifferenceFilterSelection,
  ComparisonProjectRowFilterSelection,
  ComparisonProjectServingConflictResolutionProvenanceParams,
} from './comparisonProjectJudgmentRowsTypes.ts'
import {getInClause, isDefined} from './comparisonProjectJudgmentRowsUtils.ts'

const comparisonProjectServingRowFilterPredicates = {
  all: 'article.passes_row_filter_all',
  'fully-answered': 'article.passes_row_filter_fully_answered',
  'human-answered-maybe': 'article.has_human_answered_maybe',
  'human-answered-no': 'article.has_human_answered_no',
  'human-answered-yes': 'article.has_human_answered_yes',
  'llm-answered-maybe': 'article.has_llm_answered_maybe',
  'llm-answered-no': 'article.has_llm_answered_no',
  'llm-answered-yes': 'article.has_llm_answered_yes',
  'multiple-answers': 'article.passes_row_filter_multiple_answers',
} satisfies Record<ComparisonProjectRowFilter, string>

const comparisonProjectServingConflictResolutionAnswerSql = 'LOWER(TRIM(conflict_resolution.answer_value))'
const comparisonProjectServingHasConflictResolutionSql =
  "NULLIF(TRIM(conflict_resolution.answer_value), '') IS NOT NULL"

const getComparisonProjectServingConflictResolutionDifferenceSql = (
  kind: ComparisonProjectDifferenceColumn['kind'],
) => {
  return `(${comparisonProjectServingHasConflictResolutionSql}
        AND (
          (article.has_${kind}_answered_yes AND ${comparisonProjectServingConflictResolutionAnswerSql} <> 'yes')
          OR (article.has_${kind}_answered_no AND ${comparisonProjectServingConflictResolutionAnswerSql} <> 'no')
          OR (article.has_${kind}_answered_maybe AND ${comparisonProjectServingConflictResolutionAnswerSql} <> 'maybe')
        ))`
}

const getComparisonProjectServingConflictResolutionTrueConflictSql = (
  kind: ComparisonProjectDifferenceColumn['kind'],
) => {
  return `(${comparisonProjectServingHasConflictResolutionSql}
        AND (
          (${comparisonProjectServingConflictResolutionAnswerSql} IN ('yes', 'maybe') AND article.has_${kind}_answered_no)
          OR (${comparisonProjectServingConflictResolutionAnswerSql} = 'no'
            AND (article.has_${kind}_answered_yes OR article.has_${kind}_answered_maybe))
        ))`
}

const comparisonProjectServingDifferenceFilterPredicates = {
  all: 'article.passes_difference_filter_all',
  'any-disagreement': 'article.passes_difference_filter_any_disagreement',
  'human-vs-llm': 'article.passes_difference_filter_human_vs_llm',
  'human-vs-llm-overlap': 'article.passes_difference_filter_human_vs_llm_overlap',
  'human-vs-llm-true-conflict': 'article.passes_difference_filter_human_vs_llm_true_conflict',
  'llm-vs-llm': 'article.passes_difference_filter_llm_vs_llm',
  'llm-vs-llm-true-difference': 'article.passes_difference_filter_llm_vs_llm_true_difference',
  'resolution-vs-human': getComparisonProjectServingConflictResolutionDifferenceSql('human'),
  'resolution-vs-human-true-conflict': getComparisonProjectServingConflictResolutionTrueConflictSql('human'),
  'resolution-vs-llm': getComparisonProjectServingConflictResolutionDifferenceSql('llm'),
  'resolution-vs-llm-true-conflict': getComparisonProjectServingConflictResolutionTrueConflictSql('llm'),
} satisfies Record<ComparisonProjectDifferenceFilter, string>

export const getComparisonProjectFilterSelectionList = <T extends string>(
  selection: ComparisonProjectFilterSelection<T>,
): T[] => {
  const values = selection === null || selection === undefined ? [] : Array.isArray(selection) ? selection : [selection]

  return Array.from(
    new Set(
      (values as readonly T[]).filter((value) => {
        return value !== 'all'
      }),
    ),
  )
}

const getComparisonProjectServingOrPredicateSql = (predicates: readonly string[], allPredicate: string) => {
  return predicates.length === 0
    ? allPredicate
    : predicates.length === 1
      ? (predicates[0] ?? allPredicate)
      : `(${predicates.join(' OR ')})`
}

export const getComparisonProjectServingRowFilterPredicateSql = (rowFilter: ComparisonProjectRowFilterSelection) => {
  return getComparisonProjectServingOrPredicateSql(
    getComparisonProjectFilterSelectionList(rowFilter).map((value) => {
      return comparisonProjectServingRowFilterPredicates[value]
    }),
    comparisonProjectServingRowFilterPredicates.all,
  )
}

export const getComparisonProjectServingDifferenceFilterPredicateSql = (
  differenceFilter: ComparisonProjectDifferenceFilterSelection,
) => {
  return getComparisonProjectServingOrPredicateSql(
    getComparisonProjectFilterSelectionList(differenceFilter).map((value) => {
      return comparisonProjectServingDifferenceFilterPredicates[value]
    }),
    comparisonProjectServingDifferenceFilterPredicates.all,
  )
}

export const getComparisonProjectServingArticleCategoryFilterPredicateSql = (
  articleCategoryFilter: ComparisonProjectArticleCategoryFilterSelection,
  articleAlias: string,
) => {
  const articleCategories = getComparisonProjectFilterSelectionList(articleCategoryFilter)

  return articleCategories.length === 0
    ? 'TRUE'
    : articleCategories.length === 1
      ? `${articleAlias}.article_category = ${getSqlLiteral(articleCategories[0] ?? '')}`
      : `${articleAlias}.article_category IN (${getInClause(articleCategories)})`
}

export const getComparisonProjectServingRequiresConflictResolution = (
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilterSelection,
  differenceFilter: ComparisonProjectDifferenceFilterSelection,
  conflictResolutionProvenanceFilter: readonly ComparisonProjectConflictResolutionProvenanceFilter[] = [],
) => {
  return (
    getComparisonProjectFilterSelectionList(conflictResolutionFilter).length > 0
    || conflictResolutionProvenanceFilter.length > 0
    || getComparisonProjectFilterSelectionList(differenceFilter).some(
      getIsComparisonProjectConflictResolutionDifferenceFilter,
    )
  )
}

export const getComparisonProjectServingConflictResolutionJoinSql = (
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilterSelection,
  differenceFilter: ComparisonProjectDifferenceFilterSelection,
  conflictResolutionProvenanceFilter: readonly ComparisonProjectConflictResolutionProvenanceFilter[] = [],
) => {
  return getComparisonProjectServingRequiresConflictResolution(
    conflictResolutionFilter,
    differenceFilter,
    conflictResolutionProvenanceFilter,
  )
    ? `
    LEFT JOIN app.comparison_project_conflict_resolution conflict_resolution
      ON conflict_resolution.comparison_project_id = article.comparison_project_id
     AND conflict_resolution.article_id = article.article_id`
    : ''
}

const comparisonProjectServingArticleTable = 'mart.comparison_article_serving'
const comparisonProjectServingActiveGenerationSql = '(SELECT generation FROM active_generation)'

export const getComparisonProjectServingArticleSourceSql = (
  searchQuery: ComparisonProjectSearchQuery | null,
  comparisonProjectId: string,
) => {
  return searchQuery === null
    ? comparisonProjectServingArticleTable
    : getComparisonProjectSearchArticleSourceSql({
        articleTable: comparisonProjectServingArticleTable,
        comparisonProjectIdSql: getSqlLiteral(comparisonProjectId),
        generationSql: comparisonProjectServingActiveGenerationSql,
        query: searchQuery,
      })
}

export const getComparisonProjectServingSearchPredicateSql = (searchQuery: ComparisonProjectSearchQuery | null) => {
  return searchQuery === null ? 'TRUE' : getComparisonProjectSearchPredicateSql(searchQuery, 'article')
}

const getComparisonProjectServingConflictResolutionAnswerPredicateSql = (answerValues: readonly string[]) => {
  return answerValues.length === 0
    ? null
    : answerValues.length === 1
      ? `conflict_resolution.answer_value = ${getSqlLiteral(answerValues[0] ?? '')}`
      : `conflict_resolution.answer_value IN (${getInClause([...answerValues])})`
}

export const getComparisonProjectServingConflictResolutionFilterPredicateSql = (
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilterSelection,
) => {
  const conflictResolutionFilters = getComparisonProjectFilterSelectionList(conflictResolutionFilter)

  if (conflictResolutionFilters.length === 0) {
    return 'TRUE'
  }

  const answerPredicate = getComparisonProjectServingConflictResolutionAnswerPredicateSql(
    conflictResolutionFilters.filter((value) => {
      return value !== 'not-set'
    }),
  )
  const predicates = [
    conflictResolutionFilters.includes('not-set')
      ? '(article.has_conflict AND conflict_resolution.article_id IS NULL)'
      : null,
    answerPredicate,
  ].filter(isDefined)

  return getComparisonProjectServingOrPredicateSql(predicates, 'TRUE')
}

export const getComparisonProjectServingProvenancePredicateSql = (
  params: ComparisonProjectServingConflictResolutionProvenanceParams,
) => {
  return getComparisonProjectConflictResolutionProvenanceFilterPredicateSql({
    currentJudgmentContextId: params.currentJudgmentContextId ?? null,
    filters: params.conflictResolutionProvenanceFilter ?? [],
  })
}
