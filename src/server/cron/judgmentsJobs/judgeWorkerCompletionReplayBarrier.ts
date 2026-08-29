import {createHash} from 'node:crypto'
import {existsSync, renameSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const barrierRootEnvKey = 'FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT'
const barrierPollIntervalMs = 20
const barrierTimeoutMs = 30_000

const getClaimKey = (claimId: string) => {
  return createHash('sha256').update(claimId).digest('hex')
}

export const getJudgeWorkerCompletionReplayBarrierPaths = ({claimId, root}: {claimId: string; root: string}) => {
  const claimKey = getClaimKey(claimId)
  const resolvedRoot = resolve(root)

  return {
    consumedPath: join(resolvedRoot, `${claimKey}.consumed`),
    controlPath: join(resolvedRoot, `${claimKey}.control`),
    releasePath: join(resolvedRoot, `${claimKey}.release`),
    signalPath: join(resolvedRoot, `${claimKey}.journal-durable`),
  }
}

const waitForRelease = async (releasePath: string, deadline: number): Promise<void> => {
  if (existsSync(releasePath)) {
    return
  }

  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for judge-worker completion replay barrier release at ${releasePath}`)
  }

  await new Promise((resolveWait) => {
    setTimeout(resolveWait, barrierPollIntervalMs)
  })
  return waitForRelease(releasePath, deadline)
}

const consumeControlFile = (controlPath: string, consumedPath: string): boolean => {
  try {
    renameSync(controlPath, consumedPath)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

export const waitAtJudgeWorkerCompletionReplayBarrier = async (claimId: string): Promise<void> => {
  const configuredRoot = String(process.env[barrierRootEnvKey] ?? '').trim()

  if (configuredRoot.length === 0) {
    return
  }

  const paths = getJudgeWorkerCompletionReplayBarrierPaths({claimId, root: configuredRoot})

  if (!consumeControlFile(paths.controlPath, paths.consumedPath)) {
    return
  }

  writeFileSync(
    paths.signalPath,
    `${JSON.stringify({claimId, journalDurableAt: new Date().toISOString(), pid: process.pid})}\n`,
    {flag: 'wx'},
  )
  await waitForRelease(paths.releasePath, Date.now() + barrierTimeoutMs)
}
