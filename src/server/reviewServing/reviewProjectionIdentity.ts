import {createHash} from 'node:crypto'

import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'

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
  upstreamDigests?: Record<string, ReviewServingIdentityPrimitive | undefined>
}

export type PromptConfigHashInput = {
  answerSchemaHash: string | null
  promptId: string
  promptTextHash: string
  settingsVersion: string
  thresholdVersion: string | null
}

export type ReviewConfigHashInput = {
  modelId: string | null
  promptConfigs: readonly {promptConfigHash: string; promptId: string}[]
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
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

export const buildReviewProjectionIdentity = (input: ReviewProjectionIdentityInput) => {
  return `${input.component}:${getReviewServingHash('review-projection', input)}`
}

export const buildPromptConfigHash = (input: PromptConfigHashInput) => {
  return `prompt:${getReviewServingHash('review-prompt-config', input)}`
}

export const buildReviewConfigHash = (input: ReviewConfigHashInput) => {
  const promptConfigs = input.promptConfigs
    .map((promptConfig) => {
      return {promptConfigHash: promptConfig.promptConfigHash, promptId: promptConfig.promptId}
    })
    .sort((left, right) => {
      return left.promptId.localeCompare(right.promptId)
    })

  return `review:${getReviewServingHash('review-config', {...input, promptConfigs})}`
}

export const buildSummaryDefinitionIdentity = (input: {
  contributionKeys: readonly string[]
  summaryDefinitionVersion: string
}) => {
  const contributionKeys = [...input.contributionKeys].sort()
  return `summary:${getReviewServingHash('review-summary-definition', {...input, contributionKeys})}`
}
