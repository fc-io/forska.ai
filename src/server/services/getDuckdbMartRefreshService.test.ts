import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

type MartRefreshServiceModule = typeof import('./getDuckdbMartRefreshService.ts')

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
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.judgment_fact') && statement.includes('article-requeue-test')) {
                    refreshRuns += 1

                    if (!hasRequeued && martRefreshService) {
                      hasRequeued = true
                      await martRefreshService.queueJudgmentArticleRefresh('article-requeue-test', 'requeued-during-drain')
                    }
                  }

                  return service.runBackground(statement)
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
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS queuedCount
          FROM app.mart_refresh_queue
        \`)

        console.log(JSON.stringify({
          queuedCount: Number(queueRow?.queuedCount ?? 0),
          refreshRuns,
          totalCount: Number(queueRow?.totalCount ?? 0),
        }))
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

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      queuedCount: number
      refreshRuns: number
      totalCount: number
    }

    expect(result.queuedCount).toBe(0)
    expect(result.refreshRuns).toBe(2)
    expect(result.totalCount).toBe(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh clears multiple queued project rebuilds in one drain', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-project-delete-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname

        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES
            ('connection-project-delete-a', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1'),
            ('connection-project-delete-b', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES
            ('model-project-delete-a', 'connection-project-delete-a', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE),
            ('model-project-delete-b', 'connection-project-delete-b', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES
            ('project-delete-a', 'Project Delete A', 'model-project-delete-a', TRUE, TRUE, FALSE, FALSE),
            ('project-delete-b', 'Project Delete B', 'model-project-delete-b', TRUE, TRUE, FALSE, FALSE)
        \`)

        const martRefreshService = (await import(martRefreshServiceModulePath + '?project-delete=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-delete-a', 'project-delete-test-a')
        await martRefreshService.queueProjectRefresh('project-delete-b', 'project-delete-test-b')
        await martRefreshService.flush()

        const [queueRow] = await database.queryJson(\`
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS queuedCount
          FROM app.mart_refresh_queue
        \`)

        console.log(JSON.stringify({
          queuedCount: Number(queueRow?.queuedCount ?? 0),
          totalCount: Number(queueRow?.totalCount ?? 0),
        }))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart project delete regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {queuedCount: number; totalCount: number}

    expect(result.queuedCount).toBe(0)
    expect(result.totalCount).toBe(2)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh task query orders by epoch(created_at) to avoid empty oldest-first reads', async () => {
  const martRefreshServiceModulePath = new URL(
    './src/server/services/getDuckdbMartRefreshService.ts',
    'file://' + process.cwd() + '/',
  ).pathname
  const martRefreshServiceModule = (await import(
    `${martRefreshServiceModulePath}?queued-sql=${Date.now()}`
  )) as MartRefreshServiceModule
  const martRefreshService = martRefreshServiceModule.getDuckdbMartRefreshService()

  expect(martRefreshService.getQueuedArticleTasksSqlForTests()).toContain('ORDER BY EPOCH(created_at) ASC, id ASC')
  expect(martRefreshService.getQueuedProjectTasksSqlForTests()).toContain(
    'ORDER BY COALESCE(project_scope_size.scopeCount, 0) ASC',
  )
})

test('mart refresh prioritizes smaller queued project rebuilds ahead of larger ones', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-project-priority-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        const projectRefreshOrder = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    projectRefreshOrder.push(
                      statement.includes('project-small-priority-test')
                        ? 'small'
                        : statement.includes('project-large-priority-test')
                          ? 'large'
                          : 'unknown',
                    )
                  }

                  return service.runBackground(statement)
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
          VALUES ('connection-project-priority-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-project-priority-test', 'connection-project-priority-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES
            ('project-large-priority-test', 'Large Priority Project', 'model-project-priority-test', TRUE, TRUE, FALSE, FALSE),
            ('project-small-priority-test', 'Small Priority Project', 'model-project-priority-test', TRUE, TRUE, FALSE, FALSE)
        \`)

        for (const index of [0, 1, 2]) {
          await database.run(\`
            INSERT INTO app.article (id, article_title)
            VALUES ('article-large-priority-test-\${index}', 'Large Priority Article \${index}')
          \`)
          await database.run(\`
            INSERT INTO app.project_article (id, project_id, article_id)
            VALUES ('project-large-priority-link-\${index}', 'project-large-priority-test', 'article-large-priority-test-\${index}')
          \`)
          await database.run(\`
            INSERT INTO mart.project_scope_article (
              project_id,
              article_id,
              in_curated_scope,
              in_route_scope,
              article_created_at,
              article_updated_at
            )
            VALUES (
              'project-large-priority-test',
              'article-large-priority-test-\${index}',
              TRUE,
              FALSE,
              current_timestamp,
              current_timestamp
            )
          \`)
        }

        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('article-small-priority-test-0', 'Small Priority Article 0')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-small-priority-link-0', 'project-small-priority-test', 'article-small-priority-test-0')
        \`)
        await database.run(\`
          INSERT INTO mart.project_scope_article (
            project_id,
            article_id,
            in_curated_scope,
            in_route_scope,
            article_created_at,
            article_updated_at
          )
          VALUES (
            'project-small-priority-test',
            'article-small-priority-test-0',
            TRUE,
            FALSE,
            current_timestamp,
            current_timestamp
          )
        \`)

        const martRefreshService = (await import(martRefreshServiceModulePath + '?priority=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-large-priority-test', 'large-project-priority-test')
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        await martRefreshService.queueProjectRefresh('project-small-priority-test', 'small-project-priority-test')
        await martRefreshService.flush()

        console.log(JSON.stringify({projectRefreshOrder}))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart project priority regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {projectRefreshOrder: string[]}

    expect(result.projectRefreshOrder).toEqual(['small', 'large'])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh runs project rebuild statements on the background database connection', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let queueActive = true
        let backgroundRunCount = 0

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes('WHERE refresh_generation IS NULL')
                        ? [{count: 0}]
                        : statement.includes('SELECT COUNT(*) AS count')
                          ? [{count: queueActive ? 1 : 0}]
                          : statement.includes('FROM app.mart_refresh_queue')
                            ? queueActive
                              ? [{
                                  articleId: null,
                                  id: 'project-task',
                                  projectId: 'project-background-test',
                                  refreshGeneration: 0,
                                  refreshScope: 'project',
                                }]
                              : []
                            : []
                },
                queryJsonBackground: async () => {
                  return []
                },
                run: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    throw new Error('project refresh ran on control connection')
                  }

                  if (statement.includes('SET completed_at = NOW()')) {
                    queueActive = false
                  }
                },
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    backgroundRunCount += 1
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?background=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.flush()
        console.log(JSON.stringify({backgroundRunCount, queueActive}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart background connection regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    backgroundRunCount: number
    queueActive: boolean
  }

  expect(result.backgroundRunCount).toBeGreaterThan(0)
  expect(result.queueActive).toBe(false)
})

test('mart refresh repairs review_article_rollup before running a project rebuild', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let queueActive = true
        const events = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes("table_name = 'review_article_rollup'")
                        ? [{count: 1}]
                        : statement.includes('WHERE refresh_generation IS NULL')
                          ? [{count: 0}]
                          : statement.includes('SELECT COUNT(*) AS count')
                            ? [{count: queueActive ? 1 : 0}]
                            : statement.includes('FROM app.mart_refresh_queue')
                              ? queueActive
                                ? [{
                                    articleId: null,
                                    id: 'project-task',
                                    projectId: 'project-rollup-repair-test',
                                    refreshGeneration: 0,
                                    refreshScope: 'project',
                                  }]
                                : []
                              : []
                },
                queryJsonBackground: async () => {
                  return []
                },
                run: async (statement) => {
                  if (statement.includes('DROP TABLE IF EXISTS mart.review_article_rollup_repair')) {
                    events.push('repair:drop-scratch')
                  }

                  if (statement.includes('CREATE TABLE mart.review_article_rollup_repair AS')) {
                    events.push('repair:copy-existing')
                  }

                  if (statement.includes('DROP TABLE mart.review_article_rollup')) {
                    events.push('repair:drop-live')
                  }

                  if (statement.includes('CREATE TABLE mart.review_article_rollup (')) {
                    events.push('repair:create-live')
                  }

                  if (statement.includes('CREATE INDEX idx_mart_review_article_rollup_project_id')) {
                    events.push('repair:create-index')
                  }

                  if (
                    statement.includes('INSERT INTO mart.review_article_rollup')
                    && statement.includes('FROM mart.review_article_rollup_repair')
                  ) {
                    events.push('repair:restore-rows')
                  }

                  if (statement.includes('SET completed_at = NOW()')) {
                    queueActive = false
                  }
                },
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    events.push('refresh:project-scope')
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?rollup-repair=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.flush()
        console.log(JSON.stringify({events, queueActive}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Mart review_article_rollup repair regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]; queueActive: boolean}

  expect(result.events).toContain('repair:create-live')
  expect(result.events).toContain('repair:create-index')
  expect(result.events).toContain('refresh:project-scope')
  expect(result.events.indexOf('repair:create-live')).toBeLessThan(result.events.indexOf('refresh:project-scope'))
  expect(result.queueActive).toBe(false)
})

test('mart refresh retries cleanly after a failed background transaction poisons the connection', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-background-rollback-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        let shouldFailBackgroundRefresh = true

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                runBackground: async (statement) => {
                  if (
                    shouldFailBackgroundRefresh
                    && statement.includes('DELETE FROM mart.judgment_fact')
                    && statement.includes('article-background-rollback-test')
                  ) {
                    shouldFailBackgroundRefresh = false
                    return service.runBackground(\`
                      BEGIN TRANSACTION;
                      DELETE FROM mart.judgment_fact
                      WHERE article_id = 'article-background-rollback-test';
                      SELECT *
                      FROM app.missing_background_rollback_table;
                      COMMIT;
                    \`)
                  }

                  return service.runBackground(statement)
                },
              }
            },
          }
        })

        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')

        await migrateDuckdb()

        const database = actualAppDatabaseModule.getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('article-background-rollback-test', 'Background Rollback Test Article')
        \`)

        const martRefreshService = (await import(martRefreshServiceModulePath + '?background-rollback=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefresh('article-background-rollback-test', 'background-rollback-test')
        const failureText = await martRefreshService.flush().then(
          () => 'no failure',
          (error) => error instanceof Error ? error.message : String(error),
        )

        const [queuedAfterFailure] = await database.queryJson(\`
          SELECT COUNT(*) AS count
          FROM app.mart_refresh_queue
          WHERE completed_at IS NULL
        \`)

        const retryText = await martRefreshService.flush().then(
          () => 'ok',
          (error) => error instanceof Error ? error.message : String(error),
        )

        const [queuedAfterRetry] = await database.queryJson(\`
          SELECT COUNT(*) AS count
          FROM app.mart_refresh_queue
          WHERE completed_at IS NULL
        \`)

        console.log(JSON.stringify({
          failureText,
          queuedAfterFailure: Number(queuedAfterFailure?.count ?? 0),
          queuedAfterRetry: Number(queuedAfterRetry?.count ?? 0),
          retryText,
        }))
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
        runScript.stderr.toString()
          || runScript.stdout.toString()
          || 'Mart background rollback recovery regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      failureText: string
      queuedAfterFailure: number
      queuedAfterRetry: number
      retryText: string
    }

    expect(result.failureText).toContain('missing_background_rollback_table')
    expect(result.queuedAfterFailure).toBe(1)
    expect(result.retryText).toBe('ok')
    expect(result.queuedAfterRetry).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
}, 20_000)

test('mart refresh populates review article serving v3 tables', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-serving-v3-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-serving-v3-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-serving-v3-test', 'connection-serving-v3-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-serving-v3-test', 'Serving V3 Project', 'model-serving-v3-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-serving-v3-test', 'Prompt body', 'hash-serving-v3-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-serving-v3-test', 'project-serving-v3-test', 'prompt-serving-v3-test', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES (
            'article-serving-v3-test',
            'Serving V3 Article',
            '2024-01-02T00:00:00.000Z',
            '2024-01-03T00:00:00.000Z',
            'external-serving-v3-test'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-serving-v3-test', 'project-serving-v3-test', 'article-serving-v3-test')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES (
            'judgment-serving-v3-test',
            'article-serving-v3-test',
            'prompt-serving-v3-test',
            'model-serving-v3-test',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            TRUE,
            'yes',
            ['yes'],
            90
          )
        \`)

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefresh('article-serving-v3-test', 'serving-v3-test')
        await martRefreshService.flush()

        const [generationRow] = await database.queryJson(\`
          SELECT active_generation AS activeGeneration
          FROM app.project_review_serving_generation
          WHERE project_id = 'project-serving-v3-test'
        \`)
        const servingRows = await database.queryJson(\`
          SELECT article_id AS articleId, has_all_llm_judgments AS hasAllLlmJudgments
          FROM mart.review_article_serving
          WHERE project_id = 'project-serving-v3-test'
            AND generation = 1
          ORDER BY article_id ASC
        \`)
        const filterRows = await database.queryJson(\`
          SELECT prompt_id AS promptId, article_id AS articleId
          FROM mart.review_article_filter_member
          WHERE project_id = 'project-serving-v3-test'
            AND generation = 1
          ORDER BY prompt_id ASC, article_id ASC
        \`)
        const detailRows = await database.queryJson(\`
          SELECT prompt_id AS promptId, article_id AS articleId, judgment_id AS judgmentId
          FROM mart.review_article_serving_detail
          WHERE project_id = 'project-serving-v3-test'
            AND generation = 1
          ORDER BY prompt_id ASC, article_id ASC
        \`)

        console.log(JSON.stringify({
          activeGeneration: Number(generationRow?.activeGeneration ?? 0),
          detailRows,
          filterRows,
          servingRows,
        }))
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
        runScript.stderr.toString()
          || runScript.stdout.toString()
          || 'Mart review article serving v3 regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      activeGeneration: number
      detailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      filterRows: Array<{articleId: string; promptId: string}>
      servingRows: Array<{articleId: string; hasAllLlmJudgments: boolean}>
    }

    expect(result.activeGeneration).toBe(1)
    expect(result.servingRows).toEqual([{articleId: 'article-serving-v3-test', hasAllLlmJudgments: true}])
    expect(result.filterRows).toEqual([{articleId: 'article-serving-v3-test', promptId: 'prompt-serving-v3-test'}])
    expect(result.detailRows).toEqual([
      {
        articleId: 'article-serving-v3-test',
        judgmentId: 'judgment-serving-v3-test',
        promptId: 'prompt-serving-v3-test',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh updates serving rows incrementally after a judgment answer changes', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-serving-incremental-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-serving-incremental-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-serving-incremental-test', 'connection-serving-incremental-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-serving-incremental-test', 'Serving Incremental Project', 'model-serving-incremental-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-serving-incremental-test', 'Prompt body', 'hash-serving-incremental-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-serving-incremental-test', 'project-serving-incremental-test', 'prompt-serving-incremental-test', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES ('article-serving-incremental-test', 'Serving Incremental Article', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z', 'external-serving-incremental-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-serving-incremental-test', 'project-serving-incremental-test', 'article-serving-incremental-test')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES (
            'judgment-serving-incremental-test',
            'article-serving-incremental-test',
            'prompt-serving-incremental-test',
            'model-serving-incremental-test',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            TRUE,
            'yes',
            ['yes'],
            90
          )
        \`)

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefresh('article-serving-incremental-test', 'serving-incremental-initial')
        await martRefreshService.flush()

        await database.run(\`
          UPDATE app.judgment
          SET answered_original = 'no',
              answered_original_as_array = ['no'],
              updated_at = current_timestamp
          WHERE id = 'judgment-serving-incremental-test'
        \`)

        await martRefreshService.queueJudgmentArticleRefresh('article-serving-incremental-test', 'serving-incremental-update')
        await martRefreshService.flush()

        const [generationRow] = await database.queryJson(\`
          SELECT active_generation AS activeGeneration
          FROM app.project_review_serving_generation
          WHERE project_id = 'project-serving-incremental-test'
        \`)
        const filterRows = await database.queryJson(\`
          SELECT dictionary.answer_value AS answerValue
          FROM mart.review_article_filter_member member
          INNER JOIN app.review_answer_dictionary dictionary
            ON dictionary.project_id = member.project_id
           AND dictionary.prompt_id = member.prompt_id
           AND dictionary.answer_id = member.answer_id
          WHERE member.project_id = 'project-serving-incremental-test'
            AND member.article_id = 'article-serving-incremental-test'
            AND member.generation = 1
          ORDER BY dictionary.answer_value ASC
        \`)
        const detailRows = await database.queryJson(\`
          SELECT answered_original AS answeredOriginal
          FROM mart.review_article_serving_detail
          WHERE project_id = 'project-serving-incremental-test'
            AND article_id = 'article-serving-incremental-test'
            AND generation = 1
          ORDER BY created_at DESC
        \`)

        console.log(JSON.stringify({
          activeGeneration: Number(generationRow?.activeGeneration ?? 0),
          detailRows,
          filterRows,
        }))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart serving incremental update test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      activeGeneration: number
      detailRows: Array<{answeredOriginal: string}>
      filterRows: Array<{answerValue: string}>
    }

    expect(result.activeGeneration).toBe(1)
    expect(result.filterRows).toEqual([{answerValue: 'no'}])
    expect(result.detailRows).toEqual([{answeredOriginal: 'no'}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh keeps the previous serving generation during the next rebuild', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-serving-generations-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-serving-generation-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-serving-generation-test', 'connection-serving-generation-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-serving-generation-test', 'Serving Generation Project', 'model-serving-generation-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-serving-generation-test', 'Prompt body', 'hash-serving-generation-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-serving-generation-test', 'project-serving-generation-test', 'prompt-serving-generation-test', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES ('article-serving-generation-test', 'Serving Generation Article', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z', 'external-serving-generation-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-serving-generation-test', 'project-serving-generation-test', 'article-serving-generation-test')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES (
            'judgment-serving-generation-test',
            'article-serving-generation-test',
            'prompt-serving-generation-test',
            'model-serving-generation-test',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            TRUE,
            'yes',
            ['yes'],
            90
          )
        \`)

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-serving-generation-test', 'generation-test-1')
        await martRefreshService.flush()
        await martRefreshService.queueProjectRefresh('project-serving-generation-test', 'generation-test-2')
        await martRefreshService.flush()

        const [generationRow] = await database.queryJson(\`
          SELECT active_generation AS activeGeneration
          FROM app.project_review_serving_generation
          WHERE project_id = 'project-serving-generation-test'
        \`)
        const generationRows = await database.queryJson(\`
          SELECT generation, COUNT(*) AS count
          FROM mart.review_article_serving
          WHERE project_id = 'project-serving-generation-test'
          GROUP BY generation
          ORDER BY generation ASC
        \`)

        console.log(JSON.stringify({
          activeGeneration: Number(generationRow?.activeGeneration ?? 0),
          generationRows: generationRows.map((row) => {
            return {count: Number(row.count ?? 0), generation: Number(row.generation ?? 0)}
          }),
        }))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart serving generation retention test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      activeGeneration: number
      generationRows: Array<{count: number; generation: number}>
    }

    expect(result.activeGeneration).toBe(2)
    expect(result.generationRows).toEqual([
      {count: 1, generation: 1},
      {count: 1, generation: 2},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
}, 20_000)

test('mart refresh does not advance serving generation when rebuild fails', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-serving-failure-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        let shouldFailServingRefresh = false

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                runBackground: async (statement) => {
                  if (shouldFailServingRefresh && statement.includes('INSERT INTO mart.review_article_serving (')) {
                    throw new Error('simulated serving generation failure')
                  }

                  return service.runBackground(statement)
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
          VALUES ('connection-serving-failure-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-serving-failure-test', 'connection-serving-failure-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-serving-failure-test', 'Serving Failure Project', 'model-serving-failure-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-serving-failure-test', 'Prompt body', 'hash-serving-failure-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-serving-failure-test', 'project-serving-failure-test', 'prompt-serving-failure-test', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES ('article-serving-failure-test', 'Serving Failure Article', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z', 'external-serving-failure-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-serving-failure-test', 'project-serving-failure-test', 'article-serving-failure-test')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES (
            'judgment-serving-failure-test',
            'article-serving-failure-test',
            'prompt-serving-failure-test',
            'model-serving-failure-test',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            TRUE,
            'yes',
            ['yes'],
            90
          )
        \`)

        const martRefreshService = (await import(martRefreshServiceModulePath + '?serving-failure=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-serving-failure-test', 'serving-failure-1')
        await martRefreshService.flush()
        shouldFailServingRefresh = true
        await martRefreshService.queueProjectRefresh('project-serving-failure-test', 'serving-failure-2')
        const failureText = await martRefreshService.flush().then(
          () => 'no failure',
          (error) => error instanceof Error ? error.message : String(error),
        )

        const [generationRow] = await database.queryJson(\`
          SELECT active_generation AS activeGeneration
          FROM app.project_review_serving_generation
          WHERE project_id = 'project-serving-failure-test'
        \`)

        console.log(JSON.stringify({
          activeGeneration: Number(generationRow?.activeGeneration ?? 0),
          failureText,
        }))
        await database.close()
        process.exit(0)
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart serving generation failure test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      activeGeneration: number
      failureText: string
    }

    expect(result.activeGeneration).toBe(1)
    expect(result.failureText).toContain('simulated serving generation failure')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
}, 20_000)

test('mart refresh skips schema repair writes when refresh_generation already exists', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-generation-ready-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        let schemaRepairRuns = 0

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                run: async (statement) => {
                  if (statement.includes('ALTER TABLE app.mart_refresh_queue ADD COLUMN IF NOT EXISTS refresh_generation')) {
                    schemaRepairRuns += 1
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
          VALUES ('connection-generation-ready-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-generation-ready-test', 'connection-generation-ready-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-generation-ready-test', 'Generation Ready Test Project', 'model-generation-ready-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('article-generation-ready-test', 'Generation Ready Test Article')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-generation-ready-test', 'project-generation-ready-test', 'article-generation-ready-test')
        \`)

        const martRefreshService = (await import(martRefreshServiceModulePath + '?generation-ready=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefresh('article-generation-ready-test', 'generation-ready-test')
        await martRefreshService.flush()

        console.log(JSON.stringify({schemaRepairRuns}))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart generation-ready regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {schemaRepairRuns: number}

    expect(result.schemaRepairRuns).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh schema repair avoids ALTER COLUMN defaults and checkpoints after repair', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const state = {maintenanceCalls: [], runStatements: []}

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                maintenance: async (command) => {
                  state.maintenanceCalls.push(command)
                },
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 0}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 0}]
                      : statement.includes('WHERE refresh_generation IS NULL')
                        ? [{count: 0}]
                        : []
                },
                queryJsonBackground: async () => [],
                run: async (statement) => {
                  state.runStatements.push(statement)
                },
                runBackground: async () => {},
                transaction: async (work) => {
                  return work({queryJson: async () => [], run: async () => {}})
                },
              }
            },
          }
        })

        const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts?schema-repair=' + Date.now())
        const service = getDuckdbMartRefreshService()
        await service.queueJudgmentArticleRefresh('article-id', 'schema-repair-test')
        console.log(JSON.stringify(state))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart schema repair regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    maintenanceCalls: string[]
    runStatements: string[]
  }

  expect(result.maintenanceCalls).toEqual(['checkpoint', 'checkpoint'])
  expect(result.runStatements[0]).toContain('ADD COLUMN IF NOT EXISTS refresh_generation BIGINT;')
  expect(result.runStatements[0]).not.toContain('DEFAULT 0')
  expect(result.runStatements[1]).toContain('ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;')
  expect(result.runStatements[2]).toContain('INSERT INTO app.mart_refresh_queue')
  expect(result.runStatements[2]).toContain('refresh_generation')
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
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.judgment_fact') && statement.includes('article-yield-test-')) {
                    delayedRefreshRuns += 1

                    if (!hasDelayed) {
                      hasDelayed = true
                      await new Promise((resolve) => {
                        originalSetTimeout(resolve, 125)
                      })
                    }
                  }

                  return service.runBackground(statement)
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
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS queuedCount
          FROM app.mart_refresh_queue
        \`)

        console.log(JSON.stringify({
          delayedRefreshRuns,
          queuedCount: Number(queueRow?.queuedCount ?? 0),
          totalCount: Number(queueRow?.totalCount ?? 0),
          zeroDelayYieldCount,
        }))
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
      queuedCount: number
      totalCount: number
      zeroDelayYieldCount: number
    }

    expect(result.delayedRefreshRuns).toBe(5)
    expect(result.queuedCount).toBe(0)
    expect(result.totalCount).toBe(5)
    expect(result.zeroDelayYieldCount).toBeGreaterThanOrEqual(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('mart refresh deletes article tasks before a delayed project rebuild finishes', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-article-drain-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const actualAppDatabaseModule = await import(appDatabaseServiceModulePath + '?actual=' + Date.now())
        let hasDelayedProjectRefresh = false

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            ...actualAppDatabaseModule,
            getAppDatabaseService: () => {
              const service = actualAppDatabaseModule.getAppDatabaseService()

              return {
                ...service,
                runBackground: async (statement) => {
                  if (
                    !hasDelayedProjectRefresh
                    && statement.includes('DELETE FROM mart.project_scope_article')
                    && statement.includes('project-article-drain-test')
                  ) {
                    hasDelayedProjectRefresh = true
                    await new Promise((resolve) => {
                      setTimeout(resolve, 250)
                    })
                  }

                  return service.runBackground(statement)
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
          VALUES ('connection-article-drain-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-article-drain-test', 'connection-article-drain-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-article-drain-test', 'Article Drain Test Project', 'model-article-drain-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('article-article-drain-test', 'Article Drain Test Article')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-link-drain-test', 'project-article-drain-test', 'article-article-drain-test')
        \`)

        const martRefreshService = (await import(martRefreshServiceModulePath + '?article-drain=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.queueJudgmentArticleRefresh('article-article-drain-test', 'article-drain-test')
        const flushPromise = martRefreshService.flush()

        await new Promise((resolve) => {
          setTimeout(resolve, 75)
        })

        const queueRows = await database.queryJson(\`
          SELECT refresh_scope AS refreshScope, COUNT(*) AS count
          FROM app.mart_refresh_queue
          WHERE completed_at IS NULL
          GROUP BY refresh_scope
          ORDER BY refresh_scope
        \`)
        const progress = martRefreshService.getProgressSnapshot()

        await flushPromise

        console.log(JSON.stringify({
          progress,
          queueRows: queueRows.map((row) => {
            return {count: Number(row.count ?? 0), refreshScope: row.refreshScope}
          }),
        }))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart article drain regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      progress: {processingArticleIds: string[]; processingProjectIds: string[]}
      queueRows: Array<{count: number; refreshScope: string}>
    }

    expect(result.progress.processingArticleIds).toEqual(['article-article-drain-test'])
    expect(result.queueRows).toEqual([{count: 1, refreshScope: 'judgment_article'}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
