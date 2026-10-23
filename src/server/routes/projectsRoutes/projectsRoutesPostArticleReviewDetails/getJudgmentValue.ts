import type {JudgmentRecord} from '../../../../db/schemaTypes.ts'
import {getDateValue} from '../../../services/appQueryHelpers.ts'
import type {ArticleJudgmentRow} from './articleReviewDetailTypes.ts'
import {getProjectReviewDetailJudgmentValue} from './getProjectReviewDetailJudgmentValue.ts'

export const getJudgmentValue = (row: ArticleJudgmentRow): JudgmentRecord => {
  return {...getProjectReviewDetailJudgmentValue(row), deletedAt: getDateValue(row.judgmentDeletedAt)}
}
