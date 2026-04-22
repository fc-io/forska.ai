import {createAppQueryService} from './appQueryServiceCore.ts'
import {
  getApiReadOnlyAppDatabaseService,
  getJudgeWorkerReadOnlyAppDatabaseService,
} from './appReadOnlyDatabaseService.ts'

const apiReadOnlyAppQueryService = createAppQueryService(getApiReadOnlyAppDatabaseService())
const judgeWorkerReadOnlyAppQueryService = createAppQueryService(getJudgeWorkerReadOnlyAppDatabaseService())

export const getApiReadOnlyAppQueryService = () => {
  return apiReadOnlyAppQueryService
}

export const getJudgeWorkerReadOnlyAppQueryService = () => {
  return judgeWorkerReadOnlyAppQueryService
}
