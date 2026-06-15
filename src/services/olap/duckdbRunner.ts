import {getAppDatabaseService} from '../../server/services/appDatabaseService.ts'
import {getDuckdbBinary} from '../../server/utils/duckdbBinary.ts'
import {type DuckdbWorkloadContext, runMeasuredDuckdbJsonWorkload} from '../../server/utils/duckdbService.ts'
import {env} from '../../server/utils/env.ts'
import {getDuckdbPath} from '../../server/utils/getDuckdbPath.ts'

export const getDuckdbSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

export const getDuckdbSqlBoolean = (value: boolean) => {
  return value ? 'TRUE' : 'FALSE'
}

export const getDuckdbSqlStringList = (values: string[]) => {
  return values.map((value) => {
    return getDuckdbSqlString(value)
  })
}

const getDuckdbDatabasePath = (duckdbPath?: string) => {
  return getDuckdbPath({duckdbPath: duckdbPath ?? env.DUCKDB_PATH})
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const getDuckdbPrelude = () => {
  const tempDirectory = getTrimmedValue(env.DUCKDB_TEMP_DIRECTORY)
  const tempDirectoryStatement = tempDirectory ? `SET temp_directory = ${getDuckdbSqlString(tempDirectory)}; ` : ''
  return `SET memory_limit = ${getDuckdbSqlString(env.DUCKDB_MEMORY_LIMIT)}; ${tempDirectoryStatement}`
}

const runDuckdbJsonQueryFromSpawn = async <T>(query: string, duckdbPath: string): Promise<T[]> => {
  const process = globalThis.Bun.spawn([getDuckdbBinary(), '-json', duckdbPath, `${getDuckdbPrelude()} ${query}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  const trimmedStdout = stdout.trim()
  const trimmedStderr = stderr.trim()

  if (exitCode !== 0) {
    throw new Error(trimmedStderr || trimmedStdout || `DuckDB query failed with exit code ${exitCode}`)
  }

  if (!trimmedStdout) {
    return []
  }

  const parsed = JSON.parse(trimmedStdout) as T[] | T
  return Array.isArray(parsed) ? parsed : [parsed]
}

export const runDuckdbJsonQuery = async <T>(
  query: string,
  duckdbPath?: string,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T[]> => {
  const resolvedDuckdbPath = getDuckdbDatabasePath(duckdbPath)
  return resolvedDuckdbPath === env.DUCKDB_PATH
    ? getAppDatabaseService().queryJson<T>(query, workloadContext)
    : runMeasuredDuckdbJsonWorkload({
        operation: 'externalQuery',
        queue: 'external',
        queueDepthAtStart: 0,
        workloadContext,
        work: () => {
          return runDuckdbJsonQueryFromSpawn<T>(query, resolvedDuckdbPath)
        },
      })
}
