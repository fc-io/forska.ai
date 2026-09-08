import {Effect} from 'effect'

import {readDuckdbOwnerLease, releaseDuckdbOwnerLease} from '../src/server/utils/duckdbOwnerLease.ts'
import {getConfiguredDuckdbPath} from '../src/server/utils/getDuckdbPath.ts'
import {
  readJudgeWorkerJournalLock,
  releaseJudgeWorkerJournalLock,
} from '../src/server/utils/judgeWorkerJournalIdentity.ts'
import {isLockOwnedByCurrentMachine} from '../src/server/utils/localMachineIdentity.ts'

type StoppedServer = {
  pid: number
  processStartedAt: string
  exitedAt: string
  role: 'api' | 'judge' | 'maintenance'
  envValues: Record<string, string | undefined>
  cwd?: string
}

const isProcessGone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

const belongsToStoppedServer = (
  metadata: {pid: number; acquiredAt: string; hostname: string; machineFingerprint?: string},
  server: StoppedServer,
) => {
  const acquiredAt = Date.parse(metadata.acquiredAt)
  return (
    metadata.pid === server.pid
    && isLockOwnedByCurrentMachine(metadata)
    && acquiredAt >= Date.parse(server.processStartedAt)
    && acquiredAt <= Date.parse(server.exitedAt)
    && isProcessGone(server.pid)
  )
}

export const releaseStoppedServerLocks = (server: StoppedServer) => {
  return Effect.gen(function* () {
    if (server.role === 'maintenance') {
      const databasePath = getConfiguredDuckdbPath({cwd: server.cwd, envValues: server.envValues})
      const metadata = yield* readDuckdbOwnerLease(databasePath)
      if (metadata !== null && belongsToStoppedServer(metadata, server)) {
        yield* releaseDuckdbOwnerLease({leasePath: `${databasePath}.duckdb-owner.lock`, metadata})
      }
    }
    if (server.role === 'judge') {
      yield* Effect.sync(() => {
        const lock = readJudgeWorkerJournalLock({cwd: server.cwd, envValues: server.envValues})
        if (lock !== null && belongsToStoppedServer(lock.metadata, server)) {
          releaseJudgeWorkerJournalLock(lock.identity.lockPath, lock.metadata.leaseId)
        }
      })
    }
  })
}
