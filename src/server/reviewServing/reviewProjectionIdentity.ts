import {createHash} from 'node:crypto'

import type {ReviewServingProjectionComponent, ReviewServingReadContractKey} from './reviewServingContracts.ts'

type ReviewServingIdentityPrimitive = boolean | null | number | string

export type ReviewServingIdentityValue =
  | ReviewServingIdentityPrimitive
  | readonly ReviewServingIdentityValue[]
  | {[key: string]: ReviewServingIdentityValue | undefined}
  | undefined

export type ReviewProjectionIdentityInput = {
  baseGeneration?: number | string
  component: ReviewServingProjectionComponent
  definitionVersion: string
  patchWatermark?: number | string
  upstreamDigests?: {[key: string]: ReviewServingIdentityValue | undefined}
}

export type ReviewDisplayIdentityInput = {definitionVersion: string; displayDependencyKeys: readonly string[]}

export type ReviewSearchIdentityInput = {
  definitionVersion: string
  searchDependencyKeys: readonly string[]
  tokenizerVersion: string
}

export type ReviewJudgmentInputContentIdentityInput = {
  contentDependencyKeys: readonly string[]
  definitionVersion: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type ReviewProjectScopeIdentityInput = {definitionVersion: string; projectScopeDependencyKeys: readonly string[]}

export type PromptConfigHashInput = {
  answerSchemaHash: string | null
  promptId: string
  promptTextHash: string
  settingsVersion: string
  thresholdVersion: string | null
}

export type ReviewConfigHashInput = {
  modelExecutionIdentity: ReviewServingIdentityValue
  modelId: string | null
  promptConfigs: readonly {promptConfigHash: string; promptId: string}[]
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type ReviewServingRouteComponentIdentityInput = {
  baseGeneration: number | string
  patchWatermark: number | string
  projectionIdentity: string
}

export type ComposedRouteIdentityInput = {
  componentStates: Partial<Record<ReviewServingProjectionComponent, ReviewServingRouteComponentIdentityInput>>
  contractKey: ReviewServingReadContractKey
  optionalComponents: readonly ReviewServingProjectionComponent[]
  requiredComponents: readonly ReviewServingProjectionComponent[]
  reviewConfigHash: string | null
  routeVersion: string
  selectedImportSnapshotId?: string | null
}

const isPlainIdentityRecord = (
  value: ReviewServingIdentityValue,
): value is {[key: string]: ReviewServingIdentityValue | undefined} => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const getPrimitiveJson = (value: ReviewServingIdentityValue) => {
  const normalizedValue = typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
  return normalizedValue === undefined ? '"__undefined__"' : (JSON.stringify(normalizedValue) ?? 'null')
}

export const getStableReviewServingJson = (value: ReviewServingIdentityValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(getStableReviewServingJson).join(',')}]`
  }

  if (isPlainIdentityRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => {
        return value[key] !== undefined
      })
      .map((key) => {
        return `${JSON.stringify(key)}:${getStableReviewServingJson(value[key])}`
      })

    return `{${entries.join(',')}}`
  }

  return getPrimitiveJson(value)
}

const getReviewServingHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getSortedUniqueValues = <T extends string>(values: readonly T[]) => {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right)
  })
}

const getStableIdentityRecord = (value: {[key: string]: ReviewServingIdentityValue | undefined}) => {
  return Object.keys(value)
    .sort()
    .reduce<{[key: string]: ReviewServingIdentityValue}>((record, key) => {
      const entry = value[key]
      return entry === undefined ? record : {...record, [key]: entry}
    }, {})
}

const getReviewProjectionIdentityValue = (input: ReviewProjectionIdentityInput): ReviewServingIdentityValue => {
  return {
    component: input.component,
    definitionVersion: input.definitionVersion,
    ...(input.upstreamDigests === undefined ? {} : {upstreamDigests: getStableIdentityRecord(input.upstreamDigests)}),
  }
}

const getComposedRouteComponentState = (
  component: ReviewServingProjectionComponent,
  states: Partial<Record<ReviewServingProjectionComponent, ReviewServingRouteComponentIdentityInput>>,
): ReviewServingIdentityValue => {
  const state = states[component]
  return state === undefined
    ? {component, state: null}
    : {
        baseGeneration: state.baseGeneration,
        component,
        patchWatermark: state.patchWatermark,
        projectionIdentity: state.projectionIdentity,
      }
}

const getComposedRouteComponentStates = (
  components: readonly ReviewServingProjectionComponent[],
  states: Partial<Record<ReviewServingProjectionComponent, ReviewServingRouteComponentIdentityInput>>,
) => {
  return getSortedUniqueValues(components).map((component) => {
    return getComposedRouteComponentState(component, states)
  })
}

const getComposedRouteIdentityValue = (input: ComposedRouteIdentityInput): ReviewServingIdentityValue => {
  return {
    componentStates: {
      optional: getComposedRouteComponentStates(input.optionalComponents, input.componentStates),
      required: getComposedRouteComponentStates(input.requiredComponents, input.componentStates),
    },
    contractKey: input.contractKey,
    reviewConfigHash: input.reviewConfigHash,
    routeVersion: input.routeVersion,
    ...(input.selectedImportSnapshotId === undefined ? {} : {selectedImportSnapshotId: input.selectedImportSnapshotId}),
  }
}

export const buildReviewProjectionIdentity = (input: ReviewProjectionIdentityInput) => {
  return `${input.component}:${getReviewServingHash('review-projection', getReviewProjectionIdentityValue(input))}`
}

export const buildReviewDisplayIdentity = (input: ReviewDisplayIdentityInput) => {
  return buildReviewProjectionIdentity({
    component: 'display',
    definitionVersion: input.definitionVersion,
    upstreamDigests: {displayDependencyKeys: getSortedUniqueValues(input.displayDependencyKeys)},
  })
}

export const buildReviewSearchIdentity = (input: ReviewSearchIdentityInput) => {
  return buildReviewProjectionIdentity({
    component: 'search',
    definitionVersion: input.definitionVersion,
    upstreamDigests: {
      searchDependencyKeys: getSortedUniqueValues(input.searchDependencyKeys),
      tokenizerVersion: input.tokenizerVersion,
    },
  })
}

export const buildReviewJudgmentInputContentIdentity = (input: ReviewJudgmentInputContentIdentityInput) => {
  return buildReviewProjectionIdentity({
    component: 'judgmentInputContent',
    definitionVersion: input.definitionVersion,
    upstreamDigests: {
      contentDependencyKeys: getSortedUniqueValues(input.contentDependencyKeys),
      useAbstract: input.useAbstract,
      useFulltext: input.useFulltext,
      useFulltextNoImages: input.useFulltextNoImages,
      useTitle: input.useTitle,
    },
  })
}

export const buildReviewProjectScopeIdentity = (input: ReviewProjectScopeIdentityInput) => {
  return buildReviewProjectionIdentity({
    component: 'projectScope',
    definitionVersion: input.definitionVersion,
    upstreamDigests: {projectScopeDependencyKeys: getSortedUniqueValues(input.projectScopeDependencyKeys)},
  })
}

export const buildPromptConfigHash = (input: PromptConfigHashInput) => {
  return `prompt:${getReviewServingHash('review-prompt-config', {
    answerSchemaHash: input.answerSchemaHash,
    promptId: input.promptId,
    promptTextHash: input.promptTextHash,
    settingsVersion: input.settingsVersion,
    thresholdVersion: input.thresholdVersion,
  })}`
}

export const buildReviewConfigHash = (input: ReviewConfigHashInput) => {
  const promptConfigs = input.promptConfigs
    .map((promptConfig) => {
      return {promptConfigHash: promptConfig.promptConfigHash, promptId: promptConfig.promptId}
    })
    .sort((left, right) => {
      return left.promptId.localeCompare(right.promptId)
    })

  return `review:${getReviewServingHash('review-config', {
    modelExecutionIdentity: input.modelExecutionIdentity,
    modelId: input.modelId,
    promptConfigs,
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  })}`
}

export const buildSummaryDefinitionIdentity = (input: {
  contributionKeys: readonly string[]
  summaryDefinitionVersion: string
}) => {
  const contributionKeys = getSortedUniqueValues(input.contributionKeys)
  return `summary:${getReviewServingHash('review-summary-definition', {
    contributionKeys,
    summaryDefinitionVersion: input.summaryDefinitionVersion,
  })}`
}

export const getComposedRouteIdentityJson = (input: ComposedRouteIdentityInput) => {
  return getStableReviewServingJson(getComposedRouteIdentityValue(input))
}

export const buildComposedRouteIdentity = (input: ComposedRouteIdentityInput) => {
  return `route:${getReviewServingHash('review-composed-route', getComposedRouteIdentityValue(input))}`
}
