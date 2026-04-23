import {Context, Effect, Fiber, Layer, ManagedRuntime} from 'effect'

import {registerDuckdbOwnerDemotionHandler} from '../../utils/serverRuntimeRole.ts'
import {ConnectionError} from './connectionHealth.ts'
import {
  enqueueJudgeWorkerCompletion,
  flushJudgeWorkerCompletionOutboxForClaim,
  shouldUseJudgeWorkerOwnerHandoff,
} from './judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
import {processPromptWithLLM} from './judgmentsJobsSendToLLM/processPromptWithLLM.ts'

type ProviderQueueInput = {
  providerConnectionId: string | null
  providerMaxInflightRequests: number | null
  providerUsesFamilyDefault: boolean
}

type DispatchPrompt = {label: string; prompt: PromptToProcess}

type ProviderDispatchState = {
  activePrompts: DispatchPrompt[]
  batchFibers: Set<Fiber.Fiber<void, unknown>>
  isPaused: boolean
  key: string
  maxActivePrompts: number
  maxQueuedPrompts: number
  queuedPrompts: DispatchPrompt[]
}

export type JudgmentDispatchProviderStats = {
  jobActivePromptCount: number
  jobQueuedPromptCount: number
  providerActiveLimit: number
  providerActivePromptCount: number
  providerQueueLimit: number
  providerQueuedPromptCount: number
}

type JudgmentDispatchRuntimeService = {
  enqueueClaimedPrompts: (input: {
    label: string
    prompts: PromptToProcess[]
  }) => Effect.Effect<{acceptedCount: number; rejectedPrompts: PromptToProcess[]}>
  getProviderDispatchStats: (
    input: ProviderQueueInput & {jobId: string},
  ) => Effect.Effect<JudgmentDispatchProviderStats>
  getProviderQueueCapacity: (input: ProviderQueueInput) => Effect.Effect<number>
}

type JudgmentDispatchRuntimeOptions = {
  processPrompt?: (input: {label: string; prompt: PromptToProcess}) => Promise<void>
  processPromptBatch?: (input: {label: string; prompts: PromptToProcess[]}) => Promise<void>
  recoverPrompts?: (prompts: PromptToProcess[], reason: string) => Promise<void>
}

type JudgmentDispatchRuntimeHandle = {
  enqueueClaimedPrompts: (input: {
    label: string
    prompts: PromptToProcess[]
  }) => Promise<{acceptedCount: number; rejectedPrompts: PromptToProcess[]}>
  getProviderDispatchStats: (input: ProviderQueueInput & {jobId: string}) => Promise<JudgmentDispatchProviderStats>
  getProviderQueueCapacity: (input: ProviderQueueInput) => Promise<number>
  shutdown: (reason?: string) => Promise<void>
}

const JudgmentDispatchRuntime = Context.GenericTag<JudgmentDispatchRuntimeService>('JudgmentDispatchRuntime')

const defaultRecoverPrompts = async (prompts: PromptToProcess[], _reason: string): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    await Promise.all(
      prompts.map(async (prompt) => {
        await enqueueJudgeWorkerCompletion({
          articleId: prompt.articleId,
          claimId: prompt.claimId,
          executionSnapshotHash: prompt.executionSnapshotHash,
          executionSnapshotId: prompt.executionSnapshotId,
          jobId: prompt.jobId,
          modelId: prompt.modelId,
          projectId: prompt.projectId,
          promptId: prompt.promptId,
          queueRecordId: prompt.recordId,
          status: 'retry',
          useAbstract: prompt.useAbstract,
          useFulltext: prompt.useFulltext,
          useFulltextNoImages: prompt.useFulltextNoImages,
          useTitle: prompt.useTitle,
        })
        await flushJudgeWorkerCompletionOutboxForClaim(prompt.claimId)
      }),
    )
    return
  }

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

const getProviderActivePromptLimit = ({providerMaxInflightRequests}: ProviderQueueInput): number => {
  return Math.max(1, providerMaxInflightRequests ?? 1)
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

const getProviderQueuedPromptCount = (state: ProviderDispatchState): number => {
  return state.queuedPrompts.length
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
  const processPrompt =
    options.processPrompt
    ?? (options.processPromptBatch
      ? async ({label, prompt}: {label: string; prompt: PromptToProcess}) => {
          await options.processPromptBatch?.({label, prompts: [prompt]})
        }
      : async ({prompt}: {label: string; prompt: PromptToProcess}) => {
          await processPromptWithLLM(prompt)
        })
  const recoverPrompts = options.recoverPrompts ?? defaultRecoverPrompts

  return Layer.scoped(
    JudgmentDispatchRuntime,
    Effect.gen(function* () {
      const providerStates = new Map<string, ProviderDispatchState>()
      const scope = yield* Effect.scope
      let isShuttingDown = false

      const removeActivePrompt = (state: ProviderDispatchState, recordId: string): void => {
        state.activePrompts = state.activePrompts.filter((entry) => {
          return entry.prompt.recordId !== recordId
        })
      }

      const recoverQueuedPrompts = (state: ProviderDispatchState, reason: string): Promise<void> => {
        const promptsToRecover = state.queuedPrompts.map((entry) => {
          return entry.prompt
        })
        state.queuedPrompts = []

        return promptsToRecover.length === 0 ? Promise.resolve() : recoverPrompts(promptsToRecover, reason)
      }

      const launchAvailablePrompts = (state: ProviderDispatchState): Effect.Effect<void> => {
        return Effect.gen(function* () {
          while (!isShuttingDown && !state.isPaused && state.activePrompts.length < state.maxActivePrompts) {
            const [nextPrompt, ...remainingQueuedPrompts] = state.queuedPrompts

            if (!nextPrompt) {
              return undefined
            }

            state.queuedPrompts = remainingQueuedPrompts
            state.activePrompts = [...state.activePrompts, nextPrompt]

            let promptFiber: Fiber.Fiber<void, unknown> | null = null
            const trackedPrompt = Effect.tryPromise({
              catch: (error) => {
                return error
              },
              try: () => {
                return processPrompt(nextPrompt)
              },
            }).pipe(
              Effect.catchAll((error) => {
                return Effect.tryPromise(async () => {
                  if (error instanceof ConnectionError) {
                    state.isPaused = true
                    await recoverQueuedPrompts(state, 'connection-error')
                    state.isPaused = false
                    return undefined
                  }

                  if (isShuttingDown) {
                    return undefined
                  }

                  return undefined
                })
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  removeActivePrompt(state, nextPrompt.prompt.recordId)

                  if (promptFiber) {
                    state.batchFibers.delete(promptFiber)
                  }
                }).pipe(Effect.zipRight(launchAvailablePrompts(state))),
              ),
            )

            promptFiber = yield* Effect.forkIn(trackedPrompt, scope)
            state.batchFibers.add(promptFiber)
          }
        })
      }

      const getOrCreateProviderState = (input: ProviderQueueInput): Effect.Effect<ProviderDispatchState> => {
        const key = getProviderDispatchKey(input)
        const existing = providerStates.get(key)
        const maxActivePrompts = getProviderActivePromptLimit(input)
        const maxQueuedPrompts = getProviderQueueCapacityLimit(input)

        if (existing) {
          existing.maxActivePrompts = maxActivePrompts
          existing.maxQueuedPrompts = maxQueuedPrompts
          return Effect.succeed(existing)
        }

        return Effect.sync(() => {
          const state: ProviderDispatchState = {
            activePrompts: [],
            batchFibers: new Set(),
            isPaused: false,
            key,
            maxActivePrompts,
            maxQueuedPrompts,
            queuedPrompts: [],
          }
          providerStates.set(key, state)
          return state
        })
      }

      const getProviderDispatchStats = ({
        jobId,
        ...input
      }: ProviderQueueInput & {jobId: string}): JudgmentDispatchProviderStats => {
        const state = providerStates.get(getProviderDispatchKey(input))
        const providerActiveLimit = getProviderActivePromptLimit(input)
        const providerQueueLimit = getProviderQueueCapacityLimit(input)

        if (!state) {
          return {
            jobActivePromptCount: 0,
            jobQueuedPromptCount: 0,
            providerActiveLimit,
            providerActivePromptCount: 0,
            providerQueueLimit,
            providerQueuedPromptCount: 0,
          }
        }

        const jobActivePromptCount = state.activePrompts.filter((entry) => {
          return entry.prompt.jobId === jobId
        }).length
        const jobQueuedPromptCount = state.queuedPrompts.filter((entry) => {
          return entry.prompt.jobId === jobId
        }).length

        return {
          jobActivePromptCount,
          jobQueuedPromptCount,
          providerActiveLimit: state.maxActivePrompts,
          providerActivePromptCount: state.activePrompts.length,
          providerQueueLimit: state.maxQueuedPrompts,
          providerQueuedPromptCount: state.queuedPrompts.length,
        }
      }

      const cleanupProviderState = (state: ProviderDispatchState): Effect.Effect<void> => {
        const recoverablePrompts = [...state.activePrompts, ...state.queuedPrompts].map((entry) => {
          return entry.prompt
        })

        state.activePrompts = []
        state.queuedPrompts = []
        state.isPaused = true
        const batchFibers = Array.from(state.batchFibers)
        state.batchFibers.clear()

        return Effect.gen(function* () {
          yield* Effect.all(
            batchFibers.map((fiber) => {
              return Fiber.interrupt(fiber)
            }),
            {concurrency: 'unbounded', discard: true},
          )

          if (recoverablePrompts.length > 0) {
            yield* Effect.tryPromise(async () => {
              await recoverPrompts(recoverablePrompts, getShutdownReason())
            })
          }
        }).pipe(
          Effect.catchAll((error) => {
            return Effect.sync(() => {
              if (!isShuttingDown) {
                logDispatchWorkerError(state.key, error)
              }
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
              const remainingCapacity = Math.max(
                0,
                providerState.maxQueuedPrompts - getProviderQueuedPromptCount(providerState),
              )
              const acceptedPrompts = providerPrompts.slice(0, remainingCapacity)
              const rejectedProviderPrompts = providerPrompts.slice(remainingCapacity)

              if (acceptedPrompts.length > 0) {
                providerState.queuedPrompts = [
                  ...providerState.queuedPrompts,
                  ...acceptedPrompts.map((prompt) => {
                    return {label, prompt}
                  }),
                ]
                yield* launchAvailablePrompts(providerState)
                acceptedCount += acceptedPrompts.length
              }

              rejectedPrompts = [...rejectedPrompts, ...rejectedProviderPrompts]
            }

            return {acceptedCount, rejectedPrompts}
          })
        },
        getProviderDispatchStats: (input) => {
          return Effect.sync(() => {
            return getProviderDispatchStats(input)
          })
        },
        getProviderQueueCapacity: (input) => {
          return Effect.gen(function* () {
            const state = yield* getOrCreateProviderState(input)
            return Math.max(0, state.maxQueuedPrompts - getProviderQueuedPromptCount(state))
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
    getProviderDispatchStats: (input) => {
      return withService((service) => {
        return service.getProviderDispatchStats(input)
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

registerDuckdbOwnerDemotionHandler(async (reason) => {
  await judgmentDispatchRuntime.shutdown(reason)
})

export const enqueueClaimedJudgmentPrompts = (input: {label: string; prompts: PromptToProcess[]}) => {
  return judgmentDispatchRuntime.enqueueClaimedPrompts(input)
}

export const getJudgmentDispatchQueueCapacity = (input: ProviderQueueInput) => {
  return judgmentDispatchRuntime.getProviderQueueCapacity(input)
}

export const getJudgmentDispatchProviderStats = (input: ProviderQueueInput & {jobId: string}) => {
  return judgmentDispatchRuntime.getProviderDispatchStats(input)
}

export const shutdownJudgmentDispatchRuntime = async (reason = 'shutdown') => {
  await judgmentDispatchRuntime.shutdown(reason)
}

export const resetJudgmentDispatchRuntimeForTests = async () => {
  await judgmentDispatchRuntime.shutdown('test-reset')
  judgmentDispatchRuntime = createJudgmentDispatchRuntime()
}
