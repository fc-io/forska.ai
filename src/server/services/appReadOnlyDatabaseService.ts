import {
  closeReadOnlyDuckdbService,
  type ReadOnlyDuckdbContext,
  runReadOnlyDuckdbJsonQuery,
  validateReadOnlyDuckdbService,
} from './readOnlyDuckdbService.ts'

export type AppReadOnlyDatabaseService = {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  validate: () => Promise<void>
}

const createAppReadOnlyDatabaseService = (context: ReadOnlyDuckdbContext): AppReadOnlyDatabaseService => {
  return {
    close: closeReadOnlyDuckdbService,
    queryJson: <T>(statement: string) => {
      return runReadOnlyDuckdbJsonQuery<T>(context, statement)
    },
    validate: () => {
      return validateReadOnlyDuckdbService(context)
    },
  }
}

const apiReadOnlyAppDatabaseService = createAppReadOnlyDatabaseService('api-read-only')
const judgeWorkerReadOnlyAppDatabaseService = createAppReadOnlyDatabaseService('judge-worker')

export const getApiReadOnlyAppDatabaseService = () => {
  return apiReadOnlyAppDatabaseService
}

export const getJudgeWorkerReadOnlyAppDatabaseService = () => {
  return judgeWorkerReadOnlyAppDatabaseService
}

export const closeAppReadOnlyDatabaseServices = async () => {
  await closeReadOnlyDuckdbService()
}
