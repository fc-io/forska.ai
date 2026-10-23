import {getAnthropicSupportedThinkingEfforts} from '../../../../utils/anthropicThinking.ts'
import {appendProviderModelThinkingBadgeLabel} from '../../../../utils/providerModelLabel.ts'
import type {ProviderModelRecord} from '../../../providers/providerTypes.ts'
import {getTrimmedValue} from '../../providerRoutes/providerRoutesShared.ts'
import {getSelectableModelLabel} from '../getSelectableModelLabel.ts'
import {getSelectableStoredModel} from './getSelectableStoredModel.ts'

const toAnthropicVirtualId = (modelName: string, effort: string): string => {
  return `anthropic:${modelName}:${effort}`
}

const getAnthropicStoredModelKey = (model: {
  modelName: string | null
  remoteModelId: string | null
  variant: string | null
  version: string | null
}) => {
  const modelName = getTrimmedValue(model.remoteModelId) ?? getTrimmedValue(model.modelName) ?? 'anthropic'
  const effort = getTrimmedValue(model.variant ?? model.version) ?? 'base'

  return `${modelName}:${effort}`
}

const getSelectableAnthropicVirtualModel = ({
  baseURL,
  createdAt,
  displayName,
  id,
  modelName,
  providerConnectionId,
  updatedAt,
  version,
}: {
  baseURL: string | null
  createdAt: Date | null
  displayName: string
  id: string
  modelName: string
  providerConnectionId: string | null
  updatedAt: Date | null
  version: string | null
}) => {
  return {
    apiKeyVariable: null,
    baseURL,
    createdAt,
    id,
    label: getSelectableModelLabel({metadataJson: null, name: displayName, provider: 'anthropic', version}),
    modelName,
    name: displayName,
    provider: 'anthropic',
    providerConnectionId,
    updatedAt,
    version,
    workerUrls: null,
  }
}

export const getAnthropicSelectableModels = (storedModels: ProviderModelRecord[]) => {
  const anthropicModels = storedModels.filter((model) => {
    return model.provider === 'anthropic'
  })
  const storedVariants = new Map(
    anthropicModels.map((model) => {
      return [getAnthropicStoredModelKey(model), model]
    }),
  )
  const usedModelIds = new Set<string>()
  const modelsFromBaseRows = anthropicModels.flatMap((model) => {
    const currentVersion = getTrimmedValue(model.variant ?? model.version)
    const modelName = getTrimmedValue(model.remoteModelId) ?? getTrimmedValue(model.modelName)

    if (currentVersion || !modelName) {
      return []
    }

    const baseDisplayName = model.displayName ?? model.name
    const supportedEfforts = getAnthropicSupportedThinkingEfforts(modelName)

    usedModelIds.add(model.id)

    return [
      getSelectableStoredModel(model),
      ...supportedEfforts.map((effort) => {
        const storedVariant = storedVariants.get(
          getAnthropicStoredModelKey({modelName, remoteModelId: modelName, variant: effort, version: effort}),
        )

        if (storedVariant) {
          usedModelIds.add(storedVariant.id)

          return getSelectableStoredModel(storedVariant)
        }

        return getSelectableAnthropicVirtualModel({
          baseURL: model.baseURL,
          createdAt: model.createdAt,
          displayName: appendProviderModelThinkingBadgeLabel({label: baseDisplayName, thinking: effort}),
          id: toAnthropicVirtualId(modelName, effort),
          modelName,
          providerConnectionId: model.providerConnectionId,
          updatedAt: model.updatedAt,
          version: effort,
        })
      }),
    ]
  })
  const remainingStoredModels = anthropicModels
    .filter((model) => {
      return !usedModelIds.has(model.id)
    })
    .map(getSelectableStoredModel)

  return [...modelsFromBaseRows, ...remainingStoredModels]
}
