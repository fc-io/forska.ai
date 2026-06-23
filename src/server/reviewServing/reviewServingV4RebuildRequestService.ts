import {Effect} from 'effect'

import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  createReviewServingRebuildRequest,
  type ReviewServingRebuildRequest,
} from './reviewServingRebuildRequestRepository.ts'

export const defaultReviewServingV4RebuildComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
  'search',
] as const satisfies readonly ReviewServingProjectionComponent[]

export const defaultJudgmentRepairV4RebuildComponents = [
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
] as const satisfies readonly ReviewServingProjectionComponent[]

const defaultRequestBudget = {
  maxInputRows: 250_000,
  maxOutputBytes: 128 * 1024 * 1024,
  maxOutputRows: 250_000,
  maxPayloadBytes: 64 * 1024 * 1024,
  maxPromptCount: 10_000,
  maxSnapshotCount: 1,
  maxTempBytes: 0,
} as const

export type RequestReviewServingV4RebuildInput = {
  components?: readonly ReviewServingProjectionComponent[]
  projectId: string
  reason: string
}

export const requestReviewServingV4RebuildEffect = (input: RequestReviewServingV4RebuildInput) => {
  return Effect.tryPromise(() => {
    const components = input.components ?? defaultReviewServingV4RebuildComponents

    return createReviewServingRebuildRequest({
      budget: defaultRequestBudget,
      diagnostics: {source: 'phase5b-v4-rebuild-request-service', v4Cutover: true},
      estimate: {
        estimatedInputRows: components.length,
        estimatedOutputBytes: 0,
        estimatedOutputRows: components.length,
        estimatedPayloadBytes: 0,
        estimatedPromptCount: components.length,
        estimatedSnapshotCount: 1,
        estimatedTempBytes: 0,
      },
      identity: {componentSet: components, requestKind: 'v4-review-serving-rebuild'},
      projectId: input.projectId,
      reason: input.reason,
      requestedComponents: components,
      retryPolicy: {maxAttempts: 3, retryAfterMs: 60_000, terminalState: 'blocked_over_budget'},
      sourceWatermarks: {},
    })
  })
}

export const requestReviewServingV4Rebuild = (input: RequestReviewServingV4RebuildInput) => {
  return Effect.runPromise(requestReviewServingV4RebuildEffect(input))
}

export const requestReviewServingV4RebuildsEffect = (inputs: readonly RequestReviewServingV4RebuildInput[]) => {
  return Effect.forEach(inputs, requestReviewServingV4RebuildEffect, {concurrency: 1})
}

export const requestReviewServingV4Rebuilds = (
  inputs: readonly RequestReviewServingV4RebuildInput[],
): Promise<ReviewServingRebuildRequest[]> => {
  return Effect.runPromise(requestReviewServingV4RebuildsEffect(inputs))
}
