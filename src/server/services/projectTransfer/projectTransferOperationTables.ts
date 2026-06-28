import {randomUUID} from 'node:crypto'

import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getSqlLiteral} from '../appQueryHelpers.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'
import type {ProjectTransferImportTempLayout} from './projectTransferSession.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

export type ProjectTransferOperationTableRunner = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  run: (statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<void>
}

type ProjectTransferOperationTableDatabase = {
  transaction: <T>(
    work: (runner: ProjectTransferOperationTableRunner) => Promise<T> | T,
    workloadContext?: DuckdbWorkloadContext,
  ) => Promise<T>
}

export type ProjectTransferOperationTableSet = {
  operationId: string
  tableNames: Record<ProjectTransferPayloadKey, string>
}

type ProjectTransferOperationTableWorkInput = {
  runner: ProjectTransferOperationTableRunner
  tables: ProjectTransferOperationTableSet
}

type ProjectTransferOperationTableInput = RuntimePathOptions & {
  database?: ProjectTransferOperationTableDatabase
  layout: ProjectTransferImportTempLayout
  operationId?: string
  runner?: ProjectTransferOperationTableRunner
  workloadContext?: DuckdbWorkloadContext
}

type ProjectTransferOperationTableWork<T> = ProjectTransferOperationTableInput & {
  work: (input: ProjectTransferOperationTableWorkInput) => Promise<T>
}

const getOperationId = (operationId?: string) => {
  const value = operationId?.trim() ?? randomUUID()
  const identifier = value.replaceAll('-', '_').replace(/[^A-Za-z0-9_]/g, '_')

  return identifier === '' ? randomUUID().replaceAll('-', '_') : identifier
}

const getTableKeyPart = (key: ProjectTransferPayloadKey) => {
  return key.replace(/[A-Z]/g, (match) => {
    return `_${match.toLowerCase()}`
  })
}

export const getProjectTransferOperationTableNames = (operationId?: string): ProjectTransferOperationTableSet => {
  const resolvedOperationId = getOperationId(operationId)

  return {
    operationId: resolvedOperationId,
    tableNames: projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, string>>(
      (tableNames, key) => {
        return {...tableNames, [key]: `temp_project_transfer_${resolvedOperationId}_${getTableKeyPart(key)}`}
      },
      {} as Record<ProjectTransferPayloadKey, string>,
    ),
  }
}

const getPayloadPath = (layout: ProjectTransferImportTempLayout, key: ProjectTransferPayloadKey) => {
  return `${layout.extractedPath}/${projectTransferPayloadPathByKey[key]}`
}

const getResolvedPayloadPathLiteral = ({
  key,
  layout,
  runtimeOptions,
}: {
  key: ProjectTransferPayloadKey
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
}) => {
  return getSqlLiteral(
    resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: getPayloadPath(layout, key)}),
  )
}

const getCreateNdjsonOperationTableSql = ({pathLiteral, tableName}: {pathLiteral: string; tableName: string}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      row_number() OVER () - 1 AS row_index,
      json(payload_text) AS payload_json
    FROM read_csv(
      ${pathLiteral},
      columns = {'payload_text': 'VARCHAR'},
      delim = '\t',
      escape = '',
      header = false,
      quote = ''
    )
    WHERE trim(payload_text) <> ''
  `
}

const getCreateJsonOperationTableSql = ({pathLiteral, tableName}: {pathLiteral: string; tableName: string}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      0::BIGINT AS row_index,
      json(content) AS payload_json
    FROM read_text(${pathLiteral})
  `
}

const getCreateAssetManifestOperationTableSql = ({
  pathLiteral,
  tableName,
}: {
  pathLiteral: string
  tableName: string
}) => {
  return `
    CREATE TEMP TABLE ${tableName} AS
    SELECT
      row_number() OVER () - 1 AS row_index,
      entry AS payload_json
    FROM read_text(${pathLiteral}),
      UNNEST(json_extract(json(content), '$.entries[*]')) AS entries(entry)
  `
}

const getCreateOperationTableSql = ({
  key,
  layout,
  runtimeOptions,
  tableName,
}: {
  key: ProjectTransferPayloadKey
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
  tableName: string
}) => {
  const pathLiteral = getResolvedPayloadPathLiteral({key, layout, runtimeOptions})

  return key === 'assetManifest'
    ? getCreateAssetManifestOperationTableSql({pathLiteral, tableName})
    : projectTransferPayloadFormatByKey[key] === 'ndjson'
      ? getCreateNdjsonOperationTableSql({pathLiteral, tableName})
      : getCreateJsonOperationTableSql({pathLiteral, tableName})
}

export const loadProjectTransferOperationTables = async ({
  layout,
  operationId,
  runner,
  ...runtimeOptions
}: RuntimePathOptions & {
  layout: ProjectTransferImportTempLayout
  operationId?: string
  runner: ProjectTransferOperationTableRunner
}): Promise<ProjectTransferOperationTableSet> => {
  const tables = getProjectTransferOperationTableNames(operationId)

  await projectTransferPayloadKeys.reduce<Promise<void>>(async (previous, key) => {
    await previous
    const tableName = tables.tableNames[key]

    return runner.run(`
      DROP TABLE IF EXISTS ${tableName};
      ${getCreateOperationTableSql({key, layout, runtimeOptions, tableName})}
    `)
  }, Promise.resolve())

  return tables
}

export const dropProjectTransferOperationTables = async ({
  runner,
  tables,
}: {
  runner: ProjectTransferOperationTableRunner
  tables: ProjectTransferOperationTableSet
}) => {
  await projectTransferPayloadKeys.reduce<Promise<void>>(async (previous, key) => {
    await previous

    return runner.run(`DROP TABLE IF EXISTS ${tables.tableNames[key]}`)
  }, Promise.resolve())
}

export const withProjectTransferOperationTables = async <T>({
  database,
  layout,
  operationId,
  runner,
  work,
  ...runtimeOptions
}: ProjectTransferOperationTableWork<T>): Promise<T> => {
  if (runner === undefined) {
    const operationDatabase = database ?? getAppDatabaseService()

    return operationDatabase.transaction((tx) => {
      return withProjectTransferOperationTables({...runtimeOptions, layout, operationId, runner: tx, work})
    }, runtimeOptions.workloadContext)
  }

  const tables = await loadProjectTransferOperationTables({...runtimeOptions, layout, operationId, runner})

  try {
    const result = await work({runner, tables})
    await dropProjectTransferOperationTables({runner, tables})

    return result
  } catch (error) {
    await dropProjectTransferOperationTables({runner, tables}).catch(() => {
      return undefined
    })
    throw error
  }
}
