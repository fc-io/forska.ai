import {Context, Effect, Fiber, Layer, ManagedRuntime, Queue} from 'effect'

import {registerWriterDemotionHandler} from '../../utils/serverRuntimeRole.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {processClaimedPromptsByConnection} from './judgmentsJobsSendToLLM.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'

type ProviderQueueInput = {
  providerConnectionId: string | null
  providerMaxInflightRequests: number | null
  providerUsesFamilyDefault: boolean
}

type DispatchBatch = {label: string; prompts: PromptToProcess[]}

type ProviderDispatchState = {
  activePrompts: PromptToProcess[]
  key: string
  maxQueuedPrompts: number
  pendingBatches: DispatchBatch[]
  pendingPromptCount: number
  queue: Queue.Queue<DispatchBatch>
  workerFiber: Fiber.Fiber<void, never> | null
}

type JudgmentDispatchRuntimeService = {
  enqueueClaimedPrompts: (input: {
    label: string
    prompts: PromptToProcess[]
  }) => Effect.Effect<{acceptedCount: number; rejectedPrompts: PromptToProcess[]}>
  getProviderQueueCapacity: (input: ProviderQueueInput) => Effect.Effect<number>
}

type JudgmentDispatchRuntimeOptions = {
  processPromptBatch?: (input: {label: string; prompts: PromptToProcess[]}) => Promise<void>
  recoverPrompts?: (prompts: PromptToProcess[], reason: string) => Promise<void>
}

type JudgmentDispatchRuntimeHandle = {
  enqueueClaimedPrompts: (input: {
    label: string
    prompts: PromptToProcess[]
  }) => Promise<{acceptedCount: number; rejectedPrompts: PromptToProcess[]}>
  getProviderQueueCapacity: (input: ProviderQueueInput) => Promise<number>
  shutdown: (reason?: string) => Promise<void>
}

const JudgmentDispatchRuntime = Context.GenericTag<JudgmentDispatchRuntimeService>('JudgmentDispatchRuntime')

const defaultRecoverPrompts = async (prompts: PromptToProcess[], _reason: string): Promise<void> => {
  const sqliteService = getJudgmentJobSqliteService()

  await Promise.all(
    prompts.map((prompt) => {
      return sqliteService.markPromptAsRecoverable(prompt.jobId, prompt.recordId)
    }),
  )
}

const getProviderDispatchKey = ({providerConnectionId}: ProviderQueueInput): string => {
  return providerConnectionId ?? 'unknown'
}

const getProviderQueueCapacityLimit = ({providerMaxInflightRequests}: ProviderQueueInput): number => {
  return Math.max(1, providerMaxInflightRequests ?? 1)
}

const getPromptProviderQueueInput = (prompt: PromptToProcess): ProviderQueueInput => {
  return {
    providerConnectionId: prompt.providerConnectionId,
    providerMaxInflightRequests: prompt.providerMaxInflightRequests,
    providerUsesFamilyDefault: prompt.providerUsesFamilyDefault,
  }
}

const getProviderBatchesPrompts = (batches: DispatchBatch[]): PromptToProcess[] => {
  return batches.flatMap((batch) => {
    return batch.prompts
  })
}

const logDispatchWorkerError = (key: string, error: unknown) => {
  const safeError =
    error instanceof Error ? {message: error.message, name: error.name, stack: error.stack} : {message: String(error)}

  console.error('[judgment-dispatch-runtime] provider worker failed', {error: safeError, providerKey: key})
}

const createJudgmentDispatchRuntimeLayer = (
  options: JudgmentDispatchRuntimeOptions,
  getShutdownReason: () => string,
) => {
  const processPromptBatch =
    options.processPromptBatch
    ?? (async ({label, prompts}: {label: string; prompts: PromptToProcess[]}) => {
      await processClaimedPromptsByConnection({label, prompts})
    })
  const recoverPrompts = options.recoverPrompts ?? defaultRecoverPrompts

  return Layer.scoped(
    JudgmentDispatchRuntime,
    Effect.gen(function* () {
      const providerStates = new Map<string, ProviderDispatchState>()
      const scope = yield* Effect.scope
      let isShuttingDown = false

      const runProviderWorker = (state: ProviderDispatchState): Effect.Effect<void> => {
        const runNextBatch = Effect.gen(function* () {
          const batch = yield* Queue.take(state.queue)
          state.pendingBatches = state.pendingBatches.slice(1)
          state.pendingPromptCount = Math.max(0, state.pendingPromptCount - batch.prompts.length)
          state.activePrompts = batch.prompts

          yield* Effect.tryPromise(async () => {
            await processPromptBatch(batch)
          }).pipe(
            Effect.catchAll((error) => {
              return Effect.sync(() => {
                logDispatchWorkerError(state.key, error)
              })
            }),
          )

          state.activePrompts = []
        })

        return Effect.forever(runNextBatch).pipe(
          Effect.catchAll(() => {
            return Effect.void
          }),
        )
      }

      const getOrCreateProviderState = (input: ProviderQueueInput): Effect.Effect<ProviderDispatchState> => {
        const key = getProviderDispatchKey(input)
        const existing = providerStates.get(key)

        if (existing) {
          existing.maxQueuedPrompts = Math.max(existing.maxQueuedPrompts, getProviderQueueCapacityLimit(input))
          return Effect.succeed(existing)
        }

        return Effect.gen(function* () {
          const maxQueuedPrompts = getProviderQueueCapacityLimit(input)
          const queue = yield* Queue.bounded<DispatchBatch>(maxQueuedPrompts)
          const state: ProviderDispatchState = {
            activePrompts: [],
            key,
            maxQueuedPrompts,
            pendingBatches: [],
            pendingPromptCount: 0,
            queue,
            workerFiber: null,
          }
          const workerFiber = yield* Effect.forkIn(runProviderWorker(state), scope)

          state.workerFiber = workerFiber
          providerStates.set(key, state)
          return state
        })
      }

      const cleanupProviderState = (state: ProviderDispatchState): Effect.Effect<void> => {
        const recoverablePrompts = [...state.activePrompts, ...getProviderBatchesPrompts(state.pendingBatches)]

        state.activePrompts = []
        state.pendingBatches = []
        state.pendingPromptCount = 0

        return Effect.gen(function* () {
          yield* Queue.shutdown(state.queue)

          if (state.workerFiber) {
            yield* Fiber.interrupt(state.workerFiber)
          }

          if (recoverablePrompts.length > 0) {
            yield* Effect.tryPromise(async () => {
              await recoverPrompts(recoverablePrompts, getShutdownReason())
            })
          }
        }).pipe(
          Effect.catchAll((error) => {
            return Effect.sync(() => {
              logDispatchWorkerError(state.key, error)
            })
          }),
        )
      }

      const service: JudgmentDispatchRuntimeService = {
        enqueueClaimedPrompts: ({label, prompts}) => {
          if (prompts.length === 0 || isShuttingDown) {
            return Effect.succeed({acceptedCount: 0, rejectedPrompts: prompts})
          }

          return Effect.gen(function* () {
            const groupedPrompts = prompts.reduce((state, prompt) => {
              const key = getProviderDispatchKey(getPromptProviderQueueInput(prompt))
              return new Map(state).set(key, [...(state.get(key) ?? []), prompt])
            }, new Map<string, PromptToProcess[]>())

            let acceptedCount = 0
            let rejectedPrompts: PromptToProcess[] = []

            for (const providerPrompts of groupedPrompts.values()) {
              const [firstPrompt] = providerPrompts

              if (!firstPrompt) {
                continue
              }

              const providerState = yield* getOrCreateProviderState(getPromptProviderQueueInput(firstPrompt))
              const remainingCapacity = Math.max(0, providerState.maxQueuedPrompts - providerState.pendingPromptCount)
              const acceptedPrompts = providerPrompts.slice(0, remainingCapacity)
              const rejectedProviderPrompts = providerPrompts.slice(remainingCapacity)

              if (acceptedPrompts.length > 0) {
                const batch = {label, prompts: acceptedPrompts}
                providerState.pendingBatches = [...providerState.pendingBatches, batch]
                providerState.pendingPromptCount += acceptedPrompts.length
                yield* Queue.offer(providerState.queue, batch)
                acceptedCount += acceptedPrompts.length
              }

              rejectedPrompts = [...rejectedPrompts, ...rejectedProviderPrompts]
            }

            return {acceptedCount, rejectedPrompts}
          })
        },
        getProviderQueueCapacity: (input) => {
          return Effect.gen(function* () {
            const state = yield* getOrCreateProviderState(input)
            return Math.max(0, state.maxQueuedPrompts - state.pendingPromptCount)
          })
        },
      }

      return yield* Effect.acquireRelease(Effect.succeed(service), () => {
        isShuttingDown = true

        return Effect.all(
          Array.from(providerStates.values()).map((state) => {
            return cleanupProviderState(state)
          }),
          {concurrency: 'unbounded', discard: true},
        )
      })
    }),
  )
}

export const createJudgmentDispatchRuntime = (
  options: JudgmentDispatchRuntimeOptions = {},
): JudgmentDispatchRuntimeHandle => {
  let shutdownReason = 'shutdown'
  let runtime: ManagedRuntime.ManagedRuntime<JudgmentDispatchRuntimeService, never> | null = null

  const getRuntime = () => {
    runtime ??= ManagedRuntime.make(
      createJudgmentDispatchRuntimeLayer(options, () => {
        return shutdownReason
      }),
    )
    return runtime
  }

  const withService = async <T>(work: (service: JudgmentDispatchRuntimeService) => Effect.Effect<T>): Promise<T> => {
    return getRuntime().runPromise(
      Effect.gen(function* () {
        const service = yield* JudgmentDispatchRuntime
        return yield* work(service)
      }),
    )
  }

  return {
    enqueueClaimedPrompts: ({label, prompts}) => {
      return withService((service) => {
        return service.enqueueClaimedPrompts({label, prompts})
      })
    },
    getProviderQueueCapacity: (input) => {
      return withService((service) => {
        return service.getProviderQueueCapacity(input)
      })
    },
    shutdown: async (reason = 'shutdown') => {
      shutdownReason = reason
      const currentRuntime = runtime
      runtime = null

      if (currentRuntime) {
        await currentRuntime.dispose()
      }
    },
  }
}

let judgmentDispatchRuntime = createJudgmentDispatchRuntime()

registerWriterDemotionHandler(async (reason) => {
  await judgmentDispatchRuntime.shutdown(reason)
})

export const enqueueClaimedJudgmentPrompts = (input: {label: string; prompts: PromptToProcess[]}) => {
  return judgmentDispatchRuntime.enqueueClaimedPrompts(input)
}

export const getJudgmentDispatchQueueCapacity = (input: ProviderQueueInput) => {
  return judgmentDispatchRuntime.getProviderQueueCapacity(input)
}

export const shutdownJudgmentDispatchRuntime = async (reason = 'shutdown') => {
  await judgmentDispatchRuntime.shutdown(reason)
}

export const resetJudgmentDispatchRuntimeForTests = async () => {
  await judgmentDispatchRuntime.shutdown('test-reset')
  judgmentDispatchRuntime = createJudgmentDispatchRuntime()
}
