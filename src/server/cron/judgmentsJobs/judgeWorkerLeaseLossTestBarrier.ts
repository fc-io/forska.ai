import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {sleep} from 'bun'

type BarrierEnvironment = Record<string, string | undefined>

export type JudgeWorkerLeaseLossTestBarrierPaths = {
  outcomePath: string
  pausePath: string
  reachedPath: string
  releasePath: string
}

const getBarrierPaths = (envValues: BarrierEnvironment = process.env): JudgeWorkerLeaseLossTestBarrierPaths | null => {
  const root = envValues.FORSKA_TEST_JUDGE_LEASE_LOSS_BARRIER_ROOT
  const workerId = envValues.JUDGE_WORKER_ID

  if (
    envValues.NODE_ENV !== 'test'
    || typeof root !== 'string'
    || root.length === 0
    || typeof workerId !== 'string'
    || workerId.length === 0
  ) {
    return null
  }

  return {
    outcomePath: join(root, `${workerId}.outcome`),
    pausePath: join(root, `${workerId}.pause`),
    reachedPath: join(root, `${workerId}.reached`),
    releasePath: join(root, `${workerId}.release`),
  }
}

export const isJudgeWorkerLeaseLossTestBarrierActive = (envValues: BarrierEnvironment = process.env): boolean => {
  const paths = getBarrierPaths(envValues)
  return paths !== null && existsSync(paths.pausePath)
}

export const getJudgeWorkerLeaseLossTestClaimLimit = (
  requestedLimit: number,
  envValues: BarrierEnvironment = process.env,
): number => {
  const configuredLimit = Number(envValues.FORSKA_TEST_JUDGE_CLAIM_LIMIT)

  return envValues.NODE_ENV === 'test' && Number.isInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(requestedLimit, configuredLimit)
    : requestedLimit
}

export const recordJudgeWorkerLeaseLossTestBarrierOutcome = (
  outcome: string,
  envValues: BarrierEnvironment = process.env,
): void => {
  const paths = getBarrierPaths(envValues)
  if (!paths || !existsSync(paths.pausePath)) return

  try {
    writeFileSync(paths.outcomePath, `${outcome}\n`, {flag: 'wx'})
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
}

export const getJudgeWorkerLeaseLossTestBarrierPaths = (
  envValues: BarrierEnvironment = process.env,
): JudgeWorkerLeaseLossTestBarrierPaths => {
  const paths = getBarrierPaths(envValues)
  if (!paths) throw new Error('Judge-worker lease-loss test barrier is unavailable')
  return paths
}

export const waitAtJudgeWorkerLeaseLossTestBarrier = async (
  envValues: BarrierEnvironment = process.env,
): Promise<boolean> => {
  const paths = getBarrierPaths(envValues)
  if (!paths || !existsSync(paths.pausePath)) return false

  mkdirSync(dirname(paths.pausePath), {recursive: true})
  writeFileSync(paths.reachedPath, 'reached\n')
  const deadline = Date.now() + 180_000

  while (!existsSync(paths.releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for judge-worker lease-loss test barrier release')
    }
    await sleep(25)
  }

  return true
}
