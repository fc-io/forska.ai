import {getIsComparisonProjectStatsHumanComparison} from './comparisonProjectStatsComparisonKind.ts'
import type {
  ComparisonProjectStatsAggregate,
  ComparisonProjectStatsComparisonKind,
} from './comparisonProjectStatsTypes.ts'
import {getRate} from './getRate.ts'

export const getCohensKappaFromAggregate = (aggregate: ComparisonProjectStatsAggregate) => {
  const pairCount = aggregate.binaryPairCount

  if (pairCount === 0) {
    return null
  }

  const observedAgreement = aggregate.agreementCount / pairCount
  const expectedAgreement =
    (aggregate.leftIncludeCount / pairCount) * (aggregate.rightIncludeCount / pairCount)
    + (aggregate.leftExcludeCount / pairCount) * (aggregate.rightExcludeCount / pairCount)
  const denominator = 1 - expectedAgreement

  return denominator === 0
    ? observedAgreement === 1
      ? 1
      : null
    : (observedAgreement - expectedAgreement) / denominator
}

export const getSensitivityFromAggregate = (
  kind: ComparisonProjectStatsComparisonKind,
  aggregate: ComparisonProjectStatsAggregate,
) => {
  return getIsComparisonProjectStatsHumanComparison(kind)
    ? getRate(aggregate.leftIncludeRightIncludeCount, aggregate.leftIncludeCount)
    : null
}

export const getSpecificityFromAggregate = (
  kind: ComparisonProjectStatsComparisonKind,
  aggregate: ComparisonProjectStatsAggregate,
) => {
  return getIsComparisonProjectStatsHumanComparison(kind)
    ? getRate(aggregate.leftExcludeRightExcludeCount, aggregate.leftExcludeCount)
    : null
}
