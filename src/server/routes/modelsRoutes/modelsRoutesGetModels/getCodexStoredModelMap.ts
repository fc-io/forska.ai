import type {ProviderModelRecord} from '../../../providers/providerTypes.ts'
import {getTrimmedValue} from '../../providerRoutes/providerRoutesShared.ts'
import {toCodexVirtualId} from './toCodexVirtualId.ts'

export const getCodexStoredModelKey = (model: {
  modelName: string | null
  remoteModelId: string | null
  variant: string | null
  version: string | null
}) => {
  const modelName = getTrimmedValue(model.remoteModelId) ?? getTrimmedValue(model.modelName) ?? 'codex'
  const effort = getTrimmedValue(model.variant ?? model.version)

  return toCodexVirtualId(modelName, effort)
}

const isPreferredCodexProviderModel = ({
  model,
  preferredProviderConnectionId,
}: {
  model: ProviderModelRecord
  preferredProviderConnectionId: string | null
}): boolean => {
  return Boolean(preferredProviderConnectionId && model.providerConnectionId === preferredProviderConnectionId)
}

const getCodexStoredModelTimestamp = (model: ProviderModelRecord): number => {
  return model.updatedAt?.getTime() ?? model.createdAt?.getTime() ?? 0
}

const shouldReplaceCodexStoredModel = ({
  current,
  model,
  preferredProviderConnectionId,
}: {
  current: ProviderModelRecord | undefined
  model: ProviderModelRecord
  preferredProviderConnectionId: string | null
}): boolean => {
  if (!current) {
    return true
  }

  const currentIsPreferred = isPreferredCodexProviderModel({model: current, preferredProviderConnectionId})
  const modelIsPreferred = isPreferredCodexProviderModel({model, preferredProviderConnectionId})

  if (currentIsPreferred !== modelIsPreferred) {
    return modelIsPreferred
  }

  if (current.enabled !== model.enabled) {
    return model.enabled
  }

  return getCodexStoredModelTimestamp(model) > getCodexStoredModelTimestamp(current)
}

export const getCodexStoredModelMap = ({
  preferredProviderConnectionId,
  storedModels,
}: {
  preferredProviderConnectionId: string | null
  storedModels: ProviderModelRecord[]
}): Map<string, ProviderModelRecord> => {
  return storedModels.reduce((storedModelMap, model) => {
    const modelId = getCodexStoredModelKey(model)

    if (shouldReplaceCodexStoredModel({current: storedModelMap.get(modelId), model, preferredProviderConnectionId})) {
      storedModelMap.set(modelId, model)
    }

    return storedModelMap
  }, new Map<string, ProviderModelRecord>())
}
