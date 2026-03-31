import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'

const activeJudgmentJobImportStatuses = [
  'not_started',
  'running',
  'waiting_on_db_connection',
  'waiting_on_llm_connection',
] as const

const drainingStorageStateLiteral = getSqlLiteral('draining')
const activeStorageStateLiteral = getSqlLiteral('active')
const activeJudgmentJobImportStatusLiterals = getQuotedStringList([...activeJudgmentJobImportStatuses]).join(', ')

export const getImportableJudgmentJobWhereSql = () => {
  return `
    (
      storage_state = ${activeStorageStateLiteral}
      AND status IN (${activeJudgmentJobImportStatusLiterals})
    )
    OR storage_state = ${drainingStorageStateLiteral}
  `
}
