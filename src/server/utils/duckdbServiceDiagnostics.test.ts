import {expect, test} from 'bun:test'

type DiagnosticEvent = {
  attrs: {
    connectionRole: string
    durationMs: number | null
    errorName: string | null
    lane: number | null
    operation: string
    phase: string
    progress: {percentage: number; rowsProcessed: string; totalRowsToProcess: string} | null
    progressSource: string | null
    queue: string
    queueDepthAtStart: number
    routeOrJobKey: string
    statementExecutionId: string
    statementHash: string
    statementKind: string
    statementTargetTable: string | null
    workloadClass: string
  }
  event: string
  message: string
  severity: string
}

const getSpawnOutput = (result: ReturnType<typeof globalThis.Bun.spawnSync>) => {
  const stderr = Buffer.from(result.stderr ?? []).toString()
  const stdout = Buffer.from(result.stdout ?? []).toString()

  if (result.exitCode !== 0) {
    throw new Error(stderr || stdout || `Process exited with code ${result.exitCode}`)
  }

  return stdout.trim()
}

test('duckdb native statement diagnostics identify workload and connection without logging SQL', () => {
  const privateSqlValue = 'private-project-value'
  const stdout = getSpawnOutput(
    globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {mock} = await import('bun:test')

          const runtimeLoggerModulePath = new URL('./src/server/utils/runtimeLogger.ts', 'file://' + process.cwd() + '/').pathname
          const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname
          const events = []
          let connectCount = 0

          void mock.module(runtimeLoggerModulePath, () => {
            return {
              exitWithRuntimeLogFlush: async () => {},
              getRuntimeLogConfig: () => ({
                logDir: '/tmp/forska-duckdb-diagnostics-test',
                logLevel: 'INFO',
                logStderrLevel: 'WARN',
                runtimeProfile: 'local',
              }),
              writeRuntimeFailureLogEvent: () => false,
              writeRuntimeLogEvent: (event) => {
                events.push(event)
                throw new Error('diagnostic sink unavailable')
              },
              writeRuntimeOperatorLogEvent: () => false,
            }
          })

          void mock.module(serverRuntimeRoleModulePath, () => {
            return {
              canCurrentServerOwnDuckdb: () => true,
              ensureCurrentDuckdbOwnerLease: async () => {},
              registerDuckdbOwnerDemotionHandler: () => {},
              releaseCurrentDuckdbOwnerLease: async () => {},
            }
          })

          void mock.module('@duckdb/node-api', () => {
            class MockConnection {
              constructor(kind) {
                this.kind = kind
              }

              get progress() {
                return {percentage: 100, rows_processed: 3n, total_rows_to_process: 3n}
              }

              async run(statement) {
                if (statement.includes('BLOCK_QUEUE')) {
                  await new Promise((resolve) => setTimeout(resolve, 10))
                }

                if (statement.includes('FAIL_NATIVE')) {
                  throw new TypeError('native failure')
                }
              }

              async runAndReadAll() {
                return {getRowObjectsJson: () => [{value: 1}]}
              }

              interrupt() {}
              closeSync() {}
            }

            class MockInstance {
              static async create() {
                return new MockInstance()
              }

              async connect() {
                connectCount += 1
                return new MockConnection(connectCount === 1 ? 'control' : 'secondary')
              }

              closeSync() {}
            }

            return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
          })

          const service = await import('./src/server/utils/duckdbService.ts')
          const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
          const appDatabase = getAppDatabaseService()
          const rows = await service.runDuckdbJsonQuery("SELECT '${privateSqlValue}' AS value", {
            routeOrJobKey: 'reviewServing.summary.request',
            workloadClass: 'reviewProjector',
          })
          await service.runDuckdbJsonQuery('WITH recent_rows AS (SELECT * FROM app.review_serving_snapshot_manifest) SELECT * FROM recent_rows', {
            routeOrJobKey: 'reviewServing.summary.read',
            workloadClass: 'reviewProjector',
          })
          await service.runDuckdbAppendJsonQuery('SELECT 1 AS value', undefined, undefined, {
            routeOrJobKey: 'reviewServing.summary.append',
            workloadClass: 'reviewProjector',
          })
          const error = await service.runDuckdbBackgroundStatement('FAIL_NATIVE ${privateSqlValue}', {
            routeOrJobKey: 'maintenance.summary.refresh',
            workloadClass: 'maintenance',
          }).then(() => null, (caughtError) => caughtError)
          await Promise.all([
            appDatabase.transaction(async (tx) => {
              await tx.run('SELECT BLOCK_QUEUE')
            }, {
              routeOrJobKey: 'maintenance.blockingTransaction',
              workloadClass: 'maintenance',
            }),
            appDatabase.transaction(async (tx) => {
              await service.runWithDuckdbWorkloadDiagnosticContext({
                routeOrJobKey: 'reviewServing.projector.writer.snapshotPromotion',
                workloadClass: 'reviewProjector',
              }, async () => {
                await tx.run("INSERT INTO app.review_serving_snapshot_manifest VALUES ('${privateSqlValue}')")
              })
            }, {
              routeOrJobKey: 'reviewServing.projector.writer.summary',
              workloadClass: 'reviewProjector',
            }),
          ])

          await service.closeDuckdbService({checkpointBeforeClose: false})
          console.log(JSON.stringify({errorName: error?.name ?? null, events, rows}))
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DUCKDB_APPEND_LANE_COUNT: '1',
          DUCKDB_MEMORY_LIMIT: '20GB',
          DUCKDB_PATH: ':memory:',
          SERVER_ROLE: 'maintenance-worker',
        },
      },
    ),
  )
  const result = JSON.parse(stdout) as {errorName: string | null; events: DiagnosticEvent[]; rows: unknown[]}
  const [queryStart, queryEnd, readStart, readEnd, appendStart, appendEnd, statementStart, statementError] =
    result.events
  const transactionEvents = result.events.filter((event) => {
    return event.attrs.routeOrJobKey === 'reviewServing.projector.writer.snapshotPromotion'
  })

  expect(result.rows).toEqual([{value: 1}])
  expect(result.errorName).toBe('Error')
  expect(result.events).toHaveLength(20)
  expect(JSON.stringify(result.events)).not.toContain(privateSqlValue)
  expect(queryStart).toMatchObject({
    attrs: {
      connectionRole: 'control',
      durationMs: null,
      lane: null,
      operation: 'mainQuery',
      phase: 'start',
      progress: null,
      queue: 'main',
      routeOrJobKey: 'reviewServing.summary.request',
      statementKind: 'SELECT',
      statementTargetTable: null,
      workloadClass: 'reviewProjector',
    },
    event: 'duckdb.statement.start',
    severity: 'INFO',
  })
  expect(queryEnd).toMatchObject({
    attrs: {
      connectionRole: 'control',
      operation: 'mainQuery',
      phase: 'end',
      progress: {percentage: 100, rowsProcessed: '3', totalRowsToProcess: '3'},
      progressSource: 'DuckDBConnection.progress -> @duckdb/node-bindings.query_progress',
    },
    event: 'duckdb.statement.end',
    severity: 'INFO',
  })
  expect(readStart).toMatchObject({
    attrs: {
      operation: 'mainQuery',
      routeOrJobKey: 'reviewServing.summary.read',
      statementKind: 'WITH',
      statementTargetTable: 'app.review_serving_snapshot_manifest',
      workloadClass: 'reviewProjector',
    },
    event: 'duckdb.statement.start',
  })
  expect(readStart?.attrs.statementExecutionId).toBe(readEnd?.attrs.statementExecutionId)
  expect(appendStart).toMatchObject({
    attrs: {
      connectionRole: 'append',
      lane: 0,
      operation: 'appendQuery',
      phase: 'start',
      queue: 'main',
      routeOrJobKey: 'reviewServing.summary.append',
    },
  })
  expect(appendStart?.attrs.statementExecutionId).toBe(appendEnd?.attrs.statementExecutionId)
  expect(statementStart).toMatchObject({
    attrs: {
      connectionRole: 'background',
      operation: 'backgroundStatement',
      phase: 'start',
      queue: 'main',
      routeOrJobKey: 'maintenance.summary.refresh',
      statementKind: 'FAIL',
      workloadClass: 'maintenance',
    },
  })
  expect(statementError).toMatchObject({
    attrs: {connectionRole: 'background', errorName: 'TypeError', operation: 'backgroundStatement', phase: 'error'},
    event: 'duckdb.statement.error',
    severity: 'ERROR',
  })
  expect(queryStart?.attrs.statementExecutionId).toBe(queryEnd?.attrs.statementExecutionId)
  expect(statementStart?.attrs.statementExecutionId).toBe(statementError?.attrs.statementExecutionId)
  expect(queryStart?.attrs.statementHash).toMatch(/^[a-f0-9]{12}$/)
  expect(queryStart?.attrs.statementHash).toBe(queryEnd?.attrs.statementHash)
  expect(queryEnd?.attrs.durationMs).toBeGreaterThanOrEqual(0)
  expect(statementError?.attrs.durationMs).toBeGreaterThanOrEqual(0)
  expect(
    transactionEvents.map((event) => {
      return {
        operation: event.attrs.operation,
        routeOrJobKey: event.attrs.routeOrJobKey,
        statementKind: event.attrs.statementKind,
        workloadClass: event.attrs.workloadClass,
      }
    }),
  ).toEqual([
    {
      operation: 'transaction',
      routeOrJobKey: 'reviewServing.projector.writer.snapshotPromotion',
      statementKind: 'INSERT',
      workloadClass: 'reviewProjector',
    },
    {
      operation: 'transaction',
      routeOrJobKey: 'reviewServing.projector.writer.snapshotPromotion',
      statementKind: 'INSERT',
      workloadClass: 'reviewProjector',
    },
  ])
  expect(transactionEvents[0]?.attrs.statementTargetTable).toBe('app.review_serving_snapshot_manifest')
  const summaryTransactionKinds = result.events
    .filter((event) => {
      return event.attrs.routeOrJobKey === 'reviewServing.projector.writer.summary'
    })
    .map((event) => {
      return event.attrs.statementKind
    })
  expect(summaryTransactionKinds).toEqual(['BEGIN', 'BEGIN', 'COMMIT', 'COMMIT'])
})
