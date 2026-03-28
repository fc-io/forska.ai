import {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const targetTableName = 'mart.review_article_serving'
const defaultDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT ?? '20GB'

type JsonRow = Record<string, unknown>
type ArchivedProjectRow = {projectId: string; rowCount: number}
type BatchRow = {rowId: bigint | number | string}
type SnapshotStatementResult = {error: string | null; ok: boolean}

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

const runReproArchivedProjectServingDelete = async () => {
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
            projectId: requestedProjectId,
            retainedSnapshot: keepSnapshot,
            rowCount: 0,
            rowSample: [],
            rowIds: [],
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

    const batchQuery = getPurgeBatchSql(targetProject.projectId)
    const batchRows = await querySnapshotJson<BatchRow>(snapshot.snapshotPath, batchQuery)
    const rowIds = batchRows.map((row) => {
      return row.rowId
    })
    const rowSample =
      rowIds.length === 0
        ? []
        : await querySnapshotJson<JsonRow>(snapshot.snapshotPath, getPurgeBatchRowSampleSql(rowIds))
    const deleteStatement = getPurgeDeleteSql(rowIds)
    const deleteAttempt = await runSnapshotStatement(snapshot.snapshotPath, deleteStatement)

    console.log(
      JSON.stringify(
        {
          batchQuery,
          deleteAttempt,
          deleteStatement,
          projectId: targetProject.projectId,
          retainedSnapshot: keepSnapshot,
          rowCount: Number(targetProject.rowCount ?? 0),
          rowSample,
          rowIds: rowIds.map((rowId) => {
            return String(rowId)
          }),
          snapshotPath: snapshot.snapshotPath,
          status: deleteAttempt.ok ? 'delete-succeeded-on-snapshot' : 'delete-failed-on-snapshot',
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
