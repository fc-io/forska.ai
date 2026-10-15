import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'

export type DuckdbExclusiveWorkKind = 'project_transfer_import'
export type DuckdbExclusiveWorkPhase = 'analyze' | 'commit'
export type DuckdbExclusiveWorkAdmissionState =
  | 'requested'
  | 'draining'
  | 'recycling'
  | 'ready'
  | 'running'
  | 'releasing'

export type DuckdbExclusiveWorkBlockedBy = {
  activeMaintenance?: string[]
  appendQueueDepth: number
  backgroundQueueDepth: number
  foregroundQueueDepth: number
  maxRssBytes?: number
  rssBytes?: number
  rssReady?: boolean
}

export type DuckdbExclusiveWorkSnapshot = {
  admissionState: DuckdbExclusiveWorkAdmissionState
  blockedBy: DuckdbExclusiveWorkBlockedBy
  completedRows?: number | null
  estimatedRows?: number | null
  kind: DuckdbExclusiveWorkKind
  lastProgressedAt: string
  message: string
  ownerToken?: string | null
  percent?: number | null
  phase: DuckdbExclusiveWorkPhase
  sessionId: string
  startedAt: string
  token: string
  totalRows?: number | null
}

export type DuckdbExclusiveWorkSnapshotPatch = Partial<
  Pick<
    DuckdbExclusiveWorkSnapshot,
    | 'admissionState'
    | 'blockedBy'
    | 'completedRows'
    | 'estimatedRows'
    | 'lastProgressedAt'
    | 'message'
    | 'percent'
    | 'totalRows'
  >
>

export type DuckdbExclusiveWorkInput = {
  estimatedRows?: number | null
  kind: DuckdbExclusiveWorkKind
  message?: string
  ownerToken?: string | null
  phase: DuckdbExclusiveWorkPhase
  sessionId: string
}

export type DuckdbExclusiveWorkProgressUpdate = Omit<DuckdbExclusiveWorkSnapshotPatch, 'admissionState' | 'blockedBy'>

export type DuckdbExclusiveWorkReadinessSnapshot = DuckdbExclusiveWorkBlockedBy & {recycleRecommended?: boolean}

export type DuckdbExclusiveWorkReadiness = Omit<DuckdbExclusiveWorkReadinessSnapshot, 'rssReady'> & {rssReady?: boolean}

export type DuckdbExclusiveWorkDependencies = {
  forceGarbageCollection?: () => void | Promise<void>
  getReadinessSnapshot?: () => DuckdbExclusiveWorkReadiness | Promise<DuckdbExclusiveWorkReadiness>
  now?: () => Date
  recycleDuckdbRuntime?: () => void | Promise<void>
  sleep?: (delayMs: number) => Promise<void>
}

export type PrepareDuckdbExclusiveWorkOptions = {
  dependencies?: DuckdbExclusiveWorkDependencies
  forceGarbageCollection?: () => void | Promise<void>
  getReadiness?: () => DuckdbExclusiveWorkReadiness | Promise<DuckdbExclusiveWorkReadiness>
  pollIntervalMs?: number
  reclaimDrainTimeoutMs?: number
  recycleDuckdb?: () => void | Promise<void>
  sleep?: (delayMs: number) => Promise<void>
  timeoutMs?: number
}

export type DuckdbExclusiveWorkMemoryReclaim = {
  readiness: DuckdbExclusiveWorkReadinessSnapshot
  recycled: boolean
  recycleSkippedReason?: 'drainTimeout'
}

type DuckdbExclusiveWorkReclaimSettings = {
  dependencies: DuckdbExclusiveWorkDependencies
  drainTimeoutMs: number
  pollIntervalMs: number
}

export type DuckdbExclusiveWorkLease = {
  readonly token: string
  reclaimMemory: () => Promise<DuckdbExclusiveWorkMemoryReclaim>
  release: () => Promise<void>
  run: <T>(operation: () => Promise<T> | T) => Promise<T>
  snapshot: () => DuckdbExclusiveWorkSnapshot
  update: (patch: DuckdbExclusiveWorkSnapshotPatch) => DuckdbExclusiveWorkSnapshot
  updateProgress: (update: DuckdbExclusiveWorkProgressUpdate) => DuckdbExclusiveWorkSnapshot
}

export type DuckdbExclusiveWorkHandle = DuckdbExclusiveWorkLease

const defaultPollIntervalMs = 250
const defaultTimeoutMs = 60_000
const defaultReclaimDrainTimeoutMs = 30_000
const duckdbExclusiveWorkAdmissionErrorPrefix = 'DuckDB is reserved for project-transfer '

let activeDuckdbExclusiveWork: DuckdbExclusiveWorkSnapshot | null = null
const duckdbExclusiveWorkLeaseStorage = new AsyncLocalStorage<string>()

export class DuckdbExclusiveWorkAdmissionError extends Error {}

export const isDuckdbExclusiveWorkLeaseContext = () => {
  const leaseToken = duckdbExclusiveWorkLeaseStorage.getStore()

  return leaseToken !== undefined && activeDuckdbExclusiveWork?.token === leaseToken
}

export const getDuckdbExclusiveWorkAdmissionError = ({
  operation,
  phase,
  routeOrJobKey,
}: {
  operation: string
  phase: DuckdbExclusiveWorkPhase
  routeOrJobKey: string
}) => {
  return new DuckdbExclusiveWorkAdmissionError(
    `${duckdbExclusiveWorkAdmissionErrorPrefix}${phase} work; `
      + `rejecting ${operation} for ${routeOrJobKey} until the import phase completes`,
  )
}

export const isDuckdbExclusiveWorkAdmissionError = (error: unknown) => {
  return (
    error instanceof DuckdbExclusiveWorkAdmissionError
    || (error instanceof Error
      && error.message.includes(duckdbExclusiveWorkAdmissionErrorPrefix)
      && error.message.includes('until the import phase completes'))
  )
}

const emptyBlockedBy = (): DuckdbExclusiveWorkBlockedBy => {
  return {appendQueueDepth: 0, backgroundQueueDepth: 0, foregroundQueueDepth: 0, rssReady: true}
}

const defaultReadinessSnapshot = (): DuckdbExclusiveWorkReadinessSnapshot => {
  return emptyBlockedBy()
}

const defaultSleep = (delayMs: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

const cloneBlockedBy = (blockedBy: DuckdbExclusiveWorkBlockedBy): DuckdbExclusiveWorkBlockedBy => {
  return {
    ...blockedBy,
    activeMaintenance: blockedBy.activeMaintenance === undefined ? undefined : [...blockedBy.activeMaintenance],
  }
}

const cloneSnapshot = (snapshot: DuckdbExclusiveWorkSnapshot): DuckdbExclusiveWorkSnapshot => {
  return {...snapshot, blockedBy: cloneBlockedBy(snapshot.blockedBy)}
}

const normalizeReadinessSnapshot = (snapshot: DuckdbExclusiveWorkReadiness): DuckdbExclusiveWorkReadinessSnapshot => {
  const rssReady =
    snapshot.rssReady
    ?? (snapshot.maxRssBytes === undefined || snapshot.rssBytes === undefined
      ? true
      : snapshot.rssBytes < snapshot.maxRssBytes * 0.9)

  return {
    ...snapshot,
    activeMaintenance: snapshot.activeMaintenance === undefined ? undefined : [...snapshot.activeMaintenance],
    appendQueueDepth: Math.max(0, snapshot.appendQueueDepth),
    backgroundQueueDepth: Math.max(0, snapshot.backgroundQueueDepth),
    foregroundQueueDepth: Math.max(0, snapshot.foregroundQueueDepth),
    recycleRecommended: snapshot.recycleRecommended ?? rssReady === false,
    rssReady,
  }
}

const isQueueAndMaintenanceDrained = (snapshot: DuckdbExclusiveWorkReadinessSnapshot) => {
  return (
    snapshot.foregroundQueueDepth === 0
    && snapshot.appendQueueDepth === 0
    && snapshot.backgroundQueueDepth === 0
    && (snapshot.activeMaintenance?.length ?? 0) === 0
  )
}

const isReadyForExclusiveWork = (snapshot: DuckdbExclusiveWorkReadinessSnapshot) => {
  return isQueueAndMaintenanceDrained(snapshot) && snapshot.rssReady !== false
}

const getNow = (dependencies: DuckdbExclusiveWorkDependencies) => {
  return (
    dependencies.now
    ?? (() => {
      return new Date()
    })
  )
}

const setAdmissionState = (token: string, admissionState: DuckdbExclusiveWorkAdmissionState, now: () => Date) => {
  if (activeDuckdbExclusiveWork?.token !== token) {
    return
  }

  activeDuckdbExclusiveWork = {...activeDuckdbExclusiveWork, admissionState, lastProgressedAt: now().toISOString()}
}

const updateBlockedBy = (token: string, blockedBy: DuckdbExclusiveWorkBlockedBy, now: () => Date) => {
  if (activeDuckdbExclusiveWork?.token !== token) {
    return
  }

  activeDuckdbExclusiveWork = {
    ...activeDuckdbExclusiveWork,
    blockedBy: cloneBlockedBy(blockedBy),
    lastProgressedAt: now().toISOString(),
  }
}

const updateMessage = (token: string, message: string, now: () => Date) => {
  if (activeDuckdbExclusiveWork?.token !== token) {
    return
  }

  activeDuckdbExclusiveWork = {...activeDuckdbExclusiveWork, lastProgressedAt: now().toISOString(), message}
}

const assertOwnsActiveWork = (token: string) => {
  if (activeDuckdbExclusiveWork?.token !== token) {
    throw new Error('DuckDB exclusive work lease is no longer active')
  }
}

const getActiveSnapshotForToken = (token: string) => {
  assertOwnsActiveWork(token)

  if (activeDuckdbExclusiveWork === null) {
    throw new Error('DuckDB exclusive work lease is no longer active')
  }

  return cloneSnapshot(activeDuckdbExclusiveWork)
}

const getQueueBlockerDescription = (depth: number, label: string) => {
  return depth > 0 ? `${depth} queued or running ${label} DuckDB work item(s)` : null
}

const getRssBlockerDescription = (blockedBy: DuckdbExclusiveWorkBlockedBy) => {
  return blockedBy.rssReady === false
    ? `process RSS ${blockedBy.rssBytes ?? 'unknown'} bytes against the ${blockedBy.maxRssBytes ?? 'unknown'} byte cap`
    : null
}

const getBlockedByDescription = (blockedBy: DuckdbExclusiveWorkBlockedBy) => {
  const descriptions = [
    getQueueBlockerDescription(blockedBy.foregroundQueueDepth, 'foreground'),
    getQueueBlockerDescription(blockedBy.backgroundQueueDepth, 'background'),
    getQueueBlockerDescription(blockedBy.appendQueueDepth, 'append'),
    ...(blockedBy.activeMaintenance ?? []).map((maintenance) => {
      return `in-flight ${maintenance}`
    }),
    getRssBlockerDescription(blockedBy),
  ].filter((description): description is string => {
    return description !== null
  })

  return descriptions.length === 0 ? 'no recorded blocker' : descriptions.join('; ')
}

const getTimeoutError = (snapshot: DuckdbExclusiveWorkSnapshot, timeoutMs: number) => {
  return new Error(
    `Timed out after ${timeoutMs}ms waiting for DuckDB exclusive ${snapshot.kind} ${snapshot.phase} work admission readiness `
      + `for session ${snapshot.sessionId}; blocked by ${getBlockedByDescription(snapshot.blockedBy)}`,
  )
}

const getExclusiveWorkDependencies = (options: PrepareDuckdbExclusiveWorkOptions) => {
  return {
    ...(options.dependencies ?? {}),
    forceGarbageCollection: options.forceGarbageCollection ?? options.dependencies?.forceGarbageCollection,
    getReadinessSnapshot: options.getReadiness ?? options.dependencies?.getReadinessSnapshot,
    recycleDuckdbRuntime: options.recycleDuckdb ?? options.dependencies?.recycleDuckdbRuntime,
    sleep: options.sleep ?? options.dependencies?.sleep,
  } satisfies DuckdbExclusiveWorkDependencies
}

const waitForExclusiveWorkReadiness = async (
  token: string,
  {
    dependencies,
    pollIntervalMs,
    timeoutMs,
  }: {dependencies: DuckdbExclusiveWorkDependencies; pollIntervalMs: number; timeoutMs: number},
) => {
  const now = getNow(dependencies)
  const getReadinessSnapshot = dependencies.getReadinessSnapshot ?? defaultReadinessSnapshot
  const sleep = dependencies.sleep ?? defaultSleep
  const startedAtMs = now().getTime()
  let recycled = false

  setAdmissionState(token, 'draining', now)
  updateMessage(token, 'Waiting for DuckDB maintenance work to pause', now)

  while (true) {
    assertOwnsActiveWork(token)

    const readiness = normalizeReadinessSnapshot(await getReadinessSnapshot())
    updateBlockedBy(token, readiness, now)

    if (isQueueAndMaintenanceDrained(readiness) && readiness.recycleRecommended === true && !recycled) {
      recycled = true
      setAdmissionState(token, 'recycling', now)
      updateMessage(token, 'Recycling DuckDB runtime before exclusive work starts', now)
      await dependencies.recycleDuckdbRuntime?.()
      await dependencies.forceGarbageCollection?.()
      setAdmissionState(token, 'draining', now)
      continue
    }

    if (isReadyForExclusiveWork(readiness) || (recycled && isQueueAndMaintenanceDrained(readiness))) {
      setAdmissionState(token, 'ready', now)
      updateMessage(token, 'DuckDB exclusive work is ready to start', now)
      return
    }

    if (now().getTime() - startedAtMs >= timeoutMs) {
      throw getTimeoutError(getActiveSnapshotForToken(token), timeoutMs)
    }

    await sleep(pollIntervalMs)
  }
}

const releaseDuckdbExclusiveWorkToken = async (token: string, dependencies: DuckdbExclusiveWorkDependencies = {}) => {
  const now = getNow(dependencies)

  if (activeDuckdbExclusiveWork?.token !== token) {
    return
  }

  setAdmissionState(token, 'releasing', now)

  try {
    await dependencies.forceGarbageCollection?.()
  } finally {
    if (activeDuckdbExclusiveWork?.token === token) {
      activeDuckdbExclusiveWork = null
    }
  }
}

const updateActiveDuckdbExclusiveWorkForToken = (token: string, patch: DuckdbExclusiveWorkSnapshotPatch) => {
  assertOwnsActiveWork(token)

  if (activeDuckdbExclusiveWork === null) {
    throw new Error('DuckDB exclusive work lease is no longer active')
  }

  activeDuckdbExclusiveWork = {
    ...activeDuckdbExclusiveWork,
    ...patch,
    blockedBy: patch.blockedBy === undefined ? activeDuckdbExclusiveWork.blockedBy : cloneBlockedBy(patch.blockedBy),
    lastProgressedAt: patch.lastProgressedAt ?? new Date().toISOString(),
    message: patch.message ?? activeDuckdbExclusiveWork.message,
  }

  return cloneSnapshot(activeDuckdbExclusiveWork)
}

const recycleDuckdbExclusiveWorkRuntime = async (
  token: string,
  dependencies: DuckdbExclusiveWorkDependencies,
  readiness: DuckdbExclusiveWorkReadinessSnapshot,
): Promise<DuckdbExclusiveWorkMemoryReclaim> => {
  const now = getNow(dependencies)
  const {admissionState, message} = getActiveSnapshotForToken(token)

  setAdmissionState(token, 'recycling', now)
  updateMessage(token, 'Recycling DuckDB runtime before exclusive work continues', now)
  await dependencies.recycleDuckdbRuntime?.()
  await dependencies.forceGarbageCollection?.()
  setAdmissionState(token, admissionState, now)
  updateMessage(token, message, now)

  return {readiness, recycled: true}
}

const readDuckdbExclusiveWorkReadiness = async (token: string, dependencies: DuckdbExclusiveWorkDependencies) => {
  const getReadinessSnapshot = dependencies.getReadinessSnapshot ?? defaultReadinessSnapshot

  assertOwnsActiveWork(token)

  const readiness = normalizeReadinessSnapshot(await getReadinessSnapshot())
  updateBlockedBy(token, readiness, getNow(dependencies))

  return readiness
}

const waitForDuckdbExclusiveWorkRecycleDrain = async ({
  deadlineMs,
  readiness,
  settings,
  token,
}: {
  deadlineMs: number
  readiness: DuckdbExclusiveWorkReadinessSnapshot
  settings: DuckdbExclusiveWorkReclaimSettings
  token: string
}): Promise<{drained: boolean; readiness: DuckdbExclusiveWorkReadinessSnapshot}> => {
  const drained = isQueueAndMaintenanceDrained(readiness)

  if (drained || getNow(settings.dependencies)().getTime() >= deadlineMs) {
    return {drained, readiness}
  }

  await (settings.dependencies.sleep ?? defaultSleep)(settings.pollIntervalMs)

  return waitForDuckdbExclusiveWorkRecycleDrain({
    deadlineMs,
    readiness: await readDuckdbExclusiveWorkReadiness(token, settings.dependencies),
    settings,
    token,
  })
}

const recycleDuckdbExclusiveWorkRuntimeAfterDrain = async (
  token: string,
  settings: DuckdbExclusiveWorkReclaimSettings,
  readiness: DuckdbExclusiveWorkReadinessSnapshot,
): Promise<DuckdbExclusiveWorkMemoryReclaim> => {
  const now = getNow(settings.dependencies)
  const {message} = getActiveSnapshotForToken(token)

  updateMessage(token, 'Waiting for in-flight DuckDB work to finish before recycling the runtime', now)

  const drain = await waitForDuckdbExclusiveWorkRecycleDrain({
    deadlineMs: now().getTime() + settings.drainTimeoutMs,
    readiness,
    settings,
    token,
  })

  updateMessage(token, message, now)

  return drain.drained
    ? recycleDuckdbExclusiveWorkRuntime(token, settings.dependencies, drain.readiness)
    : {readiness: drain.readiness, recycled: false, recycleSkippedReason: 'drainTimeout'}
}

const reclaimDuckdbExclusiveWorkMemory = async (
  token: string,
  settings: DuckdbExclusiveWorkReclaimSettings,
): Promise<DuckdbExclusiveWorkMemoryReclaim> => {
  assertOwnsActiveWork(token)
  await settings.dependencies.forceGarbageCollection?.()

  const readiness = await readDuckdbExclusiveWorkReadiness(token, settings.dependencies)

  return readiness.recycleRecommended === true
    ? recycleDuckdbExclusiveWorkRuntimeAfterDrain(token, settings, readiness)
    : {readiness, recycled: false}
}

const createLease = (token: string, settings: DuckdbExclusiveWorkReclaimSettings): DuckdbExclusiveWorkLease => {
  const {dependencies} = settings
  const now = getNow(dependencies)
  let released = false

  return {
    get token() {
      return token
    },
    reclaimMemory: () => {
      return reclaimDuckdbExclusiveWorkMemory(token, settings)
    },
    release: async () => {
      if (released) {
        return
      }

      released = true
      await releaseDuckdbExclusiveWorkToken(token, dependencies)
    },
    run: async <T>(operation: () => Promise<T> | T) => {
      assertOwnsActiveWork(token)
      setAdmissionState(token, 'running', now)
      updateMessage(token, 'DuckDB exclusive work is running', now)

      try {
        return await duckdbExclusiveWorkLeaseStorage.run(token, operation)
      } finally {
        await releaseDuckdbExclusiveWorkToken(token, dependencies)
        released = true
      }
    },
    snapshot: () => {
      return getActiveSnapshotForToken(token)
    },
    update: (patch: DuckdbExclusiveWorkSnapshotPatch) => {
      return updateActiveDuckdbExclusiveWorkForToken(token, patch)
    },
    updateProgress: (update: DuckdbExclusiveWorkProgressUpdate) => {
      return updateActiveDuckdbExclusiveWorkForToken(token, update)
    },
  }
}

const assertNoActiveDuckdbExclusiveWork = (input: DuckdbExclusiveWorkInput) => {
  if (activeDuckdbExclusiveWork === null) {
    return
  }

  throw new Error(
    `DuckDB exclusive work is already active for ${activeDuckdbExclusiveWork.kind}:${activeDuckdbExclusiveWork.phase}:${activeDuckdbExclusiveWork.sessionId}; cannot start ${input.kind}:${input.phase}:${input.sessionId}`,
  )
}

export const prepareDuckdbExclusiveWork = async (
  input: DuckdbExclusiveWorkInput,
  options: PrepareDuckdbExclusiveWorkOptions = {},
): Promise<DuckdbExclusiveWorkLease> => {
  assertNoActiveDuckdbExclusiveWork(input)

  const dependencies = getExclusiveWorkDependencies(options)
  const now = getNow(dependencies)
  const token = randomUUID()
  const startedAt = now().toISOString()

  activeDuckdbExclusiveWork = {
    admissionState: 'requested',
    blockedBy: emptyBlockedBy(),
    estimatedRows: input.estimatedRows ?? null,
    kind: input.kind,
    lastProgressedAt: startedAt,
    message: input.message ?? 'DuckDB exclusive work requested',
    ownerToken: input.ownerToken ?? null,
    phase: input.phase,
    sessionId: input.sessionId,
    startedAt,
    token,
  }

  try {
    await Promise.resolve()
    await waitForExclusiveWorkReadiness(token, {
      dependencies,
      pollIntervalMs: options.pollIntervalMs ?? defaultPollIntervalMs,
      timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    })

    return createLease(token, {
      dependencies,
      drainTimeoutMs: options.reclaimDrainTimeoutMs ?? defaultReclaimDrainTimeoutMs,
      pollIntervalMs: options.pollIntervalMs ?? defaultPollIntervalMs,
    })
  } catch (error) {
    await releaseDuckdbExclusiveWorkToken(token, dependencies)
    throw error
  }
}

export const acquireDuckdbExclusiveWork = prepareDuckdbExclusiveWork

export const runWithDuckdbExclusiveWork = async <T>(
  input: DuckdbExclusiveWorkInput,
  operationOrOptions: ((lease: DuckdbExclusiveWorkLease) => Promise<T> | T) | PrepareDuckdbExclusiveWorkOptions,
  optionsOrOperation: PrepareDuckdbExclusiveWorkOptions | ((lease: DuckdbExclusiveWorkLease) => Promise<T> | T) = {},
) => {
  const operation =
    typeof operationOrOptions === 'function'
      ? operationOrOptions
      : (optionsOrOperation as (lease: DuckdbExclusiveWorkLease) => Promise<T> | T)
  const options =
    typeof operationOrOptions === 'function'
      ? (optionsOrOperation as PrepareDuckdbExclusiveWorkOptions)
      : operationOrOptions
  const lease = await prepareDuckdbExclusiveWork(input, options)

  return lease.run(() => {
    return operation(lease)
  })
}

export const hasActiveDuckdbExclusiveWork = () => {
  return activeDuckdbExclusiveWork !== null
}

export const getActiveDuckdbExclusiveWorkSnapshot = () => {
  return activeDuckdbExclusiveWork === null ? null : cloneSnapshot(activeDuckdbExclusiveWork)
}

export const updateActiveDuckdbExclusiveWorkProgress = (update: DuckdbExclusiveWorkProgressUpdate) => {
  if (activeDuckdbExclusiveWork === null) {
    return null
  }

  return updateActiveDuckdbExclusiveWorkForToken(activeDuckdbExclusiveWork.token, update)
}

export const resetDuckdbExclusiveWorkForTests = () => {
  activeDuckdbExclusiveWork = null
}
