import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {resetDuckdbServiceForTests} from '../../utils/duckdbService.ts'
import {resetServerRuntimeRoleForTests} from '../../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {
  getProjectTransferOperationTableNames,
  type ProjectTransferOperationTableRunner,
  withProjectTransferOperationTables,
} from './projectTransferOperationTables.ts'
import {getProjectTransferPayloadFixtureMap, serializeProjectTransferPayload} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferImportStagingLayout} from './projectTransferStaging.ts'
import {projectTransferCommitTransactionWorkloadContext} from './projectTransferWorkloadContext.ts'

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-operation-tables-${process.pid}-`))
}

const catchMessage = async (operation: () => Promise<unknown>) => {
  try {
    await operation()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const writeStagedArticles = async ({
  cwd,
  layout,
}: {
  cwd: string
  layout: ReturnType<typeof getProjectTransferImportStagingLayout>
}) => {
  const payloadPath = join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.articles)
  const payloads = getProjectTransferPayloadFixtureMap()

  await mkdir(dirname(payloadPath), {recursive: true})
  await globalThis.Bun.write(payloadPath, serializeProjectTransferPayload('articles', payloads.articles))

  return payloads.articles.length
}

test('operation tables staged before a transaction stay visible and clean up after work rollback', async () => {
  const cwd = getRuntimeRoot()
  const duckdbPath = join(cwd, 'operation-tables.duckdb')
  process.env.API_SERVER_PORT = '3001'
  process.env.DUCKDB_PATH = duckdbPath
  process.env.DUCKDB_TEMP_DIRECTORY = join(cwd, 'duckdb-temp')
  process.env.SERVER_ROLE = 'dev-single'
  process.env.VITE_PORT = '3000'
  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  const database = getAppDatabaseService()

  try {
    const layout = getProjectTransferImportStagingLayout({
      layout: getProjectTransferImportTempLayout('operation-table-transaction-session'),
      stagingRevision: 1,
    })
    const articleCount = await writeStagedArticles({cwd, layout})
    const tables = getProjectTransferOperationTableNames('outside_transaction_visibility')
    let visibleArticleCount = 0

    await database.run('CREATE TABLE target_write_probe(value INTEGER)')
    const workError = await catchMessage(() => {
      return withProjectTransferOperationTables({
        cwd,
        layout,
        operationId: tables.operationId,
        payloadKeys: ['articles'],
        runner: database,
        workloadContext: projectTransferCommitTransactionWorkloadContext,
        work: ({tables: stagedTables}) => {
          return database.transaction(async (tx) => {
            const [count] = await tx.queryJson<{count: number | bigint}>(`
              SELECT COUNT(*) AS count
              FROM ${stagedTables.tableNames.articles}
            `)
            visibleArticleCount = Number(count?.count ?? 0)
            await tx.run('INSERT INTO target_write_probe VALUES (1)')
            throw new Error('expected writer failure')
          }, projectTransferCommitTransactionWorkloadContext)
        },
      })
    })
    const [targetWriteCount] = await database.queryJson<{count: number | bigint}>(`
      SELECT COUNT(*) AS count
      FROM target_write_probe
    `)
    const teardownError = await catchMessage(() => {
      return database.queryJson(`SELECT COUNT(*) AS count FROM ${tables.tableNames.articles}`)
    })

    expect(visibleArticleCount).toBe(articleCount)
    expect(workError).toContain('expected writer failure')
    expect(Number(targetWriteCount?.count ?? 0)).toBe(0)
    expect(teardownError).toContain(tables.tableNames.articles)
  } finally {
    await database.close().catch(() => {
      return undefined
    })
    resetDuckdbServiceForTests()
    resetServerRuntimeRoleForTests()
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('operation table load failure drops tables already staged with the same workload context', async () => {
  const cwd = getRuntimeRoot()
  const layout = getProjectTransferImportStagingLayout({
    layout: getProjectTransferImportTempLayout('operation-table-load-failure-session'),
    stagingRevision: 1,
  })
  const tables = getProjectTransferOperationTableNames('load_failure_cleanup')
  const calls: Array<{statement: string; workloadContext: unknown}> = []
  let workRan = false
  const runner: ProjectTransferOperationTableRunner = {
    queryJson: async <T>() => {
      return [] as T[]
    },
    run: async (statement, workloadContext) => {
      calls.push({statement, workloadContext})

      if (statement.includes(tables.tableNames.judgments) && statement.includes('CREATE TEMP TABLE')) {
        throw new Error('expected staged judgment load failure')
      }
    },
  }

  try {
    const loadError = await catchMessage(() => {
      return withProjectTransferOperationTables({
        cwd,
        layout,
        operationId: tables.operationId,
        payloadKeys: ['articles', 'judgments'],
        runner,
        workloadContext: projectTransferCommitTransactionWorkloadContext,
        work: async () => {
          workRan = true
        },
      })
    })
    const cleanupStatements = calls.filter(({statement}) => {
      return !statement.includes('CREATE TEMP TABLE')
    })

    expect(loadError).toContain('expected staged judgment load failure')
    expect(workRan).toBe(false)
    expect(cleanupStatements).toContainEqual({
      statement: `DROP TABLE IF EXISTS ${tables.tableNames.articles}`,
      workloadContext: projectTransferCommitTransactionWorkloadContext,
    })
    expect(cleanupStatements).toContainEqual({
      statement: `DROP TABLE IF EXISTS ${tables.tableNames.judgments}`,
      workloadContext: projectTransferCommitTransactionWorkloadContext,
    })
    expect(
      calls.every(({workloadContext}) => {
        return workloadContext === projectTransferCommitTransactionWorkloadContext
      }),
    ).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('operation table cleanup failure cannot replace a successful committed result', async () => {
  const layout = getProjectTransferImportStagingLayout({
    layout: getProjectTransferImportTempLayout('operation-table-cleanup-failure-session'),
    stagingRevision: 1,
  })
  const tables = getProjectTransferOperationTableNames('cleanup_failure_after_success')
  let cleanupAttempts = 0
  let workRan = false
  const runner: ProjectTransferOperationTableRunner = {
    queryJson: async <T>() => {
      return [] as T[]
    },
    run: async (statement) => {
      if (!statement.includes('CREATE TEMP TABLE')) {
        cleanupAttempts += 1
        throw new Error(`expected cleanup failure ${cleanupAttempts}`)
      }
    },
  }

  const result = await withProjectTransferOperationTables({
    layout,
    operationId: tables.operationId,
    payloadKeys: ['articles'],
    runner,
    work: async () => {
      workRan = true

      return 'durable-commit-result'
    },
  })

  expect(result).toBe('durable-commit-result')
  expect(workRan).toBe(true)
  expect(cleanupAttempts).toBe(2)
})

test('operation table cleanup failure cannot replace the original work failure', async () => {
  const layout = getProjectTransferImportStagingLayout({
    layout: getProjectTransferImportTempLayout('operation-table-work-cleanup-failure-session'),
    stagingRevision: 1,
  })
  const tables = getProjectTransferOperationTableNames('cleanup_failure_after_work_failure')
  let cleanupAttempts = 0
  const runner: ProjectTransferOperationTableRunner = {
    queryJson: async <T>() => {
      return [] as T[]
    },
    run: async (statement) => {
      if (!statement.includes('CREATE TEMP TABLE')) {
        cleanupAttempts += 1
        throw new Error(`expected cleanup failure ${cleanupAttempts}`)
      }
    },
  }

  const workError = await catchMessage(() => {
    return withProjectTransferOperationTables({
      layout,
      operationId: tables.operationId,
      payloadKeys: ['articles'],
      runner,
      work: async () => {
        throw new Error('expected original work failure')
      },
    })
  })

  expect(workError).toBe('expected original work failure')
  expect(cleanupAttempts).toBe(2)
})
