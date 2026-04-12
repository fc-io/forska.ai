type JudgmentJobStorageTransferSample = {
  addedRows: number
  clearedRows: number
  insertedRows: number
  recordedAt: number
}

export type JudgmentJobStorageTransferRuntimeSnapshot = {
  addedRows: number
  addedRowsPerMinute: number
  clearedRows: number
  clearedRowsPerMinute: number
  insertedRows: number
  insertedRowsPerMinute: number
  netRows: number
  netRowsPerMinute: number
  windowMinutes: number
}

type JudgmentJobStorageTransferRuntimeState = {samplesByJob: Map<string, JudgmentJobStorageTransferSample[]>}

declare global {
  var __forskaJudgmentJobStorageTransferRuntimeState: JudgmentJobStorageTransferRuntimeState | undefined
}

const recentTransferWindowMs = 5 * 60 * 1000
const maxRecentTransferSamplesPerJob = 200

const getInitialJudgmentJobStorageTransferRuntimeState = (): JudgmentJobStorageTransferRuntimeState => {
  return {samplesByJob: new Map()}
}

const getJudgmentJobStorageTransferRuntimeState = () => {
  globalThis.__forskaJudgmentJobStorageTransferRuntimeState ??= getInitialJudgmentJobStorageTransferRuntimeState()
  return globalThis.__forskaJudgmentJobStorageTransferRuntimeState
}

const normalizeRowCount = (value: number) => {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

const trimSamples = (samples: JudgmentJobStorageTransferSample[], now: number) => {
  return samples
    .filter((sample) => {
      return now - sample.recordedAt <= recentTransferWindowMs
    })
    .slice(-maxRecentTransferSamplesPerJob)
}

const setJobSamples = ({jobId, samples}: {jobId: string; samples: JudgmentJobStorageTransferSample[]}) => {
  const runtimeState = getJudgmentJobStorageTransferRuntimeState()

  return samples.length === 0 ? runtimeState.samplesByJob.delete(jobId) : runtimeState.samplesByJob.set(jobId, samples)
}

const toRowsPerMinute = (rowCount: number) => {
  return Math.round((rowCount * 60_000 * 10) / recentTransferWindowMs) / 10
}

export const recordJudgmentJobStorageTransfer = ({
  addedRows = 0,
  clearedRows = 0,
  insertedRows = 0,
  jobId,
}: {
  addedRows?: number
  clearedRows?: number
  insertedRows?: number
  jobId: string
}) => {
  const normalizedSample = {
    addedRows: normalizeRowCount(addedRows),
    clearedRows: normalizeRowCount(clearedRows),
    insertedRows: normalizeRowCount(insertedRows),
  }

  if (normalizedSample.addedRows === 0 && normalizedSample.clearedRows === 0 && normalizedSample.insertedRows === 0) {
    return
  }

  const now = Date.now()
  const runtimeState = getJudgmentJobStorageTransferRuntimeState()
  const nextSamples = trimSamples(
    [...(runtimeState.samplesByJob.get(jobId) ?? []), {...normalizedSample, recordedAt: now}],
    now,
  )

  setJobSamples({jobId, samples: nextSamples})
}

export const getJudgmentJobStorageTransferRuntime = (
  jobId: string,
): JudgmentJobStorageTransferRuntimeSnapshot | null => {
  const now = Date.now()
  const runtimeState = getJudgmentJobStorageTransferRuntimeState()
  const samples = trimSamples(runtimeState.samplesByJob.get(jobId) ?? [], now)

  setJobSamples({jobId, samples})

  if (samples.length === 0) {
    return null
  }

  const totals = samples.reduce(
    (state, sample) => {
      return {
        addedRows: state.addedRows + sample.addedRows,
        clearedRows: state.clearedRows + sample.clearedRows,
        insertedRows: state.insertedRows + sample.insertedRows,
      }
    },
    {addedRows: 0, clearedRows: 0, insertedRows: 0},
  )
  const netRows = totals.addedRows - totals.clearedRows

  return {
    addedRows: totals.addedRows,
    addedRowsPerMinute: toRowsPerMinute(totals.addedRows),
    clearedRows: totals.clearedRows,
    clearedRowsPerMinute: toRowsPerMinute(totals.clearedRows),
    insertedRows: totals.insertedRows,
    insertedRowsPerMinute: toRowsPerMinute(totals.insertedRows),
    netRows,
    netRowsPerMinute: toRowsPerMinute(netRows),
    windowMinutes: recentTransferWindowMs / 60_000,
  }
}

export const resetJudgmentJobStorageTransferRuntimeForTests = () => {
  globalThis.__forskaJudgmentJobStorageTransferRuntimeState = getInitialJudgmentJobStorageTransferRuntimeState()
}
