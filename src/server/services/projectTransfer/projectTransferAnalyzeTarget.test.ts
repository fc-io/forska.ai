import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {resetDuckdbServiceForTests} from '../../utils/duckdbService.ts'
import {resetServerRuntimeRoleForTests} from '../../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {withProjectTransferOperationTables} from './projectTransferOperationTables.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferImportStagingLayout} from './projectTransferStaging.ts'

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-analyze-target-${process.pid}-`))
}

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const catchMessage = async (operation: () => Promise<unknown>) => {
  try {
    await operation()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const writeStagedPayloads = async ({
  cwd,
  layout,
  payloads,
}: {
  cwd: string
  layout: ReturnType<typeof getProjectTransferImportStagingLayout>
  payloads: ProjectTransferPayloadByKey
}) => {
  await projectTransferPayloadKeys.reduce<Promise<void>>(async (previous, key) => {
    await previous
    const payloadPath = join(cwd, layout.extractedPath, projectTransferPayloadPathByKey[key])

    await mkdir(dirname(payloadPath), {recursive: true})
    await globalThis.Bun.write(payloadPath, serializeProjectTransferPayload(key, payloads[key] as never))
  }, Promise.resolve())
}

test('loads staged rows into same-operation temp tables and tears them down', async () => {
  const cwd = getRuntimeRoot()
  const duckdbPath = `/tmp/f2-project-transfer-operation-tables-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  process.env.API_SERVER_PORT = '3001'
  process.env.DUCKDB_PATH = duckdbPath
  process.env.SERVER_ROLE = 'dev-single'
  process.env.VITE_PORT = '3000'
  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  try {
    const database = getAppDatabaseService()
    const layout = getProjectTransferImportStagingLayout({
      layout: getProjectTransferImportTempLayout('operation-table-session'),
      stagingRevision: 1,
    })
    const payloads = getProjectTransferPayloadFixtureMap()

    await writeStagedPayloads({cwd, layout, payloads})

    const result = await withProjectTransferOperationTables({
      cwd,
      layout,
      operationId: 'target-analysis-test',
      work: async ({runner, tables}) => {
        const [articleCount] = await runner.queryJson<{count: number | string | bigint}>(`
          SELECT COUNT(*) AS count
          FROM ${tables.tableNames.articles}
        `)
        const [projectCount] = await runner.queryJson<{count: number | string | bigint}>(`
          SELECT COUNT(*) AS count
          FROM ${tables.tableNames.project}
        `)
        const [assetEntryCount] = await runner.queryJson<{count: number | string | bigint}>(`
          SELECT COUNT(*) AS count
          FROM ${tables.tableNames.assetManifest}
        `)
        const [article] = await runner.queryJson<{sourceArticleId: string | null}>(`
          SELECT payload_json->>'sourceArticleId' AS sourceArticleId
          FROM ${tables.tableNames.articles}
          ORDER BY row_index ASC
          LIMIT 1
        `)

        return {
          articleCount: Number(articleCount?.count ?? 0),
          assetEntryCount: Number(assetEntryCount?.count ?? 0),
          projectCount: Number(projectCount?.count ?? 0),
          sourceArticleId: article?.sourceArticleId ?? null,
          tableName: tables.tableNames.articles,
        }
      },
    })
    const teardownError = await catchMessage(() => {
      return database.queryJson(`SELECT COUNT(*) AS count FROM ${result.tableName}`)
    })

    expect(result).toEqual({
      articleCount: 1,
      assetEntryCount: 1,
      projectCount: 1,
      sourceArticleId: 'article-1',
      tableName: 'temp_project_transfer_target_analysis_test_articles',
    })
    expect(teardownError).toContain(result.tableName)

    await database.close()
  } finally {
    resetDuckdbServiceForTests()
    resetServerRuntimeRoleForTests()
    removeFileIfExists(cwd)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.tmp`)
    removeFileIfExists(`${duckdbPath}.tmp/`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
})
