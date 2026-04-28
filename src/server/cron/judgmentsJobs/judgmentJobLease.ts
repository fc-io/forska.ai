import {createHash, randomUUID} from 'node:crypto'
import {readFile, rename, unlink, writeFile} from 'node:fs/promises'
import {mkdir} from 'node:fs/promises'
import {hostname, networkInterfaces} from 'node:os'
import {dirname, join} from 'node:path'

import {getJudgmentJobLeasePath} from './judgmentJobPaths.ts'

// Same-host/local-disk exclusivity only for now. This prevents split-brain on a
// single SQLite-backed judgment job; it is not yet a cross-server scheduler.
export const judgmentJobLeaseHeartbeatStaleMs = 30_000

export type JudgmentJobLeaseMetadata = {
  acquiredAt: string
  apiServerPort: number
  heartbeatAt: string
  hostname: string
  jobId: string
  leaseId: string
  machineFingerprint?: string
  pid: number
  serverJobId: string
}

export type JudgmentJobLease = {leasePath: string; metadata: JudgmentJobLeaseMetadata}

export class JudgmentJobLeaseHeldError extends Error {
  metadata: JudgmentJobLeaseMetadata

  constructor(jobId: string, metadata: JudgmentJobLeaseMetadata, options?: {cause?: unknown}) {
    super(
      `Judgment job lease for ${jobId} is held by ${getLeaseOwnerText(metadata)} since ${metadata.acquiredAt}`,
      options,
    )
    this.name = 'JudgmentJobLeaseHeldError'
    this.metadata = metadata
  }
}

export const isJudgmentJobLeaseHeldError = (error: unknown) => {
  return error instanceof JudgmentJobLeaseHeldError
}

const normalizeHostname = (value: string) => {
  return value.trim().toLowerCase()
}

const getCurrentMachineFingerprintSource = () => {
  const macAddresses = Array.from(
    new Set(
      Object.values(networkInterfaces())
        .flatMap((addresses) => {
          return (addresses ?? []).map((address) => {
            return address.mac.trim().toLowerCase()
          })
        })
        .filter((macAddress) => {
          return macAddress !== '' && macAddress !== '00:00:00:00:00:00'
        }),
    ),
  ).sort()

  return macAddresses.length > 0 ? macAddresses.join('|') : normalizeHostname(hostname())
}

const currentMachineFingerprint = createHash('sha256').update(getCurrentMachineFingerprintSource()).digest('hex')

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isExistingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readLeaseMetadata = async (jobId: string) => {
  try {
    const raw = await readFile(getJudgmentJobLeasePath(jobId), 'utf8')
    return JSON.parse(raw) as JudgmentJobLeaseMetadata
  } catch (error) {
    return isMissingFileError(error) ? null : Promise.reject(error)
  }
}

const writeLeaseMetadata = async (leasePath: string, metadata: JudgmentJobLeaseMetadata, flag?: 'wx') => {
  await mkdir(dirname(leasePath), {recursive: true})

  if (flag === 'wx') {
    await writeFile(leasePath, JSON.stringify(metadata, null, 2), {flag})
    return
  }

  const tempPath = join(dirname(leasePath), `.${randomUUID()}.lease.tmp`)
  await writeFile(tempPath, JSON.stringify(metadata, null, 2))
  await rename(tempPath, leasePath)
}

const getLeaseOwnerText = (metadata: JudgmentJobLeaseMetadata) => {
  return `${metadata.hostname} pid=${metadata.pid} serverJobId=${metadata.serverJobId}`
}

const isLeaseOwnedByCurrentMachine = (metadata: JudgmentJobLeaseMetadata) => {
  return (
    metadata.machineFingerprint === currentMachineFingerprint
    || normalizeHostname(metadata.hostname) === normalizeHostname(hostname())
  )
}

const isLeaseOwnedByCurrentProcess = (metadata: JudgmentJobLeaseMetadata) => {
  return isLeaseOwnedByCurrentMachine(metadata) && metadata.pid === process.pid
}

const canReclaimLease = (metadata: JudgmentJobLeaseMetadata, takeoverLeaseId?: string) => {
  return (
    (isLeaseOwnedByCurrentMachine(metadata) && !isJudgmentJobLeaseProcessAlive(metadata))
    || isJudgmentJobLeaseStale(metadata)
    || (takeoverLeaseId !== undefined && metadata.leaseId === takeoverLeaseId && isJudgmentJobLeaseStale(metadata))
  )
}

export const isJudgmentJobLeaseProcessAlive = (metadata: JudgmentJobLeaseMetadata) => {
  return isLeaseOwnedByCurrentMachine(metadata) ? isProcessAlive(metadata.pid) : true
}

export const isJudgmentJobLeaseStale = (metadata: JudgmentJobLeaseMetadata, nowMs = Date.now()) => {
  return nowMs - new Date(metadata.heartbeatAt).getTime() > judgmentJobLeaseHeartbeatStaleMs
}

export const readJudgmentJobLease = async (jobId: string): Promise<JudgmentJobLeaseMetadata | null> => {
  return readLeaseMetadata(jobId)
}

export const acquireJudgmentJobLease = async (params: {
  apiServerPort: number
  jobId: string
  serverJobId: string
  takeoverLeaseId?: string
}): Promise<JudgmentJobLease> => {
  const leasePath = getJudgmentJobLeasePath(params.jobId)
  const acquiredAt = new Date().toISOString()
  const metadata = {
    acquiredAt,
    apiServerPort: params.apiServerPort,
    heartbeatAt: acquiredAt,
    hostname: hostname(),
    jobId: params.jobId,
    leaseId: randomUUID(),
    machineFingerprint: currentMachineFingerprint,
    pid: process.pid,
    serverJobId: params.serverJobId,
  } satisfies JudgmentJobLeaseMetadata

  try {
    await writeLeaseMetadata(leasePath, metadata, 'wx')
    return {leasePath, metadata}
  } catch (error) {
    if (!isExistingFileError(error)) {
      throw error
    }

    const currentLease = await readLeaseMetadata(params.jobId)

    if (!currentLease) {
      return acquireJudgmentJobLease(params)
    }

    if (isLeaseOwnedByCurrentProcess(currentLease)) {
      return {leasePath, metadata: currentLease}
    }

    if (canReclaimLease(currentLease, params.takeoverLeaseId)) {
      await unlink(leasePath).catch((unlinkError) => {
        if (!isMissingFileError(unlinkError)) {
          throw unlinkError
        }
      })
      return acquireJudgmentJobLease(params)
    }

    throw new JudgmentJobLeaseHeldError(params.jobId, currentLease, {cause: error})
  }
}

export const updateJudgmentJobLeaseHeartbeat = async (lease: JudgmentJobLease): Promise<JudgmentJobLease> => {
  const currentLease = await readLeaseMetadata(lease.metadata.jobId)

  if (!currentLease || currentLease.leaseId !== lease.metadata.leaseId) {
    throw new Error('Judgment job lease is no longer owned by this process')
  }

  const heartbeatAt = new Date().toISOString()
  const metadata = {...currentLease, heartbeatAt}

  await writeLeaseMetadata(lease.leasePath, metadata)
  return {leasePath: lease.leasePath, metadata}
}

export const releaseJudgmentJobLease = async (lease: JudgmentJobLease): Promise<void> => {
  const currentLease = await readLeaseMetadata(lease.metadata.jobId)

  return !currentLease || currentLease.leaseId !== lease.metadata.leaseId
    ? undefined
    : unlink(lease.leasePath).catch((error) => {
        if (!isMissingFileError(error)) {
          throw error
        }
      })
}
