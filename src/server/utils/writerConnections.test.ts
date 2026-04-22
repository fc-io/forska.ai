import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {getDuckdbOwnerConnectionsOverview, upsertDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnections.ts'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
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
