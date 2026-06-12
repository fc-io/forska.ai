import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {migrateDuckdb} from '../../../db/migrateDuckdb.ts'
import {computePromptContentHash} from '../../utils/computePromptContentHash.ts'
import {resetDuckdbServiceForTests} from '../../utils/duckdbService.ts'
import {resetServerRuntimeRoleForTests} from '../../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getSqlLiteral} from '../appQueryHelpers.ts'
import {getProjectTransferAnalyzeTargetPlanWithOperationTables} from './projectTransferAnalyzeTarget.ts'
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

test('analyzes target rows with staged joins and recomputed prompt hashes', async () => {
  const cwd = getRuntimeRoot()
  const duckdbPath = `/tmp/f2-project-transfer-target-set-based-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  process.env.API_SERVER_PORT = '3001'
  process.env.DUCKDB_PATH = duckdbPath
  process.env.SERVER_ROLE = 'dev-single'
  process.env.VITE_PORT = '3000'
  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  try {
    const database = getAppDatabaseService()
    const layout = getProjectTransferImportStagingLayout({
      layout: getProjectTransferImportTempLayout('target-set-based-session'),
      stagingRevision: 1,
    })
    const fixturePayloads = getProjectTransferPayloadFixtureMap()
    const prompt = fixturePayloads.prompts[0]
    const importRoute = fixturePayloads.importRoutes[0]

    if (prompt === undefined || importRoute === undefined) {
      throw new Error('Project transfer target analysis fixture is incomplete')
    }

    const promptHash = computePromptContentHash(
      String(prompt.originalText),
      typeof prompt.transformedText === 'string' ? prompt.transformedText : null,
      typeof prompt.promptHeading === 'string' ? prompt.promptHeading : null,
      typeof prompt.type === 'string' ? prompt.type : null,
    )
    const payloads = {
      ...fixturePayloads,
      articles: fixturePayloads.articles.map((article) => {
        return {
          ...article,
          articleId: 'package-legacy-set-based',
          arxivId: null,
          biorxivId: null,
          doi: 'HTTPS://DOI.ORG/10.1000/SET-BASED',
          identifierInputs: [],
          medrxivId: null,
          pubmedId: null,
          signature: {...article.signature, identifierKeys: ['doi:10.1000/set-based']},
        }
      }),
      prompts: fixturePayloads.prompts.map((entry) => {
        return {...entry, contentHash: 'declared-package-hash'}
      }),
    }

    await writeStagedPayloads({cwd, layout, payloads})
    await database.run(
      "INSERT INTO app.article (id, article_id, article_title) VALUES ('target-set-based-article', 'target-legacy-set-based', 'Set-Based Target')",
    )
    await database.run(
      "INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('target-set-based-identifier', 'target-set-based-article', 'doi', '10.1000/set-based', 'test')",
    )
    await database.run(
      `INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived) VALUES ('target-set-based-prompt', ${getSqlLiteral(
        String(prompt.originalText),
      )}, NULL, ${getSqlLiteral(String(prompt.promptHeading))}, ${getSqlLiteral(String(prompt.type))}, ${getSqlLiteral(
        promptHash,
      )}, FALSE)`,
    )
    await database.run(
      `INSERT INTO app.import_route (id, route, name, active) VALUES ('target-set-based-route', ${getSqlLiteral(
        String(importRoute.route),
      )}, 'Set-Based Route', TRUE)`,
    )

    const result = await getProjectTransferAnalyzeTargetPlanWithOperationTables({
      cwd,
      layout,
      operationId: 'target-set-based',
      packageFingerprint: null,
      payloads,
    })
    const [articleMatch] = result.targetPlan.articleMatches
    const [promptPlan] = result.targetPlan.promptPlan
    const [projectRoute] = result.targetPlan.projectRoutePlan

    expect(articleMatch).toMatchObject({action: 'reuse', selectedTargetArticleId: 'target-set-based-article'})
    expect(articleMatch?.candidates[0]).toEqual({
      matchedIdentifiers: [{identifierType: 'doi', key: 'doi:10.1000/set-based', value: '10.1000/set-based'}],
      targetArticleId: 'target-set-based-article',
    })
    expect(promptPlan).toMatchObject({
      action: 'reuse',
      computedContentHash: promptHash,
      packageContentHash: 'declared-package-hash',
      targetPromptId: 'target-set-based-prompt',
    })
    expect(projectRoute).toMatchObject({action: 'link', targetImportRouteId: 'target-set-based-route'})
    expect(
      result.packageWarnings.map((warning) => {
        return warning.code
      }),
    ).toContain('promptContentHashRecomputed')

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
