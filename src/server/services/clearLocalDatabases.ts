import {rm} from 'node:fs/promises'

import {migrateDuckdb} from '../../db/migrateDuckdb.ts'
import {getJudgmentJobsRootDirectory} from '../cron/judgmentsJobs/judgmentJobPaths.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'

type ClearLocalDatabasesPathInput = {
  databasePath: string
  judgmentJobsRootDirectory: string
  tempDirectory: string | null
}

export type ClearLocalDatabasesResult = {
  clearedPaths: string[]
  duckdbPath: string
  judgmentJobsRootDirectory: string
  migrated: boolean
}

const getUniquePaths = (paths: string[]) => {
  return paths.filter((path, index) => {
    return path.trim() !== '' && paths.indexOf(path) === index
  })
}

const getDuckdbPaths = (databasePath: string) => {
  return databasePath === ':memory:' ? [] : [databasePath, `${databasePath}.wal`, `${databasePath}.tmp`]
}

const getClearableDatabasePaths = ({
  databasePath,
  judgmentJobsRootDirectory,
  tempDirectory,
}: ClearLocalDatabasesPathInput) => {
  return getUniquePaths([
    ...getDuckdbPaths(databasePath),
    judgmentJobsRootDirectory,
    ...(tempDirectory === null ? [] : [tempDirectory]),
  ])
}

const clearPath = async (path: string) => {
  await rm(path, {force: true, recursive: true})
  return path
}

export const clearLocalDatabases = async (): Promise<ClearLocalDatabasesResult> => {
  const database = getAppDatabaseService()
  const runtimeConfig = database.getRuntimeConfig()
  const judgmentJobsRootDirectory = getJudgmentJobsRootDirectory()
  const clearedPaths = getClearableDatabasePaths({
    databasePath: runtimeConfig.databasePath,
    judgmentJobsRootDirectory,
    tempDirectory: runtimeConfig.tempDirectory,
  })

  await getJudgmentJobSqliteService().closeAll()
  await database.closeForReset()
  await Promise.all(
    clearedPaths.map((path) => {
      return clearPath(path)
    }),
  )
  await migrateDuckdb()

  return {clearedPaths, duckdbPath: runtimeConfig.databasePath, judgmentJobsRootDirectory, migrated: true}
}
