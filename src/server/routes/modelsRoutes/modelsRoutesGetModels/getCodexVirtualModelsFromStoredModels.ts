import type {ProviderModelRecord} from '../../../providers/providerTypes.ts'
import {getTrimmedValue} from '../../providerRoutes/providerRoutesShared.ts'
import {getCodexStoredModelMap} from './getCodexStoredModelMap.ts'
import {getSelectableCodexModel} from './getSelectableCodexModel.ts'

export const getCodexVirtualModelsFromStoredModels = async ({
  preferredProviderConnectionId,
  storedModels,
}: {
  preferredProviderConnectionId: string | null
  storedModels: ProviderModelRecord[]
}) => {
  const deduplicatedStoredModels = Array.from(
    getCodexStoredModelMap({preferredProviderConnectionId, storedModels}).values(),
  )

  return deduplicatedStoredModels
    .filter((model) => {
      return (
        model.enabled
        && model.provider === 'codex'
        && typeof model.modelName === 'string'
        && model.modelName.trim().length > 0
      )
    })
    .map((model) => {
      const modelName = String(model.modelName).trim()
      const effort = getTrimmedValue(model.variant ?? model.version)

      return getSelectableCodexModel({
        createdAt: model.createdAt,
        displayName: model.displayName ?? model.name,
        modelName,
        providerConnectionId: model.providerConnectionId,
        updatedAt: model.updatedAt,
        version: effort,
      })
    })
}
