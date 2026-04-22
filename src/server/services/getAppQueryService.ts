import {getAppDatabaseService} from './appDatabaseService.ts'
import {createAppQueryService} from './appQueryServiceCore.ts'

const appQueryService = createAppQueryService(getAppDatabaseService())

export const getAppQueryService = () => {
  return appQueryService
}
