import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getRuntimeLogConfig} from '../src/server/utils/runtimeLogger.ts'
import {getRuntimeProfileDuckdbPath} from '../src/utils/runtimeProfile.ts'
import {getRuntimeProfileCommandEnv} from './runWithRuntimeProfile.ts'

type SpawnedProcess = ReturnType<typeof globalThis.Bun.spawn>
type RuntimeReadyBody = {data?: {ready?: boolean; role?: string}}
type RuntimeStateBody = {data?: {pid?: number; role?: string}}
type ProjectsBody = {data?: Array<{archived?: boolean; id?: string}>}
type ReviewsWarningsBody = {
  data?: {
    indexing?: {
      activeWorkCount?: number
      blockedReason?: string | null
      eligibleConsumerCount?: number
      inFlightRefreshCount?: number
      lastProgressedAt?: string | null
      pendingRefreshCount?: number
      progressState?: string
      queuedRefreshCount?: number
      serving?: {
        diagnostics?: {
          rebuildChunks?: {
            expiredLeaseCount?: number
            pendingCount?: number
            runningCount?: number
            updatedAt?: string | null
          }
        }
      }
      status?: string
    }
  }
}
type ReviewServingProgressSnapshot = {
  activeWorkCount: number
  expiredLeaseCount: number
  inFlightRefreshCount: number
  lastProgressedAt: string | null
  pendingRefreshCount: number
  progressState: string | null
  queuedRefreshCount: number
  rebuildPendingCount: number
  rebuildRunningCount: number
  rebuildUpdatedAt: string | null
}
type ReviewServingProgressCandidate = {body: ReviewsWarningsBody; projectId: string}
type LlmStatusRawResponse = {body: unknown; ok: boolean; status: number; text: string}
type MaintenanceRuntimeDiagnosticsRawResponse = {body: unknown; ok: boolean; status: number; text: string}
type ReviewServingWarningRawResponse = {body: ReviewsWarningsBody | null; ok: boolean; status: number; text: string}
type ForegroundRouteResponsivenessSample = {
  durationMs: number
  error: string | null
  ok: boolean
  route: string
  status: number | null
}
type ReviewServingWarningRouteResponsivenessSample = {
  body: ReviewsWarningsBody | null
  durationMs: number
  error: string | null
  ok: boolean
  projectId: string
  status: number | null
}
type RuntimePids = [number, number, number]
type RuntimeStabilityObservation = {
  output: string
  pidsAfter: RuntimePids
  pidsBefore: RuntimePids
  progressed: boolean
  readyAfter: [RuntimeReadyBody, RuntimeReadyBody, RuntimeReadyBody]
  runtimeLogEvidence?: RuntimeLogEvidence[]
}
type RuntimeLogSnapshot = Record<string, number>
type RuntimeLogEvidence = {
  attrs: Record<string, unknown>
  event: string
  runtime?: RuntimeLogRecord['runtime']
  severity?: string
  timestamp?: string
}
type StackStartedPids = {api: number | null; judge: number | null; maintenance: number | null}
type PipeTextCollector = {done: Promise<void>; getText: () => string}
type RuntimeCrashEvidence = {excerpt: string; label: string}
type RuntimeLogRecord = {
  attrs?: Record<string, unknown>
  event?: string
  message?: string
  runtime?: Record<string, unknown> & {pid?: number; service?: string}
  severity?: string
  timestamp?: string
}

const bunExecutablePath = realpathSync(process.execPath)
const realDevServerSmokeEnabled = process.env.FORSKA_REAL_DEV_SERVER_SMOKE === 'true'
const realDevServerSmokeTest = realDevServerSmokeEnabled ? test : test.skip
const reviewServingProgressProjectId =
  process.env.FORSKA_REVIEW_SERVING_PROGRESS_PROJECT_ID ?? 'd03fe24a-cfcf-41ed-b09f-7b554a393d80'
const isReviewServingProgressProjectIdExplicit = process.env.FORSKA_REVIEW_SERVING_PROGRESS_PROJECT_ID !== undefined
const reviewServingWarningRouteProbeProjectId =
  process.env.FORSKA_REVIEW_SERVING_WARNING_ROUTE_PROBE_PROJECT_ID ?? '4ec939b2-47bb-48dd-ad62-ad9f4b5acecf'
const staleReviewServingQueuedProgressMs = 10 * 60_000
const reviewServingWarningFetchTimeoutMs = 60_000
const reviewServingWarningResponsivenessTimeoutMs = 10_000
const maintenanceRuntimeDiagnosticsResponsivenessTimeoutMs = 3_000
const serverStackReadyTimeoutMs = process.platform === 'win32' ? 60_000 : 20_000
const serverStackTestTimeoutMs = process.platform === 'win32' ? 90_000 : 30_000
const reviewServingWarningResponsivenessPollMs = 1_000
const reviewServingWarningResponsivenessMinimumSamples = 3
const reviewServingWarningResponsivenessMaximumSamples = 45
const currentDbReviewServingQueuedWorkProgressTimeoutMs = 75_000
const currentDbReviewServingQueuedWorkProgressPollMs = 5_000
const forbiddenDevServerOutputPatterns = [
  {label: 'API role DuckDB ownership', pattern: /Current server role api cannot own DuckDB/},
  {label: 'DuckDB fatal runtime restart', pattern: /\[duckdb\] restarting embedded runtime after fatal invalidation/},
  {label: 'review-serving projector recovery pause', pattern: /paused by operator recovery marker/},
  {label: 'DuckDB owner heartbeat failure', pattern: /\[duckdb-owner\] heartbeat failed/},
  {label: 'review bulk worker loop failure', pattern: /\[reviewBulkOperationWorker\] background loop failed/},
  {label: 'server stack lock refresh failure', pattern: /\[server:stack\] failed to refresh supervisor lock/},
  {label: 'maintenance restart', pattern: /\[server:stack\] restarting maintenance/},
  {label: 'maintenance unexpected exit', pattern: /\[server:stack\] maintenance pid=\d+ exited unexpectedly/},
  {label: 'judge duplicate replacement', pattern: /judge replacement is already ready after SIGTERM/},
  {label: 'judge unexpected SIGTERM exit', pattern: /\[server:stack\] judge pid=\d+ exited with code 143/},
] as const
const runtimeCrashEvidencePatterns = [
  {label: 'SIGTRAP', pattern: /SIGTRAP/iu},
  {label: 'SIGKILL', pattern: /SIGKILL/iu},
  {label: 'out of memory', pattern: /Out of Memory/iu},
  {label: 'DuckDB owner heartbeat failure', pattern: /\[duckdb-owner\] heartbeat failed/iu},
  {label: 'DuckDB fatal runtime invalidation', pattern: /fatal invalidation/iu},
  {label: 'background loop failure', pattern: /background loop failed/iu},
] as const
const runtimeCrashEvidenceExcerptRadius = 100
const runtimeCrashDiagnosticEvidenceLimit = 48
const runtimeCrashDiagnosticEvents = new Set([
  'duckdb.statement.end',
  'duckdb.statement.error',
  'duckdb.statement.start',
  'server.stack.managed-process-unexpected-exit',
])
const duckdbStatementDiagnosticLinePattern = /^\[duckdb:statement-diagnostic\] (.+)$/u

test('current-db network smoke includes read-only browser and mutation-enabled split-stack phases', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {scripts?: Record<string, string>}
  const scripts = packageJson.scripts ?? {}

  expect(scripts['test:network-smoke']).toBe('bun run test:network-smoke:current-db')
  expect(scripts['test:network-smoke:current-db']).toBe(
    'bun run test:network-smoke:current-db:readonly && bun run test:dev-server:current-db',
  )
  expect(scripts['test:network-smoke:current-db']).not.toContain('setTimeout')
  expect(scripts['test:network-smoke:current-db:readonly']).toContain('FORSKA_DISABLE_SERVER_MUTATIONS=true')
  expect(scripts['test:network-smoke:current-db:readonly']).toContain('bun scripts/runPlaywright.ts')
  expect(scripts['test:network-smoke:current-db:readonly']).not.toContain('bunx playwright')
  expect(scripts['test:dev-server:current-db']).toContain('FORSKA_REAL_DEV_SERVER_SMOKE=true')
  expect(scripts['test:dev-server:current-db']).toContain('-t "real primary dev:server startup')

  const source = readFileSync(new URL('./runWithRuntimeProfile.test.ts', import.meta.url), 'utf8')
  expect(source).toContain('const isReviewServingProgressProjectIdExplicit =')
  expect(source).toContain('if (isReviewServingProgressProjectIdExplicit) {')

  const playwrightConfigSource = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8')
  expect(playwrightConfigSource).toContain('process.env.FORSKA_NETWORK_SMOKE_DUCKDB_PATH')
  expect(playwrightConfigSource).toContain("getRuntimeProfileDuckdbPath({profileName: 'primary'})")
  expect(playwrightConfigSource).not.toContain('?? process.env.DUCKDB_PATH')
})

test('stacked server allows DuckDB startup recovery to finish before maintenance restart', () => {
  const source = readFileSync(new URL('./startServerStack.ts', import.meta.url), 'utf8')

  expect(source).toContain('const maintenanceStartupTimeoutMs = 1_800_000')
  expect(source).toContain('deadlineMs = Date.now() + maintenanceStartupTimeoutMs')
  expect(source).toContain("process.platform === 'win32'")
  expect(source).toContain('Get-CimInstance Win32_Process')
  expect(source).toContain(": ['pgrep', '-P', String(pid)]")
  expect(source).toContain('const survivingPids = await waitForProcessIdsExit(capturedPids)')
  expect(source).toContain('const forcedKillSurvivors = await waitForProcessIdsExit(')
  expect(source).toContain("killProcessIds([...descendantPids, pid], 'SIGTERM')")
  expect(source).toContain('readProcessLockForAcquisition({')
  expect(source).toContain('processLockMalformedStaleAfterMs')
  expect(source).toContain('rename(temporaryPath, serverStackLockPath)')
  expect(source).toContain('if (currentLock?.pid === process.pid)')
  expect(source).not.toContain('deadlineMs = Date.now() + startupTimeoutMs')
  expect(source).not.toContain('currentLease.apiServerPort !== config.maintenancePort')
})

test('dev server watcher explains busy stack restart timeouts without raw source-frame failures', () => {
  const source = readFileSync(new URL('./devServerWatch.ts', import.meta.url), 'utf8')

  expect(source).toContain('getStackLockReleaseTimeoutMessage')
  expect(source).toContain('The previous stack is still alive after')
  expect(source).toContain('another terminal/screen still has `bun run dev:server` running')
  expect(source).toContain('FORSKA_DEV_SERVER_WATCH_ACTION=restart bun run dev:server')
  expect(source).toContain('logDevServerFatalError(error)')
  expect(source).toContain('if (currentLock?.pid === process.pid)')
  expect(source).toContain('readProcessLockForAcquisition({')
  expect(source).toContain('processLockMalformedStaleAfterMs')
  expect(source).toContain('nextFingerprint === watchedPathFingerprint')
  expect(source).toContain('filesystem notification left no source change; keeping server stack running')
  expect(source).not.toContain('Timed out waiting for server stack pid=${currentLock.pid} to release lock')
})

test('server stack watchdog replaces dead or persistently unhealthy judge processes', () => {
  const source = readFileSync(new URL('./startServerStack.ts', import.meta.url), 'utf8')

  expect(source).toContain('const judgeHealthWatchdogFailureThreshold = 3')
  expect(source).toContain('const processAlive = isManagedServerProcessAlive(serverProcess)')
  expect(source).toContain('const healthy = processAlive ? await isJudgeLocallyHealthy() : false')
  expect(source).toContain('isJudgeWatchdogResponseHealthy(probe) && probe.body?.data?.ready === true')
  expect(source).toContain('await restartJudgeFromHealthWatchdog({')
  expect(source).toContain("await stopManagedServerProcess('judge', serverProcess)")
  expect(source).toContain("await stopProcessTree({pid, processName: 'server process'})")
  expect(source).toContain('startJudgeHealthWatchdog()')
  expect(source).toContain('stopJudgeHealthWatchdog()')
})

const removePathIfExists = (path: string) => {
  if (existsSync(path)) {
    rmSync(path, {force: true, recursive: true})
  }
}

const getServerStackLockPath = (apiPort: number, maintenancePort: number, judgePort: number) => {
  return join(tmpdir(), 'forska-server-stack', `${apiPort}-${maintenancePort}-${judgePort}.lock.json`)
}

const waitForPathUntil = async (path: string, deadlineMs: number): Promise<void> => {
  if (existsSync(path)) {
    return
  }

  if (Date.now() >= deadlineMs) {
    throw new Error(`Timed out waiting for ${path}`)
  }

  await waitFor(100)
  return waitForPathUntil(path, deadlineMs)
}

const waitForPath = async (path: string, timeoutMs: number) => {
  return waitForPathUntil(path, Date.now() + timeoutMs)
}

const getForbiddenDevServerOutputMatches = (output: string) => {
  return forbiddenDevServerOutputPatterns.flatMap(({label, pattern}) => {
    return pattern.test(output) ? [label] : []
  })
}

const expectNoForbiddenDevServerOutput = (output: string) => {
  expect(getForbiddenDevServerOutputMatches(output), output).toEqual([])
}

const createPipeTextCollector = (pipe: SpawnedProcess['stdout']): PipeTextCollector => {
  let text = ''

  if (!(pipe instanceof ReadableStream)) {
    return {
      done: Promise.resolve(),
      getText: () => {
        return text
      },
    }
  }

  const decoder = new TextDecoder()
  const done = pipe
    .pipeTo(
      new WritableStream<Uint8Array>({
        abort: () => {
          text += decoder.decode()
        },
        close: () => {
          text += decoder.decode()
        },
        write: (chunk) => {
          text += decoder.decode(chunk, {stream: true})
        },
      }),
    )
    .catch(() => {
      text += decoder.decode()
    })

  return {
    done,
    getText: () => {
      return text
    },
  }
}

const getCollectedProcessOutput = (collectors: PipeTextCollector[]) => {
  return collectors
    .map((collector) => {
      return collector.getText()
    })
    .join('\n')
}

const getCollectedProcessOutputParts = (collectors: PipeTextCollector[]) => {
  return collectors.map((collector) => {
    return collector.getText()
  })
}

const getRuntimeCrashEvidence = (output: string): RuntimeCrashEvidence[] => {
  return runtimeCrashEvidencePatterns.flatMap(({label, pattern}) => {
    const match = pattern.exec(output)

    if (!match || match.index === undefined) {
      return []
    }

    const excerptStart = Math.max(0, match.index - runtimeCrashEvidenceExcerptRadius)
    const excerptEnd = Math.min(output.length, match.index + match[0].length + runtimeCrashEvidenceExcerptRadius)
    const excerpt = output.slice(excerptStart, excerptEnd).replace(/\s+/gu, ' ').trim()

    return [{excerpt, label}]
  })
}

const getPrimaryRuntimeLogDir = () => {
  return getRuntimeLogConfig({envValues: {...process.env, FORSKA_RUNTIME_PROFILE: 'primary'}}).logDir
}

const getRuntimeLogPaths = (logDir: string) => {
  if (!existsSync(logDir)) {
    return []
  }

  return readdirSync(logDir)
    .filter((name) => {
      return name.endsWith('.jsonl')
    })
    .map((name) => {
      return join(logDir, name)
    })
    .sort()
}

const getJsonlLineCount = (path: string) => {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length
}

const getRuntimeLogSnapshot = (logDir = getPrimaryRuntimeLogDir()): RuntimeLogSnapshot => {
  return Object.fromEntries(
    getRuntimeLogPaths(logDir).map((path) => {
      return [path, getJsonlLineCount(path)]
    }),
  )
}

const parseRuntimeLogRecord = (line: string) => {
  try {
    return JSON.parse(line) as RuntimeLogRecord
  } catch {
    return null
  }
}

const getRuntimeLogRecordsSince = ({logDir, snapshot}: {logDir: string; snapshot: RuntimeLogSnapshot}) => {
  return getRuntimeLogPaths(logDir).flatMap((path) => {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(snapshot[path] ?? 0)
      .map(parseRuntimeLogRecord)
      .filter((record): record is RuntimeLogRecord => {
        return record !== null
      })
  })
}

const getDiagnosticAttrs = (record: RuntimeLogRecord) => {
  const attrs = record.attrs ?? {}

  if (record.event === 'server.stack.managed-process-unexpected-exit') {
    return {
      exitCode: attrs.exitCode ?? null,
      pid: attrs.pid ?? null,
      restartPlanned: attrs.restartPlanned ?? null,
      role: attrs.role ?? null,
      signal: attrs.signal ?? null,
    }
  }

  return {
    connectionRole: attrs.connectionRole ?? null,
    durationMs: attrs.durationMs ?? null,
    errorName: attrs.errorName ?? null,
    lane: attrs.lane ?? null,
    operation: attrs.operation ?? null,
    phase: attrs.phase ?? null,
    queue: attrs.queue ?? null,
    queueDepthAtStart: attrs.queueDepthAtStart ?? null,
    routeOrJobKey: attrs.routeOrJobKey ?? null,
    statementExecutionId: attrs.statementExecutionId ?? null,
    statementHash: attrs.statementHash ?? null,
    statementKind: attrs.statementKind ?? null,
    statementTargetTable: attrs.statementTargetTable ?? null,
    workloadClass: attrs.workloadClass ?? null,
  }
}

const getRuntimeCrashDiagnosticEvidence = ({
  logDir,
  pidsAfter,
  pidsBefore,
  snapshot,
}: {
  logDir: string
  pidsAfter: RuntimePids
  pidsBefore: RuntimePids
  snapshot: RuntimeLogSnapshot
}): RuntimeLogEvidence[] => {
  const changedPids = new Set(
    pidsBefore.filter((pid, index) => {
      return pid !== pidsAfter[index]
    }),
  )

  if (changedPids.size === 0) {
    return []
  }

  return getRuntimeLogRecordsSince({logDir, snapshot})
    .filter((record) => {
      return (
        runtimeCrashDiagnosticEvents.has(record.event ?? '')
        && (changedPids.has(Number(record.runtime?.pid)) || changedPids.has(Number(record.attrs?.pid)))
      )
    })
    .slice(-runtimeCrashDiagnosticEvidenceLimit)
    .map((record) => {
      return {
        attrs: getDiagnosticAttrs(record),
        event: record.event ?? 'unknown',
        runtime: record.runtime,
        severity: record.severity,
        timestamp: record.timestamp,
      }
    })
}

const getRuntimeCrashOutputDiagnosticEvidence = (output: string): RuntimeLogEvidence[] => {
  return output
    .split('\n')
    .flatMap((line): RuntimeLogEvidence[] => {
      const match = duckdbStatementDiagnosticLinePattern.exec(line.trim())

      if (!match) {
        return []
      }

      const diagnosticJson = match[1] ?? ''
      const attrs =
        parseRuntimeLogRecord(diagnosticJson)?.attrs ?? parseRuntimeLogRecord(`{"attrs":${diagnosticJson}}`)?.attrs

      return attrs === undefined
        ? []
        : (() => {
            const phase = typeof attrs.phase === 'string' ? attrs.phase : 'unknown'

            return [
              {
                attrs: getDiagnosticAttrs({attrs, event: 'duckdb.statement.start'}),
                event: `duckdb.statement.${phase}`,
                severity: phase === 'error' ? 'ERROR' : 'INFO',
              },
            ]
          })()
    })
    .slice(-runtimeCrashDiagnosticEvidenceLimit)
}

const hasReviewServingRebuildChunkProgressSince = ({
  logDir,
  snapshot,
}: {
  logDir: string
  snapshot: RuntimeLogSnapshot
}) => {
  return getRuntimeLogRecordsSince({logDir, snapshot}).some((record) => {
    return (
      record.runtime?.service === 'maintenance-worker-server'
      && record.event?.startsWith('review-serving-projector-worker:rebuild-chunk:') === true
      && record.attrs?.status === 'completed'
    )
  })
}

test('runtime crash diagnostics harvest only new sanitized records for the changed pid', () => {
  const logDir = join(tmpdir(), `forska-runtime-crash-evidence-${Date.now()}`)
  const logPath = join(logDir, 'maintenance-worker-server-2026-07-13.jsonl')
  const createRecord = (record: Partial<RuntimeLogRecord> & {event: string}): RuntimeLogRecord => {
    return {
      attrs: {},
      message: 'test',
      runtime: {
        hostname: 'test-host',
        instanceId: 'test-instance',
        listenPort: 3002,
        pid: 200,
        processStartedAt: '2026-07-13T10:00:00.000Z',
        runtimeProfile: 'primary',
        service: 'maintenance-worker-server',
      },
      severity: 'INFO',
      timestamp: '2026-07-13T10:00:00.000Z',
      ...record,
    }
  }
  const stringifyRecords = (records: RuntimeLogRecord[]) => {
    return records
      .map((record) => {
        return JSON.stringify(record)
      })
      .join('\n')
      .concat('\n')
  }

  mkdirSync(logDir, {recursive: true})
  writeFileSync(
    logPath,
    stringifyRecords([
      createRecord({
        attrs: {statementHash: 'stale', statementKind: 'SELECT', rawSql: 'SELECT private_before'},
        event: 'duckdb.statement.start',
      }),
    ]),
  )

  const snapshot = getRuntimeLogSnapshot(logDir)

  writeFileSync(
    logPath,
    stringifyRecords([
      createRecord({
        attrs: {statementHash: 'stale', statementKind: 'SELECT', rawSql: 'SELECT private_before'},
        event: 'duckdb.statement.start',
      }),
      createRecord({
        attrs: {
          operation: 'appendTransaction',
          phase: 'start',
          rawSql: 'INSERT INTO private_table VALUES (secret)',
          routeOrJobKey: 'review-serving.projector',
          statementHash: 'abc123def456',
          statementKind: 'INSERT',
          statementTargetTable: 'app.review_serving_snapshot_manifest',
          workloadClass: 'review-serving',
        },
        event: 'duckdb.statement.start',
      }),
      createRecord({
        attrs: {statementHash: 'unchanged-pid'},
        event: 'duckdb.statement.start',
        runtime: {
          hostname: 'test-host',
          instanceId: 'other-instance',
          listenPort: 3003,
          pid: 300,
          processStartedAt: '2026-07-13T10:00:00.000Z',
          runtimeProfile: 'primary',
          service: 'judge-worker-server',
        },
      }),
      createRecord({
        attrs: {exitCode: 133, pid: 200, restartPlanned: true, role: 'maintenance', signal: 'SIGTRAP'},
        event: 'server.stack.managed-process-unexpected-exit',
        severity: 'ERROR',
      }),
    ]),
  )

  const evidence = getRuntimeCrashDiagnosticEvidence({
    logDir,
    pidsAfter: [100, 201, 300],
    pidsBefore: [100, 200, 300],
    snapshot,
  })
  const serializedEvidence = JSON.stringify(evidence)

  expect(evidence).toHaveLength(2)
  expect(evidence[0]).toMatchObject({
    attrs: {
      operation: 'appendTransaction',
      routeOrJobKey: 'review-serving.projector',
      statementHash: 'abc123def456',
      statementKind: 'INSERT',
      statementTargetTable: 'app.review_serving_snapshot_manifest',
      workloadClass: 'review-serving',
    },
    event: 'duckdb.statement.start',
  })
  expect(evidence[1]).toMatchObject({
    attrs: {exitCode: 133, pid: 200, restartPlanned: true, role: 'maintenance', signal: 'SIGTRAP'},
    event: 'server.stack.managed-process-unexpected-exit',
  })
  expect(serializedEvidence).not.toContain('private_table')
  expect(serializedEvidence).not.toContain('private_before')
  expect(serializedEvidence).not.toContain('unchanged-pid')
  removePathIfExists(logDir)
})

test('runtime crash diagnostics harvest sanitized DuckDB statement stderr breadcrumbs', () => {
  const evidence = getRuntimeCrashOutputDiagnosticEvidence(
    [
      '[duckdb:statement-diagnostic] {"phase":"start","routeOrJobKey":"reviewServing.projector.writer.snapshotPromotion","statementHash":"abc123def456","statementKind":"INSERT","statementTargetTable":"app.review_serving_snapshot_manifest","workloadClass":"reviewProjector","rawSql":"INSERT INTO private VALUES (secret)"}',
      '[duckdb:statement-diagnostic] not-json',
    ].join('\n'),
  )
  const serializedEvidence = JSON.stringify(evidence)

  expect(evidence).toEqual([
    {
      attrs: {
        connectionRole: null,
        durationMs: null,
        errorName: null,
        lane: null,
        operation: null,
        phase: 'start',
        queue: null,
        queueDepthAtStart: null,
        routeOrJobKey: 'reviewServing.projector.writer.snapshotPromotion',
        statementExecutionId: null,
        statementHash: 'abc123def456',
        statementKind: 'INSERT',
        statementTargetTable: 'app.review_serving_snapshot_manifest',
        workloadClass: 'reviewProjector',
      },
      event: 'duckdb.statement.start',
      severity: 'INFO',
    },
  ])
  expect(serializedEvidence).not.toContain('private')
  expect(serializedEvidence).not.toContain('secret')
})

test('runtime crash diagnostics retain a bounded window larger than one warning route', () => {
  const output = Array.from({length: 49}, (_, index) => {
    return `[duckdb:statement-diagnostic] ${JSON.stringify({
      phase: index % 2 === 0 ? 'start' : 'end',
      rawSql: `SELECT private_${index}`,
      routeOrJobKey: `review.warnings.operation-${index}`,
      statementExecutionId: `statement-${index}`,
    })}`
  }).join('\n')
  const evidence = getRuntimeCrashOutputDiagnosticEvidence(output)

  expect(evidence).toHaveLength(48)
  expect(evidence[0]?.attrs).toMatchObject({
    routeOrJobKey: 'review.warnings.operation-1',
    statementExecutionId: 'statement-1',
  })
  expect(evidence.at(-1)?.attrs).toMatchObject({
    routeOrJobKey: 'review.warnings.operation-48',
    statementExecutionId: 'statement-48',
  })
  expect(JSON.stringify(evidence)).not.toContain('private_')
})

const waitForRuntimeReadyUntil = async (port: number, deadlineMs: number): Promise<RuntimeReadyBody> => {
  return fetch(`http://127.0.0.1:${port}/api/runtime/ready`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Runtime on port ${port} returned ${response.status}`)
      }

      return (await response.json()) as RuntimeReadyBody
    })
    .catch((error) => {
      if (Date.now() >= deadlineMs) {
        throw error
      }

      return new Promise<RuntimeReadyBody>((resolve, reject) => {
        setTimeout(() => {
          waitForRuntimeReadyUntil(port, deadlineMs).then(resolve).catch(reject)
        }, 100)
      })
    })
}

const waitForRuntimeReady = async (port: number, timeoutMs: number): Promise<RuntimeReadyBody> => {
  return waitForRuntimeReadyUntil(port, Date.now() + timeoutMs)
}

const waitFor = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`)
  }

  return (await response.json()) as T
}

const fetchJsonWithTransientOwnerRetries = async <T>(
  url: string,
  init?: RequestInit,
  deadlineMs = Date.now() + 20_000,
): Promise<T> => {
  try {
    return await fetchJson<T>(url, init)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retryable =
      message.includes('returned 502')
      || message.includes('returned 503')
      || message.includes('returned 504')
      || message.includes('Unable to connect')

    if (!retryable || Date.now() >= deadlineMs) {
      throw error
    }

    await waitFor(1_000)
    return fetchJsonWithTransientOwnerRetries(url, init, deadlineMs)
  }
}

const postReviewWarnings = async (apiPort: number, projectId: string) => {
  return fetchJsonWithTransientOwnerRetries<ReviewsWarningsBody>(
    `http://127.0.0.1:${apiPort}/api/projectsreviewswarnings`,
    {
      body: JSON.stringify({projectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
      signal: AbortSignal.timeout(reviewServingWarningFetchTimeoutMs),
    },
  )
}

const postReviewWarningsRaw = async (
  apiPort: number,
  projectId: string,
  signal?: AbortSignal,
): Promise<ReviewServingWarningRawResponse> => {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/projectsreviewswarnings`, {
    body: JSON.stringify({projectId}),
    headers: {'content-type': 'application/json'},
    method: 'POST',
    signal,
  })
  const text = await response.text()
  let body: ReviewsWarningsBody | null

  try {
    body = JSON.parse(text) as ReviewsWarningsBody
  } catch {
    body = null
  }

  return {body, ok: response.ok, status: response.status, text}
}

const getLlmStatusRaw = async (apiPort: number, signal?: AbortSignal): Promise<LlmStatusRawResponse> => {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/llmstatus`, {signal})
  const text = await response.text()
  let body: unknown

  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = null
  }

  return {body, ok: response.ok, status: response.status, text}
}

const getMaintenanceRuntimeDiagnosticsRaw = async (
  apiPort: number,
  signal?: AbortSignal,
): Promise<MaintenanceRuntimeDiagnosticsRawResponse> => {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/admin/maintenance-runtime-diagnostics`, {signal})
  const text = await response.text()
  let body: unknown

  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = null
  }

  return {body, ok: response.ok, status: response.status, text}
}

const getReviewServingWarningProbe = async (
  configuredProjectId: string,
  postWarnings: (projectId: string) => Promise<ReviewsWarningsBody>,
  getProjects: () => Promise<ProjectsBody>,
) => {
  const errors: unknown[] = []

  try {
    return {body: await postWarnings(configuredProjectId), projectId: configuredProjectId}
  } catch (error) {
    errors.push(error)
  }

  const projects = await getProjects()
  const activeProjectIds =
    projects.data
      ?.filter((project) => {
        return project.archived === false && project.id && project.id !== configuredProjectId
      })
      .map((project) => {
        return project.id as string
      }) ?? []

  for (const projectId of activeProjectIds) {
    try {
      return {body: await postWarnings(projectId), projectId}
    } catch (error) {
      errors.push(error)
    }
  }

  throw new AggregateError(errors, 'Review-serving warning route failed for the configured and active projects', {
    cause: errors[0],
  })
}

const getReviewServingProgressSnapshot = (body: ReviewsWarningsBody): ReviewServingProgressSnapshot => {
  const indexing = body.data?.indexing
  const rebuildChunks = indexing?.serving?.diagnostics?.rebuildChunks

  return {
    activeWorkCount: Number(indexing?.activeWorkCount ?? 0),
    expiredLeaseCount: Number(rebuildChunks?.expiredLeaseCount ?? 0),
    inFlightRefreshCount: Number(indexing?.inFlightRefreshCount ?? 0),
    lastProgressedAt: indexing?.lastProgressedAt ?? null,
    pendingRefreshCount: Number(indexing?.pendingRefreshCount ?? 0),
    progressState: indexing?.progressState ?? null,
    queuedRefreshCount: Number(indexing?.queuedRefreshCount ?? 0),
    rebuildPendingCount: Number(rebuildChunks?.pendingCount ?? 0),
    rebuildRunningCount: Number(rebuildChunks?.runningCount ?? 0),
    rebuildUpdatedAt: rebuildChunks?.updatedAt ?? null,
  }
}

const getTimestampMs = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/u, '$1:00')
  const timestampMs = Date.parse(normalized)

  return Number.isFinite(timestampMs) ? timestampMs : null
}

const isStaleReviewServingProgressSnapshot = (snapshot: ReviewServingProgressSnapshot) => {
  const latestProgressMs = Math.max(
    getTimestampMs(snapshot.lastProgressedAt) ?? 0,
    getTimestampMs(snapshot.rebuildUpdatedAt) ?? 0,
  )

  return latestProgressMs === 0 || Date.now() - latestProgressMs > staleReviewServingQueuedProgressMs
}

const hasReviewServingProgressWork = (snapshot: ReviewServingProgressSnapshot) => {
  return (
    snapshot.inFlightRefreshCount > 0
    || snapshot.activeWorkCount > 0
    || snapshot.rebuildPendingCount > 0
    || snapshot.rebuildRunningCount > 0
  )
}

const isReviewServingProgressCandidate = (body: ReviewsWarningsBody) => {
  const indexing = body.data?.indexing
  const snapshot = getReviewServingProgressSnapshot(body)

  return (
    indexing?.status === 'refreshing'
    && Number(indexing.eligibleConsumerCount ?? 0) > 0
    && indexing.blockedReason === null
    && hasReviewServingProgressWork(snapshot)
  )
}

const getReviewServingProgressCandidates = async (apiPort: number) => {
  const projectIds = new Set([reviewServingProgressProjectId])
  const candidates: ReviewServingProgressCandidate[] = []
  const targetBody = await postReviewWarnings(apiPort, reviewServingProgressProjectId).catch(() => {
    return null
  })

  if (targetBody !== null && isReviewServingProgressCandidate(targetBody)) {
    candidates.push({body: targetBody, projectId: reviewServingProgressProjectId})
  }

  if (isReviewServingProgressProjectIdExplicit) {
    return candidates
  }

  try {
    const projectsBody = await fetchJson<ProjectsBody>(`http://127.0.0.1:${apiPort}/api/projects`)
    projectsBody.data?.forEach((project) => {
      if (project.id) {
        projectIds.add(project.id)
      }
    })
  } catch {
    // The explicit project probe below is enough for local current-DB smoke coverage.
  }

  for (const projectId of projectIds) {
    if (projectId === reviewServingProgressProjectId) {
      continue
    }

    const body = await postReviewWarnings(apiPort, projectId).catch(() => {
      return null
    })

    if (body !== null && isReviewServingProgressCandidate(body)) {
      candidates.push({body, projectId})
    }
  }

  return candidates
}

const didReviewServingWorkProgress = (before: ReviewServingProgressSnapshot, after: ReviewServingProgressSnapshot) => {
  return (
    after.progressState !== before.progressState
    || after.activeWorkCount !== before.activeWorkCount
    || after.inFlightRefreshCount !== before.inFlightRefreshCount
    || after.pendingRefreshCount < before.pendingRefreshCount
    || after.queuedRefreshCount < before.queuedRefreshCount
    || after.expiredLeaseCount < before.expiredLeaseCount
    || after.rebuildRunningCount !== before.rebuildRunningCount
    || after.rebuildPendingCount < before.rebuildPendingCount
    || (after.lastProgressedAt !== null && after.lastProgressedAt !== before.lastProgressedAt)
    || (after.rebuildUpdatedAt !== null && after.rebuildUpdatedAt !== before.rebuildUpdatedAt)
  )
}

type ReviewServingProgressPollOptions = {
  getCandidates?: (apiPort: number) => Promise<ReviewServingProgressCandidate[]>
  logDir?: string
  logSnapshot?: RuntimeLogSnapshot
  now?: () => number
  pollIntervalMs?: number
  postWarnings?: (apiPort: number, projectId: string) => Promise<ReviewsWarningsBody>
  timeoutMs?: number
  wait?: (ms: number) => Promise<void>
}

const getCurrentDbReviewServingQueuedWorkProbeResult = async (
  apiPort: number,
  beforeSnapshots: Array<{candidate: ReviewServingProgressCandidate; snapshot: ReviewServingProgressSnapshot}>,
  postWarnings: (apiPort: number, projectId: string) => Promise<ReviewsWarningsBody>,
) => {
  const details = await Promise.all(
    beforeSnapshots.map(async ({candidate, snapshot}) => {
      try {
        const body = await postWarnings(apiPort, candidate.projectId)
        const after = getReviewServingProgressSnapshot(body)
        const progressed = didReviewServingWorkProgress(snapshot, after)
        const candidateNow = isReviewServingProgressCandidate(body)
        const staleNow = isStaleReviewServingProgressSnapshot(after)

        return {
          after,
          before: snapshot,
          candidate: candidateNow,
          error: null,
          progressed,
          projectId: candidate.projectId,
          resolved: progressed || !candidateNow || !staleNow,
          stale: staleNow,
        }
      } catch (error) {
        return {
          after: null,
          before: snapshot,
          candidate: false,
          error: error instanceof Error ? error.message : String(error),
          progressed: false,
          projectId: candidate.projectId,
          resolved: true,
          stale: false,
        }
      }
    }),
  )

  return {
    details,
    passed:
      details.some((detail) => {
        return detail.progressed
      })
      || details.every((detail) => {
        return detail.resolved
      }),
  }
}

const getRuntimeStabilityFailure = ({
  output,
  pidsAfter,
  pidsBefore,
  progressed,
  readyAfter,
  runtimeLogEvidence = [],
}: RuntimeStabilityObservation) => {
  const crashEvidence = getRuntimeCrashEvidence(output)

  if (
    crashEvidence.length === 0
    && pidsAfter.every((pid, index) => {
      return pid === pidsBefore[index]
    })
  ) {
    return null
  }

  const [apiPidBefore, maintenancePidBefore, judgePidBefore] = pidsBefore
  const [apiPidAfter, maintenancePidAfter, judgePidAfter] = pidsAfter
  const rolesReady = readyAfter.every((body, index) => {
    return body.data?.ready === true && body.data.role === ['api', 'maintenance-worker', 'judge-worker'][index]
  })
  const maintenanceOnlyRestart =
    apiPidAfter === apiPidBefore && judgePidAfter === judgePidBefore && maintenancePidAfter !== maintenancePidBefore
  const cleanExitPattern = new RegExp(
    `\\[server:stack\\] maintenance pid=${maintenancePidBefore} exited unexpectedly with code 0 signal=none; restart planned`,
  )
  const replacementPattern = new RegExp(`\\[server:stack\\] started maintenance pid=${maintenancePidAfter}(?:\\D|$)`)
  const hasBoundedRestartEvidence =
    cleanExitPattern.test(output)
    && output.includes('[server:stack] restarting maintenance')
    && replacementPattern.test(output)
  const hasCrashEvidence = crashEvidence.length > 0

  return maintenanceOnlyRestart && rolesReady && progressed && hasBoundedRestartEvidence && !hasCrashEvidence
    ? null
    : `Runtime PID stability failed: ${JSON.stringify({
        hasBoundedRestartEvidence,
        hasCrashEvidence,
        crashEvidence,
        maintenanceOnlyRestart,
        pidsAfter,
        pidsBefore,
        progressed,
        rolesReady,
        runtimeLogEvidence,
      })}`
}

const omitAcceptedMaintenanceRestartOutput = (output: string, maintenancePidBefore: number | null) => {
  if (maintenancePidBefore === null) {
    return output
  }

  return output
    .replace(
      `[server:stack] maintenance pid=${maintenancePidBefore} exited unexpectedly with code 0 signal=none; restart planned`,
      '',
    )
    .replace('[server:stack] restarting maintenance', '')
}

test('runtime stability accepts only healthy bounded maintenance restarts with review-serving progress', () => {
  const base = {
    output:
      '[server:stack] maintenance pid=20 exited unexpectedly with code 0 signal=none; restart planned\n'
      + '[server:stack] restarting maintenance\n'
      + '[server:stack] started maintenance pid=21\n',
    pidsAfter: [10, 21, 30] as RuntimePids,
    pidsBefore: [10, 20, 30] as RuntimePids,
    progressed: true,
    readyAfter: [
      {data: {ready: true, role: 'api'}},
      {data: {ready: true, role: 'maintenance-worker'}},
      {data: {ready: true, role: 'judge-worker'}},
    ] as [RuntimeReadyBody, RuntimeReadyBody, RuntimeReadyBody],
  }

  expect(getRuntimeStabilityFailure(base)).toBeNull()
  expect(getRuntimeStabilityFailure({...base, pidsAfter: [11, 21, 30]})).toContain('Runtime PID stability failed')
  expect(getRuntimeStabilityFailure({...base, progressed: false})).toContain('Runtime PID stability failed')
  const sigtrapFailure = getRuntimeStabilityFailure({...base, output: `${base.output}process exited via SIGTRAP`})
  const outOfMemoryFailure = getRuntimeStabilityFailure({...base, output: `${base.output}fatal: Out of Memory`})

  expect(sigtrapFailure).toContain('Runtime PID stability failed')
  expect(sigtrapFailure).toContain('"label":"SIGTRAP"')
  expect(sigtrapFailure).toContain('started maintenance pid=21 process exited via SIGTRAP')
  expect(outOfMemoryFailure).toContain('"label":"out of memory"')
  expect(outOfMemoryFailure).toContain('fatal: Out of Memory')
  expect(
    getRuntimeStabilityFailure({
      ...base,
      output: `${base.output}See OOM_ERRORS.md and the OOM documentation label for prior incidents`,
    }),
  ).toBeNull()
  expect(
    getRuntimeStabilityFailure({
      ...base,
      readyAfter: [base.readyAfter[0], {data: {ready: false, role: 'maintenance-worker'}}, base.readyAfter[2]],
    }),
  ).toContain('Runtime PID stability failed')
  expect(getForbiddenDevServerOutputMatches(omitAcceptedMaintenanceRestartOutput(base.output, 20))).toEqual([])
  expect(
    getForbiddenDevServerOutputMatches(omitAcceptedMaintenanceRestartOutput(`${base.output}${base.output}`, 20)),
  ).toEqual(['maintenance restart', 'maintenance unexpected exit'])
})

const expectCurrentDbReviewServingQueuedWorkProgresses = async (
  apiPort: number,
  {
    getCandidates = getReviewServingProgressCandidates,
    logDir = getPrimaryRuntimeLogDir(),
    logSnapshot = getRuntimeLogSnapshot(logDir),
    now = Date.now,
    pollIntervalMs = currentDbReviewServingQueuedWorkProgressPollMs,
    postWarnings = postReviewWarnings,
    timeoutMs = currentDbReviewServingQueuedWorkProgressTimeoutMs,
    wait = waitFor,
  }: ReviewServingProgressPollOptions = {},
) => {
  const candidates = await getCandidates(apiPort)

  if (candidates.length === 0) {
    return
  }

  const beforeSnapshots = candidates
    .map((candidate) => {
      return {candidate, snapshot: getReviewServingProgressSnapshot(candidate.body)}
    })
    .filter(({snapshot}) => {
      return isStaleReviewServingProgressSnapshot(snapshot)
    })

  if (beforeSnapshots.length === 0) {
    return
  }

  const deadlineMs = now() + timeoutMs

  while (true) {
    const result = await getCurrentDbReviewServingQueuedWorkProbeResult(apiPort, beforeSnapshots, postWarnings)

    if (result.passed) {
      return
    }

    if (hasReviewServingRebuildChunkProgressSince({logDir, snapshot: logSnapshot})) {
      return
    }

    if (now() >= deadlineMs) {
      expect(
        false,
        'Review serving work stayed refreshing without a maintenance-worker progress signal. '
          + `candidates=${JSON.stringify(result.details)}`,
      ).toBe(true)
      return
    }

    await wait(Math.min(pollIntervalMs, Math.max(deadlineMs - now(), 0)))
  }
}

const createReviewServingProgressCandidateBody = (
  overrides: NonNullable<NonNullable<ReviewsWarningsBody['data']>['indexing']> = {},
): ReviewsWarningsBody => {
  return {
    data: {
      indexing: {
        activeWorkCount: 1,
        blockedReason: null,
        eligibleConsumerCount: 1,
        inFlightRefreshCount: 1,
        lastProgressedAt: '2026-07-07T11:30:00.000Z',
        pendingRefreshCount: 9,
        progressState: 'processing',
        queuedRefreshCount: 0,
        serving: {
          diagnostics: {rebuildChunks: {pendingCount: 8, runningCount: 1, updatedAt: '2026-07-07T11:30:00.000Z'}},
        },
        status: 'refreshing',
        ...overrides,
      },
    },
  }
}

test('current-db review-serving smoke polls until original queued work progresses', async () => {
  let nowMs = Date.parse('2026-07-24T10:00:00.000Z')
  const initialBody = createReviewServingProgressCandidateBody()
  const progressedBody = createReviewServingProgressCandidateBody({
    pendingRefreshCount: 8,
    serving: {diagnostics: {rebuildChunks: {pendingCount: 7, runningCount: 1, updatedAt: '2026-07-07T11:30:00.000Z'}}},
  })
  let probeCount = 0
  const waits: number[] = []

  await expectCurrentDbReviewServingQueuedWorkProgresses(3001, {
    getCandidates: async () => {
      return [{body: initialBody, projectId: 'project-a'}]
    },
    now: () => {
      return nowMs
    },
    postWarnings: async () => {
      probeCount += 1

      return probeCount < 3 ? initialBody : progressedBody
    },
    wait: async (ms) => {
      waits.push(ms)
      nowMs += ms
    },
  })

  expect(probeCount).toBe(3)
  expect(waits).toEqual([
    currentDbReviewServingQueuedWorkProgressPollMs,
    currentDbReviewServingQueuedWorkProgressPollMs,
  ])
})

test('current-db review-serving smoke accepts original queued work becoming non-candidate', async () => {
  const initialBody = createReviewServingProgressCandidateBody()
  const resolvedBody = createReviewServingProgressCandidateBody({
    activeWorkCount: 0,
    inFlightRefreshCount: 0,
    pendingRefreshCount: 0,
    progressState: 'ready',
    queuedRefreshCount: 0,
    serving: {diagnostics: {rebuildChunks: {pendingCount: 0, runningCount: 0, updatedAt: '2026-07-07T11:30:00.000Z'}}},
    status: 'ready',
  })
  let probeCount = 0

  await expectCurrentDbReviewServingQueuedWorkProgresses(3001, {
    getCandidates: async () => {
      return [{body: initialBody, projectId: 'project-a'}]
    },
    postWarnings: async () => {
      probeCount += 1

      return resolvedBody
    },
    wait: async () => {
      throw new Error('resolved candidates should not wait')
    },
  })

  expect(probeCount).toBe(1)
})

test('current-db review-serving smoke accepts original queued work becoming non-stale', async () => {
  const initialBody = createReviewServingProgressCandidateBody()
  const nonStaleBody = createReviewServingProgressCandidateBody({
    lastProgressedAt: '2026-07-24T10:00:00.000Z',
    serving: {diagnostics: {rebuildChunks: {pendingCount: 8, runningCount: 1, updatedAt: '2026-07-24T10:00:00.000Z'}}},
  })
  const nowMs = Date.parse('2026-07-24T10:00:01.000Z')
  let probeCount = 0

  await expectCurrentDbReviewServingQueuedWorkProgresses(3001, {
    getCandidates: async () => {
      return [{body: initialBody, projectId: 'project-a'}]
    },
    now: () => {
      return nowMs
    },
    postWarnings: async () => {
      probeCount += 1

      return nonStaleBody
    },
    wait: async () => {
      throw new Error('non-stale candidates should not wait')
    },
  })

  expect(probeCount).toBe(1)
})

test('current-db review-serving smoke accepts fresh rebuild chunk log progress', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'f2-review-serving-progress-log-'))
  const logPath = join(logDir, 'maintenance-worker-server-2026-07-24.jsonl')
  const initialBody = createReviewServingProgressCandidateBody()
  let nowMs = Date.parse('2026-07-24T10:00:00.000Z')
  let probeCount = 0

  try {
    await expectCurrentDbReviewServingQueuedWorkProgresses(3001, {
      getCandidates: async () => {
        return [{body: initialBody, projectId: 'project-a'}]
      },
      logDir,
      logSnapshot: getRuntimeLogSnapshot(logDir),
      now: () => {
        return nowMs
      },
      postWarnings: async () => {
        probeCount += 1

        return initialBody
      },
      wait: async (ms) => {
        nowMs += ms
        writeFileSync(
          logPath,
          JSON.stringify({
            attrs: {chunkId: 'chunk:1', status: 'completed'},
            event: 'review-serving-projector-worker:rebuild-chunk:rebuild:1:search',
            runtime: {service: 'maintenance-worker-server'},
          }) + '\n',
        )
      },
    })
  } finally {
    rmSync(logDir, {force: true, recursive: true})
  }

  expect(probeCount).toBe(2)
})

test('current-db review-serving smoke treats active refresh work as a progress candidate', () => {
  const body: ReviewsWarningsBody = {
    data: {
      indexing: {
        activeWorkCount: 1,
        blockedReason: null,
        eligibleConsumerCount: 1,
        inFlightRefreshCount: 1,
        pendingRefreshCount: 9,
        progressState: 'processing',
        queuedRefreshCount: 0,
        serving: {
          diagnostics: {rebuildChunks: {pendingCount: 8, runningCount: 1, updatedAt: '2026-07-07T11:30:00.000Z'}},
        },
        status: 'refreshing',
      },
    },
  }
  const before = getReviewServingProgressSnapshot(body)
  const after = {...before, rebuildPendingCount: before.rebuildPendingCount - 1}

  expect(isReviewServingProgressCandidate(body)).toBe(true)
  expect(didReviewServingWorkProgress(before, before)).toBe(false)
  expect(didReviewServingWorkProgress(before, after)).toBe(true)
})

test('current-db review-serving smoke ignores stale queued counters without active rebuild work', () => {
  const body = createReviewServingProgressCandidateBody({
    activeWorkCount: 0,
    inFlightRefreshCount: 0,
    pendingRefreshCount: 88835,
    progressState: 'queued',
    queuedRefreshCount: 88835,
    serving: {diagnostics: {rebuildChunks: {pendingCount: 0, runningCount: 0, updatedAt: null}}},
  })

  expect(isReviewServingProgressCandidate(body)).toBe(false)
})

test('current-db warning route probe falls back from an unusable configured project to an active project', async () => {
  const attemptedProjectIds: string[] = []
  const expectedBody: ReviewsWarningsBody = {data: {indexing: {status: 'ready'}}}
  const result = await getReviewServingWarningProbe(
    'configured-archived',
    async (projectId) => {
      attemptedProjectIds.push(projectId)

      if (projectId === 'configured-archived') {
        throw new Error('Archived projects must be unarchived before use')
      }

      return expectedBody
    },
    async () => {
      return {
        data: [
          {archived: true, id: 'another-archived'},
          {archived: false, id: 'active-project'},
        ],
      }
    },
  )

  expect(attemptedProjectIds).toEqual(['configured-archived', 'active-project'])
  expect(result).toEqual({body: expectedBody, projectId: 'active-project'})
})

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const hasOwnerStateStartupOrRepair = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') {
    return false
  }

  if ('ownerState' in value && (value as {ownerState?: unknown}).ownerState === 'startup-or-repair') {
    return true
  }

  if (Array.isArray(value)) {
    return value.some(hasOwnerStateStartupOrRepair)
  }

  return Object.values(value).some(hasOwnerStateStartupOrRepair)
}

const isOwnerProxyTimeoutText = (text: string) => {
  return text.includes('DuckDB owner proxy target timed out')
}

const getReviewServingWarningRouteResponsivenessSample = async ({
  createTimeoutSignal = (timeoutMs) => {
    return AbortSignal.timeout(timeoutMs)
  },
  now = () => {
    return Date.now()
  },
  postWarningsRaw,
  projectId,
  timeoutMs = reviewServingWarningResponsivenessTimeoutMs,
}: {
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal
  now?: () => number
  postWarningsRaw: (projectId: string, signal: AbortSignal) => Promise<ReviewServingWarningRawResponse>
  projectId: string
  timeoutMs?: number
}): Promise<ReviewServingWarningRouteResponsivenessSample> => {
  const startedAtMs = now()
  const signal = createTimeoutSignal(timeoutMs)

  try {
    const response = await postWarningsRaw(projectId, signal)
    return {
      body: response.body,
      durationMs: now() - startedAtMs,
      error: response.ok ? null : response.text,
      ok: response.ok && response.body?.data?.indexing?.status !== undefined,
      projectId,
      status: response.status,
    }
  } catch (error) {
    return {
      body: null,
      durationMs: now() - startedAtMs,
      error: getErrorMessage(error),
      ok: false,
      projectId,
      status: null,
    }
  }
}

const expectReviewServingWarningRouteResponsivenessSample = (
  sample: ReviewServingWarningRouteResponsivenessSample,
  timeoutMs: number,
) => {
  expect(
    sample.ok && sample.durationMs <= timeoutMs,
    'Review warning route exceeded the foreground responsiveness budget while maintenance was active. '
      + `sample=${JSON.stringify(sample)} timeoutMs=${timeoutMs}`,
  ).toBe(true)
}

const getForegroundRouteResponsivenessSample = async ({
  createTimeoutSignal = (timeoutMs) => {
    return AbortSignal.timeout(timeoutMs)
  },
  fetchRoute,
  isOk,
  now = () => {
    return Date.now()
  },
  route,
  timeoutMs,
}: {
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal
  fetchRoute: (signal: AbortSignal) => Promise<{body?: unknown; ok: boolean; status: number; text: string}>
  isOk?: (response: {body?: unknown; ok: boolean; status: number; text: string}) => boolean
  now?: () => number
  route: string
  timeoutMs: number
}): Promise<ForegroundRouteResponsivenessSample> => {
  const startedAtMs = now()
  const signal = createTimeoutSignal(timeoutMs)

  try {
    const response = await fetchRoute(signal)

    return {
      durationMs: now() - startedAtMs,
      error: response.ok ? null : response.text,
      ok: isOk?.(response) ?? response.ok,
      route,
      status: response.status,
    }
  } catch (error) {
    return {durationMs: now() - startedAtMs, error: getErrorMessage(error), ok: false, route, status: null}
  }
}

const expectForegroundRouteResponsivenessSample = (sample: ForegroundRouteResponsivenessSample, timeoutMs: number) => {
  expect(
    sample.ok && sample.durationMs <= timeoutMs,
    'Foreground route exceeded the responsiveness budget while maintenance was active. '
      + `sample=${JSON.stringify(sample)} timeoutMs=${timeoutMs}`,
  ).toBe(true)
}

const expectMaintenanceRuntimeDiagnosticsRemainsResponsive = async ({
  apiPort,
  createTimeoutSignal,
  fetchDiagnostics = (signal) => {
    return getMaintenanceRuntimeDiagnosticsRaw(apiPort, signal)
  },
  isDone = () => {
    return false
  },
  maxSamples = reviewServingWarningResponsivenessMaximumSamples,
  minSamples = reviewServingWarningResponsivenessMinimumSamples,
  now = Date.now,
  pollMs = reviewServingWarningResponsivenessPollMs,
  timeoutMs = maintenanceRuntimeDiagnosticsResponsivenessTimeoutMs,
  wait = waitFor,
}: {
  apiPort: number
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal
  fetchDiagnostics?: (signal: AbortSignal) => Promise<MaintenanceRuntimeDiagnosticsRawResponse>
  isDone?: () => boolean
  maxSamples?: number
  minSamples?: number
  now?: () => number
  pollMs?: number
  timeoutMs?: number
  wait?: (ms: number) => Promise<void>
}) => {
  let sampleCount = 0

  while (sampleCount < maxSamples && (sampleCount < minSamples || !isDone())) {
    if (sampleCount > 0) {
      await wait(pollMs)
    }

    const sample = await getForegroundRouteResponsivenessSample({
      createTimeoutSignal,
      fetchRoute: fetchDiagnostics,
      isOk: (response) => {
        return response.ok && !hasOwnerStateStartupOrRepair(response.body) && !isOwnerProxyTimeoutText(response.text)
      },
      now,
      route: '/api/admin/maintenance-runtime-diagnostics',
      timeoutMs,
    })

    sampleCount += 1
    expectForegroundRouteResponsivenessSample(sample, timeoutMs)
  }
}

const expectLlmStatusRouteRemainsResponsive = async ({
  apiPort,
  createTimeoutSignal,
  fetchLlmStatus = (signal) => {
    return getLlmStatusRaw(apiPort, signal)
  },
  isDone = () => {
    return false
  },
  maxSamples = reviewServingWarningResponsivenessMaximumSamples,
  minSamples = reviewServingWarningResponsivenessMinimumSamples,
  now = Date.now,
  pollMs = reviewServingWarningResponsivenessPollMs,
  timeoutMs = 3_000,
  wait = waitFor,
}: {
  apiPort: number
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal
  fetchLlmStatus?: (signal: AbortSignal) => Promise<LlmStatusRawResponse>
  isDone?: () => boolean
  maxSamples?: number
  minSamples?: number
  now?: () => number
  pollMs?: number
  timeoutMs?: number
  wait?: (ms: number) => Promise<void>
}) => {
  let sampleCount = 0

  while (sampleCount < maxSamples && (sampleCount < minSamples || !isDone())) {
    if (sampleCount > 0) {
      await wait(pollMs)
    }

    const sample = await getForegroundRouteResponsivenessSample({
      createTimeoutSignal,
      fetchRoute: fetchLlmStatus,
      isOk: (response) => {
        return response.ok
      },
      now,
      route: '/api/llmstatus',
      timeoutMs,
    })

    sampleCount += 1
    expectForegroundRouteResponsivenessSample(sample, timeoutMs)
  }
}

const expectReviewServingWarningRouteRemainsResponsive = async ({
  apiPort,
  createTimeoutSignal,
  getProjects = () => {
    return fetchJson<ProjectsBody>(`http://127.0.0.1:${apiPort}/api/projects`)
  },
  isDone = () => {
    return false
  },
  maxSamples = reviewServingWarningResponsivenessMaximumSamples,
  minSamples = reviewServingWarningResponsivenessMinimumSamples,
  now = Date.now,
  pollMs = reviewServingWarningResponsivenessPollMs,
  postWarningsRaw: postWarningsRawInput = (projectId, signal) => {
    return postReviewWarningsRaw(apiPort, projectId, signal)
  },
  wait = waitFor,
  warningRouteProbeProjectId = reviewServingWarningRouteProbeProjectId,
  timeoutMs = reviewServingWarningResponsivenessTimeoutMs,
}: {
  apiPort: number
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal
  getProjects?: () => Promise<ProjectsBody>
  isDone?: () => boolean
  maxSamples?: number
  minSamples?: number
  now?: () => number
  pollMs?: number
  postWarningsRaw?: (projectId: string, signal: AbortSignal) => Promise<ReviewServingWarningRawResponse>
  wait?: (ms: number) => Promise<void>
  warningRouteProbeProjectId?: string
  timeoutMs?: number
}) => {
  const errors: unknown[] = []
  const getResponsiveProbe = async (projectId: string) => {
    const sample = await getReviewServingWarningRouteResponsivenessSample({
      createTimeoutSignal,
      now,
      postWarningsRaw: postWarningsRawInput,
      projectId,
      timeoutMs,
    })

    expectReviewServingWarningRouteResponsivenessSample(sample, timeoutMs)

    if (sample.body === null) {
      throw new Error(sample.error || `Review warning route returned ${sample.status ?? 'unknown status'}`)
    }

    return {body: sample.body, projectId}
  }
  let probe: {body: ReviewsWarningsBody; projectId: string} | null = null

  try {
    probe = await getResponsiveProbe(warningRouteProbeProjectId)
  } catch (error) {
    errors.push(error)
    const projects = await getProjects()
    const activeProjectIds =
      projects.data
        ?.filter((project) => {
          return project.archived === false && project.id && project.id !== warningRouteProbeProjectId
        })
        .map((project) => {
          return project.id as string
        }) ?? []

    for (const projectId of activeProjectIds) {
      try {
        probe = await getResponsiveProbe(projectId)
        break
      } catch (fallbackError) {
        errors.push(fallbackError)
      }
    }

    if (probe === null) {
      if (errors.length === 1) {
        throw errors[0]
      }

      throw new Error('Review-serving warning route failed for the configured and active projects', {cause: error})
    }
  }
  let sampleCount = 1
  const responsiveProjectId = probe.projectId

  while (sampleCount < maxSamples && (sampleCount < minSamples || !isDone())) {
    await wait(pollMs)
    const sample = await getReviewServingWarningRouteResponsivenessSample({
      createTimeoutSignal,
      now,
      postWarningsRaw: postWarningsRawInput,
      projectId: responsiveProjectId,
      timeoutMs,
    })

    sampleCount += 1
    expectReviewServingWarningRouteResponsivenessSample(sample, timeoutMs)
  }
}

test('current-db warning route responsiveness probe fails on a slow owner-held route response', async () => {
  let nowMs = 0
  const signal = new AbortController().signal

  return expect(
    expectReviewServingWarningRouteRemainsResponsive({
      apiPort: 3001,
      createTimeoutSignal: () => {
        return signal
      },
      getProjects: async () => {
        return {data: []}
      },
      now: () => {
        return nowMs
      },
      postWarningsRaw: async () => {
        nowMs += reviewServingWarningResponsivenessTimeoutMs + 1
        return {body: createReviewServingProgressCandidateBody({status: 'ready'}), ok: true, status: 200, text: ''}
      },
      wait: async () => {},
      warningRouteProbeProjectId: 'project-a',
    }),
  ).rejects.toThrow('Review warning route exceeded the foreground responsiveness budget')
})

test('current-db warning route responsiveness probe fails on owner proxy 504s', async () => {
  const signal = new AbortController().signal

  return expect(
    expectReviewServingWarningRouteRemainsResponsive({
      apiPort: 3001,
      createTimeoutSignal: () => {
        return signal
      },
      getProjects: async () => {
        return {data: []}
      },
      postWarningsRaw: async () => {
        return {body: null, ok: false, status: 504, text: 'DuckDB owner proxy target timed out after 60000 ms'}
      },
      wait: async () => {},
      warningRouteProbeProjectId: 'project-a',
    }),
  ).rejects.toThrow('Review warning route exceeded the foreground responsiveness budget')
})

test('current-db llmstatus responsiveness probe fails on owner proxy 504s', async () => {
  const signal = new AbortController().signal

  return expect(
    expectLlmStatusRouteRemainsResponsive({
      apiPort: 3001,
      createTimeoutSignal: () => {
        return signal
      },
      fetchLlmStatus: async () => {
        return {body: null, ok: false, status: 504, text: 'DuckDB owner proxy target timed out after 3000 ms'}
      },
      wait: async () => {},
    }),
  ).rejects.toThrow('Foreground route exceeded the responsiveness budget')
})

test('current-db maintenance diagnostics responsiveness probe fails on ownerState startup-or-repair', async () => {
  const signal = new AbortController().signal

  return expect(
    expectMaintenanceRuntimeDiagnosticsRemainsResponsive({
      apiPort: 3001,
      createTimeoutSignal: () => {
        return signal
      },
      fetchDiagnostics: async () => {
        return {
          body: {data: {warnings: [{ownerState: 'startup-or-repair'}]}},
          ok: true,
          status: 200,
          text: '{"data":{"warnings":[{"ownerState":"startup-or-repair"}]}}',
        }
      },
      wait: async () => {},
    }),
  ).rejects.toThrow('Foreground route exceeded the responsiveness budget')
})

test('current-db maintenance diagnostics responsiveness probe fails on owner proxy 504s', async () => {
  const signal = new AbortController().signal

  return expect(
    expectMaintenanceRuntimeDiagnosticsRemainsResponsive({
      apiPort: 3001,
      createTimeoutSignal: () => {
        return signal
      },
      fetchDiagnostics: async () => {
        return {body: null, ok: false, status: 504, text: 'DuckDB owner proxy target timed out after 3000 ms'}
      },
      wait: async () => {},
    }),
  ).rejects.toThrow('Foreground route exceeded the responsiveness budget')
})

const getRuntimeState = async (port: number): Promise<RuntimeStateBody> => {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime/state`)

  if (!response.ok) {
    throw new Error(`Runtime state on port ${port} returned ${response.status}`)
  }

  return (await response.json()) as RuntimeStateBody
}

const getRuntimePids = async (ports: number[]) => {
  return Promise.all(
    ports.map(async (port) => {
      return (await getRuntimeState(port)).data?.pid ?? null
    }),
  )
}

const getRequiredRuntimePids = async (ports: [number, number, number]) => {
  const pids = await getRuntimePids(ports)

  if (
    !pids.every((pid) => {
      return typeof pid === 'number'
    })
  ) {
    throw new Error(`Expected runtime pids for ports ${ports.join(', ')}, received ${pids.join(', ')}`)
  }

  return pids as [number, number, number]
}

const getReadyRuntimePidsUntil = async (
  ports: [number, number, number],
  deadlineMs: number,
  waitUntilReady = waitForRuntimeReadyUntil,
  getPids = getRequiredRuntimePids,
): Promise<{pids: RuntimePids; ready: [RuntimeReadyBody, RuntimeReadyBody, RuntimeReadyBody]}> => {
  const ready = (await Promise.all(
    ports.map((port) => {
      return waitUntilReady(port, deadlineMs)
    }),
  )) as [RuntimeReadyBody, RuntimeReadyBody, RuntimeReadyBody]

  return getPids(ports).then(
    (pids) => {
      return {pids, ready}
    },
    async (error) => {
      if (Date.now() >= deadlineMs) {
        throw error
      }

      await waitFor(100)
      return getReadyRuntimePidsUntil(ports, deadlineMs, waitUntilReady, getPids)
    },
  )
}

test('runtime PID sampling re-waits for ready roles after a transient state endpoint gap', async () => {
  const readyCalls: number[] = []
  const expectedPids: RuntimePids = [10, 21, 30]
  const rolesByPort = new Map([
    [3001, 'api'],
    [3002, 'maintenance-worker'],
    [3003, 'judge-worker'],
  ])
  let pidAttempts = 0
  const result = await getReadyRuntimePidsUntil(
    [3001, 3002, 3003],
    Date.now() + 1_000,
    async (port) => {
      readyCalls.push(port)
      return {data: {ready: true, role: rolesByPort.get(port)}}
    },
    async () => {
      pidAttempts += 1

      if (pidAttempts === 1) {
        throw new Error('ConnectionRefused')
      }

      return expectedPids
    },
  )

  expect(result.pids).toEqual(expectedPids)
  expect(
    result.ready.map((body) => {
      return body.data?.ready
    }),
  ).toEqual([true, true, true])
  expect(readyCalls).toEqual([3001, 3002, 3003, 3001, 3002, 3003])
})

const expectCurrentDbReviewServingWarningRouteSurvives = async (
  apiPort: number,
  runtimePorts: [number, number, number],
  getOutputParts: () => string[],
) => {
  const outputOffsets = getOutputParts().map((part) => {
    return part.length
  })
  const runtimeLogDir = getPrimaryRuntimeLogDir()
  const runtimeLogSnapshot = getRuntimeLogSnapshot(runtimeLogDir)
  const {pids: pidsBefore} = await getReadyRuntimePidsUntil(runtimePorts, Date.now() + 20_000)
  const progressCandidatesBefore = await getReviewServingProgressCandidates(apiPort)
  const {body} = await getReviewServingWarningProbe(
    reviewServingWarningRouteProbeProjectId,
    async (projectId) => {
      return postReviewWarnings(apiPort, projectId)
    },
    async () => {
      return fetchJson<ProjectsBody>(`http://127.0.0.1:${apiPort}/api/projects`)
    },
  )

  expect(body.data?.indexing?.status).toBeDefined()

  await waitFor(3_000)
  const {pids: pidsAfter, ready: readyAfter} = await getReadyRuntimePidsUntil(runtimePorts, Date.now() + 20_000)
  const progressAfter = await Promise.all(
    progressCandidatesBefore.map(async (candidate) => {
      return {
        after: getReviewServingProgressSnapshot(await postReviewWarnings(apiPort, candidate.projectId)),
        before: getReviewServingProgressSnapshot(candidate.body),
      }
    }),
  )
  const progressed = progressAfter.some(({after, before}) => {
    return didReviewServingWorkProgress(before, after)
  })
  const stabilityOutput = getOutputParts()
    .map((part, index) => {
      return part.slice(outputOffsets[index])
    })
    .join('\n')
  const stabilityFailure = getRuntimeStabilityFailure({
    output: stabilityOutput,
    pidsAfter,
    pidsBefore,
    progressed,
    readyAfter,
    runtimeLogEvidence: [
      ...getRuntimeCrashDiagnosticEvidence({
        logDir: runtimeLogDir,
        pidsAfter,
        pidsBefore,
        snapshot: runtimeLogSnapshot,
      }),
      ...getRuntimeCrashOutputDiagnosticEvidence(stabilityOutput),
    ],
  })

  expect(stabilityFailure).toBeNull()
  return pidsAfter[1] === pidsBefore[1] ? null : pidsBefore[1]
}

const readPipeText = async (pipe: SpawnedProcess['stdout']) => {
  return pipe instanceof ReadableStream ? await new Response(pipe).text() : ''
}

const readProcessOutput = async (processToRead: SpawnedProcess) => {
  const [stdout, stderr] = await Promise.all([readPipeText(processToRead.stdout), readPipeText(processToRead.stderr)])

  return `${stdout}\n${stderr}`
}

const getStackStartedPid = (output: string, role: keyof StackStartedPids) => {
  const matches = [...output.matchAll(new RegExp(`\\[server:stack\\] started ${role} pid=(\\d+)`, 'g'))]
  const latestMatch = matches.at(-1)

  return latestMatch ? Number(latestMatch[1]) : null
}

const getStackStartedPids = (output: string): StackStartedPids => {
  return {
    api: getStackStartedPid(output, 'api'),
    judge: getStackStartedPid(output, 'judge'),
    maintenance: getStackStartedPid(output, 'maintenance'),
  }
}

const isSpawnedProcessRunning = (processToCheck: SpawnedProcess) => {
  if (processToCheck.pid === undefined) {
    return false
  }

  try {
    process.kill(processToCheck.pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForProcessExitUntil = async (processToWaitFor: SpawnedProcess, deadlineMs: number): Promise<void> => {
  if (!isSpawnedProcessRunning(processToWaitFor)) {
    return
  }

  if (Date.now() >= deadlineMs) {
    throw new Error(`Timed out waiting for pid=${processToWaitFor.pid ?? 'unknown'} to exit`)
  }

  await waitFor(100)
  return waitForProcessExitUntil(processToWaitFor, deadlineMs)
}

const waitForProcessExit = async (processToWaitFor: SpawnedProcess, timeoutMs: number) => {
  return waitForProcessExitUntil(processToWaitFor, Date.now() + timeoutMs)
}

const getAvailableLocalPorts = async (count: number) => {
  const servers = Array.from({length: count}, () => {
    return globalThis.Bun.serve({
      fetch: () => {
        return new Response('ok')
      },
      hostname: '127.0.0.1',
      port: 0,
    })
  })
  const ports = servers.map((server) => {
    return server.port
  })
  await Promise.all(
    servers.map((server) => {
      return server.stop(true)
    }),
  )

  return ports
}

const getFourAvailableLocalPorts = async () => {
  const ports = await getAvailableLocalPorts(4)

  if (ports.length !== 4) {
    throw new Error(`Expected 4 available ports, received ${ports.length}`)
  }

  return ports as [number, number, number, number]
}

const getFiveAvailableLocalPorts = async () => {
  const ports = await getAvailableLocalPorts(5)

  if (ports.length !== 5) {
    throw new Error(`Expected 5 available ports, received ${ports.length}`)
  }

  return ports as [number, number, number, number, number]
}

const getCanStartLocalListener = async () => {
  try {
    await getAvailableLocalPorts(1)
    return true
  } catch {
    return false
  }
}

const canStartLocalListener = await getCanStartLocalListener()

const stopProcess = async (processToStop: SpawnedProcess) => {
  if (processToStop.exitCode === null) {
    processToStop.kill('SIGTERM')
  }

  await processToStop.exited
}

test('propagates the selected runtime profile into launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app', profileName: 'primary'}).FORSKA_RUNTIME_PROFILE).toBe('primary')

  expect(
    getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'secondary'}).FORSKA_RUNTIME_PROFILE,
  ).toBe('secondary')
})

test('fixes sink-owning runtime service names in launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'app-server',
  )
  expect(getRuntimeProfileCommandEnv({mode: 'api-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'api-server',
  )
  expect(
    getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE,
  ).toBe('maintenance-worker-server')
  expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'judge-worker-server',
  )
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'dev-single-server',
  )
})

test('maintenance-only launcher uses the maintenance-worker runtime role', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).SERVER_ROLE).toBe(
    'maintenance-worker',
  )
})

test('judge-only launcher uses the judge-worker runtime role and journal identity', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'secondary'})).toMatchObject({
    API_SERVER_PORT: '3103',
    FORSKA_RUNTIME_PROFILE: 'secondary',
    JUDGE_WORKER_ID: 'secondary-judge-worker',
    SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:3102',
    SERVER_ROLE: 'judge-worker',
  })
})

test('judge-only launcher clears inherited explicit journal paths', () => {
  const previousJournalPath = process.env.JUDGE_WORKER_JOURNAL_PATH
  process.env.JUDGE_WORKER_JOURNAL_PATH = 'data/custom/judge.sqlite'

  try {
    expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'primary'})).toMatchObject({
      JUDGE_WORKER_ID: 'primary-judge-worker',
      JUDGE_WORKER_JOURNAL_PATH: '',
      SERVER_ROLE: 'judge-worker',
    })
  } finally {
    if (previousJournalPath === undefined) {
      delete process.env.JUDGE_WORKER_JOURNAL_PATH
    }

    if (previousJournalPath !== undefined) {
      process.env.JUDGE_WORKER_JOURNAL_PATH = previousJournalPath
    }
  }
})

test('stacked server launcher carries split-role port and journal identity wiring', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'})).toMatchObject({
    API_SERVER_PORT: '3001',
    BACKGROUND_JUDGE_PORT: '3003',
    BACKGROUND_MAINTENANCE_PORT: '3002',
    DUCKDB_PATH: getRuntimeProfileDuckdbPath({profileName: 'primary'}),
    FORSKA_RUNTIME_PROFILE: 'primary',
    FORSKA_RUNTIME_SERVICE: 'dev-single-server',
    JUDGE_WORKER_ID: 'primary-judge-worker',
  })
})

test(
  'server stack script starts api, maintenance-worker, and judge-worker together',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-stack-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const [vitePort, apiPort, maintenancePort, judgePort] = await getFourAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(apiPort),
        BACKGROUND_JUDGE_PORT: String(judgePort),
        BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
        DUCKDB_PATH: duckdbPath,
        JUDGE_WORKER_ID: 'run-with-runtime-profile-stack-judge',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    try {
      const pidsAfterReady = await (async (): Promise<[number, number, number]> => {
        const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
          waitForRuntimeReady(apiPort, serverStackReadyTimeoutMs),
          waitForRuntimeReady(maintenancePort, serverStackReadyTimeoutMs),
          waitForRuntimeReady(judgePort, serverStackReadyTimeoutMs),
        ])

        expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
        expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
        expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})

        const runtimePids = await getRequiredRuntimePids([apiPort, maintenancePort, judgePort])
        await waitFor(2_500)
        expect(await getRuntimePids([apiPort, maintenancePort, judgePort])).toEqual(runtimePids)
        return runtimePids
      })()
      const stackLockPath = getServerStackLockPath(apiPort, maintenancePort, judgePort)

      expect(existsSync(stackLockPath)).toBe(true)
      removePathIfExists(stackLockPath)
      await waitForPath(stackLockPath, 5_000)
      expect((JSON.parse(readFileSync(stackLockPath, 'utf8')) as {pid?: number}).pid).toBe(stackProcess.pid)

      await stopProcess(stackProcess)

      const stackOutput = await readProcessOutput(stackProcess)

      expect(getStackStartedPids(stackOutput)).toEqual({
        api: pidsAfterReady[0],
        judge: pidsAfterReady[2],
        maintenance: pidsAfterReady[1],
      })
      expectNoForbiddenDevServerOutput(stackOutput)
    } finally {
      await stopProcess(stackProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: serverStackTestTimeoutMs},
)

test(
  'server stack reports an unexpected maintenance exit to stderr and its runtime log',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-exit-log-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const logDir = join(dataRoot, 'logs')
    const [vitePort, apiPort, maintenancePort, judgePort] = await getFourAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(apiPort),
        BACKGROUND_JUDGE_PORT: String(judgePort),
        BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
        DUCKDB_PATH: duckdbPath,
        JUDGE_WORKER_ID: 'run-with-runtime-profile-exit-log-judge',
        LOG_DIR: logDir,
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const stdout = createPipeTextCollector(stackProcess.stdout)
    const stderr = createPipeTextCollector(stackProcess.stderr)
    const collectors = [stdout, stderr]

    try {
      await Promise.all([
        waitForRuntimeReady(apiPort, 30_000),
        waitForRuntimeReady(maintenancePort, 30_000),
        waitForRuntimeReady(judgePort, 30_000),
      ])
      const [, maintenancePid] = await getRequiredRuntimePids([apiPort, maintenancePort, judgePort])
      const expectedExitCode = process.platform === 'win32' ? 1 : 137
      const expectedSignal = process.platform === 'win32' ? null : 'SIGKILL'

      process.kill(maintenancePid, 'SIGKILL')
      await waitForRuntimeReady(maintenancePort, 30_000)
      const [, replacementMaintenancePid] = await getRequiredRuntimePids([apiPort, maintenancePort, judgePort])

      expect(replacementMaintenancePid).not.toBe(maintenancePid)
      await stopProcess(stackProcess)
      await Promise.all(
        collectors.map((collector) => {
          return collector.done
        }),
      )

      const output = getCollectedProcessOutput(collectors)
      const records = getRuntimeLogRecordsSince({logDir, snapshot: {}})
      const exitRecord = records.find((record) => {
        return record.event === 'server.stack.managed-process-unexpected-exit'
      })

      expect(output).toContain(
        `[server:stack] maintenance pid=${maintenancePid} exited unexpectedly with code ${expectedExitCode} signal=${expectedSignal ?? 'none'}; restart planned`,
      )
      expect(exitRecord).toMatchObject({
        attrs: {
          exitCode: expectedExitCode,
          pid: maintenancePid,
          restartPlanned: true,
          role: 'maintenance',
          signal: expectedSignal,
        },
        runtime: {pid: maintenancePid, service: 'maintenance-worker-server'},
        severity: 'ERROR',
      })
    } finally {
      await stopProcess(stackProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: 60_000},
)

realDevServerSmokeTest(
  'real primary dev:server startup has no DuckDB owner heartbeat or restart errors',
  async () => {
    const devServerProcess = globalThis.Bun.spawn([bunExecutablePath, 'run', 'dev:server'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORSKA_DEV_SERVER_WATCH_ACTION: 'restart',
        FORSKA_DUCKDB_STATEMENT_DIAGNOSTIC_STDERR: 'true',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const stdout = createPipeTextCollector(devServerProcess.stdout)
    const stderr = createPipeTextCollector(devServerProcess.stderr)
    const collectors = [stdout, stderr]
    let acceptedMaintenanceRestartPid: number | null = null

    try {
      await Promise.race([
        Promise.all([
          waitForRuntimeReady(3001, 180_000),
          waitForRuntimeReady(3002, 180_000),
          waitForRuntimeReady(3003, 180_000),
        ]),
        devServerProcess.exited.then((exitCode) => {
          throw new Error(`dev:server exited before all roles became ready with code ${String(exitCode)}`)
        }),
      ])

      await Promise.race([
        waitFor(17_000),
        devServerProcess.exited.then((exitCode) => {
          throw new Error(`dev:server exited during startup settle with code ${String(exitCode)}`)
        }),
      ])

      await Promise.race([
        expectCurrentDbReviewServingWarningRouteSurvives(3001, [3001, 3002, 3003], () => {
          return getCollectedProcessOutputParts(collectors)
        }).then((maintenancePidBefore) => {
          acceptedMaintenanceRestartPid = maintenancePidBefore
        }),
        devServerProcess.exited.then((exitCode) => {
          throw new Error(`dev:server exited during review-serving warning route probe with code ${String(exitCode)}`)
        }),
      ])

      await Promise.race([
        (async () => {
          let progressProbeDone = false
          await Promise.all([
            expectCurrentDbReviewServingQueuedWorkProgresses(3001).finally(() => {
              progressProbeDone = true
            }),
            expectReviewServingWarningRouteRemainsResponsive({
              apiPort: 3001,
              isDone: () => {
                return progressProbeDone
              },
            }),
            expectLlmStatusRouteRemainsResponsive({
              apiPort: 3001,
              isDone: () => {
                return progressProbeDone
              },
            }),
            expectMaintenanceRuntimeDiagnosticsRemainsResponsive({
              apiPort: 3001,
              isDone: () => {
                return progressProbeDone
              },
            }),
          ])
        })(),
        devServerProcess.exited.then((exitCode) => {
          throw new Error(`dev:server exited during review-serving progress probe with code ${String(exitCode)}`)
        }),
      ])
    } finally {
      await stopProcess(devServerProcess)
    }

    await Promise.all(
      collectors.map((collector) => {
        return collector.done
      }),
    )
    expectNoForbiddenDevServerOutput(
      omitAcceptedMaintenanceRestartOutput(getCollectedProcessOutput(collectors), acceptedMaintenanceRestartPid),
    )
  },
  {timeout: 240_000},
)

test(
  'server stack startup takes over a live conflicting judge worker before spawning its own judge role',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-judge-takeover-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const [vitePort, standaloneJudgePort, apiPort, maintenancePort, judgePort] = await getFiveAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const conflictingJudgeProcess = globalThis.Bun.spawn([bunExecutablePath, 'src/server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(standaloneJudgePort),
        DUCKDB_PATH: duckdbPath,
        JUDGE_WORKER_ID: 'run-with-runtime-profile-stack-judge',
        JUDGE_WORKER_JOURNAL_PATH: '',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'judge-worker',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    let stackProcess: SpawnedProcess | null = null

    try {
      await waitForRuntimeReady(standaloneJudgePort, serverStackReadyTimeoutMs)

      stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: String(apiPort),
          BACKGROUND_JUDGE_PORT: String(judgePort),
          BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
          DUCKDB_PATH: duckdbPath,
          JUDGE_WORKER_ID: 'run-with-runtime-profile-stack-judge',
          JUDGE_WORKER_JOURNAL_PATH: '',
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          VITE_PORT: String(vitePort),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      })

      const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
        waitForRuntimeReady(apiPort, serverStackReadyTimeoutMs),
        waitForRuntimeReady(maintenancePort, serverStackReadyTimeoutMs),
        waitForRuntimeReady(judgePort, serverStackReadyTimeoutMs),
        waitForProcessExit(conflictingJudgeProcess, serverStackReadyTimeoutMs),
      ])

      expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
      expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
      expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})
    } finally {
      if (stackProcess !== null) {
        await stopProcess(stackProcess)
      }

      await stopProcess(conflictingJudgeProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: serverStackTestTimeoutMs},
)

test(
  'server stack startup takes over a live conflicting DuckDB owner before spawning its maintenance role',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-owner-takeover-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const [vitePort, apiPort, maintenancePort, judgePort] = await getFourAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const conflictingMaintenanceProcess = globalThis.Bun.spawn([bunExecutablePath, 'src/server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(maintenancePort),
        DUCKDB_PATH: duckdbPath,
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    let stackProcess: SpawnedProcess | null = null

    try {
      await waitForRuntimeReady(maintenancePort, serverStackReadyTimeoutMs)

      stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: String(apiPort),
          BACKGROUND_JUDGE_PORT: String(judgePort),
          BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
          DUCKDB_PATH: duckdbPath,
          JUDGE_WORKER_ID: 'run-with-runtime-profile-owner-takeover-judge',
          JUDGE_WORKER_JOURNAL_PATH: '',
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          VITE_PORT: String(vitePort),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      })

      const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
        waitForRuntimeReady(apiPort, serverStackReadyTimeoutMs),
        waitForRuntimeReady(maintenancePort, serverStackReadyTimeoutMs),
        waitForRuntimeReady(judgePort, serverStackReadyTimeoutMs),
        waitForProcessExit(conflictingMaintenanceProcess, serverStackReadyTimeoutMs),
      ])

      expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
      expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
      expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})
    } finally {
      if (stackProcess !== null) {
        await stopProcess(stackProcess)
      }

      await stopProcess(conflictingMaintenanceProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: serverStackTestTimeoutMs},
)
