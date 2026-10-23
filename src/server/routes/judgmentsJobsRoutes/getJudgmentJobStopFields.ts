import {getJudgmentJobStopConditions, isJudgmentJobStopReason} from '../../../utils/judgmentJobStopConditions.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'

export type JudgmentJobStopRow = {
  stopAfterArticles?: unknown
  stopAfterTotalTokens?: unknown
  stopAt?: unknown
  stopReason?: unknown
  stopReasonAt?: unknown
  stopWhenHumanAnsweredDone?: unknown
}

export const getJudgmentJobStopFields = (row: JudgmentJobStopRow) => {
  return {
    ...getJudgmentJobStopConditions(row),
    stopReason: isJudgmentJobStopReason(row.stopReason) ? row.stopReason : null,
    stopReasonAt: getDateValue(row.stopReasonAt),
  }
}
