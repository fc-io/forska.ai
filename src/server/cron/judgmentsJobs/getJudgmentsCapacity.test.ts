import {afterEach, expect, mock, test} from 'bun:test'

type GetCodexMaxInflightModule = typeof import('./getCodexMaxInflight.ts')
type GetJudgmentsCapacityModule = typeof import('./getJudgmentsCapacity.ts')

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
}

const getCodexMaxInflightModulePath = getModulePath('./src/server/cron/judgmentsJobs/getCodexMaxInflight.ts')
const getInferenceRuntimeConfigModulePath = getModulePath('./src/server/utils/getInferenceRuntimeConfig.ts')
const getJudgmentsCapacityModulePath = getModulePath('./src/server/cron/judgmentsJobs/getJudgmentsCapacity.ts')

type MockRuntimeConfig = {
  codexMaxInflight: number
  gpuTotalGpus: number
  judgmentsAddToQueueMaxBatchSize: number
  judgmentsReadyTargetMultiplier: number
  ppSize: number
  sglangApiMaxBurstRequests: number
  sglangApiMaxInflightRequests: number
  sglangMaxRunningRequests: number
  tpSize: number
}

const getRuntimeConfig = (overrides: Partial<MockRuntimeConfig> = {}): MockRuntimeConfig => {
  return {
    codexMaxInflight: 0,
    gpuTotalGpus: 0,
    judgmentsAddToQueueMaxBatchSize: 10_000,
    judgmentsReadyTargetMultiplier: 2,
    ppSize: 0,
    sglangApiMaxBurstRequests: 0,
    sglangApiMaxInflightRequests: 0,
    sglangMaxRunningRequests: 0,
    tpSize: 0,
    ...overrides,
  }
}

afterEach(() => {
  mock.restore()
})

test('reads updated runtime capacity without reloading the scheduler helpers', async () => {
  let runtimeConfig = getRuntimeConfig()

  void mock.module(getInferenceRuntimeConfigModulePath, () => {
    return {
      getInferenceRuntimeConfig: () => {
        return runtimeConfig
      },
    }
  })

  const {getCodexMaxInflight} = (await import(
    `${getCodexMaxInflightModulePath}?live=${Date.now()}`
  )) as GetCodexMaxInflightModule
  const {getJudgmentsCapacity} = (await import(
    `${getJudgmentsCapacityModulePath}?live=${Date.now()}`
  )) as GetJudgmentsCapacityModule

  expect(getCodexMaxInflight()).toBe(1)
  expect(getJudgmentsCapacity(2)).toEqual({
    addToQueueMaxBatchSize: 10_000,
    maxBurst: 1,
    maxInflight: 1,
    perWorkerMaxBurstRequests: 1,
    perWorkerMaxInflightRequests: 1,
    perWorkerMaxRunningRequests: 1,
    readyTargetPerJob: 1,
    readyTargetTotal: 2,
    workerCount: 1,
  })

  runtimeConfig = getRuntimeConfig({
    codexMaxInflight: 9,
    gpuTotalGpus: 8,
    judgmentsAddToQueueMaxBatchSize: 123,
    judgmentsReadyTargetMultiplier: 3,
    ppSize: 2,
    sglangApiMaxBurstRequests: 11,
    sglangApiMaxInflightRequests: 7,
    sglangMaxRunningRequests: 5,
    tpSize: 2,
  })

  expect(getCodexMaxInflight()).toBe(9)
  expect(getJudgmentsCapacity(4)).toEqual({
    addToQueueMaxBatchSize: 123,
    maxBurst: 22,
    maxInflight: 14,
    perWorkerMaxBurstRequests: 11,
    perWorkerMaxInflightRequests: 7,
    perWorkerMaxRunningRequests: 5,
    readyTargetPerJob: 11,
    readyTargetTotal: 42,
    workerCount: 2,
  })
})
