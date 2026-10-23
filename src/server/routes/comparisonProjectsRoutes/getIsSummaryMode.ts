import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'

export const getIsSummaryMode = (scope: Pick<ComparisonProjectScope, 'compareWithHumans' | 'humanJudgmentMode'>) => {
  return scope.compareWithHumans && scope.humanJudgmentMode === 'summary'
}
