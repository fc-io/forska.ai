import {resolve} from 'path'

import {env} from '../../server/utils/env.ts'

const getDuckdbBin = () => {
  const configured = String(process.env['DUCKDB_BIN'] ?? '').trim()
  return configured || 'duckdb'
}

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

const getDuckdbSqlitePath = (sqlitePath?: string) => {
  return resolve(process.cwd(), sqlitePath ?? env.SQLITE_PATH)
}

const getDuckdbPrelude = (sqlitePath?: string) => {
  return `INSTALL sqlite; LOAD sqlite; ATTACH ${getDuckdbSqlString(getDuckdbSqlitePath(sqlitePath))} AS app (TYPE sqlite);`
}

export const runDuckdbJsonQuery = async <T>(query: string, sqlitePath?: string): Promise<T[]> => {
  const process = globalThis.Bun.spawn(
    [getDuckdbBin(), '-json', ':memory:', `${getDuckdbPrelude(sqlitePath)} ${query}`],
    {stdout: 'pipe', stderr: 'pipe'},
  )
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
