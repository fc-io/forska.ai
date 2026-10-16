import type {
  ProjectImportOverallProgress,
  ProjectImportSession,
  ProjectImportSessionState,
} from './projectImportClient.ts'

export type ImportProgressMemory = {
  determinatePercent: number
  displayPercent: number
  key: string
  settled: boolean
  stepKey: string | null
  stepObservedAtMs: number
}

export type ImportProgressDisplay = {
  determinatePercent: number | null
  displayPercent: number | null
  indeterminate: boolean
  memory: ImportProgressMemory | null
  stepLabel: string | null
}

type ImportProgressDisplayInput = {
  createProgress: boolean
  memory: ImportProgressMemory | null
  nowMs: number
  session: ProjectImportSession | null
  uploadPercent: number | null
}

const uploadOverallPercent = 3
const waitingSlotFillShare = 0.9
const waitingSlotTimeConstantMs = 10_000
const activeSessionStates = new Set<ProjectImportSessionState>([
  'committing',
  'extracting',
  'queued',
  'uploading',
  'analyzing',
])
const uploadSessionStates = new Set<ProjectImportSessionState>(['awaiting_upload', 'uploading'])

const clampPercent = (value: number) => {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

const getLegacyPercent = (session: ProjectImportSession | null) => {
  const progressPercent = session?.progress?.percent
  const rowCountProcessed = session?.progress?.rowCountProcessed ?? session?.progress?.completedRows ?? null
  const rowCountTotal = session?.progress?.rowCountTotal ?? session?.progress?.totalRows ?? null
  const countPercent =
    typeof rowCountProcessed === 'number'
    && Number.isFinite(rowCountProcessed)
    && typeof rowCountTotal === 'number'
    && Number.isFinite(rowCountTotal)
    && rowCountTotal > 0
      ? Math.round(clampPercent((rowCountProcessed / rowCountTotal) * 100))
      : null

  return typeof progressPercent === 'number' ? Math.round(progressPercent) : countPercent
}

const getOperation = ({
  createProgress,
  overall,
  session,
}: {
  createProgress: boolean
  overall: ProjectImportOverallProgress | null
  session: ProjectImportSession | null
}) => {
  return overall?.operation ?? (createProgress || session?.state === 'committing' ? 'commit' : 'analyze')
}

export const getUploadOverallPercent = (uploadPercent: number | null) => {
  return uploadPercent === null ? null : Math.min(uploadOverallPercent, clampPercent(uploadPercent) * 0.03)
}

export const getWaitingSlotFillPercent = ({
  elapsedMs,
  step,
}: {
  elapsedMs: number
  step: ProjectImportOverallProgress['step']
}) => {
  const slotPercent = Math.max(0, step.endPercent - step.startPercent)

  return clampPercent(
    step.startPercent
      + slotPercent * waitingSlotFillShare * (1 - Math.exp(-Math.max(0, elapsedMs) / waitingSlotTimeConstantMs)),
  )
}

const getLegacyImportProgressDisplay = (session: ProjectImportSession | null): ImportProgressDisplay => {
  const percent = getLegacyPercent(session)

  return {determinatePercent: percent, displayPercent: percent, indeterminate: false, memory: null, stepLabel: null}
}

const getCurrentOperationSession = (session: ProjectImportSession | null, createProgress: boolean) => {
  return session !== null && createProgress && session.progress?.overall?.operation === 'analyze'
    ? {...session, progress: null}
    : session
}

const getOverallImportProgressDisplay = ({
  active,
  key,
  memory,
  nowMs,
  overall,
  running,
  uploadShare,
}: {
  active: boolean
  key: string
  memory: ImportProgressMemory | null
  nowMs: number
  overall: ProjectImportOverallProgress | null
  running: boolean
  uploadShare: number | null
}): ImportProgressDisplay => {
  const previous = memory === null || memory.key !== key || (memory.settled && active) ? null : memory
  const stepKey = overall?.step.key ?? null
  const stepObservedAtMs = previous !== null && previous.stepKey === stepKey ? previous.stepObservedAtMs : nowMs
  const indeterminate = overall !== null && overall.stepFraction === null && running
  const serverPercent = Math.max(overall === null ? 0 : clampPercent(overall.percent), uploadShare ?? 0)
  const determinatePercent = Math.max(
    previous?.determinatePercent ?? 0,
    indeterminate ? 0 : (previous?.displayPercent ?? 0),
    serverPercent,
  )
  const fillPercent =
    overall !== null && indeterminate
      ? getWaitingSlotFillPercent({elapsedMs: nowMs - stepObservedAtMs, step: overall.step})
      : 0
  const displayPercent = Math.max(previous?.displayPercent ?? 0, determinatePercent, fillPercent)

  return {
    determinatePercent,
    displayPercent,
    indeterminate,
    memory: {determinatePercent, displayPercent, key, settled: !active, stepKey, stepObservedAtMs},
    stepLabel: overall === null ? null : `${overall.step.label} (${overall.step.index}/${overall.step.count})`,
  }
}

export const getImportProgressDisplay = ({
  createProgress,
  memory,
  nowMs,
  session: inputSession,
  uploadPercent,
}: ImportProgressDisplayInput): ImportProgressDisplay => {
  const session = getCurrentOperationSession(inputSession, createProgress)
  const overall = session?.progress?.overall ?? null
  const operation = getOperation({createProgress, overall, session})
  const uploadShare = operation === 'analyze' ? getUploadOverallPercent(uploadPercent) : null
  const isUploading = uploadShare !== null && (session === null || uploadSessionStates.has(session.state))
  const active = createProgress || (session !== null && activeSessionStates.has(session.state))

  return overall === null && !isUploading
    ? getLegacyImportProgressDisplay(session)
    : getOverallImportProgressDisplay({
        active,
        key: `${session?.id ?? ''}:${operation}`,
        memory,
        nowMs,
        overall,
        running: session?.progress?.status === 'running',
        uploadShare,
      })
}
