import {randomUUID} from 'node:crypto'
import {readFileSync, rmSync, writeFileSync} from 'node:fs'

type DesktopSingleInstanceMetadata = {acquiredAt: string; leaseId: string; pid: number}

type AcquireDesktopSingleInstanceResult =
  | {metadata: DesktopSingleInstanceMetadata; release: () => void; status: 'acquired'}
  | {existing: DesktopSingleInstanceMetadata | null; status: 'already-running'}

const isExistingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isDesktopSingleInstanceMetadata = (value: unknown): value is DesktopSingleInstanceMetadata => {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as DesktopSingleInstanceMetadata).acquiredAt === 'string'
    && typeof (value as DesktopSingleInstanceMetadata).leaseId === 'string'
    && typeof (value as DesktopSingleInstanceMetadata).pid === 'number'
  )
}

const readDesktopSingleInstanceMetadata = (lockPath: string): DesktopSingleInstanceMetadata | null => {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown
    return isDesktopSingleInstanceMetadata(parsed) ? parsed : null
  } catch (error) {
    return isMissingFileError(error) ? null : null
  }
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

const removeDesktopSingleInstanceLock = ({expectedLeaseId, lockPath}: {expectedLeaseId?: string; lockPath: string}) => {
  const currentMetadata = readDesktopSingleInstanceMetadata(lockPath)
  const shouldRemove = expectedLeaseId === undefined || currentMetadata?.leaseId === expectedLeaseId

  if (!shouldRemove) {
    return false
  }

  rmSync(lockPath, {force: true})
  return true
}

const getDesktopSingleInstanceMetadata = ({
  acquiredAt = new Date().toISOString(),
  leaseId = randomUUID(),
  pid = process.pid,
}: {
  acquiredAt?: string
  leaseId?: string
  pid?: number
}) => {
  return {acquiredAt, leaseId, pid} satisfies DesktopSingleInstanceMetadata
}

const acquireDesktopSingleInstanceInner = ({
  isProcessAliveValue = isProcessAlive,
  lockPath,
  metadata,
}: {
  isProcessAliveValue?: (pid: number) => boolean
  lockPath: string
  metadata: DesktopSingleInstanceMetadata
}): AcquireDesktopSingleInstanceResult => {
  try {
    writeFileSync(lockPath, `${JSON.stringify(metadata, null, 2)}\n`, {flag: 'wx'})

    return {
      metadata,
      release: () => {
        removeDesktopSingleInstanceLock({expectedLeaseId: metadata.leaseId, lockPath})
      },
      status: 'acquired',
    }
  } catch (error) {
    if (!isExistingFileError(error)) {
      throw error
    }

    const existing = readDesktopSingleInstanceMetadata(lockPath)
    const shouldReclaim = existing === null || !isProcessAliveValue(existing.pid)

    return shouldReclaim
      ? removeDesktopSingleInstanceLock({expectedLeaseId: existing?.leaseId, lockPath})
        ? acquireDesktopSingleInstanceInner({isProcessAliveValue, lockPath, metadata})
        : {existing: readDesktopSingleInstanceMetadata(lockPath), status: 'already-running'}
      : {existing, status: 'already-running'}
  }
}

export const acquireDesktopSingleInstance = ({
  acquiredAt,
  isProcessAliveValue,
  leaseId,
  lockPath,
  pid,
}: {
  acquiredAt?: string
  isProcessAliveValue?: (pid: number) => boolean
  leaseId?: string
  lockPath: string
  pid?: number
}): AcquireDesktopSingleInstanceResult => {
  return acquireDesktopSingleInstanceInner({
    isProcessAliveValue,
    lockPath,
    metadata: getDesktopSingleInstanceMetadata({acquiredAt, leaseId, pid}),
  })
}
