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

test('direct project large rebuild request writes dirty and large rebuild state without project queue rows', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-project-delete-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
        const {getProjectMartLargeRebuildStateService} = await import('./src/server/services/projectMartLargeRebuildStateService.ts')

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

        const markProjectLargeRebuildDirty = async (projectId, reason) => {
          await database.transaction(async (tx) => {
            const dirtyProjects = await getProjectMartDirtyRefreshStateService().getDirtyProjectsForProjectIds(tx, [projectId])
            const states = await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
              projects: dirtyProjects,
              reason,
              runner: tx,
            })

            await states.reduce(async (promise, state) => {
              await promise
              await getProjectMartLargeRebuildStateService().requestLargeRebuild({
                projectId: state.projectId,
                rebuildPhase: 'project_scope_article',
                refreshToken: state.dirtyToken,
                runner: tx,
              })
            }, Promise.resolve())
          })
        }

        await markProjectLargeRebuildDirty('project-delete-a', 'project-delete-test-a')
        await markProjectLargeRebuildDirty('project-delete-b', 'project-delete-test-b')

        const [legacyQueueTable] = await database.queryJson(\`
          SELECT
            COUNT(*) AS tableCount
          FROM information_schema.tables
          WHERE table_schema = 'app'
            AND table_name = 'mart_refresh_queue'
        \`)
        const refreshRows = await database.queryJson(\`
          SELECT project_id AS projectId, CAST(dirty_token AS INTEGER) AS dirtyToken, last_request_reason AS reason
          FROM app.project_mart_refresh_state
          ORDER BY project_id ASC
        \`)
        const largeRebuildRows = await database.queryJson(\`
          SELECT project_id AS projectId, rebuild_phase AS rebuildPhase, CAST(refresh_token AS INTEGER) AS refreshToken
          FROM app.project_mart_large_rebuild_state
          ORDER BY project_id ASC
        \`)

        console.log(JSON.stringify({
          largeRebuildRows,
          legacyQueueTableCount: Number(legacyQueueTable?.tableCount ?? 0),
          refreshRows,
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

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      largeRebuildRows: Array<{projectId: string; rebuildPhase: string; refreshToken: number}>
      legacyQueueTableCount: number
      refreshRows: Array<{dirtyToken: number; projectId: string; reason: string}>
    }

    expect(result.legacyQueueTableCount).toBe(0)
    expect(result.refreshRows).toEqual([
      {dirtyToken: 1, projectId: 'project-delete-a', reason: 'project-delete-test-a'},
      {dirtyToken: 1, projectId: 'project-delete-b', reason: 'project-delete-test-b'},
    ])
    expect(result.largeRebuildRows).toEqual([
      {projectId: 'project-delete-a', rebuildPhase: 'project_scope_article', refreshToken: 1},
      {projectId: 'project-delete-b', rebuildPhase: 'project_scope_article', refreshToken: 1},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('refreshProject rebuilds large projects in article batches', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartMaintenanceService.ts', 'file://' + process.cwd() + '/').pathname
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

        const martRefreshService = (await import(martRefreshServiceModulePath + '?project-batch=' + Date.now())).getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-batch-test')
        console.log(JSON.stringify({events}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart project batching regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]}

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
})

test('prompt answer incremental refresh drops lookup index before row deletes and recreates it after refresh', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartMaintenanceService.ts', 'file://' + process.cwd() + '/').pathname
        const statements = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                close: async () => {},
                queryJson: async () => [],
                queryJsonBackground: async (statement) => {
                  return statement.includes('FROM app.project_review_serving_generation') && statement.includes('COUNT(*) AS count')
                    ? [{count: 1}]
                    : []
                },
                run: async () => {},
                maintenance: async () => {},
                runBackground: async (statement) => {
                  statements.push(statement)
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?prompt-index-refresh=' + Date.now())).getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProjectArticleMartsBatch('project-index-refresh-test', [
          'article-1',
          'article-2',
          'article-1',
        ])

        console.log(JSON.stringify({statements}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'Prompt answer incremental refresh index regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {statements: string[]}
  const promptRefreshStatementIndex = result.statements.findIndex((statement) => {
    return statement.includes('DELETE FROM mart.prompt_answer_fact')
  })
  const promptRefreshStatement = result.statements[promptRefreshStatementIndex] ?? ''
  const createIndexStatementIndex = result.statements.findIndex((statement, index) => {
    return (
      index > promptRefreshStatementIndex
      && statement.includes('CREATE INDEX IF NOT EXISTS idx_mart_prompt_answer_fact_lookup')
    )
  })
  const dictionaryStatementIndex = result.statements.findIndex((statement) => {
    return statement.includes('INSERT INTO app.review_answer_dictionary')
  })

  expect(promptRefreshStatementIndex).toBeGreaterThanOrEqual(0)
  expect(promptRefreshStatement).toContain('DROP INDEX IF EXISTS mart.idx_mart_prompt_answer_fact_lookup')
  expect(promptRefreshStatement.indexOf('DROP INDEX IF EXISTS mart.idx_mart_prompt_answer_fact_lookup')).toBeLessThan(
    promptRefreshStatement.indexOf('DELETE FROM mart.prompt_answer_fact'),
  )
  expect(createIndexStatementIndex).toBeGreaterThan(promptRefreshStatementIndex)
  expect(createIndexStatementIndex).toBeLessThan(dictionaryStatementIndex)
})

test('dirty project article batch refresh uses a temp article table without project-wide deletes', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartMaintenanceService.ts', 'file://' + process.cwd() + '/').pathname
        const statements = []

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJsonBackground: async () => [{count: 1}],
                runBackground: async (statement) => {
                  statements.push(statement)
                },
              }
            },
          }
        })

        const martRefreshService = (await import(martRefreshServiceModulePath + '?dirty-batch-shape=' + Date.now())).getDuckdbMartMaintenanceService()
        const articleIds = Array.from({length: 10}, (_value, index) => 'article-dirty-batch-' + index)

        await martRefreshService.refreshDirtyProjectArticleBatch('project-dirty-batch-shape', articleIds)

        console.log(JSON.stringify({statements}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Dirty batch SQL shape regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {statements: string[]}
  const [statement = ''] = result.statements

  expect(result.statements).toHaveLength(1)
  expect(statement).toContain(
    'CREATE TEMP TABLE temp_project_mart_refresh_article_batch (article_id VARCHAR PRIMARY KEY)',
  )
  expect(statement).toContain('INSERT INTO temp_project_mart_refresh_article_batch (article_id)')
  expect(statement).toContain('UNION ALL')
  expect(statement).toContain('ON CONFLICT DO NOTHING')
  expect(statement).not.toContain('FROM UNNEST')
  expect(statement).not.toContain('FROM (VALUES')
  expect(statement).not.toContain('article_id IN (')
  expect(statement).not.toMatch(
    /DELETE FROM mart\\.project_scope_article\\s+WHERE project_id = 'project-dirty-batch-shape'\\s*;/,
  )
  expect(statement).not.toMatch(
    /DELETE FROM mart\\.prompt_answer_fact\\s+WHERE project_id = 'project-dirty-batch-shape'\\s*;/,
  )
  expect(statement).not.toContain('DROP INDEX IF EXISTS mart.idx_mart_prompt_answer_fact_lookup')
  expect(statement).not.toContain('CREATE INDEX IF NOT EXISTS idx_mart_prompt_answer_fact_lookup')
})

test('project prompt and import-route dirty requests mark projects dirty without project queue rows', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-project-priority-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

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
            ('project-prompt-dirty-test', 'Prompt Dirty Project', 'model-project-priority-test', TRUE, TRUE, FALSE, FALSE),
            ('project-route-dirty-test', 'Route Dirty Project', 'model-project-priority-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-dirty-helper-test', 'Prompt dirty helper', 'prompt-dirty-helper-hash')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-dirty-helper-test', 'project-prompt-dirty-test', 'prompt-dirty-helper-test', 0, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES
            ('article-prompt-dirty-test', 'Prompt Dirty Article'),
            ('article-route-dirty-test', 'Route Dirty Article')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-prompt-dirty-test', 'project-prompt-dirty-test', 'article-prompt-dirty-test')
        \`)
        await database.run(\`
          INSERT INTO app.import_route (id, route, name)
          VALUES ('import-route-dirty-helper-test', 'route-dirty-helper', 'Route Dirty Helper')
        \`)
        await database.run(\`
          INSERT INTO app.project_import_route (id, project_id, import_route_id)
          VALUES ('project-import-route-dirty-helper-test', 'project-route-dirty-test', 'import-route-dirty-helper-test')
        \`)
        await database.run(\`
          INSERT INTO app.article_import_route (id, article_id, import_route_id)
          VALUES ('article-import-route-dirty-helper-test', 'article-route-dirty-test', 'import-route-dirty-helper-test')
        \`)

        const refreshStateService = getProjectMartDirtyRefreshStateService()

        await database.transaction(async (tx) => {
          const promptDirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, [
            'project-prompt-dirty-test',
          ])

          await refreshStateService.markProjectsDirtyAtomically({
            projects: promptDirtyProjects,
            reason: 'prompt-dirty-helper',
            runner: tx,
          })

          const routeDirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, [
            'project-route-dirty-test',
          ])

          await refreshStateService.markProjectsDirtyAtomically({
            projects: routeDirtyProjects,
            reason: 'route-dirty-helper',
            runner: tx,
          })
        })

        const [legacyQueueTable] = await database.queryJson(\`
          SELECT COUNT(*) AS tableCount
          FROM information_schema.tables
          WHERE table_schema = 'app'
            AND table_name = 'mart_refresh_queue'
        \`)
        const refreshStates = await database.queryJson(\`
          SELECT project_id AS projectId, CAST(dirty_token AS INTEGER) AS dirtyToken, last_request_reason AS reason
          FROM app.project_mart_refresh_state
          WHERE project_id IN ('project-prompt-dirty-test', 'project-route-dirty-test')
          ORDER BY project_id ASC
        \`)
        const materializationRows = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
            materialization_status AS materializationStatus,
            CAST(source_scope_expected_row_count AS INTEGER) AS expectedRowCount
          FROM app.project_mart_dirty_materialization_state
          WHERE project_id IN ('project-prompt-dirty-test', 'project-route-dirty-test')
          ORDER BY project_id ASC
        \`)
        const [largeRebuildRow] = await database.queryJson(\`
          SELECT COUNT(*) AS count
          FROM app.project_mart_large_rebuild_state
          WHERE project_id IN ('project-prompt-dirty-test', 'project-route-dirty-test')
            AND refresh_token > 0
        \`)

        console.log(JSON.stringify({
          largeRebuildCount: Number(largeRebuildRow?.count ?? 0),
          legacyQueueTableCount: Number(legacyQueueTable?.tableCount ?? 0),
          materializationRows,
          refreshStates,
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Mart prompt dirty helper regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      largeRebuildCount: number
      legacyQueueTableCount: number
      materializationRows: Array<{
        expectedRowCount: number
        materializationStatus: string
        projectId: string
        targetDirtyToken: number
      }>
      refreshStates: Array<{dirtyToken: number; projectId: string; reason: string}>
    }

    expect(result.legacyQueueTableCount).toBe(0)
    expect(result.largeRebuildCount).toBe(0)
    expect(result.refreshStates).toEqual([
      {dirtyToken: 1, projectId: 'project-prompt-dirty-test', reason: 'prompt-dirty-helper'},
      {dirtyToken: 1, projectId: 'project-route-dirty-test', reason: 'route-dirty-helper'},
    ])
    expect(result.materializationRows).toEqual([
      {
        expectedRowCount: 1,
        materializationStatus: 'pending',
        projectId: 'project-prompt-dirty-test',
        targetDirtyToken: 1,
      },
      {
        expectedRowCount: 1,
        materializationStatus: 'pending',
        projectId: 'project-route-dirty-test',
        targetDirtyToken: 1,
      },
    ])
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
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartMaintenanceService.ts', 'file://' + process.cwd() + '/').pathname
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
                        : []
                },
                queryJsonBackground: async () => {
                  return []
                },
                run: async (statement) => {
                  if (statement.includes('DELETE FROM mart.project_scope_article')) {
                    throw new Error('project refresh ran on control connection')
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

        const martRefreshService = (await import(martRefreshServiceModulePath + '?background=' + Date.now())).getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-background-test')
        console.log(JSON.stringify({backgroundRunCount}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Mart background connection regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {backgroundRunCount: number}

  expect(result.backgroundRunCount).toBeGreaterThan(0)
})

test('mart refresh ensures review_article_rollup exists without rebuilding it before a project refresh', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartMaintenanceService.ts', 'file://' + process.cwd() + '/').pathname
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

        const martRefreshService = (await import(martRefreshServiceModulePath + '?rollup-repair=' + Date.now())).getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-rollup-repair-test')
        console.log(JSON.stringify({events}))
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

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {events: string[]}

  expect(result.events).toContain('rollup:ensure-table')
  expect(result.events).toContain('rollup:ensure-index')
  expect(result.events).toContain('refresh:project-scope')
  expect(result.events.indexOf('rollup:ensure-table')).toBeLessThan(result.events.indexOf('refresh:project-scope'))
  expect(result.events).not.toContain('repair:drop-scratch')
  expect(result.events).not.toContain('repair:copy-existing')
  expect(result.events).not.toContain('repair:drop-live')
  expect(result.events).not.toContain('repair:restore-rows')
})

test('mart refresh populates review article serving v3 tables', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-serving-v3-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-serving-v3-test')

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

test('review serving dirty refresh denormalizes selected project scoped import metadata', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-scoped-serving-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-scoped-serving-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-scoped-serving-test', 'connection-scoped-serving-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-scoped-serving-test', 'Scoped Serving Project', 'model-scoped-serving-test', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.article (
            id,
            article_title,
            article_created_at,
            article_updated_at,
            article_id,
            source_metadata
          ) VALUES (
            'article-scoped-serving-test',
            'Scoped Serving Article',
            TIMESTAMPTZ '2026-04-02T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-02T01:00:00.000Z',
            'canonical-scoped-serving',
            CAST('{"journalTitle":"Canonical Journal","canonicalOnly":"canonical","same":"canonical"}' AS JSON)
          )
        \`)
        await database.run(\`
          INSERT INTO app.import_route (id, route, name)
          VALUES
            ('import-route-scoped-a', 'scoped-serving:a', 'Scoped A'),
            ('import-route-scoped-b', 'scoped-serving:b', 'Scoped B')
        \`)
        await database.run(\`
          INSERT INTO app.project_import_route (id, project_id, import_route_id)
          VALUES
            ('project-import-route-scoped-a', 'project-scoped-serving-test', 'import-route-scoped-a'),
            ('project-import-route-scoped-b', 'project-scoped-serving-test', 'import-route-scoped-b')
        \`)
        await database.run(\`
          INSERT INTO app.article_import_route (
            id,
            article_id,
            import_route_id,
            external_article_id,
            import_metadata,
            source_record_key
          ) VALUES
            (
              'article-import-route-scoped-b',
              'article-scoped-serving-test',
              'import-route-scoped-b',
              'covidence-b',
              CAST('{"journalTitle":"Scoped B Journal","scopedOnly":"b","same":"b"}' AS JSON),
              'source-record-b'
            ),
            (
              'article-import-route-scoped-a',
              'article-scoped-serving-test',
              'import-route-scoped-a',
              'covidence-a',
              CAST('{"journalTitle":"Scoped A Journal","scopedOnly":"a","same":"a"}' AS JSON),
              'source-record-a'
            )
        \`)

        const getServingRows = async () => {
          return await database.queryJson(\`
            SELECT
              article_external_id AS articleExternalId,
              journal_title AS journalTitle,
              json_extract_string(source_metadata, '$.canonicalOnly') AS canonicalOnly,
              json_extract_string(source_metadata, '$.scopedOnly') AS scopedOnly,
              json_extract_string(source_metadata, '$.same') AS sameValue
            FROM mart.review_article_serving serving
            INNER JOIN app.project_review_serving_generation generation
              ON generation.project_id = serving.project_id
             AND generation.active_generation = serving.generation
            WHERE serving.project_id = 'project-scoped-serving-test'
              AND serving.article_id = 'article-scoped-serving-test'
            ORDER BY serving.article_id ASC
          \`)
        }

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-scoped-serving-test')
        const fullRefreshRows = await getServingRows()

        await database.run(\`
          UPDATE app.article_import_route
          SET external_article_id = 'covidence-a-updated',
              import_metadata = CAST('{"journalTitle":"Scoped A Updated","scopedOnly":"a-updated","same":"a-updated"}' AS JSON)
          WHERE id = 'article-import-route-scoped-a'
        \`)
        await martRefreshService.refreshDirtyProjectArticleBatch('project-scoped-serving-test', [
          'article-scoped-serving-test',
        ])
        const dirtyRefreshRows = await getServingRows()

        console.log(JSON.stringify({dirtyRefreshRows, fullRefreshRows}))
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
          || 'Scoped review serving dirty refresh regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      dirtyRefreshRows: Array<{
        articleExternalId: string | null
        canonicalOnly: string | null
        journalTitle: string | null
        sameValue: string | null
        scopedOnly: string | null
      }>
      fullRefreshRows: Array<{
        articleExternalId: string | null
        canonicalOnly: string | null
        journalTitle: string | null
        sameValue: string | null
        scopedOnly: string | null
      }>
    }

    expect(result.fullRefreshRows).toEqual([
      {
        articleExternalId: 'covidence-a',
        canonicalOnly: 'canonical',
        journalTitle: 'Scoped A Journal',
        sameValue: 'a',
        scopedOnly: 'a',
      },
    ])
    expect(result.dirtyRefreshRows).toEqual([
      {
        articleExternalId: 'covidence-a-updated',
        canonicalOnly: 'canonical',
        journalTitle: 'Scoped A Updated',
        sameValue: 'a-updated',
        scopedOnly: 'a-updated',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists('/tmp/duckdb-temp')
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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const martRefreshService = getDuckdbMartMaintenanceService()

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-serving-incremental-test')

        await database.run(\`
          UPDATE app.judgment
          SET answered_original = 'no',
              answered_original_as_array = ['no'],
              updated_at = current_timestamp
          WHERE id = 'judgment-serving-incremental-test'
        \`)

        await martRefreshService.refreshJudgmentFactsForArticles(['article-serving-incremental-test'])
        await martRefreshService.refreshProjectArticleMartsBatch('project-serving-incremental-test', [
          'article-serving-incremental-test',
        ])

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const martRefreshService = getDuckdbMartMaintenanceService()

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

        await martRefreshService.refreshProject('project-dirty-answer-batch')

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
        await martRefreshService.refreshProjectArticleMartsBatch('project-dirty-answer-batch', [
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
        const activeDetailRows = await database.queryJson(\`
          SELECT detail.article_id AS articleId, detail.answered_original AS answeredOriginal
          FROM mart.review_article_serving_detail detail
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = detail.project_id
           AND generation.active_generation = detail.generation
          WHERE detail.project_id = 'project-dirty-answer-batch'
          ORDER BY detail.article_id ASC, detail.answered_original ASC
        \`)
        const activeServingRows = await database.queryJson(\`
          SELECT serving.article_id AS articleId
          FROM mart.review_article_serving serving
          INNER JOIN app.project_review_serving_generation generation
            ON generation.project_id = serving.project_id
           AND generation.active_generation = serving.generation
          WHERE serving.project_id = 'project-dirty-answer-batch'
          ORDER BY serving.article_id ASC
        \`)
        const dictionaryRows = await database.queryJson(\`
          SELECT answer_value AS answerValue, CAST(answer_id AS INTEGER) AS answerId
          FROM app.review_answer_dictionary
          WHERE project_id = 'project-dirty-answer-batch'
            AND prompt_id = 'prompt-dirty-answer-batch'
          ORDER BY answer_id ASC
        \`)

        console.log(JSON.stringify({
          activeDetailRows,
          activeFilterRows,
          activeServingRows,
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
      activeDetailRows: Array<{answeredOriginal: string; articleId: string}>
      activeFilterRows: Array<{answerId: number; answerValue: string; articleId: string}>
      activeServingRows: Array<{articleId: string}>
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
    expect(result.activeDetailRows).toEqual([
      {answeredOriginal: 'aaa', articleId: 'article-dirty-answer-a'},
      {answeredOriginal: 'zzz', articleId: 'article-dirty-answer-b'},
      {answeredOriginal: 'no', articleId: 'article-dirty-answer-clean'},
    ])
    expect(result.activeServingRows).toEqual([
      {articleId: 'article-dirty-answer-a'},
      {articleId: 'article-dirty-answer-b'},
      {articleId: 'article-dirty-answer-clean'},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('refreshProjectArticleMartsBatch refreshes active data used by olap filters and article review details', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-active-consumer-batch-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {queryArticlesReviewsFromDuckdb} = await import('./src/services/olap/duckdbOlap.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')
        const {projectsRoutesPostArticleReviewDetails} = await import('./src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const martRefreshService = getDuckdbMartMaintenanceService()
        const projectId = 'project-active-consumer-batch'
        const articleId = 'article-active-consumer-batch'
        const promptId = 'prompt-active-consumer-batch'

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-active-consumer-batch', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-active-consumer-batch', 'connection-active-consumer-batch', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-active-consumer-batch', 'Active Consumer Batch Project', 'model-active-consumer-batch', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-active-consumer-batch', 'Prompt body', 'hash-active-consumer-batch')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-active-consumer-batch', 'project-active-consumer-batch', 'prompt-active-consumer-batch', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES ('article-active-consumer-batch', 'Active Consumer Batch Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-active-consumer-batch')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-active-consumer-batch', 'project-active-consumer-batch', 'article-active-consumer-batch')
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
          VALUES ('judgment-active-consumer-batch', 'article-active-consumer-batch', 'prompt-active-consumer-batch', 'model-active-consumer-batch', 'project-active-consumer-batch', 'project-active-consumer-batch', TRUE, TRUE, FALSE, FALSE, TRUE, 'old', ['old'], 90)
        \`)

        await martRefreshService.refreshJudgmentArticle(articleId)
        await martRefreshService.refreshProject(projectId)

        await database.run(\`
          UPDATE app.judgment
          SET answered_original = 'new',
              answered_original_as_array = ['new'],
              updated_at = TIMESTAMPTZ '2026-04-02T00:00:00.000Z'
          WHERE id = 'judgment-active-consumer-batch'
        \`)

        await martRefreshService.refreshJudgmentArticle(articleId)
        await martRefreshService.refreshProjectArticleMartsBatch(projectId, [articleId])

        const filteredNew = await queryArticlesReviewsFromDuckdb({
          projectId,
          page: 1,
          limit: 10,
          prompts: {[promptId]: ['new']},
        })
        const filteredOld = await queryArticlesReviewsFromDuckdb({
          projectId,
          page: 1,
          limit: 10,
          prompts: {[promptId]: ['old']},
        })
        const detailsApp = new Elysia().use(projectsRoutesPostArticleReviewDetails)
        const detailsResponse = await detailsApp.handle(
          new Request('http://localhost/api/projectsreview', {
            body: JSON.stringify({articleId, projectId}),
            headers: {'content-type': 'application/json'},
            method: 'POST',
          }),
        )
        const details = await detailsResponse.json()

        console.log(JSON.stringify({
          detailAnswers: details.judgments.map((judgment) => {
            return judgment.answeredOriginal
          }),
          detailStatus: detailsResponse.status,
          newFilterAnswers: filteredNew.data.flatMap((article) => {
            return article.judgments.map((judgment) => {
              return judgment.answeredOriginal
            })
          }),
          newFilterIds: filteredNew.data.map((article) => {
            return article.id
          }),
          oldFilterIds: filteredOld.data.map((article) => {
            return article.id
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
        runScript.stderr.toString()
          || runScript.stdout.toString()
          || 'Active consumer batch refresh regression test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      detailAnswers: string[]
      detailStatus: number
      newFilterAnswers: string[]
      newFilterIds: string[]
      oldFilterIds: string[]
    }

    expect(result.detailStatus).toBe(200)
    expect(result.detailAnswers).toEqual(['new'])
    expect(result.newFilterAnswers).toEqual(['new'])
    expect(result.newFilterIds).toEqual(['article-active-consumer-batch'])
    expect(result.oldFilterIds).toEqual([])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('active review API and OLAP reads stay generation-bound through queued running promotion and cleanup', () => {
  const duckdbPath = `/tmp/f1-mart-refresh-active-read-gates-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {queryArticlesReviewsFromDuckdb} = await import('./src/services/olap/duckdbOlap.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')
        const {getProjectMartLargeRebuildExecutor} = await import('./src/server/services/projectMartLargeRebuildExecutor.ts')
        const {projectsRoutesGetArticlesReviews} = await import('./src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts')
        const {projectsRoutesPostArticleReviewDetails} = await import('./src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const martRefreshService = getDuckdbMartMaintenanceService()
        const executor = getProjectMartLargeRebuildExecutor()
        const projectId = 'project-active-read-gates'
        const articleId = 'article-active-read-gates'
        const promptId = 'prompt-active-read-gates'
        const reviewsApp = new Elysia().use(projectsRoutesGetArticlesReviews)
        const detailsApp = new Elysia().use(projectsRoutesPostArticleReviewDetails)

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-active-read-gates', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-active-read-gates', 'connection-active-read-gates', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-active-read-gates', 'Active Read Gates Project', 'model-active-read-gates', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-active-read-gates', 'Prompt body', 'hash-active-read-gates')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-active-read-gates', 'project-active-read-gates', 'prompt-active-read-gates', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
          VALUES ('article-active-read-gates', 'Active Read Gates Article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'external-active-read-gates')
        \`)
        await database.run(\`
          INSERT INTO app.project_article (id, project_id, article_id)
          VALUES ('project-article-active-read-gates', 'project-active-read-gates', 'article-active-read-gates')
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
            confidence_original,
            explanation,
            updated_at
          )
          VALUES ('judgment-active-read-gates', 'article-active-read-gates', 'prompt-active-read-gates', 'model-active-read-gates', 'project-active-read-gates', 'project-active-read-gates', TRUE, TRUE, FALSE, FALSE, TRUE, 'old', ['old'], 90, 'old detail', TIMESTAMPTZ '2026-04-01T02:00:00.000Z')
        \`)

        await martRefreshService.refreshJudgmentArticle(articleId)
        await martRefreshService.refreshProject(projectId)

        const getReviewApiResult = async (answer) => {
          const response = await reviewsApp.handle(
            new Request('http://localhost/api/articlesreviews', {
              body: JSON.stringify({projectId, page: '1', limit: '10', prompts: {[promptId]: [answer]}}),
              headers: {'content-type': 'application/json'},
              method: 'POST',
            }),
          )
          const body = await response.json()
          return {body, status: response.status}
        }
        const getDetailsResult = async () => {
          const response = await detailsApp.handle(
            new Request('http://localhost/api/projectsreview', {
              body: JSON.stringify({articleId, projectId}),
              headers: {'content-type': 'application/json'},
              method: 'POST',
            }),
          )
          const body = await response.json()
          return {body, status: response.status}
        }
        const getReviewIds = (result) => {
          return result.data.map((article) => {
            return article.id
          })
        }
        const getReviewAnswers = (result) => {
          return result.data.flatMap((article) => {
            return article.judgments.map((judgment) => {
              return judgment.answeredOriginal
            })
          })
        }
        const getFilterSnapshot = async (answer) => {
          const direct = await queryArticlesReviewsFromDuckdb({projectId, page: 1, limit: 10, prompts: {[promptId]: [answer]}})
          const api = await getReviewApiResult(answer)
          return {
            apiAnswers: getReviewAnswers(api.body),
            apiIds: getReviewIds(api.body),
            apiStatus: api.status,
            directAnswers: getReviewAnswers(direct),
            directIds: getReviewIds(direct),
          }
        }
        const getSnapshot = async (label) => {
          const oldFilter = await getFilterSnapshot('old')
          const newFilter = await getFilterSnapshot('new')
          const details = await getDetailsResult()
          return {
            detailJudgments: details.body.judgments.map((judgment) => {
              return {answer: judgment.answeredOriginal, explanation: judgment.explanation}
            }),
            detailStatus: details.status,
            label,
            newFilter,
            oldFilter,
          }
        }

        const beforeRefresh = await getSnapshot('before-refresh')

        await database.run(\`
          UPDATE app.judgment
          SET answered_original = 'new',
              answered_original_as_array = ['new'],
              confidence_original = 77,
              explanation = 'new detail',
              updated_at = TIMESTAMPTZ '2026-04-02T00:00:00.000Z'
          WHERE id = 'judgment-active-read-gates'
        \`)
        await martRefreshService.refreshJudgmentArticle(articleId)
        await database.run(\`
          INSERT INTO app.project_mart_refresh_state (
            project_id,
            dirty_token,
            active_dirty_token,
            last_completed_dirty_token,
            last_requested_at,
            refresh_status
          ) VALUES (
            'project-active-read-gates',
            2,
            0,
            1,
            TIMESTAMPTZ '2026-04-02T00:01:00.000Z',
            'idle'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_refresh_article_state (
            project_id,
            article_id,
            first_dirty_token,
            last_dirty_token,
            updated_at
          ) VALUES (
            'project-active-read-gates',
            'article-active-read-gates',
            2,
            2,
            TIMESTAMPTZ '2026-04-02T00:01:00.000Z'
          )
        \`)

        const queued = await getSnapshot('queued')

        await database.run(\`
          UPDATE app.project_mart_refresh_state
          SET active_dirty_token = 2,
              refresh_status = 'running',
              last_started_at = TIMESTAMPTZ '2026-04-02T00:02:00.000Z',
              lease_expires_at = TIMESTAMPTZ '2035-04-02T00:02:30.000Z',
              worker_id = 'active-read-gates-worker'
          WHERE project_id = 'project-active-read-gates'
        \`)

        const running = await getSnapshot('running')
        const targetGeneration = 3

        await executor.rebuildProjectPromptAnswerFactBatch(projectId, [articleId])
        await executor.rebuildProjectReviewAnswerDictionaryBatch(projectId, [articleId])
        await executor.resetProjectReviewArticleRollup(projectId)
        await executor.rebuildProjectReviewArticleRollupBatch(projectId, [articleId])
        await executor.setupProjectReviewServingStaging(projectId, targetGeneration)
        await executor.rebuildProjectReviewArticleFilterMemberBatch(projectId, [articleId], targetGeneration)
        await executor.rebuildProjectReviewServingBatch(projectId, [articleId], targetGeneration)
        await executor.finalizeProjectReviewServing(projectId, targetGeneration)
        await database.run(\`
          UPDATE app.project_mart_refresh_state
          SET last_completed_dirty_token = 2,
              last_completed_at = TIMESTAMPTZ '2026-04-02T00:03:00.000Z',
              refresh_status = 'idle',
              active_dirty_token = 0,
              lease_expires_at = NULL,
              worker_id = NULL
          WHERE project_id = 'project-active-read-gates'
        \`)

        const afterPromotion = await getSnapshot('after-promotion')
        const cleanupResult = await executor.cleanupProjectReviewServingGenerationsBatch({batchSize: 100, projectId})
        const afterCleanup = await getSnapshot('after-cleanup')

        console.log(JSON.stringify({afterCleanup, afterPromotion, beforeRefresh, cleanupResult, queued, running}))
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
        runScript.stderr.toString() || runScript.stdout.toString() || 'Active read final gates test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      afterCleanup: Record<string, unknown>
      afterPromotion: Record<string, unknown>
      beforeRefresh: Record<string, unknown>
      cleanupResult: {deletedRowCount: number}
      queued: Record<string, unknown>
      running: Record<string, unknown>
    }
    const getComparableSnapshot = (snapshot: Record<string, unknown>) => {
      return {detailJudgments: snapshot.detailJudgments, newFilter: snapshot.newFilter, oldFilter: snapshot.oldFilter}
    }
    const oldActiveSnapshot = {
      detailJudgments: [{answer: 'old', explanation: 'old detail'}],
      newFilter: {apiAnswers: [], apiIds: [], apiStatus: 200, directAnswers: [], directIds: []},
      oldFilter: {
        apiAnswers: ['old'],
        apiIds: ['article-active-read-gates'],
        apiStatus: 200,
        directAnswers: ['old'],
        directIds: ['article-active-read-gates'],
      },
    }
    const newActiveSnapshot = {
      detailJudgments: [{answer: 'new', explanation: 'new detail'}],
      newFilter: {
        apiAnswers: ['new'],
        apiIds: ['article-active-read-gates'],
        apiStatus: 200,
        directAnswers: ['new'],
        directIds: ['article-active-read-gates'],
      },
      oldFilter: {apiAnswers: [], apiIds: [], apiStatus: 200, directAnswers: [], directIds: []},
    }

    expect(getComparableSnapshot(result.beforeRefresh)).toEqual(oldActiveSnapshot)
    expect(getComparableSnapshot(result.queued)).toEqual(oldActiveSnapshot)
    expect(getComparableSnapshot(result.running)).toEqual(oldActiveSnapshot)
    expect(getComparableSnapshot(result.afterPromotion)).toEqual(newActiveSnapshot)
    expect(getComparableSnapshot(result.afterCleanup)).toEqual(newActiveSnapshot)
    expect(result.cleanupResult.deletedRowCount).toBeGreaterThan(0)
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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const martRefreshService = getDuckdbMartMaintenanceService()

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-summary-human-test')

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-cross-project-target')

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

        await martRefreshService.refreshJudgmentFactsForArticles(['article-cross-project-test'])
        await martRefreshService.refreshProject('project-cross-project-source')

        await martRefreshService.refreshProject('project-cross-project-target')

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const martRefreshService = getDuckdbMartMaintenanceService()

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

        await martRefreshService.refreshJudgmentFactsForArticles(['article-prompt-edit-isolation'])
        await martRefreshService.refreshProject('project-prompt-edit-isolation-source')
        await martRefreshService.refreshProject('project-prompt-edit-isolation-target')

        const beforeEditSourceDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-source')
        const beforeEditTargetDetailRows = await getActiveDetailRows('project-prompt-edit-isolation-target')

        await database.run(\`
          UPDATE app.project_prompt
          SET prompt_id = 'prompt-prompt-edit-isolation-edited'
          WHERE project_id = 'project-prompt-edit-isolation-target'
        \`)

        await martRefreshService.refreshProject('project-prompt-edit-isolation-target')

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

        await martRefreshService.refreshJudgmentFactsForArticles(['article-prompt-edit-isolation'])
        await martRefreshService.refreshProject('project-prompt-edit-isolation-target')

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-shared-scope-test')

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
        const {getDuckdbMartMaintenanceService} = await import('./src/server/services/getDuckdbMartMaintenanceService.ts')

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

        const martRefreshService = getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-serving-generation-test')
        await martRefreshService.refreshProject('project-serving-generation-test')

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
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartMaintenanceService.ts', 'file://' + process.cwd() + '/').pathname
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

        const martRefreshService = (await import(martRefreshServiceModulePath + '?serving-failure=' + Date.now())).getDuckdbMartMaintenanceService()

        await martRefreshService.refreshProject('project-serving-failure-test')
        shouldFailServingRefresh = true
        const failureText = await martRefreshService.refreshProject('project-serving-failure-test').then(
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
