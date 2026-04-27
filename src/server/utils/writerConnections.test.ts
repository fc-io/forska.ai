import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  getDuckdbOwnerConnectionsOverview,
  recordDuckdbOwnerConnectionProxy,
  upsertDuckdbOwnerConnectionHeartbeat,
} from './duckdbOwnerConnections.ts'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getDuckdbOwnerHeaders = (startedAt: string) => {
  return new Headers({
    'x-forska-api-server-port': '4010',
    'x-forska-hostname': 'test-host',
    'x-forska-instance-id': `api-server:test-host:4010:12345:${startedAt}`,
    'x-forska-listen-port': '4010',
    'x-forska-pid': '12345',
    'x-forska-process-started-at': startedAt,
    'x-forska-runtime-profile': 'primary',
    'x-forska-runtime-version': 'split-runtime-v1',
    'x-forska-server-role': 'api',
    'x-forska-service': 'api-server',
    'x-forska-started-at': startedAt,
    'x-forska-duckdb-owner-url': 'http://127.0.0.1:4011/',
  })
}

test('worker registry overview reads persisted maintenance heartbeats across processes', async () => {
  const duckdbPath = `/tmp/f1-worker-registry-${Date.now()}.duckdb`
  const startedAt = new Date().toISOString()

  try {
    await upsertDuckdbOwnerConnectionHeartbeat(
      {
        apiServerPort: 4101,
        duckdbOwnerUrl: 'http://127.0.0.1:4101',
        hostname: 'registry-host',
        instanceId: `maintenance-worker-server:registry-host:4101:1001:${startedAt}`,
        listenPort: 4101,
        memoryLimit: '20GB',
        pid: 1001,
        processStartedAt: startedAt,
        runtimeProfile: 'primary',
        serverRole: 'maintenance-worker',
        service: 'maintenance-worker-server',
        startedAt,
      },
      {databasePath: duckdbPath},
    )
    await upsertDuckdbOwnerConnectionHeartbeat(
      {
        apiServerPort: 4102,
        duckdbOwnerUrl: 'http://127.0.0.1:4101',
        hostname: 'registry-host',
        instanceId: `judge-worker-server:registry-host:4102:1002:${startedAt}`,
        listenPort: 4102,
        memoryLimit: '2GB',
        pid: 1002,
        processStartedAt: startedAt,
        runtimeProfile: 'secondary',
        serverRole: 'judge-worker',
        service: 'judge-worker-server',
        startedAt,
      },
      {databasePath: duckdbPath},
    )

    const overview = await getDuckdbOwnerConnectionsOverview({databasePath: duckdbPath})
    const maintenanceCapability = overview.registry.capabilities.find((capability) => {
      return capability.capability === 'maintenance'
    })
    const judgingCapability = overview.registry.capabilities.find((capability) => {
      return capability.capability === 'judging'
    })

    expect(overview.registry.registeredProcessCount).toBe(2)
    expect(maintenanceCapability).toMatchObject({
      eligibleConsumerCount: 1,
      eligibleConsumerPresent: true,
      freshConsumerCount: 1,
      registeredConsumerCount: 1,
    })
    expect(judgingCapability).toMatchObject({
      eligibleConsumerCount: 1,
      eligibleConsumerPresent: true,
      freshConsumerCount: 1,
      registeredConsumerCount: 1,
    })
  } finally {
    removeFileIfExists(`${duckdbPath}.worker-registry`)
  }
})

test('worker registry overview surfaces takeover in progress from ownerless-readable records', async () => {
  const duckdbPath = `/tmp/f1-worker-registry-takeover-${Date.now()}.duckdb`
  const startedAt = new Date().toISOString()

  try {
    await upsertDuckdbOwnerConnectionHeartbeat(
      {
        apiServerPort: 4110,
        duckdbOwnerUrl: 'http://127.0.0.1:4101',
        hostname: 'registry-host',
        instanceId: `single-server:registry-host:4110:1010:${startedAt}`,
        listenPort: 4110,
        memoryLimit: '20GB',
        pid: 1010,
        processStartedAt: startedAt,
        runtimeProfile: 'secondary',
        serverRole: 'auto',
        service: 'single-server',
        startedAt,
        takeover: {
          candidate: true,
          intent: 'takeover_in_progress',
          observedAt: startedAt,
          ownerFreshness: 'owner_dead',
          ownerHeartbeatAt: '2026-04-22T20:00:00.000Z',
          ownerLeaseId: 'lost-owner-lease',
          ownerUrl: 'http://127.0.0.1:4101',
        },
      },
      {databasePath: duckdbPath},
    )

    const overview = await getDuckdbOwnerConnectionsOverview({databasePath: duckdbPath})

    expect(overview.registry.takeover).toMatchObject({
      candidateCount: 1,
      latestOwnerFreshness: 'owner_dead',
      status: 'takeover_in_progress',
      takeoverInProgressCount: 1,
    })
  } finally {
    removeFileIfExists(`${duckdbPath}.worker-registry`)
  }
})

test('worker registry persists concurrent proxied requests that share the same millisecond timestamp', async () => {
  const duckdbPath = `/tmp/f1-worker-registry-concurrent-${Date.now()}.duckdb`
  const startedAt = new Date().toISOString()
  const headers = getDuckdbOwnerHeaders(startedAt)
  const originalDateNow = Date.now

  Date.now = () => {
    return 1_777_232_927_974
  }

  try {
    await Promise.all(
      Array.from({length: 12}, async () => {
        return recordDuckdbOwnerConnectionProxy(headers, '/api/projects', {databasePath: duckdbPath})
      }),
    )

    const overview = await getDuckdbOwnerConnectionsOverview({databasePath: duckdbPath})
    const [follower] = overview.followers

    expect(overview.registry.registeredProcessCount).toBe(1)
    expect(follower?.lastRequestPath).toBe('/api/projects')
    expect(follower?.proxyCount).toBeGreaterThan(0)
  } finally {
    Date.now = originalDateNow
    removeFileIfExists(`${duckdbPath}.worker-registry`)
  }
})
