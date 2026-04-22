import {expect, test} from 'bun:test'

import {
  assertDuckdbOwnerConnectionHeartbeatCompatible,
  getDuckdbOwnerConnectionHeartbeatPayload,
  getRuntimeCapabilityRegistryOverview,
  recordDuckdbOwnerConnectionProxy,
  upsertDuckdbOwnerConnectionHeartbeat,
} from './duckdbOwnerConnections.ts'
import {getRuntimeCutoverVersion} from './runtimeCutover.ts'
import {createRuntimeLogRecord} from './runtimeLogger.ts'
import {initializeRuntimeProcessIdentity, resetRuntimeProcessIdentityForTests} from './runtimeProcessIdentity.ts'

const getDuckdbOwnerHeaders = (startedAt: string) => {
  return new Headers({
    'x-forska-api-server-port': '4010',
    'x-forska-hostname': 'test-host',
    'x-forska-instance-id': `api-server:test-host:4010:12345:${startedAt}`,
    'x-forska-listen-port': '4010',
    'x-forska-pid': '12345',
    'x-forska-process-started-at': startedAt,
    'x-forska-runtime-profile': 'primary',
    'x-forska-runtime-version': getRuntimeCutoverVersion(),
    'x-forska-server-role': 'api',
    'x-forska-service': 'api-server',
    'x-forska-started-at': startedAt,
    'x-forska-duckdb-owner-url': 'http://127.0.0.1:4011/',
  })
}

test('tracks DuckDB owner connection heartbeats and proxy metadata', () => {
  const startedAt = new Date().toISOString()
  const heartbeat = upsertDuckdbOwnerConnectionHeartbeat({
    apiServerPort: 4010,
    hostname: 'test-host',
    instanceId: `api-server:test-host:4010:12345:${startedAt}`,
    listenPort: 4010,
    pid: 12345,
    processStartedAt: startedAt,
    runtimeProfile: 'primary',
    serverRole: 'api',
    service: 'api-server',
    startedAt,
    duckdbOwnerUrl: 'http://127.0.0.1:4011',
  })
  const proxied = recordDuckdbOwnerConnectionProxy(getDuckdbOwnerHeaders(startedAt), '/api/projects')

  expect(heartbeat.connectionId).toBe(`api-server:test-host:4010:12345:${startedAt}`)
  expect(heartbeat.instanceId).toBe(heartbeat.connectionId)
  expect(heartbeat.processStartedAt).toBe(startedAt)
  expect(heartbeat.service).toBe('api-server')
  expect(proxied?.connectionId).toBe(heartbeat.connectionId)
  expect(proxied?.lastRequestPath).toBe('/api/projects')
  expect(proxied?.proxyCount).toBe(1)
  expect(proxied?.runtimeProfile).toBe('primary')
  expect(proxied?.duckdbOwnerUrl).toBe('http://127.0.0.1:4011')
  expect(proxied?.capabilities).toEqual(['api', 'owner-proxy'])
})

test('uses the shared runtime process identity for runtime logs and owner heartbeats', () => {
  resetRuntimeProcessIdentityForTests()
  initializeRuntimeProcessIdentity({
    hostnameValue: 'shared-host',
    listenPort: 3001,
    pid: 56789,
    processStartedAt: '2026-04-20T12:00:00.000Z',
    runtimeProfile: 'secondary',
    service: 'api-server',
  })

  const runtimeRecord = createRuntimeLogRecord({
    event: 'duckdb-owner.identity.shared',
    message: 'shared identity',
    serverRole: 'api',
    severity: 'INFO',
    timestamp: '2026-04-20T12:30:00.000Z',
  })
  const heartbeat = getDuckdbOwnerConnectionHeartbeatPayload()

  expect(heartbeat.instanceId).toBe(runtimeRecord.runtime.instanceId)
  expect(heartbeat.hostname).toBe(runtimeRecord.runtime.hostname)
  expect(heartbeat.listenPort).toBe(runtimeRecord.runtime.listenPort)
  expect(heartbeat.processStartedAt).toBe(runtimeRecord.runtime.processStartedAt)
  expect(heartbeat.runtimeProfile).toBe(runtimeRecord.runtime.runtimeProfile)
  expect(heartbeat.runtimeVersion).toBe(getRuntimeCutoverVersion())
  expect(heartbeat.service).toBe(runtimeRecord.runtime.service)
  expect(heartbeat.startedAt).toBe(runtimeRecord.runtime.processStartedAt)
  resetRuntimeProcessIdentityForTests()
})

test('summarizes registered runtime capabilities from fresh heartbeats', () => {
  const startedAt = new Date().toISOString()
  const apiWorker = upsertDuckdbOwnerConnectionHeartbeat({
    apiServerPort: 4010,
    hostname: 'test-host',
    instanceId: `api-server:test-host:4010:12345:${startedAt}`,
    listenPort: 4010,
    pid: 12345,
    processStartedAt: startedAt,
    runtimeProfile: 'primary',
    serverRole: 'api',
    service: 'api-server',
    startedAt,
    duckdbOwnerUrl: 'http://127.0.0.1:4011',
  })
  const maintenanceWorker = upsertDuckdbOwnerConnectionHeartbeat({
    apiServerPort: 4011,
    hostname: 'test-host',
    instanceId: `maintenance-worker-server:test-host:4011:12346:${startedAt}`,
    listenPort: 4011,
    pid: 12346,
    processStartedAt: startedAt,
    runtimeProfile: 'primary',
    serverRole: 'maintenance-worker',
    service: 'maintenance-worker-server',
    startedAt,
    duckdbOwnerUrl: 'http://127.0.0.1:4011',
  })
  const registry = getRuntimeCapabilityRegistryOverview([apiWorker, maintenanceWorker, maintenanceWorker])

  expect(maintenanceWorker.capabilities).toEqual(['duckdb-owner', 'maintenance'])
  expect(registry.registeredProcessCount).toBe(2)
  expect(registry.freshRegisteredProcessCount).toBe(2)
  expect(registry.staleRegisteredProcessCount).toBe(0)
  expect(
    registry.capabilities.find((capability) => {
      return capability.capability === 'api'
    }),
  ).toMatchObject({eligibleConsumerCount: 1, eligibleConsumerPresent: true, registeredConsumerCount: 1})
  expect(
    registry.capabilities.find((capability) => {
      return capability.capability === 'maintenance'
    }),
  ).toMatchObject({eligibleConsumerCount: 1, eligibleConsumerPresent: true, registeredConsumerCount: 1})
})

test('rejects pre-cutover DuckDB owner connection heartbeats', () => {
  const startedAt = new Date().toISOString()

  expect(() => {
    assertDuckdbOwnerConnectionHeartbeatCompatible({
      apiServerPort: 4010,
      hostname: 'test-host',
      pid: 12345,
      serverRole: 'api',
      startedAt,
      duckdbOwnerUrl: 'http://127.0.0.1:4011',
    })
  }).toThrow('Incompatible Forska split runtime version')
})
