import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

test('mart refresh keeps a requeue that arrives during drain', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-requeue-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        let martRefreshService = null
        let refreshRuns = 0
        let hasRequeued = false

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                run: async (statement) => {
                  if (statement.includes('DELETE FROM mart.judgment_fact') && statement.includes('article-requeue-test')) {
                    refreshRuns += 1

                    if (!hasRequeued && martRefreshService) {
                      hasRequeued = true
                      await martRefreshService.queueJudgmentArticleRefresh('article-requeue-test', 'requeued-during-drain')
                    }
                  }

                  return service.run(statement)
                },
              }
            },
          }
        })

        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')

        await migrateDuckdb()

        const database = actualAppDatabaseModule.getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-requeue-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-requeue-test', 'connection-requeue-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-requeue-test', 'Requeue Test Project', 'model-requeue-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('article-requeue-test', 'Requeue Test Article')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-requeue-test', 'project-requeue-test', 'article-requeue-test')
        \`)

        martRefreshService = (await import(martRefreshServiceModulePath + '?requeue=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefresh('article-requeue-test', 'initial-drain')
        await martRefreshService.flush()

        const [queueRow] = await database.queryJson(\`
          SELECT COUNT(*) AS count
          FROM app.mart_refresh_queue
        \`)

        console.log(JSON.stringify({queueCount: Number(queueRow?.count ?? 0), refreshRuns}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3001',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (runScript.exitCode !== 0) {
      throw new Error(
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart requeue regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {queueCount: number; refreshRuns: number}

    expect(result.queueCount).toBe(0)
    expect(result.refreshRuns).toBe(2)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh yields between drain passes after exceeding the time budget', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-yield-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        const originalSetTimeout = globalThis.setTimeout
        let delayedRefreshRuns = 0
        let zeroDelayYieldCount = 0
        let hasDelayed = false

        globalThis.setTimeout = ((handler, timeout, ...args) => {
          if (Number(timeout ?? 0) === 0) {
            zeroDelayYieldCount += 1
          }

          return originalSetTimeout(handler, timeout, ...args)
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                run: async (statement) => {
                  if (statement.includes('DELETE FROM mart.judgment_fact') && statement.includes('article-yield-test-')) {
                    delayedRefreshRuns += 1

                    if (!hasDelayed) {
                      hasDelayed = true
                      await new Promise((resolve) => {
                        originalSetTimeout(resolve, 125)
                      })
                    }
                  }

                  return service.run(statement)
                },
              }
            },
          }
        })

        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')

        await migrateDuckdb()

        const database = actualAppDatabaseModule.getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-yield-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-yield-test', 'connection-yield-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-yield-test', 'Yield Test Project', 'model-yield-test', TRUE, TRUE, FALSE, FALSE)
        \`)

        for (const index of [0, 1, 2, 3, 4]) {
          await database.run(\`
            INSERT INTO app.article (id, article_title)
            VALUES ('article-yield-test-\${index}', 'Yield Test Article \${index}')
          \`)
          await database.run(\`
            INSERT INTO app.project_article (id, project_id, article_id)
            VALUES ('project-article-yield-test-\${index}', 'project-yield-test', 'article-yield-test-\${index}')
          \`)
        }

        const martRefreshService = (await import(martRefreshServiceModulePath + '?yield=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefreshes(
          ['article-yield-test-0', 'article-yield-test-1', 'article-yield-test-2', 'article-yield-test-3', 'article-yield-test-4'],
          'yield-budget-test',
        )
        await martRefreshService.flush()

        const [queueRow] = await database.queryJson(\`
          SELECT COUNT(*) AS count
          FROM app.mart_refresh_queue
        \`)

        console.log(JSON.stringify({delayedRefreshRuns, queueCount: Number(queueRow?.count ?? 0), zeroDelayYieldCount}))
        await database.close()
        globalThis.setTimeout = originalSetTimeout
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3001',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (runScript.exitCode !== 0) {
      throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Mart yield regression test failed')
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      delayedRefreshRuns: number
      queueCount: number
      zeroDelayYieldCount: number
    }

    expect(result.delayedRefreshRuns).toBe(5)
    expect(result.queueCount).toBe(0)
    expect(result.zeroDelayYieldCount).toBeGreaterThanOrEqual(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
