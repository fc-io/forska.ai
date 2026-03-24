import {existsSync, mkdirSync, readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {env} from '../../utils/env.ts'

export const getJudgmentJobsRootDirectory = () => {
  return env.DUCKDB_PATH === ':memory:'
    ? join(tmpdir(), 'forska', 'judgment-jobs')
    : join(dirname(env.DUCKDB_PATH), 'judgment-jobs')
}

export const ensureJudgmentJobsRootDirectory = () => {
  const rootDirectory = getJudgmentJobsRootDirectory()
  mkdirSync(rootDirectory, {recursive: true})
  return rootDirectory
}

export const getJudgmentJobSqlitePath = (jobId: string) => {
  return join(ensureJudgmentJobsRootDirectory(), `${jobId}.sqlite`)
}

export const getJudgmentJobLeasePath = (jobId: string) => {
  return join(ensureJudgmentJobsRootDirectory(), `${jobId}.lease.json`)
}

export const getJudgmentJobSqliteJobIds = () => {
  return existsSync(getJudgmentJobsRootDirectory())
    ? readdirSync(getJudgmentJobsRootDirectory())
        .filter((entry) => {
          return entry.endsWith('.sqlite')
        })
        .map((entry) => {
          return entry.slice(0, -'.sqlite'.length)
        })
    : []
}
