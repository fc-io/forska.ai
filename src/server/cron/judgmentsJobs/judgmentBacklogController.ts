export type JudgmentBacklogLifecycleAgesMs = {
  dispatchQueued?: number | null
  hasLiveRequest?: number | null
  persisting?: number | null
  preparing?: number | null
  waitingForRequestSlot?: number | null
}

export type JudgmentBacklogControllerInput = {
  activeHigherPriorityStopRules?: string[]
  allocationCompleteCurrent: boolean
  effectiveProviderLimit: number
  estimatedRequestWorkPerPrompt?: number | null
  expectedLocalLiveShare: number
  hasHealthyEndpointOrEndpointlessPath: boolean
  lifecycleAgesMs?: JudgmentBacklogLifecycleAgesMs
  localPromptBacklog: number
  localPromptBacklogTarget?: number | null
  localProviderLiveRequests: number
  localRequestWorkBacklog: number
  localRequestWorkBacklogTarget?: number | null
  normalRequestCapacity: number
  preconditionsStableSinceMs?: number | null
  promptClaimChunkEstimate?: number | null
  providerAvailableRequestLeases: number
  providerLeasedProbeCalls: number
  providerLimit: number
  readyCount: number
  recentDrainRatePerSecond?: number | null
}

export type JudgmentBacklogControllerState = {
  backlogReplenishmentAllowed: boolean
  localAdditionalLeaseHeadroom: number
  localAdditionalTargetHeadroom: number
  localPromptBacklogTarget: number
  localRequestWorkBacklogTarget: number
  localTargetGap: number
  preconditionChangedReason: string | null
  preconditionsStableSinceMs: number
  targetIncreaseAllowed: boolean
}

export const judgmentBacklogControllerConstants = {
  immediateSafetyClampRules: {
    clampHeadroomToProviderAvailableRequestLeases: true,
    clampTargetsToCurrentBacklogWhenEndpointUnavailable: true,
    clampTargetsToCurrentBacklogWhenInputsIncomplete: true,
    clampTargetsToEffectiveCapacityOnLimitOrProbeChange: true,
    clampTargetsToOwnerShareForAdditionalHeadroom: true,
  },
  lowLimitPromptExtraUnits: 1,
  lowLimitRequestWorkExtraUnits: 0,
  lowLimitRoundingThresholdUnits: 3,
  promptBacklogMaximumEffectiveCapacityMultiplier: 4,
  promptBacklogMinimumUnits: 1,
  promptPipelineMaximumUnits: 128,
  promptPipelineMinimumUnits: 2,
  promptBacklogRequestWorkMultiplier: 2,
  promptDrainWindowMs: 10_000,
  promptStageAgeThresholdMs: {dispatchQueued: 60_000, preparing: 120_000},
  requestWorkBacklogMaximumEffectiveCapacityMultiplier: 2,
  requestWorkBacklogMinimumUnits: 1,
  requestWorkDrainWindowMs: 10_000,
  requestWorkStageAgeThresholdMs: {hasLiveRequest: 300_000, persisting: 120_000, waitingForRequestSlot: 60_000},
  successfulLeaseWindowMs: 15_000,
  targetFillHysteresisPct: 85,
  targetIncreaseHysteresisMs: 5_000,
} as const

const getNonNegativeInteger = (value: number | null | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

const getPositiveInteger = (value: number | null | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1
}

const getNonNegativeFinite = (value: number | null | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

const getBoundedInteger = (value: number, minimum: number, maximum: number): number => {
  return Math.max(minimum, Math.min(maximum, value))
}

const getLowLimitRoundedTarget = ({
  base,
  extraUnits,
  maximum,
  minimum,
}: {
  base: number
  extraUnits: number
  maximum: number
  minimum: number
}): number => {
  const rounded = base <= judgmentBacklogControllerConstants.lowLimitRoundingThresholdUnits ? base + extraUnits : base

  return maximum <= 0 ? 0 : getBoundedInteger(rounded, Math.min(minimum, maximum), maximum)
}

const getStageAgeExceededReason = (ages: JudgmentBacklogLifecycleAgesMs | undefined): string | null => {
  const promptDispatchQueuedAgeMs = getNonNegativeInteger(ages?.dispatchQueued)
  const promptPreparingAgeMs = getNonNegativeInteger(ages?.preparing)
  const requestSlotWaitAgeMs = getNonNegativeInteger(ages?.waitingForRequestSlot)
  const liveRequestAgeMs = getNonNegativeInteger(ages?.hasLiveRequest)
  const persistingAgeMs = getNonNegativeInteger(ages?.persisting)
  const promptThresholds = judgmentBacklogControllerConstants.promptStageAgeThresholdMs
  const requestThresholds = judgmentBacklogControllerConstants.requestWorkStageAgeThresholdMs

  if (promptDispatchQueuedAgeMs > promptThresholds.dispatchQueued) {
    return 'dispatchQueuedStageAge'
  }

  if (promptPreparingAgeMs > promptThresholds.preparing) {
    return 'preparingStageAge'
  }

  if (requestSlotWaitAgeMs > requestThresholds.waitingForRequestSlot) {
    return 'requestSlotWaitStageAge'
  }

  if (persistingAgeMs > requestThresholds.persisting) {
    return 'persistingStageAge'
  }

  return liveRequestAgeMs > requestThresholds.hasLiveRequest ? 'liveRequestStageAge' : null
}

const getPreconditionChangedReason = ({
  activeHigherPriorityStopRules,
  hasHealthyEndpointOrEndpointlessPath,
  lifecycleAgesMs,
  normalRequestCapacity,
  providerAvailableRequestLeases,
  providerLimit,
}: {
  activeHigherPriorityStopRules: string[]
  hasHealthyEndpointOrEndpointlessPath: boolean
  lifecycleAgesMs?: JudgmentBacklogLifecycleAgesMs
  normalRequestCapacity: number
  providerAvailableRequestLeases: number
  providerLimit: number
}): string | null => {
  const stageAgeReason = getStageAgeExceededReason(lifecycleAgesMs)

  if (providerLimit <= 0) {
    return 'providerLimit'
  }

  if (normalRequestCapacity <= 0) {
    return 'probeOccupancy'
  }

  if (!hasHealthyEndpointOrEndpointlessPath) {
    return 'endpointRouteability'
  }

  if (activeHigherPriorityStopRules.length > 0) {
    return activeHigherPriorityStopRules[0] ?? 'higherPriorityStopRule'
  }

  if (stageAgeReason) {
    return stageAgeReason
  }

  return providerAvailableRequestLeases <= 0 ? 'providerRequestLeases' : null
}

const getTargetFillEvidence = ({
  currentTarget,
  localBacklog,
}: {
  currentTarget: number
  localBacklog: number
}): boolean => {
  const fillThreshold = Math.ceil((currentTarget * judgmentBacklogControllerConstants.targetFillHysteresisPct) / 100)

  return currentTarget > 0 && localBacklog >= fillThreshold
}

const getDrainBufferUnits = (recentDrainRatePerSecond: number | null | undefined, windowMs: number): number => {
  return Math.ceil(getNonNegativeFinite(recentDrainRatePerSecond) * (windowMs / 1_000))
}

const getTargetIncreaseAllowed = ({
  hasCapacityToGrow,
  localPromptBacklog,
  localPromptBacklogTarget,
  localRequestWorkBacklog,
  localRequestWorkBacklogTarget,
  preconditionChangedReason,
  preconditionsStableSinceMs,
  recentDrainRatePerSecond,
}: {
  hasCapacityToGrow: boolean
  localPromptBacklog: number
  localPromptBacklogTarget: number
  localRequestWorkBacklog: number
  localRequestWorkBacklogTarget: number
  preconditionChangedReason: string | null
  preconditionsStableSinceMs: number
  recentDrainRatePerSecond?: number | null
}): boolean => {
  const promptTargetFilled = getTargetFillEvidence({
    currentTarget: localPromptBacklogTarget,
    localBacklog: localPromptBacklog,
  })
  const requestTargetFilled = getTargetFillEvidence({
    currentTarget: localRequestWorkBacklogTarget,
    localBacklog: localRequestWorkBacklog,
  })
  const drainEvidence = getNonNegativeFinite(recentDrainRatePerSecond) > 0
  const stableLongEnough = preconditionsStableSinceMs >= judgmentBacklogControllerConstants.targetIncreaseHysteresisMs

  return (
    hasCapacityToGrow
    && preconditionChangedReason === null
    && stableLongEnough
    && (promptTargetFilled || requestTargetFilled || drainEvidence)
  )
}

const getSafetyCappedExistingTarget = ({
  currentBacklog,
  existingTarget,
  immediateClamp,
  maximumTarget,
}: {
  currentBacklog: number
  existingTarget: number
  immediateClamp: boolean
  maximumTarget: number
}): number => {
  const cappedTarget = Math.min(existingTarget, maximumTarget)

  return immediateClamp ? Math.min(cappedTarget, currentBacklog) : cappedTarget
}

export const getJudgmentBacklogControllerState = (
  input: JudgmentBacklogControllerInput,
): JudgmentBacklogControllerState => {
  const activeHigherPriorityStopRules = input.activeHigherPriorityStopRules ?? []
  const providerLimit = getNonNegativeInteger(input.providerLimit)
  const providerLeasedProbeCalls = getNonNegativeInteger(input.providerLeasedProbeCalls)
  const normalRequestCapacity = Math.min(
    getNonNegativeInteger(input.normalRequestCapacity),
    Math.max(0, providerLimit - providerLeasedProbeCalls),
  )
  const effectiveProviderLimit = Math.min(
    getNonNegativeInteger(input.effectiveProviderLimit),
    normalRequestCapacity,
    providerLimit,
  )
  const expectedLocalLiveShare = Math.min(getNonNegativeInteger(input.expectedLocalLiveShare), effectiveProviderLimit)
  const localProviderLiveRequests = getNonNegativeInteger(input.localProviderLiveRequests)
  const localPromptBacklog = getNonNegativeInteger(input.localPromptBacklog)
  const localRequestWorkBacklog = getNonNegativeInteger(input.localRequestWorkBacklog)
  const providerAvailableRequestLeases = getNonNegativeInteger(input.providerAvailableRequestLeases)
  const readyCount = getNonNegativeInteger(input.readyCount)
  const preconditionsStableSinceMs = getNonNegativeInteger(input.preconditionsStableSinceMs)
  const preconditionChangedReason = getPreconditionChangedReason({
    activeHigherPriorityStopRules,
    hasHealthyEndpointOrEndpointlessPath: input.hasHealthyEndpointOrEndpointlessPath,
    lifecycleAgesMs: input.lifecycleAgesMs,
    normalRequestCapacity,
    providerAvailableRequestLeases,
    providerLimit,
  })
  const hasHealthyCapacity =
    input.hasHealthyEndpointOrEndpointlessPath
    && activeHigherPriorityStopRules.length === 0
    && providerLimit > 0
    && normalRequestCapacity > 0
    && effectiveProviderLimit > 0
  const immediateClamp = !hasHealthyCapacity
  const requestWorkPerPrompt = getPositiveInteger(input.estimatedRequestWorkPerPrompt)
  const promptClaimChunkEstimate = getPositiveInteger(input.promptClaimChunkEstimate)
  const requestWorkMaxTarget = hasHealthyCapacity
    ? Math.max(
        expectedLocalLiveShare,
        effectiveProviderLimit
          * judgmentBacklogControllerConstants.requestWorkBacklogMaximumEffectiveCapacityMultiplier,
      )
    : localRequestWorkBacklog
  const promptMaxTarget = hasHealthyCapacity
    ? Math.max(
        expectedLocalLiveShare * judgmentBacklogControllerConstants.promptBacklogRequestWorkMultiplier,
        effectiveProviderLimit * judgmentBacklogControllerConstants.promptBacklogMaximumEffectiveCapacityMultiplier,
      )
    : localPromptBacklog
  const baseRequestWorkTarget = getLowLimitRoundedTarget({
    base: expectedLocalLiveShare,
    extraUnits: judgmentBacklogControllerConstants.lowLimitRequestWorkExtraUnits,
    maximum: requestWorkMaxTarget,
    minimum: judgmentBacklogControllerConstants.requestWorkBacklogMinimumUnits,
  })
  const basePromptTarget = getLowLimitRoundedTarget({
    base: expectedLocalLiveShare * judgmentBacklogControllerConstants.promptBacklogRequestWorkMultiplier,
    extraUnits: judgmentBacklogControllerConstants.lowLimitPromptExtraUnits,
    maximum: promptMaxTarget,
    minimum: judgmentBacklogControllerConstants.promptBacklogMinimumUnits,
  })
  const existingRequestWorkTarget = getNonNegativeInteger(input.localRequestWorkBacklogTarget)
  const existingPromptTarget = getNonNegativeInteger(input.localPromptBacklogTarget)
  const requestWorkTargetFloor = Math.max(baseRequestWorkTarget, existingRequestWorkTarget)
  const promptTargetFloor = Math.max(basePromptTarget, existingPromptTarget)
  const hasCapacityToGrow =
    readyCount > 0
    && providerAvailableRequestLeases > 0
    && expectedLocalLiveShare > localProviderLiveRequests
    && (requestWorkTargetFloor < requestWorkMaxTarget || promptTargetFloor < promptMaxTarget)
  const targetIncreaseAllowed = getTargetIncreaseAllowed({
    hasCapacityToGrow,
    localPromptBacklog,
    localPromptBacklogTarget: promptTargetFloor,
    localRequestWorkBacklog,
    localRequestWorkBacklogTarget: requestWorkTargetFloor,
    preconditionChangedReason,
    preconditionsStableSinceMs,
    recentDrainRatePerSecond: input.recentDrainRatePerSecond,
  })
  const requestDrainBuffer = getDrainBufferUnits(
    input.recentDrainRatePerSecond,
    judgmentBacklogControllerConstants.requestWorkDrainWindowMs,
  )
  const promptDrainBuffer = getDrainBufferUnits(
    input.recentDrainRatePerSecond,
    judgmentBacklogControllerConstants.promptDrainWindowMs,
  )
  const increasedRequestWorkTarget =
    requestWorkTargetFloor + Math.max(requestWorkPerPrompt, requestDrainBuffer, targetIncreaseAllowed ? 1 : 0)
  const increasedPromptTarget =
    promptTargetFloor + Math.max(promptClaimChunkEstimate, promptDrainBuffer, requestWorkPerPrompt)
  const safeExistingRequestWorkTarget = getSafetyCappedExistingTarget({
    currentBacklog: localRequestWorkBacklog,
    existingTarget: existingRequestWorkTarget,
    immediateClamp,
    maximumTarget: requestWorkMaxTarget,
  })
  const safeExistingPromptTarget = getSafetyCappedExistingTarget({
    currentBacklog: localPromptBacklog,
    existingTarget: existingPromptTarget,
    immediateClamp,
    maximumTarget: promptMaxTarget,
  })
  const localRequestWorkBacklogTarget = targetIncreaseAllowed
    ? Math.min(requestWorkMaxTarget, increasedRequestWorkTarget)
    : Math.min(requestWorkMaxTarget, Math.max(baseRequestWorkTarget, safeExistingRequestWorkTarget))
  const localPromptBacklogTarget = targetIncreaseAllowed
    ? Math.min(promptMaxTarget, increasedPromptTarget)
    : Math.min(promptMaxTarget, Math.max(basePromptTarget, safeExistingPromptTarget))
  const backlogReplenishmentAllowed =
    readyCount > 0
    && preconditionChangedReason === null
    && providerAvailableRequestLeases > 0
    && normalRequestCapacity > 0
  const localTargetGap = Math.max(0, localRequestWorkBacklogTarget - localRequestWorkBacklog)
  const localShareGap = Math.max(0, expectedLocalLiveShare - localProviderLiveRequests)
  const localAdditionalTargetHeadroom = Math.min(localTargetGap, localShareGap)
  const localAdditionalLeaseHeadroom = Math.min(providerAvailableRequestLeases, localAdditionalTargetHeadroom)

  return {
    backlogReplenishmentAllowed,
    localAdditionalLeaseHeadroom,
    localAdditionalTargetHeadroom,
    localPromptBacklogTarget,
    localRequestWorkBacklogTarget,
    localTargetGap,
    preconditionChangedReason,
    preconditionsStableSinceMs,
    targetIncreaseAllowed,
  }
}

export const getJudgmentPromptQueueTargetFromProviderLimit = ({
  providerMaxInflightRequests,
  providerPromptBacklogTarget,
}: {
  providerMaxInflightRequests: number | null | undefined
  providerPromptBacklogTarget?: number | null
}): {activePromptLimit: number; queuedPromptLimit: number} => {
  const providerLimit = getPositiveInteger(providerMaxInflightRequests)
  const defaultPromptBacklogTarget =
    providerLimit * judgmentBacklogControllerConstants.promptBacklogRequestWorkMultiplier
  const promptBacklogTarget = getNonNegativeInteger(providerPromptBacklogTarget) || defaultPromptBacklogTarget
  const maximumActivePromptLimit = Math.max(
    judgmentBacklogControllerConstants.promptPipelineMaximumUnits,
    providerLimit * judgmentBacklogControllerConstants.promptBacklogRequestWorkMultiplier,
  )
  const activePromptLimit = getBoundedInteger(
    Math.max(providerLimit + 1, Math.min(promptBacklogTarget, providerLimit * 2)),
    judgmentBacklogControllerConstants.promptPipelineMinimumUnits,
    maximumActivePromptLimit,
  )
  const queuedPromptLimit = Math.max(1, promptBacklogTarget - activePromptLimit)

  return {activePromptLimit, queuedPromptLimit}
}
