import {expect, mock, test} from 'bun:test'

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
}

const waitFor = async (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const martRefreshDrainHeartbeatModulePath = getModulePath('./src/server/utils/martRefreshDrainHeartbeat.ts')
const martRefreshServiceModulePath = getModulePath('./src/server/services/getDuckdbMartRefreshService.ts')
const serverRuntimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
type MartRefreshDrainHeartbeatModule = typeof import('./martRefreshDrainHeartbeat.ts')
type ServerRuntimeRoleModule = typeof import('./serverRuntimeRole.ts')

test('startMartRefreshDrainHeartbeat flushes immediately when writer work is enabled', async () => {
  let flushCount = 0
  const actualServerRuntimeRoleModule = (await import(
    `${serverRuntimeRoleModulePath}?actual=${Date.now()}`
  )) as ServerRuntimeRoleModule

  void mock.module(martRefreshServiceModulePath, () => {
    return {
      getDuckdbMartRefreshService: () => {
        return {
          flush: async () => {
            flushCount += 1
          },
        }
      },
    }
  })
  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      ...actualServerRuntimeRoleModule,
      shouldCurrentServerRunWriterWork: () => {
        return true
      },
    }
  })

  const martRefreshDrainHeartbeatModule = (await import(
    `${martRefreshDrainHeartbeatModulePath}?writer=${Date.now()}`
  )) as MartRefreshDrainHeartbeatModule
  const stop = martRefreshDrainHeartbeatModule.startMartRefreshDrainHeartbeat({intervalMs: 50})

  try {
    await waitFor(20)
    expect(flushCount).toBeGreaterThanOrEqual(1)
  } finally {
    stop()
  }
})

test('startMartRefreshDrainHeartbeat begins flushing after the server becomes writer', async () => {
  let flushCount = 0
  let shouldRunWriterWork = false
  const actualServerRuntimeRoleModule = (await import(
    `${serverRuntimeRoleModulePath}?actual=${Date.now()}`
  )) as ServerRuntimeRoleModule

  void mock.module(martRefreshServiceModulePath, () => {
    return {
      getDuckdbMartRefreshService: () => {
        return {
          flush: async () => {
            flushCount += 1
          },
        }
      },
    }
  })
  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      ...actualServerRuntimeRoleModule,
      shouldCurrentServerRunWriterWork: () => {
        return shouldRunWriterWork
      },
    }
  })

  const martRefreshDrainHeartbeatModule = (await import(
    `${martRefreshDrainHeartbeatModulePath}?promotion=${Date.now()}`
  )) as MartRefreshDrainHeartbeatModule
  const stop = martRefreshDrainHeartbeatModule.startMartRefreshDrainHeartbeat({intervalMs: 10})

  try {
    await waitFor(25)
    expect(flushCount).toBe(0)

    shouldRunWriterWork = true

    await waitFor(30)
    expect(flushCount).toBeGreaterThanOrEqual(1)
  } finally {
    stop()
  }
})
