import type {HumanJudgmentMode} from '../../../../db/schemaTypes.ts'
import {getDateValue} from '../../../services/appQueryHelpers.ts'

export type ComparisonProjectConflictResolutionImportSource = {
  id: string
  name: string
  description: string | null
  createdAt: Date
  humanJudgmentMode: HumanJudgmentMode
  resolutionCount: number
}

export type ComparisonProjectConflictResolutionImportSourceQueryRow = {
  id: string
  name: string
  description: string | null
  createdAt: unknown
  humanJudgmentMode: HumanJudgmentMode | null
  resolutionCount: unknown
}

export const getComparisonProjectConflictResolutionImportSourceValue = (
  row: ComparisonProjectConflictResolutionImportSourceQueryRow,
): ComparisonProjectConflictResolutionImportSource => {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    humanJudgmentMode: row.humanJudgmentMode ?? 'prompt',
    resolutionCount: Number(row.resolutionCount ?? 0),
  }
}
