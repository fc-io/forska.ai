export type ProcessActivityStatus = 'completed' | 'failed' | 'idle' | 'running' | 'skipped'

export type ProcessActivityDetails = Record<string, unknown>

export type ProcessActivityRecord = {
  category: string
  details: ProcessActivityDetails
  durationMs: number | null
  finishedAt: string | null
  id: string
  label: string
  startedAt: string
  status: ProcessActivityStatus
  updatedAt: string
}

export type ProcessActivitySnapshot = {
  active: ProcessActivityRecord[]
  maxRecent: number
  recent: ProcessActivityRecord[]
  startedAt: string
}

type ProcessActivityState = {
  active: Map<string, ProcessActivityRecord>
  maxRecent: number
  nextSequence: number
  recent: ProcessActivityRecord[]
  startedAt: string
}

type BeginProcessActivityInput = {category: string; details?: ProcessActivityDetails; label: string; now?: Date}

type FinishProcessActivityInput = {
  details?: ProcessActivityDetails
  error?: unknown
  now?: Date
  status: Exclude<ProcessActivityStatus, 'running'>
}

type RecordProcessActivityEventInput = BeginProcessActivityInput & {
  durationMs?: number | null
  status: Exclude<ProcessActivityStatus, 'running'>
}

declare global {
  var __forskaProcessActivityState: ProcessActivityState | undefined
}

const defaultRecentActivityLimit = 200

const getProcessActivityState = (): ProcessActivityState => {
  globalThis.__forskaProcessActivityState ??= {
    active: new Map(),
    maxRecent: defaultRecentActivityLimit,
    nextSequence: 0,
    recent: [],
    startedAt: new Date().toISOString(),
  }

  return globalThis.__forskaProcessActivityState
}

const processActivityState = getProcessActivityState()

const getActivityId = (state: ProcessActivityState, now: Date) => {
  state.nextSequence += 1
  return `${process.pid}:${now.getTime()}:${state.nextSequence}`
}

const getActivityDurationMs = (record: ProcessActivityRecord, finishedAt: Date) => {
  return Math.max(0, finishedAt.getTime() - new Date(record.startedAt).getTime())
}

const normalizeDetailValue = (value: unknown, depth = 0): unknown => {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) {
    return typeof value === 'bigint' ? String(value) : value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof Error) {
    return {message: value.message, name: value.name}
  }

  if (Array.isArray(value)) {
    return depth >= 2
      ? `[${value.length} items]`
      : value.slice(0, 20).map((entry) => {
          return normalizeDetailValue(entry, depth + 1)
        })
  }

  if (typeof value === 'object' && value !== null) {
    if (depth >= 2) {
      return '[object]'
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, entry]) => {
          return [key, normalizeDetailValue(entry, depth + 1)]
        }),
    )
  }

  if (typeof value === 'function') {
    return value.name ? `[function ${value.name}]` : '[function]'
  }

  if (typeof value === 'symbol') {
    return value.description ? `[symbol ${value.description}]` : '[symbol]'
  }

  return '[undefined]'
}

const normalizeDetails = (details: ProcessActivityDetails | undefined): ProcessActivityDetails => {
  return Object.fromEntries(
    Object.entries(details ?? {}).map(([key, value]) => {
      return [key, normalizeDetailValue(value)]
    }),
  )
}

const appendRecentActivity = (record: ProcessActivityRecord) => {
  processActivityState.recent.unshift(record)

  if (processActivityState.recent.length > processActivityState.maxRecent) {
    processActivityState.recent.length = processActivityState.maxRecent
  }
}

export const beginProcessActivity = ({category, details, label, now = new Date()}: BeginProcessActivityInput) => {
  const timestamp = now.toISOString()
  const id = getActivityId(processActivityState, now)
  const record: ProcessActivityRecord = {
    category,
    details: normalizeDetails(details),
    durationMs: null,
    finishedAt: null,
    id,
    label,
    startedAt: timestamp,
    status: 'running',
    updatedAt: timestamp,
  }

  processActivityState.active.set(id, record)
  return id
}

export const finishProcessActivity = (
  activityId: string | null | undefined,
  {details, error, now = new Date(), status}: FinishProcessActivityInput,
) => {
  if (!activityId) {
    return null
  }

  const activeRecord = processActivityState.active.get(activityId)

  if (activeRecord === undefined) {
    return null
  }

  processActivityState.active.delete(activityId)

  const finishedAt = now.toISOString()
  const finishedRecord: ProcessActivityRecord = {
    ...activeRecord,
    details: normalizeDetails({...activeRecord.details, ...(details ?? {}), ...(error === undefined ? {} : {error})}),
    durationMs: getActivityDurationMs(activeRecord, now),
    finishedAt,
    status,
    updatedAt: finishedAt,
  }

  appendRecentActivity(finishedRecord)
  return finishedRecord
}

export const recordProcessActivityEvent = ({
  category,
  details,
  durationMs = null,
  label,
  now = new Date(),
  status,
}: RecordProcessActivityEventInput) => {
  const timestamp = now.toISOString()
  const record: ProcessActivityRecord = {
    category,
    details: normalizeDetails(details),
    durationMs,
    finishedAt: timestamp,
    id: getActivityId(processActivityState, now),
    label,
    startedAt: timestamp,
    status,
    updatedAt: timestamp,
  }

  appendRecentActivity(record)
  return record
}

export const getProcessActivitySnapshot = ({limit = 50}: {limit?: number} = {}): ProcessActivitySnapshot => {
  const clampedLimit = Math.max(1, Math.min(processActivityState.maxRecent, Math.floor(limit)))
  const active = Array.from(processActivityState.active.values()).sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  })

  return {
    active,
    maxRecent: processActivityState.maxRecent,
    recent: processActivityState.recent.slice(0, clampedLimit),
    startedAt: processActivityState.startedAt,
  }
}

export const resetProcessActivityStateForTests = () => {
  processActivityState.active.clear()
  processActivityState.nextSequence = 0
  processActivityState.recent = []
  processActivityState.startedAt = new Date().toISOString()
}
