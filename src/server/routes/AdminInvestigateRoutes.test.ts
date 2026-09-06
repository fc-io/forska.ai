import {readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, setDefaultTimeout, test} from 'bun:test'

setDefaultTimeout(120_000)

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
  const duckdbPath = join(tmpdir(), `f1-admin-append-metrics-route-${Date.now()}.duckdb`)
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

test('admin duckdb runtime workloads route returns non-querying active work diagnostics', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')

        const duckdbServiceModulePath = new URL('./src/server/utils/duckdbService.ts', 'file://' + process.cwd() + '/').href
        const actualDuckdbService = await import('./src/server/utils/duckdbService.ts?runtime-workloads-route-test=' + Date.now())

        void mock.module(duckdbServiceModulePath, () => {
          return {
            ...actualDuckdbService,
            getDuckdbBackgroundRuntimeDiagnostics: async () => {
              throw new Error('maintenance settings diagnostics should not be queried')
            },
            getDuckdbRuntimeWorkloadDiagnosticsSnapshot: () => ({
              activeMainWork: {
                durationMs: 42,
                operation: 'mainQuery',
                queue: 'main',
                queueDepthAtStart: 1,
                queueWaitMs: 7,
                routeOrJobKey: 'llmStatus.route',
                startedAt: '2026-08-12T12:00:00.000Z',
                statementHash: 'abcdef123456',
                statementKind: 'SELECT',
                workloadClass: 'foreground-diagnostic',
              },
              queues: {main: {queueDepth: 1}, background: {queueDepth: 0}},
              workloads: [],
            }),
          }
        })

        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')
        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(new Request('http://localhost/api/admin/duckdb-runtime-workloads'))
        console.log(await response.text())
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, API_SERVER_PORT: '3001', SERVER_ROLE: 'maintenance-worker', VITE_PORT: '3000'},
    },
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin DuckDB runtime workloads route test failed',
    )
  }

  const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    activeMainWork: {routeOrJobKey: string; statementHash: string; workloadClass: string}
    queues: {main: {queueDepth: number}}
    workloads: unknown[]
  }

  expect(responseBody.activeMainWork).toMatchObject({
    routeOrJobKey: 'llmStatus.route',
    statementHash: 'abcdef123456',
    workloadClass: 'foreground-diagnostic',
  })
  expect(responseBody.queues.main.queueDepth).toBe(1)
  expect(responseBody.workloads).toEqual([])
})

test('admin clear databases route rebuilds DuckDB and removes judgment job SQLite files', () => {
  const runtimeRoot = join(tmpdir(), `f1-admin-clear-databases-route-${Date.now()}`)
  const duckdbPath = join(runtimeRoot, 'forska.duckdb')
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
          leaseExists: existsSync(process.env.DUCKDB_PATH + '.duckdb-owner.lock'),
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
  const duckdbPath = join(tmpdir(), `f1-admin-maintenance-runtime-diagnostics-${Date.now()}.duckdb`)
  const tempDirectory = join(tmpdir(), `f1-admin-maintenance-runtime-diagnostics-temp-${Date.now()}`)
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
    expect(responseBody.duckdb.configured.checkpointThreshold).toBe('64MiB')
    expect(responseBody.duckdb.configured.memoryLimit).toBe('256MiB')
    expect(responseBody.duckdb.configured.preserveInsertionOrder).toBe(false)
    expect(responseBody.duckdb.configured.serializeConcurrentWork).toBe(true)
    expect(responseBody.duckdb.configured.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.configured.threads).toBe('1')
    expect(responseBody.duckdb.instanceOptions).toEqual({
      checkpoint_threshold: '64MiB',
      memory_limit: '256MiB',
      preserve_insertion_order: 'false',
      temp_directory: tempDirectory,
      threads: '1',
    })
    expect(responseBody.duckdb.effective.checkpointThreshold).toBe('64MiB')
    expect(responseBody.duckdb.effective.memoryLimit).toBe('256MiB')
    expect(responseBody.duckdb.effective.preserveInsertionOrder).toBe(false)
    expect(responseBody.duckdb.effective.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.effective.threads).toBe('1')
    expect(responseBody.duckdb.tempSpill.tempDirectory).toBe(tempDirectory)
    expect(responseBody.duckdb.queues.main.tasksStarted).toBe(0)
    expect(responseBody.duckdb.queues.main.tasksCompleted).toBe(0)
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
  const duckdbPath = join(tmpdir(), `f1-admin-worker-runtime-diagnostics-${Date.now()}.duckdb`)
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
          {databasePath: process.env.DUCKDB_PATH},
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
          {databasePath: process.env.DUCKDB_PATH},
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

test('retired project mart admin mutation routes are removed from admin investigate routes', async () => {
  const adminSource = readFileSync(`${process.cwd()}/src/server/routes/AdminInvestigateRoutes.ts`, 'utf8')
  const removedRoutePaths = [
    '/api/admin/project-mart-large-rebuild-run',
    '/api/admin/project-mart-large-rebuild-pause',
    '/api/admin/project-mart-large-rebuild-resume',
    '/api/admin/project-mart-large-rebuild-note',
    '/api/admin/project-mart-dirty-materialization-requeue',
  ]
  const removedHelpers = [
    'RetiredProjectMartLargeRebuildMutationResponse',
    'RetiredProjectMartDirtyMaterializationMutationResponse',
    'getRetiredProjectMartLargeRebuildMutationResponse',
    'getRetiredProjectMartDirtyMaterializationMutationResponse',
  ]

  for (const removedText of [...removedRoutePaths, ...removedHelpers]) {
    expect(adminSource).not.toContain(removedText)
  }

  const {Elysia} = await import('elysia')
  const {adminInvestigateRoutes} = await import('./AdminInvestigateRoutes.ts')
  const app = new Elysia().use(adminInvestigateRoutes)

  for (const routePath of removedRoutePaths) {
    const response = await app.handle(
      new Request(`http://localhost${routePath}`, {
        body: JSON.stringify({projectId: 'removed-project-mart-admin-route'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    )

    expect(response.status).toBe(404)
  }
})
