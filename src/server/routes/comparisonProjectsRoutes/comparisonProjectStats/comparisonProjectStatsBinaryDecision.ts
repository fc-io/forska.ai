import type {BinaryDecision} from './comparisonProjectStatsTypes.ts'

const getBinaryDecision = (answer: string): BinaryDecision | null => {
  return answer === 'yes' || answer === 'maybe' ? 'include' : answer === 'no' ? 'exclude' : null
}

export const getBinaryDecisionSet = (answers: readonly string[]) => {
  return new Set(
    answers.map(getBinaryDecision).filter((decision): decision is BinaryDecision => {
      return decision !== null
    }),
  )
}

export const getBinaryDecisionValue = (answers: readonly string[]) => {
  const decisions = Array.from(getBinaryDecisionSet(answers))

  return decisions.length === 1 ? (decisions[0] ?? null) : null
}

export const getHasOneValidBinaryDecision = (answers: readonly string[]) => {
  return (
    answers.length > 0
    && answers.every((answer) => {
      return getBinaryDecision(answer) !== null
    })
    && getBinaryDecisionValue(answers) !== null
  )
}

export const getValidBinaryDecisionValue = (answers: readonly string[]) => {
  return getHasOneValidBinaryDecision(answers) ? getBinaryDecisionValue(answers) : null
}
