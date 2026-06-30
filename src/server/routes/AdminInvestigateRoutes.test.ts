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

test('admin clear databases route rebuilds DuckDB and removes judgment job SQLite files', () => {
  const runtimeRoot = `/tmp/f1-admin-clear-databases-route-${Date.now()}`
  const duckdbPath = `${runtimeRoot}/forska.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {existsSync, writeFileSync} = await import('node:fs')
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getJudgmentJobSqlitePath} = await import('./src/server/cron/judgmentsJobs/judgmentJobPaths.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getProductApiRoutes} = await import('./src/server/routes/productApiRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        await database.run(\`INSERT INTO app.prompt (id, original_text, content_hash) VALUES ('clear-route-prompt', 'Prompt', 'clear-route-hash')\`)

        const sqlitePath = getJudgmentJobSqlitePath('clear-route-job')
        writeFileSync(sqlitePath, 'sqlite-state')

        const app = new Elysia().use(getProductApiRoutes())
        const response = await app.handle(new Request('http://localhost/api/admin/clear-databases', {method: 'POST'}))
        const responseBody = await response.json()
        const projectsResponse = await app.handle(new Request('http://localhost/api/projects'))
        const projectsBody = await projectsResponse.json()
        const [promptCountRow] = await database.queryJson(\`SELECT COUNT(*)::INTEGER AS count FROM app.prompt\`)
        const [migrationCountRow] = await database.queryJson(\`SELECT COUNT(*)::INTEGER AS count FROM app_schema_migration\`)

        console.log(JSON.stringify({
          leaseExists: existsSync(\`${duckdbPath}.duckdb-owner.lock\`),
          migrationCount: migrationCountRow?.count ?? 0,
          promptCount: promptCountRow?.count ?? 0,
          projectsBody,
          projectsStatus: projectsResponse.status,
          responseBody,
          sqliteExists: existsSync(sqlitePath),
          status: response.status,
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin clear databases route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      leaseExists: boolean
      migrationCount: number
      promptCount: number
      projectsBody: {data?: unknown[]; error?: string}
      projectsStatus: number
      responseBody: {data?: {migrated?: boolean}; error?: string}
      sqliteExists: boolean
      status: number
    }

    expect(responseBody).toMatchObject({
      leaseExists: true,
      promptCount: 0,
      projectsBody: {data: []},
      projectsStatus: 200,
      responseBody: {data: {migrated: true}},
      sqliteExists: false,
      status: 200,
    })
    expect(responseBody.migrationCount).toBeGreaterThan(0)
  } finally {
    removeFileIfExists(runtimeRoot)
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
          checkpointThreshold: string
          memoryLimit: string
          preserveInsertionOrder: boolean
          serializeConcurrentWork: boolean
          tempDirectory: string | null
          threads: string
        }
        effective: {
          checkpointThreshold: string | null
          memoryLimit: string | null
          preserveInsertionOrder: boolean | null
          tempDirectory: string | null
          threads: string | null
        }
        instanceOptions: {
          checkpoint_threshold: string
          memory_limit: string
          preserve_insertion_order: string
          temp_directory?: string
          threads: string
        }
        queues: {
          background: {maxQueueDepth: number; queueDepth: number; tasksCompleted: number; tasksStarted: number}
          main: {maxQueueDepth: number; queueDepth: number; tasksCompleted: number; tasksStarted: number}
        }
        tempSpill: {
          available: boolean
          error: string | null
          fileCount: number | null
          tempDirectory: string | null
          totalBytes: number | null
        }
      }
      pid: number
      processMemory: {heapUsedBytes: number; rssBytes: number}
      role: string
      serverRole: string | null
    }

    expect(responseBody.serverRole).toBe('maintenance-worker')
    expect(responseBody.role).toBe('maintenance-worker')
    expect(responseBody.pid).toBeGreaterThan(0)
    expect(responseBody.duckdb.configured.appendLaneCount).toBeGreaterThan(0)
    expect(responseBody.duckdb.configured.checkpointThreshold).toBe('8GB')
    expect(responseBody.duckdb.configured.memoryLimit).toBe('256MiB')
    expect(responseBody.duckdb.configured.preserveInsertionOrder).toBe(false)
    expect(responseBody.duckdb.configured.serializeConcurrentWork).toBe(true)
    expect(responseBody.duckdb.configured.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.configured.threads).toBe('1')
    expect(responseBody.duckdb.instanceOptions).toEqual({
      checkpoint_threshold: '8GB',
      memory_limit: '256MiB',
      preserve_insertion_order: 'false',
      temp_directory: tempDirectory,
      threads: '1',
    })
    expect(responseBody.duckdb.effective.checkpointThreshold).toBe('7.4 GiB')
    expect(responseBody.duckdb.effective.memoryLimit).toBe('256.0 MiB')
    expect(responseBody.duckdb.effective.preserveInsertionOrder).toBe(false)
    expect(responseBody.duckdb.effective.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.effective.threads).toBe('1')
    expect(responseBody.duckdb.tempSpill.available).toBe(true)
    expect(responseBody.duckdb.tempSpill.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.tempSpill.totalBytes).toBeGreaterThanOrEqual(0)
    expect(responseBody.duckdb.queues.main.tasksStarted).toBeGreaterThan(0)
    expect(responseBody.duckdb.queues.main.tasksCompleted).toBeGreaterThan(0)
    expect(responseBody.duckdb.queues.main.queueDepth).toBe(0)
    expect(responseBody.duckdb.queues.background.tasksStarted).toBe(0)
    expect(responseBody.duckdb.queues.background.tasksCompleted).toBe(0)
    expect(responseBody.duckdb.queues.background.queueDepth).toBe(0)
    expect(responseBody.processMemory.rssBytes).toBeGreaterThan(0)
    expect(responseBody.processMemory.heapUsedBytes).toBeGreaterThan(0)
    expect('projectMartLargeRebuildHeartbeat' in responseBody).toBe(false)
    expect('projectMartLargeRebuildRuntimeMetrics' in responseBody).toBe(false)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(tempDirectory)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin worker runtime diagnostics route reports local capabilities, registry state, and shared ack visibility', () => {
  const duckdbPath = `/tmp/f1-admin-worker-runtime-diagnostics-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {getJudgmentJobSqliteHealthProjectionService} = await import('./src/server/services/judgmentJobSqliteHealthProjectionService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')
        const {upsertDuckdbOwnerConnectionHeartbeat} = await import('./src/server/utils/duckdbOwnerConnections.ts')
        const {getRuntimeCutoverVersion} = await import('./src/server/utils/runtimeCutover.ts')
        const {validateOwnerlessRouteBackends} = await import('./src/server/utils/ownerlessReadableBackends.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const nowIso = new Date().toISOString()
        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('connection-worker-diagnostics', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('model-worker-diagnostics', 'connection-worker-diagnostics', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('project-worker-diagnostics', 'Worker Diagnostics', FALSE, 'model-worker-diagnostics', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.judgment_job (id, project_id, status, storage_state)
          VALUES ('job-worker-diagnostics', 'project-worker-diagnostics', 'running', 'active')
        \`)
        await getJudgmentJobSqliteHealthProjectionService().publishJudgmentJobSqliteHealthProjection({
          jobId: 'job-worker-diagnostics',
          projectedBy: 'judge-worker-diagnostics',
          projectionSource: 'local-sqlite',
          health: {
            claimedOutboxCount: 0,
            hasOutboxRows: false,
            hasPendingCompletionAck: true,
            hasQueueRows: false,
            lastAckSeq: 7,
            oldestUnackedCompletionAgeMs: 1234,
            oldestUnexportedAgeMs: null,
            orphanedJudgedRowCount: 0,
            outboxRowCount: 0,
            pendingCompletionAckCount: 2,
            promptCounts: {claimed: 0, judged: 1, ready: 0, running: 0, skipped: 0},
            retainedRowCount: 0,
            sqliteFileBytes: 4096,
            walBytes: 0,
          },
        })
        await upsertDuckdbOwnerConnectionHeartbeat(
          {
            apiServerPort: 4101,
            capabilities: ['duckdb-owner', 'maintenance'],
            hostname: 'registry-host',
            instanceId: \`maintenance-worker-server:registry-host:4101:1001:\${nowIso}\`,
            listenPort: 4101,
            memoryLimit: '20GB',
            pid: 1001,
            processStartedAt: nowIso,
            runtimeProfile: 'local',
            runtimeVersion: getRuntimeCutoverVersion(),
            serverRole: 'maintenance-worker',
            service: 'maintenance-worker-server',
            startedAt: nowIso,
            throughputProfile: {
              batchSize: 8,
              martRefreshDrainEligible: true,
              maxCyclesPerWake: 4,
              pollIntervalMs: 1500,
              profile: 'maintenance',
            },
            takeover: {
              candidate: false,
              intent: 'none',
              observedAt: nowIso,
              ownerFreshness: 'owner_fresh',
              ownerHeartbeatAt: nowIso,
              ownerLeaseId: 'lease-worker-diagnostics',
              ownerUrl: 'http://127.0.0.1:4101',
            },
            duckdbOwnerUrl: 'http://127.0.0.1:4101',
          },
          {databasePath: '${duckdbPath}'},
        )
        await upsertDuckdbOwnerConnectionHeartbeat(
          {
            apiServerPort: 4102,
            capabilities: ['judging'],
            hostname: 'registry-host',
            instanceId: \`judge-worker-server:registry-host:4102:1002:\${nowIso}\`,
            listenPort: 4102,
            memoryLimit: null,
            pid: 1002,
            processStartedAt: nowIso,
            runtimeProfile: 'local',
            runtimeVersion: getRuntimeCutoverVersion(),
            serverRole: 'judge-worker',
            service: 'judge-worker-server',
            startedAt: nowIso,
            duckdbOwnerUrl: 'http://127.0.0.1:4101',
          },
          {databasePath: '${duckdbPath}'},
        )
        await validateOwnerlessRouteBackends()

        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(new Request('http://localhost/api/admin/worker-runtime-diagnostics'))
        console.log(await response.text())
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3001',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        FORSKA_OWNERLESS_READ_ONLY_DUCKDB: 'disabled',
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString()
          || runRoute.stdout.toString()
          || 'Admin worker runtime diagnostics route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      capabilities: string[]
      cutoverRefusal: {
        refusedRegisteredProcessCount: number
        refusesMissingRuntimeVersion: boolean
        runtimeVersion: string
        status: string
      }
      duckdbOwnership: {canOwnDuckdb: boolean; ownsDuckdb: boolean}
      localRole: string | null
      ownerlessBackends: {validated: boolean; workerRuntimeDiagnostics: {backend: string; pathname: string} | null}
      pendingCompletionAckVisibility: {
        available: boolean
        freshProjectionCount: number
        hasPendingCompletionAck: boolean
        jobCount: number
        pendingCompletionAckCount: number
      }
      readPath: {judgmentJobs: {mode: string; sharedProjectionFreshnessMs: number}}
      registry: {
        capabilities: Array<{capability: string; eligibleConsumerCount: number; eligibleConsumerPresent: boolean}>
        freshRegisteredProcessCount: number
        registeredProcessCount: number
        takeover: {status: string}
      }
      registryDerivedEligibleConsumers: Array<{
        capability: string
        eligibleConsumerCount: number
        eligibleConsumerPresent: boolean
      }>
      routeServing: {duckdbOwnerPrivateApi: boolean; mode: string; publicProductApi: boolean}
      serverRole: string
      takeoverState: {status: string}
    }
    const maintenanceCapability = responseBody.registry.capabilities.find((capability) => {
      return capability.capability === 'maintenance'
    })
    const judgingCapability = responseBody.registryDerivedEligibleConsumers.find((capability) => {
      return capability.capability === 'judging'
    })

    expect(responseBody.localRole).toBe('dev-single')
    expect(responseBody.serverRole).toBe('dev-single')
    expect(responseBody.capabilities).toEqual(['api', 'duckdb-owner', 'maintenance', 'judging'])
    expect(responseBody.duckdbOwnership).toMatchObject({canOwnDuckdb: true, ownsDuckdb: true})
    expect(responseBody.routeServing).toMatchObject({
      duckdbOwnerPrivateApi: true,
      mode: 'public-and-duckdb-owner-private',
      publicProductApi: true,
    })
    expect(responseBody.ownerlessBackends.validated).toBe(true)
    expect(responseBody.ownerlessBackends.workerRuntimeDiagnostics).toMatchObject({
      backend: 'ownerless-control-state',
      pathname: '/api/admin/worker-runtime-diagnostics',
    })
    expect(responseBody.registry.registeredProcessCount).toBeGreaterThanOrEqual(3)
    expect(responseBody.registry.freshRegisteredProcessCount).toBeGreaterThanOrEqual(3)
    expect(maintenanceCapability?.eligibleConsumerPresent).toBe(true)
    expect(maintenanceCapability?.eligibleConsumerCount).toBeGreaterThanOrEqual(1)
    expect(judgingCapability?.eligibleConsumerPresent).toBe(true)
    expect(responseBody.takeoverState.status).toBe(responseBody.registry.takeover.status)
    expect(responseBody.cutoverRefusal.runtimeVersion).toBe('split-runtime-v1')
    expect(responseBody.cutoverRefusal.status).toBe('enforced')
    expect(responseBody.cutoverRefusal.refusesMissingRuntimeVersion).toBe(true)
    expect(responseBody.cutoverRefusal.refusedRegisteredProcessCount).toBe(0)
    expect(responseBody.readPath.judgmentJobs.mode).toBe('local-sqlite')
    expect(responseBody.readPath.judgmentJobs.sharedProjectionFreshnessMs).toBe(30_000)
    expect(responseBody.pendingCompletionAckVisibility).toMatchObject({
      available: true,
      freshProjectionCount: 1,
      hasPendingCompletionAck: true,
      jobCount: 1,
      pendingCompletionAckCount: 2,
    })
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.worker-registry`)
  }
})

test('admin project mart large rebuild run route is retired for the selected project', () => {
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
          INSERT INTO app.project_mart_refresh_state (project_id, dirty_token, active_dirty_token, last_completed_dirty_token, refresh_status)
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
            body: JSON.stringify({projectId: 'project-admin-large-rebuild-run', maxCycles: 1, maxWakeMs: 10_000, until: 'max-cycles', batchSize: 1, workerId: 'admin-runner'}),
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
      projectId: string
      retired: boolean
      status: string
    }

    expect(responseBody).toMatchObject({projectId: 'project-admin-large-rebuild-run', retired: true, status: 'retired'})
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart large rebuild pause and resume routes are retired', () => {
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
      paused: {projectId: string; retired: boolean; status: string}
      resumed: {projectId: string; retired: boolean; status: string}
    }

    expect(responseBody.paused).toMatchObject({
      projectId: 'project-admin-large-rebuild-pause',
      retired: true,
      status: 'retired',
    })
    expect(responseBody.resumed).toMatchObject({
      projectId: 'project-admin-large-rebuild-pause',
      retired: true,
      status: 'retired',
    })
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart large rebuild note route is retired', () => {
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
      projectId: string
      retired: boolean
      status: string
    }

    expect(responseBody).toMatchObject({
      projectId: 'project-admin-large-rebuild-note',
      retired: true,
      status: 'retired',
    })
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('admin project mart dirty-materialization requeue route is retired', async () => {
  const {Elysia} = await import('elysia')
  const {adminInvestigateRoutes} = await import('./AdminInvestigateRoutes.ts')
  const app = new Elysia().use(adminInvestigateRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/admin/project-mart-dirty-materialization-requeue', {
      body: JSON.stringify({
        projectId: 'project-admin-dirty-materialization-requeue',
        sourceKind: 'project_scope',
        targetDirtyToken: 42,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const responseBody = (await response.json()) as {
    projectId: string
    retired: boolean
    sourceKind: string
    status: string
    targetDirtyToken: number
  }

  expect(responseBody).toMatchObject({
    projectId: 'project-admin-dirty-materialization-requeue',
    retired: true,
    sourceKind: 'project_scope',
    status: 'retired',
    targetDirtyToken: 42,
  })
})
