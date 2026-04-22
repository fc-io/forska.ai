import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

test('admin append metrics route returns append lane metrics', () => {
  const duckdbPath = `/tmp/f1-admin-append-metrics-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const now = new Date()
        const connectionId = 'connection-route-test'
        const modelId = 'model-route-test'
        const promptId = 'prompt-route-test'
        const articleId = 'article-route-test'

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('\${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('\${modelId}', '\${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('\${promptId}', 'Prompt', 'prompt-route-test-hash')
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('\${articleId}', 'Route Test Article')
        \`)
        await database.appendJudgments([
          {
            answeredOriginal: 'yes',
            answeredOriginalAsArray: ['yes'],
            articleId,
            chunkingStrategy: null,
            confidenceOriginal: 50,
            createdAt: now,
            explanation: 'route test',
            id: 'judgment-route-test',
            isAnswered: true,
            modelId,
            projectId: null,
            promptId,
            quotes: ['quote'],
            snapshotProjectId: null,
            snapshotProjectModelName: null,
            updatedAt: now,
            useAbstract: true,
            useFulltext: false,
            useFulltextNoImages: false,
            useTitle: true,
          },
        ])

        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(new Request('http://localhost/api/admin/duckdb-append-metrics'))
        console.log(await response.text())
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin append metrics route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      laneCount: number
      lastInsertedRows: number | null
      queueDepth: number
      rowsAttempted: number
      rowsInserted: number
      rowsSkipped: number
    }

    expect(responseBody.laneCount).toBe(2)
    expect(responseBody.lastInsertedRows).toBe(1)
    expect(responseBody.queueDepth).toBe(0)
    expect(responseBody.rowsAttempted).toBe(1)
    expect(responseBody.rowsInserted).toBe(1)
    expect(responseBody.rowsSkipped).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart large rebuild status route returns explicit operator progress for a project', () => {
  const duckdbPath = `/tmp/f1-admin-large-rebuild-status-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-admin-large-rebuild', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-admin-large-rebuild', 'connection-admin-large-rebuild', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-admin-large-rebuild', 'Admin Large Rebuild', FALSE, 'model-admin-large-rebuild', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_refresh_state (
            project_id,
            dirty_token,
            active_refresh_token,
            last_completed_refresh_token,
            refresh_status,
            last_error,
            worker_id
          ) VALUES (
            'project-admin-large-rebuild',
            7,
            0,
            3,
            'idle',
            NULL,
            NULL
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (
            project_id,
            refresh_token,
            rebuild_phase,
            cursor_article_created_at,
            cursor_article_id,
            refresh_status,
            last_error
          ) VALUES (
            'project-admin-large-rebuild',
            7,
            'prompt_answer_fact',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            'article-progress-1',
            'idle',
            NULL
          )
        \`)

        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(new Request('http://localhost/api/admin/project-mart-large-rebuild-status?projectId=project-admin-large-rebuild'))
        console.log(await response.text())
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin large rebuild status route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      estimates: {overallProgressPercent: number; scopeArticleCount: number}
      largeRebuild: {
        cursorArticleCreatedAt: string | null
        cursorArticleId: string | null
        lastError: string | null
        operatorNote: string | null
        rebuildPhase: string | null
        refreshStatus: string | null
        refreshToken: number | null
      } | null
      project: {archived: boolean; id: string; name: string}
      refreshState: {
        activeRefreshToken: number
        dirtyToken: number
        lastCompletedRefreshToken: number
        lastError: string | null
        refreshStatus: string
        workerId: string | null
      } | null
    }

    expect(responseBody.project).toEqual({
      archived: false,
      id: 'project-admin-large-rebuild',
      name: 'Admin Large Rebuild',
    })
    expect(responseBody.refreshState).toEqual({
      activeRefreshToken: 0,
      dirtyToken: 7,
      lastCompletedRefreshToken: 3,
      lastError: null,
      refreshStatus: 'idle',
      workerId: null,
    })
    expect(responseBody.largeRebuild?.cursorArticleCreatedAt).toBe('2026-04-01 02:00:00+02')
    expect(responseBody.largeRebuild?.cursorArticleId).toBe('article-progress-1')
    expect(responseBody.largeRebuild?.lastError).toBeNull()
    expect(responseBody.largeRebuild?.operatorNote).toBeNull()
    expect(responseBody.largeRebuild?.rebuildPhase).toBe('prompt_answer_fact')
    expect(responseBody.largeRebuild?.refreshStatus).toBe('idle')
    expect(responseBody.largeRebuild?.refreshToken).toBe(7)
    expect(responseBody.estimates.overallProgressPercent).toBeGreaterThanOrEqual(0)
    expect(responseBody.estimates.scopeArticleCount).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin maintenance runtime diagnostics route reports effective duckdb settings and process memory', () => {
  const duckdbPath = `/tmp/f1-admin-maintenance-runtime-diagnostics-${Date.now()}.duckdb`
  const tempDirectory = `/tmp/f1-admin-maintenance-runtime-diagnostics-temp-${Date.now()}`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')
        const {closeDuckdbService} = await import('./src/server/utils/duckdbService.ts')

        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(new Request('http://localhost/api/admin/maintenance-runtime-diagnostics'))
        console.log(await response.text())
        await closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3001',
        DUCKDB_MEMORY_LIMIT: '256MiB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: tempDirectory,
        PROJECT_MART_LARGE_REBUILD_BATCH_SIZE: '8',
        PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE: '4',
        PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS: '1500',
        SERVER_ROLE: 'maintenance-worker',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString()
          || runRoute.stdout.toString()
          || 'Admin maintenance runtime diagnostics route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      duckdb: {
        configured: {
          appendLaneCount: number
          memoryLimit: string
          preserveInsertionOrder: boolean
          serializeConcurrentWork: boolean
          tempDirectory: string | null
          threads: string
        }
        effective: {
          memoryLimit: string | null
          preserveInsertionOrder: boolean | null
          tempDirectory: string | null
          threads: string | null
        }
        instanceOptions: {
          memory_limit: string
          preserve_insertion_order: string
          temp_directory?: string
          threads: string
        }
        queues: {
          background: {maxQueueDepth: number; queueDepth: number; tasksCompleted: number; tasksStarted: number}
          main: {maxQueueDepth: number; queueDepth: number; tasksCompleted: number; tasksStarted: number}
        }
      }
      pid: number
      processMemory: {heapUsedBytes: number; rssBytes: number}
      projectMartLargeRebuildHeartbeat: {
        automatic: {batchSize: number; maxCyclesPerWake: number; pollIntervalMs: number}
        batchSize: number
        maxCyclesPerWake: number
        pollIntervalMs: number
        sources: {batchSize: string; maxCyclesPerWake: string; pollIntervalMs: string}
        stored: {tuningMode: string}
      }
      projectMartLargeRebuildRuntimeMetrics: {
        recentCycles: unknown[]
        totals: {
          cyclesCompleted: number
          cyclesFailed: number
          cyclesIdle: number
          cyclesProgressed: number
          rowsProcessed: number
        }
      }
      role: string
      serverRole: string | null
    }

    expect(responseBody.serverRole).toBe('maintenance-worker')
    expect(responseBody.role).toBe('maintenance-worker')
    expect(responseBody.pid).toBeGreaterThan(0)
    expect(responseBody.duckdb.configured.appendLaneCount).toBeGreaterThan(0)
    expect(responseBody.duckdb.configured.memoryLimit).toBe('256MiB')
    expect(responseBody.duckdb.configured.preserveInsertionOrder).toBe(false)
    expect(responseBody.duckdb.configured.serializeConcurrentWork).toBe(true)
    expect(responseBody.duckdb.configured.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.configured.threads).toBe('1')
    expect(responseBody.duckdb.instanceOptions).toEqual({
      memory_limit: '256MiB',
      preserve_insertion_order: 'false',
      temp_directory: tempDirectory,
      threads: '1',
    })
    expect(responseBody.duckdb.effective.memoryLimit).toBe('256.0 MiB')
    expect(responseBody.duckdb.effective.preserveInsertionOrder).toBe(false)
    expect(responseBody.duckdb.effective.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.effective.threads).toBe('1')
    expect(responseBody.duckdb.queues.main.tasksStarted).toBeGreaterThan(0)
    expect(responseBody.duckdb.queues.main.tasksCompleted).toBeGreaterThan(0)
    expect(responseBody.duckdb.queues.main.queueDepth).toBe(0)
    expect(responseBody.duckdb.queues.background.tasksStarted).toBe(0)
    expect(responseBody.duckdb.queues.background.tasksCompleted).toBe(0)
    expect(responseBody.duckdb.queues.background.queueDepth).toBe(0)
    expect(responseBody.processMemory.rssBytes).toBeGreaterThan(0)
    expect(responseBody.processMemory.heapUsedBytes).toBeGreaterThan(0)
    expect(responseBody.projectMartLargeRebuildHeartbeat.batchSize).toBe(8)
    expect(responseBody.projectMartLargeRebuildHeartbeat.maxCyclesPerWake).toBe(4)
    expect(responseBody.projectMartLargeRebuildHeartbeat.pollIntervalMs).toBe(1500)
    expect(responseBody.projectMartLargeRebuildHeartbeat.sources).toEqual({
      batchSize: 'env',
      maxCyclesPerWake: 'env',
      pollIntervalMs: 'env',
    })
    expect(responseBody.projectMartLargeRebuildHeartbeat.stored.tuningMode).toBe('automatic')
    expect(responseBody.projectMartLargeRebuildHeartbeat.automatic.batchSize).toBeGreaterThan(0)
    expect(responseBody.projectMartLargeRebuildHeartbeat.automatic.maxCyclesPerWake).toBeGreaterThan(0)
    expect(responseBody.projectMartLargeRebuildHeartbeat.automatic.pollIntervalMs).toBeGreaterThan(0)
    expect(responseBody.projectMartLargeRebuildRuntimeMetrics.recentCycles).toEqual([])
    expect(responseBody.projectMartLargeRebuildRuntimeMetrics.totals).toEqual({
      cyclesCompleted: 0,
      cyclesFailed: 0,
      cyclesIdle: 0,
      cyclesProgressed: 0,
      rowsProcessed: 0,
    })
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart large rebuild run route triggers bounded rebuild cycles for the selected project', () => {
  const duckdbPath = `/tmp/f1-admin-large-rebuild-run-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-admin-large-rebuild-run', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-admin-large-rebuild-run', 'connection-admin-large-rebuild-run', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-admin-large-rebuild-run', 'Admin Large Rebuild Run', FALSE, 'model-admin-large-rebuild-run', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_refresh_state (project_id, dirty_token, active_refresh_token, last_completed_refresh_token, refresh_status)
          VALUES ('project-admin-large-rebuild-run', 0, 0, 0, 'idle')
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-admin-large-rebuild-run', 'Prompt admin large rebuild run', 'hash-admin-large-rebuild-run')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-admin-large-rebuild-run', 'project-admin-large-rebuild-run', 'prompt-admin-large-rebuild-run', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
          VALUES ('article-admin-large-rebuild-run', 'Article admin large rebuild run', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z')
        \`)
        await database.run(\`
          INSERT INTO mart.project_scope_article (
            project_id,
            article_id,
            in_curated_scope,
            in_route_scope,
            article_created_at,
            article_updated_at
          ) VALUES (
            'project-admin-large-rebuild-run',
            'article-admin-large-rebuild-run',
            TRUE,
            FALSE,
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO mart.judgment_fact (
            judgment_id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            snapshot_project_model_name,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            chunking_strategy,
            is_answered,
            answered_original,
            answered_original_as_array,
            normalized_answers,
            confidence_original,
            explanation,
            quotes,
            article_title,
            article_created_at,
            article_updated_at,
            article_import_route,
            article_publication_status,
            created_at,
            updated_at
          ) VALUES (
            'judgment-admin-large-rebuild-run',
            'article-admin-large-rebuild-run',
            'prompt-admin-large-rebuild-run',
            'model-admin-large-rebuild-run',
            'project-admin-large-rebuild-run',
            'project-admin-large-rebuild-run',
            'Project project-admin-large-rebuild-run',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            NULL,
            TRUE,
            'yes',
            ['yes'],
            ['yes'],
            1,
            NULL,
            NULL,
            'Article admin large rebuild run',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z',
            NULL,
            NULL,
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (project_id, refresh_token, rebuild_phase, refresh_status)
          VALUES ('project-admin-large-rebuild-run', 3, 'prompt_answer_fact', 'idle')
        \`)

        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(
          new Request('http://localhost/api/admin/project-mart-large-rebuild-run', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({projectId: 'project-admin-large-rebuild-run', maxCycles: 1, until: 'max-cycles', batchSize: 1, workerId: 'admin-runner'}),
          }),
        )
        console.log(await response.text())
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin large rebuild run route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      completedCycles: number
      cycleResults: Array<{projectId: string | null; status: string}>
      status: string
      stopReason: string
      workerId: string
    }

    expect(responseBody.status).toBe('completed')
    expect(responseBody.stopReason).toBe('max-cycles')
    expect(responseBody.completedCycles).toBe(1)
    expect(responseBody.workerId).toBe('admin-runner')
    expect(responseBody.cycleResults[0]?.projectId).toBe('project-admin-large-rebuild-run')
    expect(responseBody.cycleResults[0]?.status).toBe('progressed')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart large rebuild pause and resume routes toggle operator status explicitly', () => {
  const duckdbPath = `/tmp/f1-admin-large-rebuild-pause-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-admin-large-rebuild-pause', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-admin-large-rebuild-pause', 'connection-admin-large-rebuild-pause', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-admin-large-rebuild-pause', 'Admin Large Rebuild Pause', FALSE, 'model-admin-large-rebuild-pause', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (project_id, refresh_token, rebuild_phase, refresh_status, cursor_article_id)
          VALUES ('project-admin-large-rebuild-pause', 4, 'prompt_answer_fact', 'idle', 'article-pause-1')
        \`)

        const app = new Elysia().use(adminInvestigateRoutes)
        const pausedResponse = await app.handle(
          new Request('http://localhost/api/admin/project-mart-large-rebuild-pause', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({projectId: 'project-admin-large-rebuild-pause', reason: 'Paused by operator for inspection'}),
          }),
        )
        const resumedResponse = await app.handle(
          new Request('http://localhost/api/admin/project-mart-large-rebuild-resume', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({projectId: 'project-admin-large-rebuild-pause'}),
          }),
        )
        console.log(JSON.stringify({paused: await pausedResponse.json(), resumed: await resumedResponse.json()}))
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin large rebuild pause route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      paused: {cursorArticleId: string | null; lastError: string | null; refreshStatus: string}
      resumed: {cursorArticleId: string | null; refreshStatus: string}
    }

    expect(responseBody.paused.refreshStatus).toBe('paused')
    expect(responseBody.paused.cursorArticleId).toBe('article-pause-1')
    expect(responseBody.paused.lastError).toBe('Paused by operator for inspection')
    expect(responseBody.resumed.refreshStatus).toBe('idle')
    expect(responseBody.resumed.cursorArticleId).toBe('article-pause-1')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart large rebuild note route persists operator notes without overwriting errors', () => {
  const duckdbPath = `/tmp/f1-admin-large-rebuild-note-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-admin-large-rebuild-note', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-admin-large-rebuild-note', 'connection-admin-large-rebuild-note', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-admin-large-rebuild-note', 'Admin Large Rebuild Note', FALSE, 'model-admin-large-rebuild-note', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (project_id, refresh_token, rebuild_phase, refresh_status, last_error)
          VALUES ('project-admin-large-rebuild-note', 4, 'prompt_answer_fact', 'failed', 'existing failure')
        \`)

        const app = new Elysia().use(adminInvestigateRoutes)
        const noteResponse = await app.handle(
          new Request('http://localhost/api/admin/project-mart-large-rebuild-note', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({projectId: 'project-admin-large-rebuild-note', note: 'Watch cursor after restarting worker'}),
          }),
        )
        console.log(JSON.stringify(await noteResponse.json()))
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin large rebuild note route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      lastError: string | null
      operatorNote: string | null
      refreshStatus: string
    }

    expect(responseBody.refreshStatus).toBe('failed')
    expect(responseBody.lastError).toBe('existing failure')
    expect(responseBody.operatorNote).toBe('Watch cursor after restarting worker')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
