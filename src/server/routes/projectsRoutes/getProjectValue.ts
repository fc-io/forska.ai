import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import type {ProjectRow} from './getProjectRow.ts'
import {getProjectFullTextValues} from './projectFullTextSettings.ts'

export const getProjectValue = (row: ProjectRow) => {
  return {
    ...getProjectFullTextValues(row),
    systemPromptVariant: getSystemPromptVariant(row.systemPromptVariant),
    dateFrom: getDateValue(row.dateFrom),
    dateTo: getDateValue(row.dateTo),
    createdAt: getDateValue(row.createdAt),
    updatedAt: getDateValue(row.updatedAt),
  }
}
