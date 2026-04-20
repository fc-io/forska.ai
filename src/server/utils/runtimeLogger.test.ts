import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {getRuntimeServiceNameForServerRole} from './runtimeBootstrap.ts'
import {
  flushRuntimeLogs,
  getDefaultRuntimeLogDir,
  getRuntimeLogConfig,
  getRuntimeLogFileMode,
  getRuntimeLogProfile,
  installRuntimeJsonlSink,
  isRuntimeJsonlSinkInstalled,
  pruneManagedRuntimeLogFiles,
  resetRuntimeJsonlSinkForTests,
  writeRuntimeFailureLogEvent,
  writeRuntimeLogEvent,
  writeRuntimeOperatorLogEvent,
} from './runtimeLogger.ts'
import {
  getRuntimeProcessLogIdentity,
  initializeRuntimeProcessIdentity,
  resetRuntimeProcessIdentityForTests,
  resolveRuntimeProcessIdentity,
} from './runtimeProcessIdentity.ts'

test('defaults unresolved runtime log profile to local', () => {
  expect(getRuntimeLogProfile({envValues: {}})).toBe('local')
  expect(getRuntimeLogProfile({envValues: {FORSKA_RUNTIME_PROFILE: 'unknown'}})).toBe('local')
})

test('resolves default runtime log dir under writable root and profile', () => {
  expect(getDefaultRuntimeLogDir({cwd: '/repo/forska', envValues: {FORSKA_RUNTIME_PROFILE: 'primary'}})).toBe(
    '/repo/forska/logs/runtime/primary',
  )
})

test('resolves test runtime log dirs under temp when no explicit log dir is configured', () => {
  const logDir = getRuntimeLogConfig({
    cwd: '/repo/forska',
    envValues: {FORSKA_RUNTIME_PROFILE: 'secondary', FORSKA_TEST_LOG_ROOT: '/tmp/forska-tests', NODE_ENV: 'test'},
  }).logDir

  expect(logDir).toBe(`/tmp/forska-tests/forska-runtime-logs/${process.pid}/secondary`)
})

test('resolves desktop runtime log dir under desktop writable root', () => {
  const envValues = {
    DUCKDB_PATH: '/Users/tester/Library/Application Support/Forska/desktop/forska.duckdb',
    FORSKA_DESKTOP_MODE: 'true',
    FORSKA_RUNTIME_PROFILE: 'local',
  }

  expect(getDefaultRuntimeLogDir({cwd: '/repo/forska', envValues})).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/logs/runtime/local',
  )
})

test('normalizes runtime log filtering env and resolves explicit log dirs', () => {
  expect(
    getRuntimeLogConfig({
      cwd: '/repo/forska',
      envValues: {LOG_DIR: 'tmp/logs', LOG_LEVEL: 'debug', LOG_STDERR_LEVEL: 'error'},
    }),
  ).toEqual({logDir: '/repo/forska/tmp/logs', logLevel: 'DEBUG', logStderrLevel: 'ERROR', runtimeProfile: 'local'})
})

test('selects shared runtime log files only on tested platform allowlist', () => {
  expect(getRuntimeLogFileMode({platform: 'darwin'})).toBe('shared-file')
  expect(getRuntimeLogFileMode({platform: 'linux'})).toBe('shared-file')
  expect(getRuntimeLogFileMode({platform: 'win32'})).toBe('per-instance-file')
})

test('selects stable runtime service names from server role before runtime imports', () => {
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'api'})).toBe('api-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'worker'})).toBe('worker-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'writer'})).toBe('worker-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'dev-single'})).toBe('dev-single-server')
  expect(getRuntimeServiceNameForServerRole({SERVER_ROLE: 'auto'})).toBe('single-server')
  expect(getRuntimeServiceNameForServerRole({})).toBe('single-server')
})

test('resolves one runtime process identity with stable instance id shape', () => {
  expect(
    resolveRuntimeProcessIdentity({
      envValues: {FORSKA_RUNTIME_PROFILE: 'primary'},
      hostnameValue: 'test-host',
      listenPort: 3002,
      pid: 48192,
      processStartedAt: '2026-04-12T10:10:00.000Z',
      service: 'worker-server',
    }),
  ).toEqual({
    hostname: 'test-host',
    instanceId: 'worker-server:test-host:3002:48192:2026-04-12T10:10:00.000Z',
    listenPort: 3002,
    pid: 48192,
    processStartedAt: '2026-04-12T10:10:00.000Z',
    runtimeProfile: 'primary',
    service: 'worker-server',
  })
})

test('omits serverRole for app-server runtime log identity', () => {
  resetRuntimeProcessIdentityForTests()
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 8080,
    pid: 100,
    processStartedAt: '2026-04-12T10:10:00.000Z',
    service: 'app-server',
  })
  const identity = getRuntimeProcessLogIdentity({serverRole: 'api'})

  expect(identity.service).toBe('app-server')
  expect('serverRole' in identity).toBe(false)
  resetRuntimeProcessIdentityForTests()
})

test('runtime JSONL sink writes one structured record to the service daily file', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  const timestamp = '2026-04-20T12:30:00.000Z'
  initializeRuntimeProcessIdentity({
    envValues: {FORSKA_RUNTIME_PROFILE: 'primary'},
    hostnameValue: 'test-host',
    listenPort: 4011,
    pid: 222,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'worker-server',
  })
  installRuntimeJsonlSink({
    envValues: {FORSKA_RUNTIME_PROFILE: 'primary', LOG_DIR: logDir, LOG_LEVEL: 'INFO', SERVER_ROLE: 'worker'},
  })

  expect(
    writeRuntimeLogEvent({
      attrs: {attempt: 1, ok: true},
      event: 'runtime.logger.test',
      message: 'structured sink test',
      severity: 'INFO',
      timestamp,
    }),
  ).toBe(true)

  const logContent = readFileSync(join(logDir, 'worker-server-2026-04-20.jsonl'), 'utf8')
  const lines = logContent.split('\n').filter(Boolean)
  const [record] = lines.map((line) => {
    return JSON.parse(line) as Record<string, unknown>
  })

  expect(lines).toHaveLength(1)
  expect(record).toEqual({
    attrs: {attempt: 1, ok: true},
    event: 'runtime.logger.test',
    message: 'structured sink test',
    runtime: {
      hostname: 'test-host',
      instanceId: 'worker-server:test-host:4011:222:2026-04-20T12:00:00.000Z',
      listenPort: 4011,
      pid: 222,
      processStartedAt: '2026-04-20T12:00:00.000Z',
      runtimeProfile: 'primary',
      serverRole: 'worker',
      service: 'worker-server',
    },
    severity: 'INFO',
    timestamp,
  })
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('runtime JSONL sink uses instance suffixed fallback files when shared append is disabled', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 4012,
    pid: 223,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'worker-server',
  })
  installRuntimeJsonlSink({
    envValues: {LOG_DIR: logDir, LOG_LEVEL: 'INFO', SERVER_ROLE: 'worker'},
    platform: 'win32',
    timestamp: '2026-04-20T12:00:00.000Z',
  })

  expect(
    writeRuntimeLogEvent({
      event: 'runtime.logger.instance-file',
      message: 'instance fallback',
      severity: 'INFO',
      timestamp: '2026-04-20T12:30:00.000Z',
    }),
  ).toBe(true)

  expect(
    existsSync(
      join(logDir, 'worker-server-2026-04-20-worker-server_test-host_4012_223_2026-04-20T12_00_00.000Z.jsonl'),
    ),
  ).toBe(true)
  expect(existsSync(join(logDir, 'worker-server-2026-04-20.jsonl'))).toBe(false)
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('runtime JSONL sink prunes managed files older than seven UTC days at bootstrap and rollover', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  const oldFile = 'worker-server-2026-04-11.jsonl'
  const retainedFile = 'worker-server-2026-04-13.jsonl'
  const unmanagedFile = 'notes-2026-04-01.jsonl'
  writeFileSync(join(logDir, oldFile), '{}\n', 'utf8')
  writeFileSync(join(logDir, retainedFile), '{}\n', 'utf8')
  writeFileSync(join(logDir, unmanagedFile), '{}\n', 'utf8')

  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 4013,
    pid: 224,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'worker-server',
  })
  installRuntimeJsonlSink({
    envValues: {LOG_DIR: logDir, LOG_LEVEL: 'INFO', SERVER_ROLE: 'worker'},
    timestamp: '2026-04-20T00:00:00.000Z',
  })

  expect(existsSync(join(logDir, oldFile))).toBe(false)
  expect(existsSync(join(logDir, retainedFile))).toBe(true)
  expect(existsSync(join(logDir, unmanagedFile))).toBe(true)

  writeFileSync(join(logDir, 'worker-server-2026-04-12.jsonl'), '{}\n', 'utf8')
  expect(
    writeRuntimeLogEvent({
      event: 'runtime.logger.rollover',
      message: 'rollover prune',
      severity: 'INFO',
      timestamp: '2026-04-21T00:00:00.001Z',
    }),
  ).toBe(true)
  expect(existsSync(join(logDir, 'worker-server-2026-04-12.jsonl'))).toBe(false)
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('runtime log pruning returns deleted managed files', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  writeFileSync(join(logDir, 'api-server-2026-04-10-api_server_instance.jsonl'), '{}\n', 'utf8')
  writeFileSync(join(logDir, 'api-server-2026-04-20.jsonl'), '{}\n', 'utf8')

  expect(pruneManagedRuntimeLogFiles({currentDate: '2026-04-20', logDir})).toEqual([
    'api-server-2026-04-10-api_server_instance.jsonl',
  ])
})

test('runtime JSONL sink remains opt-in and honors the configured log level', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 3001,
    pid: 333,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'api-server',
  })

  expect(isRuntimeJsonlSinkInstalled()).toBe(false)
  expect(
    writeRuntimeLogEvent({
      event: 'runtime.logger.uninstalled',
      message: 'not installed',
      severity: 'ERROR',
      timestamp: '2026-04-20T12:00:00.000Z',
    }),
  ).toBe(false)

  installRuntimeJsonlSink({envValues: {LOG_DIR: logDir, LOG_LEVEL: 'WARN', SERVER_ROLE: 'api'}})
  expect(
    writeRuntimeLogEvent({
      event: 'runtime.logger.filtered',
      message: 'filtered',
      severity: 'INFO',
      timestamp: '2026-04-20T12:01:00.000Z',
    }),
  ).toBe(false)
  expect(existsSync(join(logDir, 'api-server-2026-04-20.jsonl'))).toBe(false)

  expect(
    writeRuntimeLogEvent({
      event: 'runtime.logger.warning',
      message: 'warning',
      severity: 'WARN',
      timestamp: '2026-04-20T12:02:00.000Z',
    }),
  ).toBe(true)
  expect(existsSync(join(logDir, 'api-server-2026-04-20.jsonl'))).toBe(true)
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('operator-visible INFO events write to terminal and JSONL below configured file level', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  const originalLog = console.log
  const logs: unknown[][] = []
  console.log = ((...args: unknown[]) => {
    logs.push(args)
  }) as typeof console.log
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 4015,
    pid: 226,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'api-server',
  })
  installRuntimeJsonlSink({
    envValues: {LOG_DIR: logDir, LOG_LEVEL: 'ERROR', SERVER_ROLE: 'api'},
    timestamp: '2026-04-20T12:00:00.000Z',
  })

  expect(
    writeRuntimeOperatorLogEvent({
      attrs: {port: 3001},
      event: 'server.startup.port-bound',
      message: '[server] started',
      severity: 'INFO',
      timestamp: '2026-04-20T12:30:00.000Z',
    }),
  ).toBe(true)

  const logContent = readFileSync(join(logDir, 'api-server-2026-04-20.jsonl'), 'utf8')
  const [record] = logContent
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as Record<string, unknown>
    })

  expect(logs).toEqual([['[server] started']])
  expect(record.event).toBe('server.startup.port-bound')
  expect(record.severity).toBe('INFO')
  expect(record.attrs).toEqual({port: 3001})
  console.log = originalLog
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('failure-visible events always write terminal stderr and may duplicate to JSONL', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  const originalError = console.error
  const errors: unknown[][] = []
  console.error = ((...args: unknown[]) => {
    errors.push(args)
  }) as typeof console.error
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 4016,
    pid: 227,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'worker-server',
  })
  installRuntimeJsonlSink({
    envValues: {LOG_DIR: logDir, LOG_LEVEL: 'ERROR', SERVER_ROLE: 'worker'},
    timestamp: '2026-04-20T12:00:00.000Z',
  })

  expect(
    writeRuntimeFailureLogEvent({
      attrs: {attempt: 2},
      event: 'duckdb.startup.retry',
      message: '[duckdb] retrying startup after recoverable initialization failure',
      severity: 'WARN',
      terminalArgs: ['recoverable'],
      timestamp: '2026-04-20T12:30:00.000Z',
    }),
  ).toBe(true)

  const logContent = readFileSync(join(logDir, 'worker-server-2026-04-20.jsonl'), 'utf8')
  const [record] = logContent
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as Record<string, unknown>
    })

  expect(errors).toEqual([['[duckdb] retrying startup after recoverable initialization failure', 'recoverable']])
  expect(record.event).toBe('duckdb.startup.retry')
  expect(record.severity).toBe('WARN')
  expect(record.attrs).toEqual({attempt: 2})
  console.error = originalError
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('file-only rate-limited logs fall back to terminal when the runtime sink is absent', async () => {
  resetRuntimeJsonlSinkForTests()
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = ((...args: unknown[]) => {
    warnings.push(args)
  }) as typeof console.warn
  const logger = createRateLimitedLogger({sink: 'file-only', windowMs: 10})

  logger.warn('runtime.logger.file-only-fallback', 'fallback warning', {fallback: true})
  logger.warn('runtime.logger.file-only-fallback', 'suppressed warning', {suppressed: true})
  await new Promise((resolve) => {
    setTimeout(resolve, 15)
  })
  logger.warn('runtime.logger.file-only-fallback', 'fallback warning', {fallback: true})

  expect(warnings).toEqual([
    ['fallback warning', '{"fallback":true}'],
    ['fallback warning (+1 suppressed)', '{"fallback":true}'],
  ])
  console.warn = originalWarn
  resetRuntimeJsonlSinkForTests()
})

test('file-only rate-limited logs write runtime JSONL without terminal output when the sink is installed', () => {
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
  const logDir = mkdtempSync(join(tmpdir(), 'forska-runtime-logger-'))
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = ((...args: unknown[]) => {
    warnings.push(args)
  }) as typeof console.warn
  initializeRuntimeProcessIdentity({
    hostnameValue: 'test-host',
    listenPort: 4014,
    pid: 225,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    service: 'worker-server',
  })
  installRuntimeJsonlSink({
    envValues: {LOG_DIR: logDir, LOG_LEVEL: 'INFO', SERVER_ROLE: 'worker'},
    timestamp: '2026-04-20T12:00:00.000Z',
  })
  const logger = createRateLimitedLogger({sink: 'file-only', windowMs: 10})

  logger.warn('runtime.logger.file-only-installed', 'file warning', {batch: 1})

  const logContent = readFileSync(join(logDir, 'worker-server-2026-04-20.jsonl'), 'utf8')
  const [record] = logContent
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as Record<string, unknown>
    })

  expect(warnings).toEqual([])
  expect(record.event).toBe('runtime.logger.file-only-installed')
  expect(record.message).toBe('file warning')
  expect(record.severity).toBe('WARN')
  expect(record.attrs).toEqual({args: ['{"batch":1}']})
  console.warn = originalWarn
  resetRuntimeJsonlSinkForTests()
  resetRuntimeProcessIdentityForTests()
})

test('flushRuntimeLogs resolves through one bounded path', async () => {
  const result = await flushRuntimeLogs({timeoutMs: 50})

  expect(result).toBe(true)
})
