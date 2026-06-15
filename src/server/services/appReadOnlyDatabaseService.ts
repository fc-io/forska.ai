import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  closeReadOnlyDuckdbService,
  type ReadOnlyDuckdbContext,
  runReadOnlyDuckdbJsonQuery,
  validateReadOnlyDuckdbService,
} from './readOnlyDuckdbService.ts'

export type AppReadOnlyDatabaseService = {
  close: () => Promise<void>
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  validate: () => Promise<void>
}

const createAppReadOnlyDatabaseService = (context: ReadOnlyDuckdbContext): AppReadOnlyDatabaseService => {
  return {
    close: closeReadOnlyDuckdbService,
    queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => {
      return runReadOnlyDuckdbJsonQuery<T>(context, statement, workloadContext)
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
