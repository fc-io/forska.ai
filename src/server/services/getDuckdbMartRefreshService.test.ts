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
                  if (
                    statement.includes('temp_dirty_judgment_fact_article')
                    && statement.includes("SELECT 'article-requeue-test' AS article_id")
                  ) {
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh rebuilds large projects in article batches', () => {
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
        const firstBatch = [
          {articleCreatedAt: '2024-01-01T00:00:00.000Z', articleId: 'article-1'},
          {articleCreatedAt: '2024-01-02T00:00:00.000Z', articleId: 'article-2'},
        ]
        const secondBatch = [{articleCreatedAt: '2024-01-03T00:00:00.000Z', articleId: 'article-3'}]

        const getBatchRows = (statement, type) => {
          const hasSecondCursor = statement.includes("article_id > 'article-2'")
          const hasFinalCursor = statement.includes("article_id > 'article-3'")

          if (hasFinalCursor) {
            return []
          }

          if (type === 'source') {
            return hasSecondCursor
              ? secondBatch.map((row) => {
                  return {
                    ...row,
                    articleUpdatedAt: row.articleCreatedAt,
                    inCuratedScope: true,
                    inRouteScope: false,
                  }
                })
              : firstBatch.map((row) => {
                  return {
                    ...row,
                    articleUpdatedAt: row.articleCreatedAt,
                    inCuratedScope: true,
                    inRouteScope: false,
                  }
                })
          }

          return hasSecondCursor ? secondBatch : firstBatch
        }

        const recordBatchEvent = (label, statement) => {
          const hasFirstBatch = statement.includes("'article-1'") && statement.includes("'article-2'")
          const hasSecondBatch = statement.includes("'article-3'")

          if (hasFirstBatch && hasSecondBatch) {
            events.push(label + ':all')
            return
          }

          if (hasFirstBatch) {
            events.push(label + ':batch-1')
            return
          }

          if (hasSecondBatch) {
            events.push(label + ':batch-2')
          }
        }

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? [{
                                articleId: null,
                                id: 'project-batch-task',
                                projectId: 'project-batch-test',
                                refreshGeneration: 0,
                                refreshScope: 'project',
                              }]
                            : []
                          : []
                },
                queryJsonBackground: async (statement) => {
                  return statement.includes('FROM aggregated_scope')
                    ? getBatchRows(statement, 'source')
                    : statement.includes('FROM mart.project_scope_article') && statement.includes('article_id AS articleId')
                      ? getBatchRows(statement, 'scope')
                      : []
                },
                run: async (statement) => {
                  if (statement.includes('CREATE TABLE IF NOT EXISTS mart.review_article_rollup (')) {
                    events.push('rollup:ensure-table')
                  }

                  if (statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_review_article_rollup_project_id')) {
                    events.push('rollup:ensure-index')
                  }

                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
                    events.push('queue:complete')
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    events.push('scope:reset')
                  }

                  if (statement.includes('INSERT INTO mart.project_scope_article (')) {
                    recordBatchEvent('scope', statement)
                  }

                  if (statement.includes('DELETE FROM mart.prompt_answer_fact')) {
                    events.push('prompt:reset')
                  }

                  if (statement.includes('CREATE TABLE mart.prompt_answer_fact_project_refresh_rewrite')) {
                    events.push('prompt:rewrite-created')
                  }

                  if (statement.includes('DROP TABLE mart.prompt_answer_fact;')) {
                    events.push('prompt:rewrite-drop-old')
                  }

                  if (statement.includes('RENAME TO prompt_answer_fact')) {
                    events.push('prompt:rewrite-swap')
                  }

                  if (statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_prompt_answer_fact_lookup')) {
                    events.push('prompt:rewrite-index')
                  }

                  if (statement.includes('INSERT INTO mart.prompt_answer_fact (')) {
                    recordBatchEvent('prompt', statement)
                  }

                  if (statement.includes('DELETE FROM app.review_answer_dictionary')) {
                    events.push('dictionary:rebuild')
                  }

                  if (statement.includes('DELETE FROM mart.review_article_rollup')) {
                    events.push('rollup:reset')
                  }

                  if (statement.includes('INSERT INTO mart.review_article_rollup (')) {
                    recordBatchEvent('rollup', statement)
                  }

                  if (statement.includes('INSERT INTO app.project_review_serving_generation')) {
                    events.push('serving:setup')
                  }

                  if (statement.includes('INSERT INTO mart.review_article_serving (')) {
                    recordBatchEvent('serving', statement)
                  }

                  if (statement.includes('UPDATE app.project_review_serving_generation')) {
                    events.push('serving:finalize')
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?project-batch=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.flush()
        console.log(JSON.stringify({events, queueActive}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart project batching regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]; queueActive: boolean}

  expect(result.events).toContain('scope:batch-1')
  expect(result.events).toContain('scope:batch-2')
  expect(result.events).toContain('prompt:rewrite-created')
  expect(result.events).toContain('prompt:rewrite-drop-old')
  expect(result.events).toContain('prompt:rewrite-swap')
  expect(result.events).toContain('prompt:rewrite-index')
  expect(result.events).toContain('prompt:batch-1')
  expect(result.events).toContain('prompt:batch-2')
  expect(result.events).toContain('rollup:batch-1')
  expect(result.events).toContain('rollup:batch-2')
  expect(result.events).toContain('serving:batch-1')
  expect(result.events).toContain('serving:batch-2')
  expect(result.events).not.toContain('prompt:reset')
  expect(result.events).not.toContain('prompt:all')
  expect(result.events).not.toContain('rollup:all')
  expect(result.events).not.toContain('serving:all')
  expect(result.queueActive).toBe(false)
})

test('mart refresh recovers archived projects in row batches', () => {
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
        const firstBatch = [{rowId: 101}, {rowId: 102}]
        const secondBatch = [{rowId: 103}]
        const batchCallCounts = {}

        const getBatchTableName = (statement) => {
          return statement.includes('FROM mart.review_article_serving_detail')
            ? 'mart.review_article_serving_detail'
            : statement.includes('FROM mart.review_article_filter_member')
              ? 'mart.review_article_filter_member'
            : statement.includes('FROM mart.review_article_rollup')
                  ? 'mart.review_article_rollup'
                  : statement.includes('FROM mart.prompt_answer_fact')
                    ? 'mart.prompt_answer_fact'
                    : statement.includes('FROM mart.project_scope_article')
                      ? 'mart.project_scope_article'
                      : 'unknown'
        }

        const getBatchRows = (statement) => {
          const tableName = getBatchTableName(statement)
          const nextCallCount = (batchCallCounts[tableName] ?? 0) + 1

          batchCallCounts[tableName] = nextCallCount

          return nextCallCount === 1 ? firstBatch : nextCallCount === 2 ? secondBatch : []
        }

        const recordDeleteEvent = (label, statement) => {
          const hasFirstBatch = statement.includes('101') && statement.includes('102')
          const hasSecondBatch = statement.includes('103')

          if (hasFirstBatch) {
            events.push(label + ':batch-1')
          }

          if (hasSecondBatch) {
            events.push(label + ':batch-2')
          }
        }

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? [{
                                articleId: null,
                                id: 'project-archive-task',
                                projectId: 'project-archive-batch-test',
                                refreshGeneration: 0,
                                refreshScope: 'project',
                              }]
                            : []
                          : []
                },
                queryJsonBackground: async (statement) => {
                  return statement.includes('SELECT archived AS archived')
                    ? [{archived: true}]
                    : statement.includes('SELECT') && statement.includes('rowid AS rowId') && statement.includes('FROM mart.')
                      ? getBatchRows(statement)
                      : []
                },
                run: async (statement) => {
                  if (statement.includes('CREATE TABLE IF NOT EXISTS mart.review_article_rollup (')) {
                    events.push('rollup:ensure-table')
                  }

                  if (statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_review_article_rollup_project_id')) {
                    events.push('rollup:ensure-index')
                  }

                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.review_article_serving_detail')) {
                    recordDeleteEvent('serving-detail', statement)
                  }

                  if (statement.includes('DELETE FROM mart.review_article_filter_member')) {
                    recordDeleteEvent('filter-member', statement)
                  }

                  if (statement.includes('CREATE TABLE mart.review_article_serving_project_purge_rewrite')) {
                    events.push('serving:rewrite-created')
                  }

                  if (statement.includes('PRIMARY KEY(project_id, generation, article_id)')) {
                    events.push('serving:rewrite-primary-key')
                  }

                  if (statement.includes('DROP TABLE mart.review_article_serving')) {
                    events.push('serving:rewrite-drop-old')
                  }

                  if (statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_review_article_serving_order')) {
                    events.push('serving:rewrite-index')
                  }

                  if (statement.includes('INSERT INTO mart.review_article_serving_project_purge_rewrite')) {
                    events.push('serving:rewrite-batch')
                  }

                  if (statement.includes('RENAME TO review_article_serving')) {
                    events.push('serving:rewrite-swap')
                  }

                  if (statement.includes('DELETE FROM mart.review_article_rollup')) {
                    recordDeleteEvent('rollup', statement)
                  }

                  if (statement.includes('DELETE FROM mart.prompt_answer_fact')) {
                    recordDeleteEvent('prompt', statement)
                  }

                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    recordDeleteEvent('scope', statement)
                  }

                  if (statement.includes('DELETE FROM app.review_answer_dictionary')) {
                    events.push('dictionary:purged')
                  }

                  if (statement.includes('DELETE FROM app.project_review_serving_generation')) {
                    events.push('generation:purged')
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?project-archive-batch=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.recoverQueuedArchivedProjectRefresh('project-archive-batch-test')
        console.log(JSON.stringify({events, queueActive}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Mart archived project purge regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]; queueActive: boolean}

  expect(result.events).toContain('serving-detail:batch-1')
  expect(result.events).toContain('serving-detail:batch-2')
  expect(result.events).toContain('serving:rewrite-created')
  expect(result.events).toContain('serving:rewrite-primary-key')
  expect(result.events).toContain('serving:rewrite-batch')
  expect(result.events).toContain('serving:rewrite-drop-old')
  expect(result.events).toContain('serving:rewrite-index')
  expect(result.events).toContain('serving:rewrite-swap')
  expect(result.events).toContain('rollup:batch-1')
  expect(result.events).toContain('rollup:batch-2')
  expect(result.events).toContain('scope:batch-1')
  expect(result.events).toContain('scope:batch-2')
  expect(result.events).toContain('dictionary:purged')
  expect(result.events).toContain('generation:purged')
  expect(result.queueActive).toBe(false)
})

test('mart refresh recovery splits non-serving archived purge batches after an index delete failure', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let queueActive = true
        let rollupBatchQueryCount = 0
        let failedLargeDelete = false
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
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? [{
                                articleId: null,
                                id: 'project-archive-split-task',
                                projectId: 'project-archive-split-test',
                                refreshGeneration: 0,
                                refreshScope: 'project',
                              }]
                            : []
                          : []
                },
                queryJsonBackground: async (statement) => {
                  return statement.includes('SELECT archived AS archived')
                    ? [{archived: true}]
                    : statement.includes('FROM mart.review_article_serving_detail') && statement.includes('rowid AS rowId')
                      ? []
                      : statement.includes('FROM mart.review_article_rollup') && statement.includes('rowid AS rowId')
                      ? (() => {
                          rollupBatchQueryCount += 1
                          return rollupBatchQueryCount === 1
                            ? Array.from({length: 10}, (_unused, index) => {
                                return {rowId: index + 1}
                              })
                            : []
                        })()
                      : []
                },
                run: async (statement) => {
                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (
                    statement.includes('DELETE FROM mart.review_article_rollup')
                  ) {
                    if (!failedLargeDelete && statement.includes('rowid IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)')) {
                      failedLargeDelete = true
                      throw new Error(
                        'Invalid Input Error: Failed to delete all rows from index. Only deleted 4 out of 10 rows.',
                      )
                    }

                    if (statement.includes('rowid IN (1, 2, 3, 4, 5)')) {
                      events.push('rollup:split-left')
                    }

                    if (statement.includes('rowid IN (6, 7, 8, 9, 10)')) {
                      events.push('rollup:split-right')
                    }
                  }

                  if (statement.includes('CREATE TABLE mart.review_article_serving_project_purge_rewrite')) {
                    events.push('serving:rewrite-created')
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?project-archive-split=' + Date.now())).getDuckdbMartRefreshService()
        const result = await martRefreshService.recoverQueuedArchivedProjectRefresh('project-archive-split-test').then(
          () => 'ok',
          (error) => error instanceof Error ? error.message : String(error),
        )
        console.log(JSON.stringify({events, failedLargeDelete, queueActive, result}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Mart archived purge split retry regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    events: string[]
    failedLargeDelete: boolean
    queueActive: boolean
    result: string
  }

  expect(result.failedLargeDelete).toBe(true)
  expect(result.events).toContain('rollup:split-left')
  expect(result.events).toContain('rollup:split-right')
  expect(result.events).toContain('serving:rewrite-created')
  expect(result.result).toBe('ok')
  expect(result.queueActive).toBe(false)
})

test('mart refresh recovery retries the same archived purge task after fatal invalidation without rollback or split retries', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let closeCount = 0
        let completedTaskCount = 0
        let queuedTaskReadCount = 0
        let queueActive = true
        let rollbackCount = 0
        let rollupBatchQueryCount = 0
        let shouldFailLargeDelete = true
        let splitRetryCount = 0

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                close: async () => {
                  closeCount += 1
                },
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? (() => {
                                queuedTaskReadCount += 1

                                return [{
                                  articleId: null,
                                  id: 'project-archive-fatal-task',
                                  projectId: 'project-archive-fatal-test',
                                  refreshGeneration: 0,
                                  refreshScope: 'project',
                                }]
                              })()
                            : []
                          : []
                },
                queryJsonBackground: async (statement) => {
                  return statement.includes('SELECT archived AS archived')
                    ? [{archived: true}]
                    : statement.includes('FROM mart.review_article_rollup') && statement.includes('rowid AS rowId')
                      ? (() => {
                          rollupBatchQueryCount += 1

                          return rollupBatchQueryCount <= 2
                            ? Array.from({length: 10}, (_unused, index) => {
                                return {rowId: index + 1}
                              })
                            : []
                        })()
                      : []
                },
                run: async (statement) => {
                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
                    completedTaskCount += 1
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (statement === 'ROLLBACK') {
                    rollbackCount += 1
                  }

                  if (
                    statement.includes('DELETE FROM mart.review_article_rollup')
                    && statement.includes('rowid IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)')
                    && shouldFailLargeDelete
                  ) {
                    shouldFailLargeDelete = false
                    throw new Error(
                      'FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again. Original error: "Invalid Input Error: Failed to delete all rows from index. Only deleted 4 out of 10 rows."',
                    )
                  }

                  if (
                    statement.includes('DELETE FROM mart.review_article_rollup')
                    && (
                      statement.includes('rowid IN (1, 2, 3, 4, 5)')
                      || statement.includes('rowid IN (6, 7, 8, 9, 10)')
                    )
                  ) {
                    splitRetryCount += 1
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?project-archive-fatal=' + Date.now())).getDuckdbMartRefreshService()
        const failureText = await martRefreshService.recoverQueuedArchivedProjectRefresh('project-archive-fatal-test').then(
          () => 'ok',
          (error) => error instanceof Error ? error.message : String(error),
        )
        const retryText = await martRefreshService.recoverQueuedArchivedProjectRefresh('project-archive-fatal-test').then(
          () => 'ok',
          (error) => error instanceof Error ? error.message : String(error),
        )
        console.log(JSON.stringify({
          closeCount,
          completedTaskCount,
          failureText,
          queuedTaskReadCount,
          queueActive,
          retryText,
          rollbackCount,
          splitRetryCount,
        }))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Mart archived purge fatal restart regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    closeCount: number
    completedTaskCount: number
    failureText: string
    queuedTaskReadCount: number
    queueActive: boolean
    retryText: string
    rollbackCount: number
    splitRetryCount: number
  }

  expect(result.closeCount).toBe(1)
  expect(result.completedTaskCount).toBe(1)
  expect(result.failureText).toContain('Failed to delete all rows from index')
  expect(result.failureText).not.toContain('rollback failed')
  expect(result.failureText).not.toContain('cannot rollback')
  expect(result.queuedTaskReadCount).toBe(2)
  expect(result.rollbackCount).toBe(0)
  expect(result.splitRetryCount).toBe(0)
  expect(result.retryText).toBe('ok')
  expect(result.queueActive).toBe(false)
})

test('mart refresh recovery completes archived purge without retrying the serving row delete path', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let queueActive = true
        let servingRewriteBatchQueryCount = 0
        let servingDeleteAttempted = false
        const statements = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? [{
                                articleId: null,
                                id: 'project-archive-single-row-task',
                                projectId: 'project-archive-single-row-test',
                                refreshGeneration: 0,
                                refreshScope: 'project',
                              }]
                            : []
                          : []
                },
                queryJsonBackground: async (statement) => {
                  return statement.includes('SELECT archived AS archived')
                    ? [{archived: true}]
                    : statement.includes('FROM mart.review_article_serving')
                      && !statement.includes('FROM mart.review_article_serving_detail')
                      && statement.includes('rowid AS rowId')
                      ? (() => {
                          servingRewriteBatchQueryCount += 1
                          return servingRewriteBatchQueryCount === 1 ? [{rowId: 1}] : []
                        })()
                    : []
                },
                run: async (statement) => {
                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (
                    statement.includes('DELETE FROM mart.review_article_serving')
                    && !statement.includes('DELETE FROM mart.review_article_serving_detail')
                    && statement.includes('rowid IN')
                  ) {
                    servingDeleteAttempted = true
                    throw new Error(
                      'FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again. Original error: "Invalid Input Error: Failed to delete all rows from index. Only deleted 4 out of 10 rows."',
                    )
                  }

                  statements.push(statement)
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?rewrite-serving=' + Date.now())).getDuckdbMartRefreshService()
        const result = await martRefreshService.recoverQueuedArchivedProjectRefresh('project-archive-single-row-test').then(
          () => 'ok',
          (error) => error instanceof Error ? error.message : String(error),
        )
        console.log(JSON.stringify({queueActive, result, servingDeleteAttempted, statements}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart serving rewrite purge regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    queueActive: boolean
    result: string
    servingDeleteAttempted: boolean
    statements: string[]
  }

  expect(
    result.statements.some((statement) => {
      return statement.includes('CREATE TABLE mart.review_article_serving_project_purge_rewrite')
    }),
  ).toBe(true)
  expect(
    result.statements.some((statement) => {
      return statement.includes('PRIMARY KEY(project_id, generation, article_id)')
    }),
  ).toBe(true)
  expect(
    result.statements.some((statement) => {
      return statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_review_article_serving_order')
    }),
  ).toBe(true)
  expect(
    result.statements.some((statement) => {
      return statement.includes('INSERT INTO mart.review_article_serving_project_purge_rewrite')
    }),
  ).toBe(true)
  expect(
    result.statements.some((statement) => {
      return (
        statement.includes('INSERT INTO mart.review_article_serving_project_purge_rewrite')
        && statement.includes('SELECT\n      project_id')
      )
    }),
  ).toBe(true)
  expect(
    result.statements.some((statement) => {
      return statement.includes('DELETE FROM mart.review_article_serving\n    WHERE rowid IN')
    }),
  ).toBe(false)
  expect(result.servingDeleteAttempted).toBe(false)
  expect(result.result).toBe('ok')
  expect(result.queueActive).toBe(false)
})

test('mart refresh recovery does not attempt rollback after archived serving rewrite commit failure', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let queueActive = true
        let rollbackCount = 0
        let servingRewriteBatchQueryCount = 0

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("column_name = 'refresh_generation'")
                    ? [{count: 1}]
                    : statement.includes("column_name = 'completed_at'")
                      ? [{count: 1}]
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? [{
                                articleId: null,
                                id: 'project-archive-commit-memory-task',
                                projectId: 'project-archive-commit-memory-test',
                                refreshGeneration: 0,
                                refreshScope: 'project',
                              }]
                            : []
                          : []
                },
                queryJsonBackground: async (statement) => {
                  return statement.includes('SELECT archived AS archived')
                    ? [{archived: true}]
                    : statement.includes('FROM mart.review_article_serving')
                      && !statement.includes('FROM mart.review_article_serving_detail')
                      && statement.includes('rowid AS rowId')
                      ? (() => {
                          servingRewriteBatchQueryCount += 1
                          return servingRewriteBatchQueryCount === 1 ? [{rowId: 1}] : []
                        })()
                      : []
                },
                run: async (statement) => {
                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (statement === 'ROLLBACK') {
                    rollbackCount += 1
                    throw new Error('TransactionContext Error: cannot rollback - no transaction is active')
                  }

                  if (statement.includes('INSERT INTO mart.review_article_serving_project_purge_rewrite')) {
                    throw new Error(
                      'TransactionContext Error: Failed to commit: failed to pin block of size 256.0 KiB (3.7 GiB/3.7 GiB used)',
                    )
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?rewrite-commit-failure=' + Date.now())).getDuckdbMartRefreshService()
        const failureText = await martRefreshService.recoverQueuedArchivedProjectRefresh('project-archive-commit-memory-test').then(
          () => 'ok',
          (error) => error instanceof Error ? error.message : String(error),
        )
        console.log(JSON.stringify({failureText, queueActive, rollbackCount}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Mart commit failure cleanup regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    failureText: string
    queueActive: boolean
    rollbackCount: number
  }

  expect(result.failureText).toContain('Failed to commit: failed to pin block')
  expect(result.failureText).not.toContain('rollback failed')
  expect(result.failureText).not.toContain('cannot rollback - no transaction is active')
  expect(result.rollbackCount).toBe(0)
  expect(result.queueActive).toBe(true)
})

test('mart refresh prunes known noop project rebuilds before draining', () => {
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
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: queueActive ? 1 : 0}]
                        : statement.includes('FROM app.mart_refresh_queue')
                          ? queueActive
                            ? [{
                                articleId: null,
                                id: 'project-known-noop-test',
                                projectId: 'project-known-noop-test',
                                refreshGeneration: 0,
                                refreshScope: 'project',
                              }]
                            : []
                          : []
                },
                run: async (statement) => {
                  if (statement.includes("reason IN ('humanAssessmentRoutesPostInit')")) {
                    events.push('cleanup:known-noop')
                    queueActive = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    events.push('refresh:project-scope')
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?known-noop=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.flush()
        console.log(JSON.stringify({events, queueActive}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart known noop prune regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]; queueActive: boolean}

  expect(result.events).toContain('cleanup:known-noop')
  expect(result.events).not.toContain('refresh:project-scope')
  expect(result.queueActive).toBe(false)
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
  expect(martRefreshService.getQueuedProjectTasksSqlForTests()).toContain('project.archived = FALSE')
})

test('mart refresh flush keeps article draining moving past archived project cleanup backlog', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        let articleQueueActive = true
        let projectRefreshAttempted = false
        let archivedProjectTaskStillQueued = true
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
                      : statement.includes('SELECT COUNT(*) AS count')
                        ? [{count: articleQueueActive ? 1 : 0}]
                        : statement.includes("refresh_scope = 'judgment_article'")
                          ? articleQueueActive
                            ? [{
                                articleId: 'article-drain-test',
                                id: 'article-drain-task',
                                projectId: null,
                                refreshGeneration: 0,
                                refreshScope: 'judgment_article',
                              }]
                            : []
                          : statement.includes("refresh_scope = 'project'")
                            ? statement.includes('project.archived = FALSE')
                              ? []
                              : archivedProjectTaskStillQueued
                                ? [{
                                    articleId: null,
                                    id: 'project-archive-task',
                                    projectId: 'project-archive-test',
                                    refreshGeneration: 0,
                                    refreshScope: 'project',
                                  }]
                                : []
                            : []
                },
                queryJsonBackground: async (statement) => {
                  if (statement.includes('SELECT archived AS archived')) {
                    projectRefreshAttempted = true
                    return [{archived: true}]
                  }

                  return []
                },
                run: async (statement) => {
                  if (statement.includes("WHERE id = 'article-drain-task'")) {
                    articleQueueActive = false
                  }

                  if (statement.includes("WHERE id = 'project-archive-task'")) {
                    archivedProjectTaskStillQueued = false
                  }
                },
                maintenance: async () => {},
                runBackground: async (statement) => {
                  if (statement.includes("'article-drain-test'")) {
                    events.push('article:refreshed')
                  }
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?archived-backlog=' + Date.now())).getDuckdbMartRefreshService()

        await martRefreshService.flush()
        console.log(JSON.stringify({archivedProjectTaskStillQueued, articleQueueActive, events, projectRefreshAttempted}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Mart refresh archived backlog regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    archivedProjectTaskStillQueued: boolean
    articleQueueActive: boolean
    events: string[]
    projectRefreshAttempted: boolean
  }

  expect(result.articleQueueActive).toBe(false)
  expect(result.archivedProjectTaskStillQueued).toBe(true)
  expect(result.projectRefreshAttempted).toBe(false)
  expect(result.events).toContain('article:refreshed')
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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

                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
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

test('mart refresh ensures review_article_rollup exists without rebuilding it before a project refresh', () => {
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
                  if (statement.includes('CREATE TABLE IF NOT EXISTS mart.review_article_rollup (')) {
                    events.push('rollup:ensure-table')
                  }

                  if (statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_review_article_rollup_project_id')) {
                    events.push('rollup:ensure-index')
                  }

                  if (
                    statement.includes('SET completed_at = NOW()')
                    && !statement.includes("reason IN ('humanAssessmentRoutesPostInit')")
                  ) {
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
        || 'Mart review_article_rollup ensure regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]; queueActive: boolean}

  expect(result.events).toContain('rollup:ensure-table')
  expect(result.events).toContain('rollup:ensure-index')
  expect(result.events).toContain('refresh:project-scope')
  expect(result.events.indexOf('rollup:ensure-table')).toBeLessThan(result.events.indexOf('refresh:project-scope'))
  expect(result.events).not.toContain('repair:drop-scratch')
  expect(result.events).not.toContain('repair:copy-existing')
  expect(result.events).not.toContain('repair:drop-live')
  expect(result.events).not.toContain('repair:restore-rows')
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
                    && statement.includes('temp_dirty_judgment_fact_article')
                    && statement.includes('article-background-rollback-test')
                  ) {
                    shouldFailBackgroundRefresh = false
                    return service.runBackground(\`
                      BEGIN TRANSACTION;
                      DROP TABLE mart.judgment_fact;
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
            project_id,
            snapshot_project_id,
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
            'project-serving-v3-test',
            'project-serving-v3-test',
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh repairs missing judgment facts during a full project refresh', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-stale-judgment-fact-${Date.now()}.duckdb`
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

        await database.run(
          "INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url) VALUES ('connection-stale-fact-refresh', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')"
        )
        await database.run(
          "INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('model-stale-fact-refresh', 'connection-stale-fact-refresh', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)"
        )
        await database.run(
          "INSERT INTO app.project (id, name, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images) VALUES ('project-stale-fact-refresh', 'Stale Fact Refresh Project', 'model-stale-fact-refresh', 'summary', TRUE, TRUE, FALSE, FALSE)"
        )
        await database.run(
          "INSERT INTO app.prompt (id, original_text, content_hash) VALUES ('prompt-stale-fact-refresh-1', 'Prompt one', 'hash-stale-fact-refresh-1'), ('prompt-stale-fact-refresh-2', 'Prompt two', 'hash-stale-fact-refresh-2')"
        )
        await database.run(
          "INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled) VALUES ('project-prompt-stale-fact-refresh-1', 'project-stale-fact-refresh', 'prompt-stale-fact-refresh-1', 0, TRUE), ('project-prompt-stale-fact-refresh-2', 'project-stale-fact-refresh', 'prompt-stale-fact-refresh-2', 1, TRUE)"
        )
        await database.run(
          "INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id) VALUES ('article-stale-fact-refresh', 'Stale Fact Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-stale-fact-refresh')"
        )
        await database.run(
          "INSERT INTO app.project_article (id, project_id, article_id) VALUES ('project-article-stale-fact-refresh', 'project-stale-fact-refresh', 'article-stale-fact-refresh')"
        )
        await database.run(
          "INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, snapshot_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original) VALUES ('judgment-stale-fact-refresh-1', 'article-stale-fact-refresh', 'prompt-stale-fact-refresh-1', 'model-stale-fact-refresh', 'project-stale-fact-refresh', 'project-stale-fact-refresh', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90), ('judgment-stale-fact-refresh-2', 'article-stale-fact-refresh', 'prompt-stale-fact-refresh-2', 'model-stale-fact-refresh', 'project-stale-fact-refresh', 'project-stale-fact-refresh', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 80)"
        )
        await database.run(
          "INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin) VALUES ('human-summary-stale-fact-refresh', 'project-stale-fact-refresh', 'article-stale-fact-refresh', 'no', 'manual_override')"
        )

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.refreshProject('project-stale-fact-refresh')

        const factRows = await database.queryJson(\`
          SELECT judgment_id AS judgmentId, prompt_id AS promptId
          FROM mart.judgment_fact
          WHERE article_id = 'article-stale-fact-refresh'
          ORDER BY prompt_id ASC
        \`)
        const servingRows = await database.queryJson(\`
          SELECT
            has_all_human_answers AS hasAllHumanAnswers,
            has_all_llm_judgments AS hasAllLlmJudgments,
            llm_judged_prompt_count AS llmJudgedPromptCount
          FROM mart.review_article_serving serving
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = serving.project_id
           AND generation.active_generation = serving.generation
          WHERE serving.project_id = 'project-stale-fact-refresh'
            AND serving.article_id = 'article-stale-fact-refresh'
        \`)
        const detailRows = await database.queryJson(\`
          SELECT judgment_id AS judgmentId, prompt_id AS promptId
          FROM mart.review_article_serving_detail detail
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = detail.project_id
           AND generation.active_generation = detail.generation
          WHERE detail.project_id = 'project-stale-fact-refresh'
            AND detail.article_id = 'article-stale-fact-refresh'
          ORDER BY prompt_id ASC
        \`)

        console.log(JSON.stringify({detailRows, factRows, servingRows}))
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
          || 'Mart stale judgment fact repair regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      detailRows: Array<{judgmentId: string; promptId: string}>
      factRows: Array<{judgmentId: string; promptId: string}>
      servingRows: Array<{hasAllHumanAnswers: boolean; hasAllLlmJudgments: boolean; llmJudgedPromptCount: number}>
    }

    expect(result.factRows).toEqual([
      {judgmentId: 'judgment-stale-fact-refresh-1', promptId: 'prompt-stale-fact-refresh-1'},
      {judgmentId: 'judgment-stale-fact-refresh-2', promptId: 'prompt-stale-fact-refresh-2'},
    ])
    expect(result.servingRows).toEqual([{hasAllHumanAnswers: true, hasAllLlmJudgments: true, llmJudgedPromptCount: 2}])
    expect(result.detailRows).toEqual([
      {judgmentId: 'judgment-stale-fact-refresh-1', promptId: 'prompt-stale-fact-refresh-1'},
      {judgmentId: 'judgment-stale-fact-refresh-2', promptId: 'prompt-stale-fact-refresh-2'},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh replaces dirty article facts while preserving shared and unrelated facts', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-dirty-judgment-facts-${Date.now()}.duckdb`
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
        const martRefreshService = getDuckdbMartRefreshService()

        await database.run(
          "INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url) VALUES ('connection-dirty-fact-preserve', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')"
        )
        await database.run(
          "INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('model-dirty-fact-preserve', 'connection-dirty-fact-preserve', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)"
        )
        await database.run(
          "INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images) VALUES ('project-dirty-fact-source', 'Dirty Fact Source', 'model-dirty-fact-preserve', TRUE, TRUE, FALSE, FALSE), ('project-dirty-fact-target', 'Dirty Fact Target', 'model-dirty-fact-preserve', TRUE, TRUE, FALSE, FALSE), ('project-dirty-fact-unrelated', 'Dirty Fact Unrelated', 'model-dirty-fact-preserve', TRUE, TRUE, FALSE, FALSE)"
        )
        await database.run(
          "INSERT INTO app.prompt (id, original_text, content_hash) VALUES ('prompt-dirty-fact-shared', 'Shared prompt', 'hash-dirty-fact-shared'), ('prompt-dirty-fact-stale', 'Stale prompt', 'hash-dirty-fact-stale'), ('prompt-dirty-fact-unrelated', 'Unrelated prompt', 'hash-dirty-fact-unrelated')"
        )
        await database.run(
          "INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled) VALUES ('project-prompt-dirty-fact-source', 'project-dirty-fact-source', 'prompt-dirty-fact-shared', 1, TRUE), ('project-prompt-dirty-fact-target', 'project-dirty-fact-target', 'prompt-dirty-fact-shared', 1, TRUE), ('project-prompt-dirty-fact-unrelated', 'project-dirty-fact-unrelated', 'prompt-dirty-fact-unrelated', 1, TRUE)"
        )
        await database.run(
          "INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id) VALUES ('article-dirty-fact-shared', 'Dirty Shared Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-dirty-shared'), ('article-dirty-fact-unrelated', 'Unrelated Article', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z', 'external-dirty-unrelated')"
        )
        await database.run(
          "INSERT INTO app.project_article (id, project_id, article_id) VALUES ('project-article-dirty-fact-source', 'project-dirty-fact-source', 'article-dirty-fact-shared'), ('project-article-dirty-fact-target', 'project-dirty-fact-target', 'article-dirty-fact-shared'), ('project-article-dirty-fact-unrelated', 'project-dirty-fact-unrelated', 'article-dirty-fact-unrelated')"
        )
        await database.run(
          "INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, snapshot_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, is_answered, answered_original, answered_original_as_array, confidence_original) VALUES ('judgment-dirty-fact-shared-source', 'article-dirty-fact-shared', 'prompt-dirty-fact-shared', 'model-dirty-fact-preserve', 'project-dirty-fact-source', 'project-dirty-fact-source', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90), ('judgment-dirty-fact-stale', 'article-dirty-fact-shared', 'prompt-dirty-fact-stale', 'model-dirty-fact-preserve', 'project-dirty-fact-source', 'project-dirty-fact-source', TRUE, TRUE, FALSE, FALSE, TRUE, 'stale', ['stale'], 50), ('judgment-dirty-fact-unrelated', 'article-dirty-fact-unrelated', 'prompt-dirty-fact-unrelated', 'model-dirty-fact-preserve', 'project-dirty-fact-unrelated', 'project-dirty-fact-unrelated', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 80)"
        )

        await martRefreshService.refreshJudgmentArticle('article-dirty-fact-shared')
        await martRefreshService.refreshJudgmentArticle('article-dirty-fact-unrelated')
        await database.run(
          "UPDATE app.judgment SET deleted_at = current_timestamp, delete_generation = 1 WHERE id = 'judgment-dirty-fact-stale'"
        )
        await martRefreshService.refreshJudgmentArticle('article-dirty-fact-shared')
        await martRefreshService.refreshProject('project-dirty-fact-target')

        const factRows = await database.queryJson(\`
          SELECT article_id AS articleId, judgment_id AS judgmentId
          FROM mart.judgment_fact
          WHERE article_id IN ('article-dirty-fact-shared', 'article-dirty-fact-unrelated')
          ORDER BY article_id ASC, judgment_id ASC
        \`)
        const targetAnswerRows = await database.queryJson(\`
          SELECT answer_value AS answerValue, judgment_id AS judgmentId
          FROM mart.prompt_answer_fact
          WHERE project_id = 'project-dirty-fact-target'
          ORDER BY judgment_id ASC
        \`)

        console.log(JSON.stringify({factRows, targetAnswerRows}))
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
          || 'Mart dirty judgment fact replacement regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      factRows: Array<{articleId: string; judgmentId: string}>
      targetAnswerRows: Array<{answerValue: string; judgmentId: string}>
    }

    expect(result.factRows).toEqual([
      {articleId: 'article-dirty-fact-shared', judgmentId: 'judgment-dirty-fact-shared-source'},
      {articleId: 'article-dirty-fact-unrelated', judgmentId: 'judgment-dirty-fact-unrelated'},
    ])
    expect(result.targetAnswerRows).toEqual([{answerValue: 'yes', judgmentId: 'judgment-dirty-fact-shared-source'}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
            project_id,
            snapshot_project_id,
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
            'project-serving-incremental-test',
            'project-serving-incremental-test',
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh updates prompt facts and rollups for the same dirty article batch without renumbering dictionary ids', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-dirty-answer-batch-${Date.now()}.duckdb`
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
        const martRefreshService = getDuckdbMartRefreshService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-dirty-answer-batch', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-dirty-answer-batch', 'connection-dirty-answer-batch', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-dirty-answer-batch', 'Dirty Answer Batch Project', 'model-dirty-answer-batch', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-dirty-answer-batch', 'Prompt body', 'hash-dirty-answer-batch')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-dirty-answer-batch', 'project-dirty-answer-batch', 'prompt-dirty-answer-batch', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES
            ('article-dirty-answer-a', 'Dirty Answer A', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-dirty-answer-a'),
            ('article-dirty-answer-b', 'Dirty Answer B', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z', 'external-dirty-answer-b'),
            ('article-dirty-answer-clean', 'Dirty Answer Clean', TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T01:00:00.000Z', 'external-dirty-answer-clean')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES
            ('project-article-dirty-answer-a', 'project-dirty-answer-batch', 'article-dirty-answer-a'),
            ('project-article-dirty-answer-b', 'project-dirty-answer-batch', 'article-dirty-answer-b'),
            ('project-article-dirty-answer-clean', 'project-dirty-answer-batch', 'article-dirty-answer-clean')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES
            ('judgment-dirty-answer-a', 'article-dirty-answer-a', 'prompt-dirty-answer-batch', 'model-dirty-answer-batch', 'project-dirty-answer-batch', 'project-dirty-answer-batch', TRUE, TRUE, FALSE, FALSE, TRUE, 'maybe', ['maybe'], 90),
            ('judgment-dirty-answer-b', 'article-dirty-answer-b', 'prompt-dirty-answer-batch', 'model-dirty-answer-batch', 'project-dirty-answer-batch', 'project-dirty-answer-batch', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90),
            ('judgment-dirty-answer-clean', 'article-dirty-answer-clean', 'prompt-dirty-answer-batch', 'model-dirty-answer-batch', 'project-dirty-answer-batch', 'project-dirty-answer-batch', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 90)
        \`)

        await martRefreshService.queueProjectRefresh('project-dirty-answer-batch', 'dirty-answer-batch-initial')
        await martRefreshService.flush()

        const initialDictionaryRows = await database.queryJson(\`
          SELECT answer_value AS answerValue, CAST(answer_id AS INTEGER) AS answerId
          FROM app.review_answer_dictionary
          WHERE project_id = 'project-dirty-answer-batch'
            AND prompt_id = 'prompt-dirty-answer-batch'
          ORDER BY answer_id ASC
        \`)

        await database.run(\`
          UPDATE app.judgment
          SET answered_original = 'aaa',
              answered_original_as_array = ['aaa'],
              updated_at = current_timestamp
          WHERE id = 'judgment-dirty-answer-a'
        \`)
        await database.run(\`
          UPDATE app.judgment
          SET answered_original = 'zzz',
              answered_original_as_array = ['zzz'],
              updated_at = current_timestamp
          WHERE id = 'judgment-dirty-answer-b'
        \`)

        await martRefreshService.refreshJudgmentArticle('article-dirty-answer-a')
        await martRefreshService.refreshJudgmentArticle('article-dirty-answer-b')
        await martRefreshService.refreshProjectArticleServingForArticles('project-dirty-answer-batch', [
          'article-dirty-answer-a',
          'article-dirty-answer-b',
        ])

        const promptRows = await database.queryJson(\`
          SELECT article_id AS articleId, answer_value AS answerValue
          FROM mart.prompt_answer_fact
          WHERE project_id = 'project-dirty-answer-batch'
          ORDER BY article_id ASC, answer_value ASC
        \`)
        const rollupRows = await database.queryJson(\`
          SELECT
            rollup.article_id AS articleId,
            fact.answer_value AS answerValue,
            CAST(rollup.llm_judged_prompt_count AS INTEGER) AS llmJudgedPromptCount,
            rollup.has_all_llm_judgments AS hasAllLlmJudgments
          FROM mart.review_article_rollup rollup
          LEFT JOIN mart.prompt_answer_fact fact
            ON fact.project_id = rollup.project_id
           AND fact.article_id = rollup.article_id
          WHERE rollup.project_id = 'project-dirty-answer-batch'
          ORDER BY rollup.article_id ASC, fact.answer_value ASC
        \`)
        const activeFilterRows = await database.queryJson(\`
          SELECT member.article_id AS articleId, dictionary.answer_value AS answerValue, CAST(dictionary.answer_id AS INTEGER) AS answerId
          FROM mart.review_article_filter_member member
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = member.project_id
           AND generation.active_generation = member.generation
          INNER JOIN app.review_answer_dictionary dictionary
            ON dictionary.project_id = member.project_id
           AND dictionary.prompt_id = member.prompt_id
           AND dictionary.answer_id = member.answer_id
          WHERE member.project_id = 'project-dirty-answer-batch'
          ORDER BY member.article_id ASC, dictionary.answer_value ASC
        \`)
        const dictionaryRows = await database.queryJson(\`
          SELECT answer_value AS answerValue, CAST(answer_id AS INTEGER) AS answerId
          FROM app.review_answer_dictionary
          WHERE project_id = 'project-dirty-answer-batch'
            AND prompt_id = 'prompt-dirty-answer-batch'
          ORDER BY answer_id ASC
        \`)

        console.log(JSON.stringify({
          activeFilterRows,
          dictionaryRows,
          initialDictionaryRows,
          promptRows,
          rollupRows,
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
          || 'Mart dirty answer batch refresh regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      activeFilterRows: Array<{answerId: number; answerValue: string; articleId: string}>
      dictionaryRows: Array<{answerId: number; answerValue: string}>
      initialDictionaryRows: Array<{answerId: number; answerValue: string}>
      promptRows: Array<{answerValue: string; articleId: string}>
      rollupRows: Array<{
        answerValue: string
        articleId: string
        hasAllLlmJudgments: boolean
        llmJudgedPromptCount: number
      }>
    }

    expect(result.initialDictionaryRows).toEqual([
      {answerId: 1, answerValue: 'maybe'},
      {answerId: 2, answerValue: 'no'},
      {answerId: 3, answerValue: 'yes'},
    ])
    expect(result.dictionaryRows).toEqual([
      {answerId: 1, answerValue: 'maybe'},
      {answerId: 2, answerValue: 'no'},
      {answerId: 3, answerValue: 'yes'},
      {answerId: 4, answerValue: 'aaa'},
      {answerId: 5, answerValue: 'zzz'},
    ])
    expect(result.promptRows).toEqual([
      {answerValue: 'aaa', articleId: 'article-dirty-answer-a'},
      {answerValue: 'zzz', articleId: 'article-dirty-answer-b'},
      {answerValue: 'no', articleId: 'article-dirty-answer-clean'},
    ])
    expect(result.rollupRows).toEqual([
      {answerValue: 'aaa', articleId: 'article-dirty-answer-a', hasAllLlmJudgments: true, llmJudgedPromptCount: 1},
      {answerValue: 'zzz', articleId: 'article-dirty-answer-b', hasAllLlmJudgments: true, llmJudgedPromptCount: 1},
      {answerValue: 'no', articleId: 'article-dirty-answer-clean', hasAllLlmJudgments: true, llmJudgedPromptCount: 1},
    ])
    expect(result.activeFilterRows).toEqual([
      {answerId: 4, answerValue: 'aaa', articleId: 'article-dirty-answer-a'},
      {answerId: 5, answerValue: 'zzz', articleId: 'article-dirty-answer-b'},
      {answerId: 2, answerValue: 'no', articleId: 'article-dirty-answer-clean'},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh maintains project scope article deltas before downstream dirty article refreshes', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-scope-deltas-${Date.now()}.duckdb`
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
        const martRefreshService = getDuckdbMartRefreshService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-scope-delta-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-scope-delta-test', 'connection-scope-delta-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES
            ('project-scope-delta-target', 'Scope Delta Target', 'model-scope-delta-test', TRUE, TRUE, FALSE, FALSE),
            ('project-scope-delta-other', 'Scope Delta Other', 'model-scope-delta-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-scope-delta-test', 'Prompt body', 'hash-scope-delta-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES
            ('project-prompt-scope-delta-target', 'project-scope-delta-target', 'prompt-scope-delta-test', 1, TRUE),
            ('project-prompt-scope-delta-other', 'project-scope-delta-other', 'prompt-scope-delta-test', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES
            ('article-scope-delta-retained', 'Scope Delta Retained', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-scope-delta-retained'),
            ('article-scope-delta-added', 'Scope Delta Added', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z', 'external-scope-delta-added'),
            ('article-scope-delta-removed', 'Scope Delta Removed', TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T01:00:00.000Z', 'external-scope-delta-removed'),
            ('article-scope-delta-other', 'Scope Delta Other', TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z', 'external-scope-delta-other')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES
            ('project-article-scope-delta-target-retained', 'project-scope-delta-target', 'article-scope-delta-retained'),
            ('project-article-scope-delta-target-removed', 'project-scope-delta-target', 'article-scope-delta-removed'),
            ('project-article-scope-delta-other-removed', 'project-scope-delta-other', 'article-scope-delta-removed'),
            ('project-article-scope-delta-other-other', 'project-scope-delta-other', 'article-scope-delta-other')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES
            ('judgment-scope-delta-retained', 'article-scope-delta-retained', 'prompt-scope-delta-test', 'model-scope-delta-test', 'project-scope-delta-target', 'project-scope-delta-target', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90),
            ('judgment-scope-delta-added', 'article-scope-delta-added', 'prompt-scope-delta-test', 'model-scope-delta-test', 'project-scope-delta-target', 'project-scope-delta-target', TRUE, TRUE, FALSE, FALSE, TRUE, 'maybe', ['maybe'], 80),
            ('judgment-scope-delta-removed', 'article-scope-delta-removed', 'prompt-scope-delta-test', 'model-scope-delta-test', 'project-scope-delta-other', 'project-scope-delta-other', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 70),
            ('judgment-scope-delta-other', 'article-scope-delta-other', 'prompt-scope-delta-test', 'model-scope-delta-test', 'project-scope-delta-other', 'project-scope-delta-other', TRUE, TRUE, FALSE, FALSE, TRUE, 'other', ['other'], 60)
        \`)

        await martRefreshService.refreshJudgmentArticle('article-scope-delta-retained')
        await martRefreshService.refreshJudgmentArticle('article-scope-delta-added')
        await martRefreshService.refreshJudgmentArticle('article-scope-delta-removed')
        await martRefreshService.refreshJudgmentArticle('article-scope-delta-other')
        await martRefreshService.refreshProject('project-scope-delta-target')
        await martRefreshService.refreshProject('project-scope-delta-other')

        await database.run(\`
          UPDATE app.article
          SET article_updated_at = TIMESTAMPTZ '2026-04-05T05:00:00.000Z'
          WHERE id = 'article-scope-delta-retained'
        \`)
        await database.run(\`
          DELETE FROM app.project_article
          WHERE project_id = 'project-scope-delta-target'
            AND article_id = 'article-scope-delta-removed'
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-scope-delta-target-added', 'project-scope-delta-target', 'article-scope-delta-added')
        \`)

        await martRefreshService.refreshProjectScopeArticles('project-scope-delta-target', [
          'article-scope-delta-retained',
          'article-scope-delta-added',
          'article-scope-delta-removed',
        ])
        await martRefreshService.refreshJudgmentArticle('article-scope-delta-retained')
        await martRefreshService.refreshJudgmentArticle('article-scope-delta-added')
        await martRefreshService.refreshProjectArticleServing('project-scope-delta-target', 'article-scope-delta-retained')
        await martRefreshService.refreshProjectArticleServing('project-scope-delta-target', 'article-scope-delta-added')
        await martRefreshService.refreshProjectArticleServing('project-scope-delta-target', 'article-scope-delta-removed')

        const targetScopeRows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            CAST(article_updated_at AS VARCHAR) AS articleUpdatedAt,
            in_curated_scope AS inCuratedScope
          FROM mart.project_scope_article
          WHERE project_id = 'project-scope-delta-target'
          ORDER BY article_id ASC
        \`)
        const targetPromptRows = await database.queryJson(\`
          SELECT article_id AS articleId, answer_value AS answerValue
          FROM mart.prompt_answer_fact
          WHERE project_id = 'project-scope-delta-target'
          ORDER BY article_id ASC
        \`)
        const activeServingRows = await database.queryJson(\`
          SELECT serving.article_id AS articleId, CAST(serving.article_updated_at AS VARCHAR) AS articleUpdatedAt
          FROM mart.review_article_serving serving
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = serving.project_id
           AND generation.active_generation = serving.generation
          WHERE serving.project_id = 'project-scope-delta-target'
          ORDER BY serving.article_id ASC
        \`)
        const activeFilterRows = await database.queryJson(\`
          SELECT member.article_id AS articleId
          FROM mart.review_article_filter_member member
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = member.project_id
           AND generation.active_generation = member.generation
          WHERE member.project_id = 'project-scope-delta-target'
          ORDER BY member.article_id ASC
        \`)
        const activeDetailRows = await database.queryJson(\`
          SELECT detail.article_id AS articleId
          FROM mart.review_article_serving_detail detail
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = detail.project_id
           AND generation.active_generation = detail.generation
          WHERE detail.project_id = 'project-scope-delta-target'
          ORDER BY detail.article_id ASC
        \`)
        const otherRows = await database.queryJson(\`
          SELECT 'prompt' AS tableName, article_id AS articleId
          FROM mart.prompt_answer_fact
          WHERE project_id = 'project-scope-delta-other'
          UNION ALL
          SELECT 'serving' AS tableName, serving.article_id AS articleId
          FROM mart.review_article_serving serving
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = serving.project_id
           AND generation.active_generation = serving.generation
          WHERE serving.project_id = 'project-scope-delta-other'
          ORDER BY tableName ASC, articleId ASC
        \`)

        console.log(JSON.stringify({
          activeDetailRows,
          activeFilterRows,
          activeServingRows,
          otherRows,
          targetPromptRows,
          targetScopeRows,
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart scope delta refresh test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      activeDetailRows: Array<{articleId: string}>
      activeFilterRows: Array<{articleId: string}>
      activeServingRows: Array<{articleId: string; articleUpdatedAt: string}>
      otherRows: Array<{articleId: string; tableName: string}>
      targetPromptRows: Array<{answerValue: string; articleId: string}>
      targetScopeRows: Array<{articleId: string; articleUpdatedAt: string; inCuratedScope: boolean}>
    }

    expect(
      result.targetScopeRows.map((row) => {
        return row.articleId
      }),
    ).toEqual(['article-scope-delta-added', 'article-scope-delta-retained'])
    expect(result.targetScopeRows[1]?.articleUpdatedAt).toContain('2026-04-05')
    expect(result.targetPromptRows).toEqual([
      {answerValue: 'maybe', articleId: 'article-scope-delta-added'},
      {answerValue: 'yes', articleId: 'article-scope-delta-retained'},
    ])
    expect(
      result.activeServingRows.map((row) => {
        return row.articleId
      }),
    ).toEqual(['article-scope-delta-added', 'article-scope-delta-retained'])
    expect(result.activeServingRows[1]?.articleUpdatedAt).toContain('2026-04-05')
    expect(result.activeFilterRows).toEqual([
      {articleId: 'article-scope-delta-added'},
      {articleId: 'article-scope-delta-retained'},
    ])
    expect(result.activeDetailRows).toEqual([
      {articleId: 'article-scope-delta-added'},
      {articleId: 'article-scope-delta-retained'},
    ])
    expect(result.otherRows).toEqual([
      {articleId: 'article-scope-delta-other', tableName: 'prompt'},
      {articleId: 'article-scope-delta-removed', tableName: 'prompt'},
      {articleId: 'article-scope-delta-other', tableName: 'serving'},
      {articleId: 'article-scope-delta-removed', tableName: 'serving'},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh computes summary-mode human completeness from summary judgments', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-summary-human-${Date.now()}.duckdb`
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
          VALUES ('connection-summary-human-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-summary-human-test', 'connection-summary-human-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (
            id,
            name,
            model_id,
            human_judgment_mode,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images
          )
          VALUES ('project-summary-human-test', 'Summary Human Project', 'model-summary-human-test', 'summary', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES
            ('prompt-summary-human-1', 'Prompt one', 'hash-summary-human-1'),
            ('prompt-summary-human-2', 'Prompt two', 'hash-summary-human-2')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition)
          VALUES
            ('project-prompt-summary-human-1', 'project-summary-human-test', 'prompt-summary-human-1', 0, TRUE, 'include'),
            ('project-prompt-summary-human-2', 'project-summary-human-test', 'prompt-summary-human-2', 1, TRUE, 'exclude')
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES
            ('article-summary-human-complete', 'Complete summary article'),
            ('article-summary-human-missing', 'Missing summary article')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES
            ('project-article-summary-human-complete', 'project-summary-human-test', 'article-summary-human-complete'),
            ('project-article-summary-human-missing', 'project-summary-human-test', 'article-summary-human-missing')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original
          )
          VALUES
            ('judgment-summary-human-complete-1', 'article-summary-human-complete', 'prompt-summary-human-1', 'model-summary-human-test', 'project-summary-human-test', 'project-summary-human-test', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90),
            ('judgment-summary-human-complete-2', 'article-summary-human-complete', 'prompt-summary-human-2', 'model-summary-human-test', 'project-summary-human-test', 'project-summary-human-test', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 90),
            ('judgment-summary-human-missing-1', 'article-summary-human-missing', 'prompt-summary-human-1', 'model-summary-human-test', 'project-summary-human-test', 'project-summary-human-test', TRUE, TRUE, FALSE, FALSE, TRUE, 'yes', ['yes'], 90),
            ('judgment-summary-human-missing-2', 'article-summary-human-missing', 'prompt-summary-human-2', 'model-summary-human-test', 'project-summary-human-test', 'project-summary-human-test', TRUE, TRUE, FALSE, FALSE, TRUE, 'no', ['no'], 90)
        \`)
        await database.run(\`
          INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
          VALUES ('human-summary-complete', 'project-summary-human-test', 'article-summary-human-complete', 'no', 'manual_override')
        \`)

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-summary-human-test', 'summary-human-test')
        await martRefreshService.flush()

        const rollupRows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            enabled_prompt_count AS enabledPromptCount,
            human_answered_prompt_count AS humanAnsweredPromptCount,
            has_all_human_answers AS hasAllHumanAnswers
          FROM mart.review_article_rollup
          WHERE project_id = 'project-summary-human-test'
          ORDER BY article_id ASC
        \`)

        console.log(JSON.stringify({rollupRows}))
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
          || 'Mart summary-mode human completeness regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      rollupRows: Array<{
        articleId: string
        enabledPromptCount: number
        humanAnsweredPromptCount: number
        hasAllHumanAnswers: boolean
      }>
    }

    expect(result.rollupRows).toEqual([
      {
        articleId: 'article-summary-human-complete',
        enabledPromptCount: 2,
        humanAnsweredPromptCount: 1,
        hasAllHumanAnswers: true,
      },
      {
        articleId: 'article-summary-human-missing',
        enabledPromptCount: 2,
        humanAnsweredPromptCount: 0,
        hasAllHumanAnswers: false,
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh reuses shared judgments across projects with matching prompt and config', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-project-scoped-judgments-${Date.now()}.duckdb`
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
          VALUES ('connection-project-scoped-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES (
            'model-project-scoped-test',
            'connection-project-scoped-test',
            'Qwen/Qwen3.5-35B-A3B',
            'Qwen/Qwen3.5-35B-A3B',
            'Qwen 35B',
            'manual',
            TRUE
          )
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES (
            'project-cross-project-target',
            'Cross Project Target',
            'model-project-scoped-test',
            TRUE,
            TRUE,
            FALSE,
            FALSE
          )
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES (
            'project-cross-project-source',
            'Cross Project Source',
            'model-project-scoped-test',
            TRUE,
            TRUE,
            FALSE,
            FALSE
          )
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-cross-project-test', 'Prompt body', 'hash-cross-project-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES
            ('project-prompt-cross-project-target', 'project-cross-project-target', 'prompt-cross-project-test', 1, TRUE),
            ('project-prompt-cross-project-source', 'project-cross-project-source', 'prompt-cross-project-test', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES (
            'article-cross-project-test',
            'Cross Project Article',
            '2024-01-02T00:00:00.000Z',
            '2024-01-03T00:00:00.000Z',
            'external-cross-project-test'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES
            ('project-article-cross-project-target', 'project-cross-project-target', 'article-cross-project-test'),
            ('project-article-cross-project-source', 'project-cross-project-source', 'article-cross-project-test')
        \`)

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-cross-project-target', 'project-scope-init')
        await martRefreshService.flush()

        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
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
            'judgment-cross-project-source',
            'article-cross-project-test',
            'prompt-cross-project-test',
            'model-project-scoped-test',
            'project-cross-project-source',
            'project-cross-project-source',
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

        await martRefreshService.queueJudgmentArticleRefresh('article-cross-project-test', 'cross-project-judgment')
        await martRefreshService.flush()

        await martRefreshService.queueProjectRefresh('project-cross-project-target', 'project-scope-rebuild')
        await martRefreshService.flush()

        const [counts] = await database.queryJson(\`
          SELECT
            (SELECT active_generation FROM app.project_review_serving_generation WHERE project_id = 'project-cross-project-target') AS targetActiveGeneration,
            (SELECT COUNT(*) FROM mart.prompt_answer_fact WHERE project_id = 'project-cross-project-target') AS targetPromptAnswerCount,
            (SELECT COUNT(*) FROM mart.review_article_filter_member WHERE project_id = 'project-cross-project-target') AS targetFilterCount,
            (
              SELECT COUNT(*)
              FROM mart.review_article_serving
              WHERE project_id = 'project-cross-project-target'
                AND COALESCE(llm_judged_prompt_count, 0) > 0
            ) AS targetReviewedServingCount,
            (SELECT COUNT(*) FROM mart.review_article_serving_detail WHERE project_id = 'project-cross-project-target') AS targetDetailCount,
            (SELECT active_generation FROM app.project_review_serving_generation WHERE project_id = 'project-cross-project-source') AS sourceActiveGeneration,
            (SELECT COUNT(*) FROM mart.prompt_answer_fact WHERE project_id = 'project-cross-project-source') AS sourcePromptAnswerCount,
            (SELECT COUNT(*) FROM mart.review_article_filter_member WHERE project_id = 'project-cross-project-source') AS sourceFilterCount,
            (
              SELECT COUNT(*)
              FROM mart.review_article_serving
              WHERE project_id = 'project-cross-project-source'
                AND COALESCE(llm_judged_prompt_count, 0) > 0
            ) AS sourceReviewedServingCount,
            (SELECT COUNT(*) FROM mart.review_article_serving_detail WHERE project_id = 'project-cross-project-source') AS sourceDetailCount
        \`)

        console.log(JSON.stringify({
          sourceActiveGeneration: Number(counts?.sourceActiveGeneration ?? 0),
          sourceDetailCount: Number(counts?.sourceDetailCount ?? 0),
          sourceFilterCount: Number(counts?.sourceFilterCount ?? 0),
          sourcePromptAnswerCount: Number(counts?.sourcePromptAnswerCount ?? 0),
          sourceReviewedServingCount: Number(counts?.sourceReviewedServingCount ?? 0),
          targetActiveGeneration: Number(counts?.targetActiveGeneration ?? 0),
          targetDetailCount: Number(counts?.targetDetailCount ?? 0),
          targetFilterCount: Number(counts?.targetFilterCount ?? 0),
          targetPromptAnswerCount: Number(counts?.targetPromptAnswerCount ?? 0),
          targetReviewedServingCount: Number(counts?.targetReviewedServingCount ?? 0),
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
          || 'Mart shared judgment reuse regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      sourceActiveGeneration: number
      sourceDetailCount: number
      sourceFilterCount: number
      sourcePromptAnswerCount: number
      sourceReviewedServingCount: number
      targetActiveGeneration: number
      targetDetailCount: number
      targetFilterCount: number
      targetPromptAnswerCount: number
      targetReviewedServingCount: number
    }

    expect(result.targetActiveGeneration).toBe(2)
    expect(result.targetPromptAnswerCount).toBe(1)
    expect(result.targetFilterCount).toBeGreaterThan(0)
    expect(result.targetReviewedServingCount).toBeGreaterThan(0)
    expect(result.targetDetailCount).toBeGreaterThan(0)
    expect(result.sourceActiveGeneration).toBe(1)
    expect(result.sourcePromptAnswerCount).toBe(1)
    expect(result.sourceFilterCount).toBe(1)
    expect(result.sourceReviewedServingCount).toBe(1)
    expect(result.sourceDetailCount).toBe(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh drops reused source judgments after a cloned project repoints to a new prompt id', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-prompt-edit-isolation-${Date.now()}.duckdb`
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
        const martRefreshService = getDuckdbMartRefreshService()

        const getActiveDetailRows = async (projectId) => {
          return database.queryJson(\`
            SELECT detail.article_id AS articleId, detail.judgment_id AS judgmentId, detail.prompt_id AS promptId
            FROM mart.review_article_serving_detail detail
            INNER JOIN app.project_review_serving_generation generation
              ON generation.project_id = detail.project_id
             AND generation.active_generation = detail.generation
            WHERE detail.project_id = '\${projectId}'
            ORDER BY detail.prompt_id ASC, detail.article_id ASC
          \`)
        }

        const getPromptAnswerRows = async (projectId) => {
          return database.queryJson(\`
            SELECT article_id AS articleId, judgment_id AS judgmentId, prompt_id AS promptId
            FROM mart.prompt_answer_fact
            WHERE project_id = '\${projectId}'
            ORDER BY prompt_id ASC, article_id ASC
          \`)
        }

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-prompt-edit-isolation', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES (
            'model-prompt-edit-isolation',
            'connection-prompt-edit-isolation',
            'Qwen/Qwen3.5-35B-A3B',
            'Qwen/Qwen3.5-35B-A3B',
            'Qwen 35B',
            'manual',
            TRUE
          )
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES
            ('project-prompt-edit-isolation-target', 'Prompt Edit Isolation Target', 'model-prompt-edit-isolation', TRUE, TRUE, FALSE, FALSE),
            ('project-prompt-edit-isolation-source', 'Prompt Edit Isolation Source', 'model-prompt-edit-isolation', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES
            ('prompt-prompt-edit-isolation-shared', 'Shared prompt body', 'hash-prompt-edit-isolation-shared'),
            ('prompt-prompt-edit-isolation-edited', 'Edited prompt body', 'hash-prompt-edit-isolation-edited')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES
            ('project-prompt-prompt-edit-isolation-target', 'project-prompt-edit-isolation-target', 'prompt-prompt-edit-isolation-shared', 1, TRUE),
            ('project-prompt-prompt-edit-isolation-source', 'project-prompt-edit-isolation-source', 'prompt-prompt-edit-isolation-shared', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES (
            'article-prompt-edit-isolation',
            'Prompt edit isolation article',
            '2024-01-02T00:00:00.000Z',
            '2024-01-03T00:00:00.000Z',
            'external-prompt-edit-isolation'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES
            ('project-article-prompt-edit-isolation-target', 'project-prompt-edit-isolation-target', 'article-prompt-edit-isolation'),
            ('project-article-prompt-edit-isolation-source', 'project-prompt-edit-isolation-source', 'article-prompt-edit-isolation')
        \`)
        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
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
            'judgment-prompt-edit-isolation-source',
            'article-prompt-edit-isolation',
            'prompt-prompt-edit-isolation-shared',
            'model-prompt-edit-isolation',
            'project-prompt-edit-isolation-source',
            'project-prompt-edit-isolation-source',
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

        await martRefreshService.queueJudgmentArticleRefresh('article-prompt-edit-isolation', 'prompt-edit-isolation-source-judgment')
        await martRefreshService.queueProjectRefresh('project-prompt-edit-isolation-source', 'prompt-edit-isolation-source-initial')
        await martRefreshService.queueProjectRefresh('project-prompt-edit-isolation-target', 'prompt-edit-isolation-target-initial')
        await martRefreshService.flush()

        const beforeEditSourceDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-source')
        const beforeEditTargetDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-target')

        await database.run(\`
          UPDATE app.project_prompt
          SET prompt_id = 'prompt-prompt-edit-isolation-edited'
          WHERE project_id = 'project-prompt-edit-isolation-target'
        \`)

        await martRefreshService.queueProjectRefresh('project-prompt-edit-isolation-target', 'prompt-edit-isolation-target-repointed')
        await martRefreshService.flush()

        const afterEditSourceDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-source')
        const afterEditTargetDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-target')
        const afterEditTargetPromptAnswerRows = await getPromptAnswerRows('project-prompt-edit-isolation-target')

        await database.run(\`
          INSERT INTO app.judgment (
            id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
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
            'judgment-prompt-edit-isolation-target',
            'article-prompt-edit-isolation',
            'prompt-prompt-edit-isolation-edited',
            'model-prompt-edit-isolation',
            'project-prompt-edit-isolation-target',
            'project-prompt-edit-isolation-target',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            TRUE,
            'no',
            ['no'],
            89
          )
        \`)

        await martRefreshService.queueJudgmentArticleRefresh('article-prompt-edit-isolation', 'prompt-edit-isolation-target-judgment')
        await martRefreshService.queueProjectRefresh('project-prompt-edit-isolation-target', 'prompt-edit-isolation-target-rerun')
        await martRefreshService.flush()

        const afterRerunSourceDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-source')
        const afterRerunTargetDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-target')
        const afterRerunTargetPromptAnswerRows = await getPromptAnswerRows('project-prompt-edit-isolation-target')

        console.log(JSON.stringify({
          afterEditSourceDetailRows,
          afterEditTargetDetailRows,
          afterEditTargetPromptAnswerRows,
          afterRerunSourceDetailRows,
          afterRerunTargetDetailRows,
          afterRerunTargetPromptAnswerRows,
          beforeEditSourceDetailRows,
          beforeEditTargetDetailRows,
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
          || 'Mart prompt edit isolation regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      afterEditSourceDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      afterEditTargetDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      afterEditTargetPromptAnswerRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      afterRerunSourceDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      afterRerunTargetDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      afterRerunTargetPromptAnswerRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      beforeEditSourceDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
      beforeEditTargetDetailRows: Array<{articleId: string; judgmentId: string; promptId: string}>
    }

    expect(result.beforeEditSourceDetailRows).toEqual([
      {
        articleId: 'article-prompt-edit-isolation',
        judgmentId: 'judgment-prompt-edit-isolation-source',
        promptId: 'prompt-prompt-edit-isolation-shared',
      },
    ])
    expect(result.beforeEditTargetDetailRows).toEqual([
      {
        articleId: 'article-prompt-edit-isolation',
        judgmentId: 'judgment-prompt-edit-isolation-source',
        promptId: 'prompt-prompt-edit-isolation-shared',
      },
    ])
    expect(result.afterEditSourceDetailRows).toEqual([
      {
        articleId: 'article-prompt-edit-isolation',
        judgmentId: 'judgment-prompt-edit-isolation-source',
        promptId: 'prompt-prompt-edit-isolation-shared',
      },
    ])
    expect(result.afterEditTargetDetailRows).toEqual([])
    expect(result.afterEditTargetPromptAnswerRows).toEqual([])
    expect(result.afterRerunSourceDetailRows).toEqual([
      {
        articleId: 'article-prompt-edit-isolation',
        judgmentId: 'judgment-prompt-edit-isolation-source',
        promptId: 'prompt-prompt-edit-isolation-shared',
      },
    ])
    expect(result.afterRerunTargetDetailRows).toEqual([
      {
        articleId: 'article-prompt-edit-isolation',
        judgmentId: 'judgment-prompt-edit-isolation-target',
        promptId: 'prompt-prompt-edit-isolation-edited',
      },
    ])
    expect(result.afterRerunTargetPromptAnswerRows).toEqual([
      {
        articleId: 'article-prompt-edit-isolation',
        judgmentId: 'judgment-prompt-edit-isolation-target',
        promptId: 'prompt-prompt-edit-isolation-edited',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('mart refresh deduplicates an article that is both curated and import-routed in one project', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-shared-scope-${Date.now()}.duckdb`
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
          VALUES ('connection-shared-scope-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-shared-scope-test', 'connection-shared-scope-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-shared-scope-test', 'Shared Scope Project', 'model-shared-scope-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-shared-scope-test', 'shared-scope:test', 'shared-scope:test', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES (
            'article-shared-scope-test',
            'Shared Scope Article',
            '2024-01-02T00:00:00.000Z',
            '2024-01-03T00:00:00.000Z',
            'external-shared-scope-test'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_import_route (id, project_id, import_route_id)
          VALUES ('project-import-route-shared-scope-test', 'project-shared-scope-test', 'route-shared-scope-test')
        \`)
        await database.run(\`
          INSERT INTO app.article_import_route (id, article_id, import_route_id)
          VALUES ('article-import-route-shared-scope-test', 'article-shared-scope-test', 'route-shared-scope-test')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-shared-scope-test', 'project-shared-scope-test', 'article-shared-scope-test')
        \`)

        const martRefreshService = getDuckdbMartRefreshService()

        await martRefreshService.queueProjectRefresh('project-shared-scope-test', 'shared-scope-test')
        await martRefreshService.flush()

        const projectScopeRows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            in_curated_scope AS inCuratedScope,
            in_route_scope AS inRouteScope
          FROM mart.project_scope_article
          WHERE project_id = 'project-shared-scope-test'
          ORDER BY article_id ASC
        \`)
        const rollupRows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            in_curated_scope AS inCuratedScope,
            in_route_scope AS inRouteScope
          FROM mart.review_article_rollup
          WHERE project_id = 'project-shared-scope-test'
          ORDER BY article_id ASC
        \`)
        const servingRows = await database.queryJson(\`
          SELECT article_id AS articleId
          FROM mart.review_article_serving
          WHERE project_id = 'project-shared-scope-test'
          ORDER BY article_id ASC
        \`)

        console.log(JSON.stringify({projectScopeRows, rollupRows, servingRows}))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart shared scope dedupe test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      projectScopeRows: Array<{articleId: string; inCuratedScope: boolean; inRouteScope: boolean}>
      rollupRows: Array<{articleId: string; inCuratedScope: boolean; inRouteScope: boolean}>
      servingRows: Array<{articleId: string}>
    }

    expect(result.projectScopeRows).toEqual([
      {articleId: 'article-shared-scope-test', inCuratedScope: true, inRouteScope: true},
    ])
    expect(result.rollupRows).toEqual([
      {articleId: 'article-shared-scope-test', inCuratedScope: true, inRouteScope: true},
    ])
    expect(result.servingRows).toEqual([{articleId: 'article-shared-scope-test'}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
            project_id,
            snapshot_project_id,
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
            'project-serving-generation-test',
            'project-serving-generation-test',
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
            project_id,
            snapshot_project_id,
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
            'project-serving-failure-test',
            'project-serving-failure-test',
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
                  if (
                    statement.includes('temp_dirty_judgment_fact_article')
                    && statement.includes('article-yield-test-')
                    && statement.includes(' AS article_id')
                  ) {
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
