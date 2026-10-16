import {AsyncLocalStorage} from 'node:async_hooks'

import type {
  ProjectTransferOverallProgress,
  ProjectTransferOverallProgressOperation,
  ProjectTransferProgressPayload,
} from './projectTransferContracts.ts'
import {
  getProjectTransferCompletedOverallProgress,
  getProjectTransferOverallProgress,
  type ProjectTransferOverallProgressStepKey,
} from './projectTransferProgressWeights.ts'

export const projectTransferProgressThrottleMs = 1_000

export type ProjectTransferOverallProgressStepUpdate<TOperation extends ProjectTransferOverallProgressOperation> = {
  step: ProjectTransferOverallProgressStepKey<TOperation>
  stepFraction: number | null
}

export type ProjectTransferOverallProgressTracker<TOperation extends ProjectTransferOverallProgressOperation> = {
  complete: () => ProjectTransferOverallProgress
  getCurrent: () => ProjectTransferOverallProgress | null
  update: (update: ProjectTransferOverallProgressStepUpdate<TOperation>) => ProjectTransferOverallProgress
}

export type ProjectTransferProgressScheduler = ReturnType<typeof createProjectTransferProgressScheduler>

export const createProjectTransferOverallProgressTracker = <TOperation extends ProjectTransferOverallProgressOperation>(
  operation: TOperation,
): ProjectTransferOverallProgressTracker<TOperation> => {
  const state: {current: ProjectTransferOverallProgress | null} = {current: null}

  return {
    complete: () => {
      state.current = getProjectTransferCompletedOverallProgress(operation)

      return state.current
    },
    getCurrent: () => {
      return state.current
    },
    update: ({step, stepFraction}) => {
      state.current = getProjectTransferOverallProgress({
        operation,
        previousPercent: state.current?.percent ?? 0,
        step,
        stepFraction,
      })

      return state.current
    },
  }
}

export const createProjectTransferProgressScheduler = ({
  getNowMs = Date.now,
  throttleMs = projectTransferProgressThrottleMs,
}: {getNowMs?: () => number; throttleMs?: number} = {}) => {
  const state = {
    error: null as {cause: unknown} | null,
    lastPublishedAtMs: Number.NEGATIVE_INFINITY,
    pending: null as (() => unknown) | null,
    queue: Promise.resolve() as Promise<unknown>,
    queued: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
  }
  const assertHealthy = () => {
    if (state.error !== null) throw state.error.cause
  }
  const cancelPending = () => {
    if (state.timer !== null) clearTimeout(state.timer)
    state.pending = null
    state.timer = null
  }
  const enqueue = <TResult>(work: () => Promise<TResult> | TResult): Promise<TResult> => {
    state.queued += 1
    const next = state.queue.then(() => {
      assertHealthy()
      state.lastPublishedAtMs = getNowMs()
      return work()
    })
    state.queue = next
      .catch((cause: unknown) => {
        state.error ??= {cause}
      })
      .finally(() => {
        state.queued -= 1
        void schedulePending()?.catch(() => {})
      })
    return next
  }
  const schedulePending = (): Promise<unknown> | undefined => {
    if (state.pending === null || state.queued > 0 || state.error !== null) return
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    const remaining = throttleMs - (getNowMs() - state.lastPublishedAtMs)
    if (remaining > 0) {
      state.timer = setTimeout(() => {
        void schedulePending()?.catch(() => {})
      }, remaining)
      return
    }
    const pending = state.pending
    state.pending = null
    return enqueue(pending)
  }
  const publishNow = <TResult>(work: () => Promise<TResult> | TResult) => {
    cancelPending()
    return enqueue(work)
  }
  const publishThrottled = async (work: () => unknown) => {
    assertHealthy()
    state.pending = work
    await schedulePending()
  }
  const flush = async (): Promise<void> => {
    await state.queue
    assertHealthy()
    if (state.queued > 0) return flush()
    if (state.pending !== null) {
      const remaining = Math.max(0, throttleMs - (getNowMs() - state.lastPublishedAtMs))
      await new Promise((resolve) => {
        setTimeout(resolve, remaining)
      })
      await schedulePending()
      await flush()
    }
  }
  const close = async () => {
    cancelPending()
    await state.queue
    assertHealthy()
  }

  return {cancelPending, close, enqueue, flush, publishNow, publishThrottled}
}

export const createProjectTransferSessionProgressLane = <TValue>(write: (value: TValue) => unknown) => {
  const runOutsideWork = AsyncLocalStorage.snapshot()
  const state = {
    error: null as {cause: unknown} | null,
    pending: null as {value: TValue} | null,
    writing: null as Promise<void> | null,
  }
  const assertHealthy = () => {
    if (state.error !== null) throw state.error.cause
  }
  const start = () => {
    if (state.writing !== null || state.pending === null || state.error !== null) return
    const {value} = state.pending
    state.pending = null
    state.writing = runOutsideWork(() => {
      return Promise.resolve()
        .then(() => {
          return write(value)
        })
        .then(
          () => {},
          (cause: unknown) => {
            state.error ??= {cause}
            state.pending = null
          },
        )
        .finally(() => {
          state.writing = null
          start()
        })
    })
  }
  const publish = (value: TValue) => {
    assertHealthy()
    state.pending = {value}
    start()
  }
  const flush = async (): Promise<void> => {
    if (state.writing !== null) {
      await state.writing
      return flush()
    }
    assertHealthy()
  }
  return {assertHealthy, flush, publish}
}

export const createProjectTransferProgressPublisher = ({
  initialProgress = null,
  throttleMs,
  writeArtifact,
  writeSession,
}: {
  initialProgress?: ProjectTransferProgressPayload | null
  throttleMs?: number
  writeArtifact: (progress: ProjectTransferProgressPayload) => unknown
  writeSession?: (progress: ProjectTransferProgressPayload) => unknown
}) => {
  const scheduler = createProjectTransferProgressScheduler({throttleMs})
  const session = createProjectTransferSessionProgressLane((progress: ProjectTransferProgressPayload) => {
    return writeSession?.(progress)
  })
  const state = {lastWritten: initialProgress}
  const persist = async (progress: ProjectTransferProgressPayload, persistSession: boolean) => {
    session.assertHealthy()
    const previous = state.lastWritten?.overall
    const overall = progress.overall
    const written = {
      ...progress,
      ...(overall && previous?.operation === overall.operation
        ? {overall: {...overall, percent: Math.max(previous.percent, overall.percent)}}
        : {}),
      updatedAt: new Date().toISOString(),
    }
    await writeArtifact(written)
    state.lastWritten = written
    if (persistSession) session.publish(written)
  }
  const publish = (
    progress: ProjectTransferProgressPayload,
    {persist: target = 'session', throttled = false}: {persist?: 'artifact' | 'session'; throttled?: boolean} = {},
  ) => {
    const work = () => {
      return persist(progress, target === 'session')
    }
    return throttled ? scheduler.publishThrottled(work) : scheduler.publishNow(work)
  }
  const heartbeat = () => {
    return scheduler.enqueue(async () => {
      if (state.lastWritten !== null) await persist(state.lastWritten, false)
    })
  }
  const drain = async (close: boolean) => {
    const artifactResult = await (close ? scheduler.close() : scheduler.flush()).then(
      () => {
        return null
      },
      (cause: unknown) => {
        return {cause}
      },
    )
    await session.flush()
    if (artifactResult !== null) throw artifactResult.cause
  }
  return {
    cancelPending: scheduler.cancelPending,
    close: () => {
      return drain(true)
    },
    flush: () => {
      return drain(false)
    },
    getLastWritten: () => {
      return state.lastWritten
    },
    heartbeat,
    publish,
  }
}
