import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getApiReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {getCurrentServerRole} from '../../utils/serverRuntimeRole.ts'

export const getJudgmentJobsReadDatabase = (): JudgmentJobSqliteHealthProjectionReader => {
  return getCurrentServerRole() === 'api' ? getApiReadOnlyAppDatabaseService() : getAppDatabaseService()
}
