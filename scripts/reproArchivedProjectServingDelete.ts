import {cpSync, existsSync, rmSync} from 'node:fs'

import {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const targetTableName = 'mart.review_article_serving'
const rewriteProbeTableName = 'mart.review_article_serving_rewrite_probe'
const defaultDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT ?? '20GB'

type JsonRow = Record<string, unknown>
type ArchivedProjectRow = {projectId: string; rowCount: number}
type BatchRow = {rowId: bigint | number | string}
type CountRow = {rowCount: bigint | number | string}
type SnapshotStatementResult = {error: string | null; ok: boolean}
type ReproOperationName = 'projectDelete' | 'rewriteProbe' | 'singleRowDelete'
type ReproRemediationPath = 'keep-single-row-purge' | 'manual-investigation-required' | 'rewrite-serving-table'
type ReproDeleteOperationResult = {
  batchQuery: string | null
  deleteAttempt: SnapshotStatementResult
  deleteStatement: string
  rowCountAfter: number | null
  rowIds: string[]
  rowSample: JsonRow[]
  status: string
}
type ReproRewriteOperationResult = {
  retainedRowCount: number | null
  rewriteAttempt: SnapshotStatementResult
  rewriteStatement: string
  status: string
}
type ReproOperationResults = {
  projectDelete: ReproDeleteOperationResult
  rewriteProbe: ReproRewriteOperationResult
  singleRowDelete: ReproDeleteOperationResult
}

const getArgValue = (flag: string) => {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => {
    return arg === flag
  })

  return index === -1 ? null : (args[index + 1] ?? null)
}

const hasArg = (flag: string) => {
  return process.argv.slice(2).includes(flag)
}

const deleteSnapshotFile = (snapshotPath: string) => {
  return [
    snapshotPath,
    `${snapshotPath}.wal`,
    `${snapshotPath}.duckdb-owner.history.json`,
    `${snapshotPath}.duckdb-owner.lock`,
  ].map((filePath) => {
    return existsSync(filePath) ? rmSync(filePath, {force: true, recursive: true}) : null
  })
}

const getScratchSnapshotPath = (snapshotPath: string, operationName: ReproOperationName) => {
  return `${snapshotPath}.${operationName}.probe`
}

const withSnapshotConnection = async <T>({
  readonly,
  snapshotPath,
  work,
}: {
  readonly: boolean
  snapshotPath: string
  work: (connection: DuckDBConnection) => Promise<T>
}) => {
  const duckdbInstance = await DuckDBInstance.create(snapshotPath, {
    access_mode: readonly ? 'READ_ONLY' : 'READ_WRITE',
    memory_limit: defaultDuckdbMemoryLimit,
  })
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`SET memory_limit = '${defaultDuckdbMemoryLimit}'`)
    return await work(connection)
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

const querySnapshotJson = async <T>(snapshotPath: string, statement: string): Promise<T[]> => {
  return withSnapshotConnection({
    readonly: true,
    snapshotPath,
    work: async (connection) => {
      const reader = await connection.runAndReadAll(statement)
      return reader.getRowObjectsJson() as T[]
    },
  })
}

const runSnapshotStatement = async (snapshotPath: string, statement: string): Promise<SnapshotStatementResult> => {
  return withSnapshotConnection({
    readonly: false,
    snapshotPath,
    work: async (connection) => {
      try {
        await connection.run(statement)
        return {error: null, ok: true}
      } catch (error) {
        return {error: error instanceof Error ? error.message : String(error), ok: false}
      }
    },
  })
}

const withScratchSnapshot = async <T>({
  keepSnapshot,
  operationName,
  snapshotPath,
  work,
}: {
  keepSnapshot: boolean
  operationName: ReproOperationName
  snapshotPath: string
  work: (scratchSnapshotPath: string) => Promise<T>
}) => {
  const scratchSnapshotPath = getScratchSnapshotPath(snapshotPath, operationName)
  cpSync(snapshotPath, scratchSnapshotPath)

  try {
    return await work(scratchSnapshotPath)
  } finally {
    if (!keepSnapshot) {
      deleteSnapshotFile(scratchSnapshotPath)
    }
  }
}

const getArchivedProjectQuerySql = (projectId: string | null) => {
  const projectFilter = projectId === null ? '' : ` AND project.id = ${getSqlLiteral(projectId)}`

  return `
    SELECT
      project.id AS projectId,
      COUNT(*) AS rowCount
    FROM ${targetTableName} serving
    INNER JOIN app.project project ON project.id = serving.project_id
    WHERE project.archived = TRUE${projectFilter}
    GROUP BY project.id
    ORDER BY rowCount DESC, project.id ASC
    LIMIT 1
  `
}

const getPurgeBatchSql = (projectId: string) => {
  return `
    SELECT
      rowid AS rowId
    FROM ${targetTableName}
    WHERE project_id = ${getSqlLiteral(projectId)}
    ORDER BY rowid ASC
    LIMIT 1
  `
}

const getPurgeBatchRowSampleSql = (rowIds: Array<bigint | number | string>) => {
  return `
    SELECT
      rowid AS rowId,
      *
    FROM ${targetTableName}
    WHERE rowid IN (${rowIds
      .map((rowId) => {
        return getSqlLiteral(rowId)
      })
      .join(', ')})
    ORDER BY rowid ASC
  `
}

const getPurgeDeleteSql = (rowIds: Array<bigint | number | string>) => {
  return `
    BEGIN TRANSACTION;
    DELETE FROM ${targetTableName}
    WHERE rowid IN (${rowIds
      .map((rowId) => {
        return getSqlLiteral(rowId)
      })
      .join(', ')});
    COMMIT;
  `
}

const getProjectDeleteSql = (projectId: string) => {
  return `
    BEGIN TRANSACTION;
    DELETE FROM ${targetTableName}
    WHERE project_id = ${getSqlLiteral(projectId)};
    COMMIT;
  `
}

const getProjectRowCountSql = (projectId: string) => {
  return `
    SELECT COUNT(*) AS rowCount
    FROM ${targetTableName}
    WHERE project_id = ${getSqlLiteral(projectId)}
  `
}

const getRewriteProbeSql = (projectId: string) => {
  return `
    BEGIN TRANSACTION;
    CREATE OR REPLACE TABLE ${rewriteProbeTableName} AS
    SELECT *
    FROM ${targetTableName}
    WHERE project_id != ${getSqlLiteral(projectId)};
    COMMIT;
  `
}

const getRewriteProbeCountSql = () => {
  return `
    SELECT COUNT(*) AS rowCount
    FROM ${rewriteProbeTableName}
  `
}

const getNumberValue = (value: bigint | number | string | null | undefined) => {
  return value === null || value === undefined ? null : Number(value)
}

const getRowCount = async (snapshotPath: string, statement: string) => {
  const countRows = await querySnapshotJson<CountRow>(snapshotPath, statement)
  return getNumberValue(countRows[0]?.rowCount)
}

const getSingleRowDeleteStatus = (deleteAttempt: SnapshotStatementResult) => {
  return deleteAttempt.ok ? 'single-row-delete-succeeded' : 'single-row-delete-failed'
}

const getProjectDeleteStatus = (deleteAttempt: SnapshotStatementResult) => {
  return deleteAttempt.ok ? 'project-delete-succeeded' : 'project-delete-failed'
}

const getRewriteProbeStatus = (rewriteAttempt: SnapshotStatementResult) => {
  return rewriteAttempt.ok ? 'rewrite-probe-succeeded' : 'rewrite-probe-failed'
}

export const getServingTableRemediationPath = (results: ReproOperationResults): ReproRemediationPath => {
  return !results.singleRowDelete.deleteAttempt.ok && results.rewriteProbe.rewriteAttempt.ok
    ? 'rewrite-serving-table'
    : results.singleRowDelete.deleteAttempt.ok
      ? 'keep-single-row-purge'
      : 'manual-investigation-required'
}

const runSingleRowDeleteProbe = async ({
  keepSnapshot,
  projectId,
  snapshotPath,
}: {
  keepSnapshot: boolean
  projectId: string
  snapshotPath: string
}): Promise<ReproDeleteOperationResult> => {
  return withScratchSnapshot({
    keepSnapshot,
    operationName: 'singleRowDelete',
    snapshotPath,
    work: async (scratchSnapshotPath) => {
      const batchQuery = getPurgeBatchSql(projectId)
      const batchRows = await querySnapshotJson<BatchRow>(scratchSnapshotPath, batchQuery)
      const rowIds = batchRows.map((row) => {
        return row.rowId
      })
      const rowSample =
        rowIds.length === 0
          ? []
          : await querySnapshotJson<JsonRow>(scratchSnapshotPath, getPurgeBatchRowSampleSql(rowIds))
      const deleteStatement = getPurgeDeleteSql(rowIds)
      const deleteAttempt = await runSnapshotStatement(scratchSnapshotPath, deleteStatement)
      const rowCountAfter = deleteAttempt.ok
        ? await getRowCount(scratchSnapshotPath, getProjectRowCountSql(projectId))
        : null

      return {
        batchQuery,
        deleteAttempt,
        deleteStatement,
        rowCountAfter,
        rowIds: rowIds.map((rowId) => {
          return String(rowId)
        }),
        rowSample,
        status: getSingleRowDeleteStatus(deleteAttempt),
      }
    },
  })
}

const runProjectDeleteProbe = async ({
  keepSnapshot,
  projectId,
  snapshotPath,
}: {
  keepSnapshot: boolean
  projectId: string
  snapshotPath: string
}): Promise<ReproDeleteOperationResult> => {
  return withScratchSnapshot({
    keepSnapshot,
    operationName: 'projectDelete',
    snapshotPath,
    work: async (scratchSnapshotPath) => {
      const deleteStatement = getProjectDeleteSql(projectId)
      const deleteAttempt = await runSnapshotStatement(scratchSnapshotPath, deleteStatement)
      const rowCountAfter = deleteAttempt.ok
        ? await getRowCount(scratchSnapshotPath, getProjectRowCountSql(projectId))
        : null

      return {
        batchQuery: null,
        deleteAttempt,
        deleteStatement,
        rowCountAfter,
        rowIds: [],
        rowSample: [],
        status: getProjectDeleteStatus(deleteAttempt),
      }
    },
  })
}

const runRewriteProbe = async ({
  keepSnapshot,
  projectId,
  snapshotPath,
}: {
  keepSnapshot: boolean
  projectId: string
  snapshotPath: string
}): Promise<ReproRewriteOperationResult> => {
  return withScratchSnapshot({
    keepSnapshot,
    operationName: 'rewriteProbe',
    snapshotPath,
    work: async (scratchSnapshotPath) => {
      const rewriteStatement = getRewriteProbeSql(projectId)
      const rewriteAttempt = await runSnapshotStatement(scratchSnapshotPath, rewriteStatement)
      const retainedRowCount = rewriteAttempt.ok
        ? await getRowCount(scratchSnapshotPath, getRewriteProbeCountSql())
        : null

      return {retainedRowCount, rewriteAttempt, rewriteStatement, status: getRewriteProbeStatus(rewriteAttempt)}
    },
  })
}

export const runReproArchivedProjectServingDelete = async () => {
  const requestedProjectId = getArgValue('--project-id')
  const keepSnapshot = hasArg('--keep-snapshot')

  await withDuckdbMaintenanceAccess('repro archived project serving delete', async () => {
    const snapshot = await getAppDatabaseService().createSnapshot()
    const archivedProjects = await querySnapshotJson<ArchivedProjectRow>(
      snapshot.snapshotPath,
      getArchivedProjectQuerySql(requestedProjectId),
    )
    const targetProject = archivedProjects[0] ?? null

    if (targetProject === null) {
      console.log(
        JSON.stringify(
          {
            batchQuery: null,
            deleteAttempt: null,
            deleteStatement: null,
            operations: null,
            projectId: requestedProjectId,
            remediationPath: null,
            retainedSnapshot: keepSnapshot,
            rowCount: 0,
            rowIds: [],
            rowSample: [],
            snapshotPath: snapshot.snapshotPath,
            status: 'no-archived-project-serving-rows',
            tableName: targetTableName,
          },
          null,
          2,
        ),
      )

      return keepSnapshot ? Promise.resolve() : getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
    }

    const singleRowDelete = await runSingleRowDeleteProbe({
      keepSnapshot,
      projectId: targetProject.projectId,
      snapshotPath: snapshot.snapshotPath,
    })
    const projectDelete = await runProjectDeleteProbe({
      keepSnapshot,
      projectId: targetProject.projectId,
      snapshotPath: snapshot.snapshotPath,
    })
    const rewriteProbe = await runRewriteProbe({
      keepSnapshot,
      projectId: targetProject.projectId,
      snapshotPath: snapshot.snapshotPath,
    })
    const operations = {projectDelete, rewriteProbe, singleRowDelete}
    const remediationPath = getServingTableRemediationPath(operations)

    console.log(
      JSON.stringify(
        {
          batchQuery: singleRowDelete.batchQuery,
          deleteAttempt: singleRowDelete.deleteAttempt,
          deleteStatement: singleRowDelete.deleteStatement,
          operations,
          projectId: targetProject.projectId,
          remediationPath,
          retainedSnapshot: keepSnapshot,
          rowCount: Number(targetProject.rowCount ?? 0),
          rowIds: singleRowDelete.rowIds,
          rowSample: singleRowDelete.rowSample,
          snapshotPath: snapshot.snapshotPath,
          status: remediationPath,
          tableName: targetTableName,
        },
        null,
        2,
      ),
    )

    return keepSnapshot ? Promise.resolve() : getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  })
}

if (import.meta.main) {
  await runReproArchivedProjectServingDelete()
}
