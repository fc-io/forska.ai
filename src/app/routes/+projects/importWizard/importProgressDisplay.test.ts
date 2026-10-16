import {expect, test} from 'bun:test'

import {
  getImportProgressDisplay,
  getUploadOverallPercent,
  getWaitingSlotFillPercent,
  type ImportProgressDisplay,
} from './importProgressDisplay.ts'
import type {ProjectImportOverallProgress, ProjectImportProgress, ProjectImportSession} from './projectImportClient.ts'

const getOverall = (overrides: Partial<ProjectImportOverallProgress> = {}): ProjectImportOverallProgress => {
  return {
    operation: 'analyze',
    percent: 40,
    step: {
      count: 6,
      endPercent: 95,
      index: 4,
      key: 'targetAnalysis',
      label: 'Analyzing target project',
      startPercent: 27,
    },
    stepFraction: 0.2,
    ...overrides,
  }
}

const getSession = ({
  progress = null,
  state = 'analyzing',
}: {progress?: ProjectImportProgress | null; state?: ProjectImportSession['state']} = {}) => {
  return {id: 'session-1', planRevision: 1, progress, state} as ProjectImportSession
}

const getRunningProgress = (
  overall: ProjectImportOverallProgress | null,
  status: ProjectImportProgress['status'] = 'running',
) => {
  return {overall, phase: 'analyze', status}
}

const getDisplay = ({
  createProgress = false,
  previous = null,
  nowMs = 0,
  session,
  uploadPercent = null,
}: {
  createProgress?: boolean
  nowMs?: number
  previous?: ImportProgressDisplay | null
  session: ProjectImportSession | null
  uploadPercent?: number | null
}) => {
  return getImportProgressDisplay({createProgress, memory: previous?.memory ?? null, nowMs, session, uploadPercent})
}

test('maps the upload to the first three percent of the analyze bar', () => {
  expect(getUploadOverallPercent(null)).toBeNull()
  expect(getUploadOverallPercent(0)).toBe(0)
  expect(getUploadOverallPercent(50)).toBe(1.5)
  expect(getUploadOverallPercent(100)).toBe(3)
  expect(getUploadOverallPercent(250)).toBe(3)

  const uploading = getDisplay({session: getSession({state: 'awaiting_upload'}), uploadPercent: 50})

  expect(uploading.displayPercent).toBe(1.5)
  expect(uploading.stepLabel).toBeNull()
  expect(uploading.indeterminate).toBe(false)
})

test('drops the finished upload percent once the server owns progress', () => {
  const legacyQueued = getDisplay({
    session: getSession({progress: {phase: 'upload', status: 'completed'}, state: 'queued'}),
    uploadPercent: 100,
  })
  const overallQueued = getDisplay({
    session: getSession({
      progress: {
        overall: getOverall({percent: 3, step: {...getOverall().step, index: 1, key: 'upload'}, stepFraction: 1}),
        phase: 'upload',
        status: 'completed',
      },
      state: 'queued',
    }),
    uploadPercent: 100,
  })

  expect(legacyQueued.displayPercent).toBeNull()
  expect(overallQueued.displayPercent).toBe(3)
})

test('uses the server overall percent with the step label and never decreases within an operation', () => {
  const first = getDisplay({session: getSession({progress: getRunningProgress(getOverall({percent: 40}))})})
  const lower = getDisplay({
    previous: first,
    session: getSession({progress: getRunningProgress(getOverall({percent: 31}))}),
  })
  const higher = getDisplay({
    previous: lower,
    session: getSession({progress: getRunningProgress(getOverall({percent: 52}))}),
  })

  expect(first.displayPercent).toBe(40)
  expect(first.stepLabel).toBe('Analyzing target project (4/6)')
  expect(lower.displayPercent).toBe(40)
  expect(lower.determinatePercent).toBe(40)
  expect(higher.displayPercent).toBe(52)
})

test('starts a new bar when the operation changes or a settled session becomes active again', () => {
  const analyzed = getDisplay({
    session: getSession({
      progress: getRunningProgress(getOverall({percent: 100}), 'completed'),
      state: 'ready_to_commit',
    }),
  })
  const committing = getDisplay({
    createProgress: true,
    previous: analyzed,
    session: getSession({
      progress: getRunningProgress(getOverall({operation: 'commit', percent: 7})),
      state: 'committing',
    }),
  })
  const failed = getDisplay({
    previous: committing,
    session: getSession({
      progress: getRunningProgress(getOverall({operation: 'commit', percent: 50}), 'failed'),
      state: 'failed',
    }),
  })
  const retried = getDisplay({
    createProgress: true,
    previous: failed,
    session: getSession({
      progress: getRunningProgress(getOverall({operation: 'commit', percent: 7})),
      state: 'committing',
    }),
  })

  expect(analyzed.displayPercent).toBe(100)
  expect(committing.displayPercent).toBe(7)
  expect(failed.displayPercent).toBe(50)
  expect(retried.displayPercent).toBe(7)
})

test('hides a finished analyze bar while a create request has not reported progress yet', () => {
  const display = getDisplay({
    createProgress: true,
    session: getSession({
      progress: getRunningProgress(getOverall({percent: 100}), 'completed'),
      state: 'ready_to_commit',
    }),
  })

  expect(display.displayPercent).toBeNull()
})

test('fills a waiting slot toward 90 percent of the slot with a ten second time constant', () => {
  const step = {
    count: 6,
    endPercent: 7,
    index: 1,
    key: 'waitForDuckdb',
    label: 'Waiting for the database',
    startPercent: 0,
  }

  expect(getWaitingSlotFillPercent({elapsedMs: 0, step})).toBe(0)
  expect(getWaitingSlotFillPercent({elapsedMs: 10_000, step})).toBeCloseTo(7 * 0.9 * (1 - Math.exp(-1)), 6)
  expect(getWaitingSlotFillPercent({elapsedMs: 1_000_000, step})).toBeCloseTo(6.3, 6)

  const waitingSession = getSession({
    progress: getRunningProgress(getOverall({operation: 'commit', percent: 0, step, stepFraction: null})),
    state: 'committing',
  })
  const started = getDisplay({createProgress: true, nowMs: 1_000, session: waitingSession})
  const later = getDisplay({createProgress: true, nowMs: 21_000, previous: started, session: waitingSession})
  const nextStep = getDisplay({
    createProgress: true,
    nowMs: 22_000,
    previous: later,
    session: getSession({
      progress: getRunningProgress(
        getOverall({
          operation: 'commit',
          percent: 7,
          step: {...step, endPercent: 67, index: 2, key: 'revalidation', startPercent: 7},
          stepFraction: 0,
        }),
      ),
      state: 'committing',
    }),
  })

  expect(started.indeterminate).toBe(true)
  expect(started.displayPercent).toBe(0)
  expect(later.determinatePercent).toBe(0)
  expect(later.displayPercent).toBeCloseTo(7 * 0.9 * (1 - Math.exp(-2)), 6)
  expect(nextStep.indeterminate).toBe(false)
  expect(nextStep.displayPercent).toBe(7)
})

test('keeps the legacy per-phase percent for progress payloads without an overall block', () => {
  const rows = getDisplay({
    session: getSession({
      progress: {phase: 'commit', rowCountProcessed: 71_308, rowCountTotal: 142_616, status: 'running'},
      state: 'committing',
    }),
  })
  const explicit = getDisplay({session: getSession({progress: {percent: 35, phase: 'extract', status: 'running'}})})

  expect(rows.displayPercent).toBe(50)
  expect(rows.memory).toBeNull()
  expect(explicit.displayPercent).toBe(35)
})

test('retains visible waiting fill when animation stops on failure or real progress', () => {
  const overall = getOverall({
    operation: 'commit',
    percent: 0,
    stepFraction: null,
    step: {count: 6, endPercent: 7, index: 1, key: 'waitForDuckdb', label: 'Waiting', startPercent: 0},
  })
  const session = getSession({progress: getRunningProgress(overall), state: 'committing'})
  const started = getDisplay({nowMs: 1000, session})
  const waiting = getDisplay({nowMs: 21000, previous: started, session})
  const failed = getDisplay({
    nowMs: 22000,
    previous: waiting,
    session: getSession({state: 'failed', progress: getRunningProgress(overall, 'failed')}),
  })
  const realUpdate = getDisplay({
    nowMs: 22000,
    previous: waiting,
    session: getSession({
      state: 'committing',
      progress: getRunningProgress({...overall, percent: 1, stepFraction: 0.1}),
    }),
  })
  expect(waiting.displayPercent).toBeGreaterThan(5)
  for (const stopped of [failed, realUpdate]) {
    expect(stopped.indeterminate).toBe(false)
    expect(stopped.determinatePercent).toBe(waiting.displayPercent)
    expect(stopped.displayPercent).toBe(waiting.displayPercent)
  }
})
