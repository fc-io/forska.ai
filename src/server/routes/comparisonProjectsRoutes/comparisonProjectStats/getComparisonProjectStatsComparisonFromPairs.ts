import {getBinaryDecisionSet, getBinaryDecisionValue} from './comparisonProjectStatsBinaryDecision.ts'
import {getIsComparisonProjectStatsHumanComparison} from './comparisonProjectStatsComparisonKind.ts'
import type {
  BinaryDecision,
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsComparisonKind,
  ComparisonProjectStatsPair,
} from './comparisonProjectStatsTypes.ts'
import {getRate} from './getRate.ts'

type BinaryDecisionPair = {leftDecision: BinaryDecision; rightDecision: BinaryDecision}

const getAnswerUnionSize = (leftAnswers: readonly string[], rightAnswers: readonly string[]) => {
  return new Set([...leftAnswers, ...rightAnswers]).size
}

const getHasConflict = (pair: ComparisonProjectStatsPair) => {
  return getAnswerUnionSize(pair.leftAnswers, pair.rightAnswers) > 1
}

const getHasTrueConflict = (pair: ComparisonProjectStatsPair) => {
  const leftDecisions = getBinaryDecisionSet(pair.leftAnswers)
  const rightDecisions = getBinaryDecisionSet(pair.rightAnswers)

  return leftDecisions.size > 0 && rightDecisions.size > 0 && new Set([...leftDecisions, ...rightDecisions]).size > 1
}

const getDecisionCount = (pairs: readonly BinaryDecisionPair[], side: keyof BinaryDecisionPair) => {
  return pairs.reduce(
    (counts, pair) => {
      const decision = pair[side]

      return decision === 'include'
        ? {...counts, include: counts.include + 1}
        : decision === 'exclude'
          ? {...counts, exclude: counts.exclude + 1}
          : counts
    },
    {exclude: 0, include: 0},
  )
}

const getBinaryDecisionPairs = (pairs: readonly ComparisonProjectStatsPair[]) => {
  return pairs
    .map<BinaryDecisionPair | null>((pair) => {
      const leftDecision = getBinaryDecisionValue(pair.leftAnswers)
      const rightDecision = getBinaryDecisionValue(pair.rightAnswers)

      return leftDecision && rightDecision ? {leftDecision, rightDecision} : null
    })
    .filter((pair): pair is BinaryDecisionPair => {
      return pair !== null
    })
}

const getCohensKappa = (pairs: readonly ComparisonProjectStatsPair[]) => {
  const binaryPairs = getBinaryDecisionPairs(pairs)
  const pairCount = binaryPairs.length

  if (pairCount === 0) {
    return null
  }

  const agreementCount = binaryPairs.filter((pair) => {
    return pair.leftDecision === pair.rightDecision
  }).length
  const leftCounts = getDecisionCount(binaryPairs, 'leftDecision')
  const rightCounts = getDecisionCount(binaryPairs, 'rightDecision')
  const observedAgreement = agreementCount / pairCount
  const expectedAgreement =
    (leftCounts.include / pairCount) * (rightCounts.include / pairCount)
    + (leftCounts.exclude / pairCount) * (rightCounts.exclude / pairCount)
  const denominator = 1 - expectedAgreement

  return denominator === 0
    ? observedAgreement === 1
      ? 1
      : null
    : (observedAgreement - expectedAgreement) / denominator
}

const getBinaryDecisionOutcomeRate = (
  pairs: readonly ComparisonProjectStatsPair[],
  referenceDecision: BinaryDecision,
) => {
  const referencePairs = getBinaryDecisionPairs(pairs).filter((pair) => {
    return pair.leftDecision === referenceDecision
  })
  const matchingPredictionCount = referencePairs.filter((pair) => {
    return pair.rightDecision === referenceDecision
  }).length

  return getRate(matchingPredictionCount, referencePairs.length)
}

const getSensitivity = (kind: ComparisonProjectStatsComparisonKind, pairs: readonly ComparisonProjectStatsPair[]) => {
  return getIsComparisonProjectStatsHumanComparison(kind) ? getBinaryDecisionOutcomeRate(pairs, 'include') : null
}

const getSpecificity = (kind: ComparisonProjectStatsComparisonKind, pairs: readonly ComparisonProjectStatsPair[]) => {
  return getIsComparisonProjectStatsHumanComparison(kind) ? getBinaryDecisionOutcomeRate(pairs, 'exclude') : null
}

export const getComparisonProjectStatsComparisonFromPairs = (params: {
  group: ComparisonProjectStatsComparisonGroup
  pairs: readonly ComparisonProjectStatsPair[]
  shouldComputeCohensKappa: boolean
}) => {
  const conflictCount = params.pairs.filter(getHasConflict).length
  const trueConflictCount = params.pairs.filter(getHasTrueConflict).length

  return {
    ...params.group,
    cohensKappa: params.shouldComputeCohensKappa ? getCohensKappa(params.pairs) : null,
    conflictCount,
    overlapCount: params.pairs.length,
    sensitivity: getSensitivity(params.group.kind, params.pairs),
    specificity: getSpecificity(params.group.kind, params.pairs),
    trueConflictCount,
  }
}
