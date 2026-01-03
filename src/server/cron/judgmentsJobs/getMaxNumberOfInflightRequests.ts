import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'

export const getMaxNumberOfInflightRequests = (): number => {
  return getJudgmentsCapacity(1).maxInflight
}
