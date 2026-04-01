import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {judgmentJobAutoDrainStatuses} from './judgmentJobStoragePolicy.ts'

const drainingStorageStateLiteral = getSqlLiteral('draining')
const activeStorageStateLiteral = getSqlLiteral('active')
const activeJudgmentJobImportStatusLiterals = getQuotedStringList([...judgmentJobAutoDrainStatuses]).join(', ')

export const getImportableJudgmentJobWhereSql = () => {
  return `
    (
      storage_state = ${activeStorageStateLiteral}
      AND status IN (${activeJudgmentJobImportStatusLiterals})
    )
    OR storage_state = ${drainingStorageStateLiteral}
  `
}
