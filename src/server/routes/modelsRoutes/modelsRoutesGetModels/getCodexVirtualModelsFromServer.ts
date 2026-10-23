import {resolveProviderRuntimeCredentials} from '../../../providers/providerAuthService.ts'
import {requireProviderRegistryEntry} from '../../../providers/providerRegistry.ts'
import type {ProviderConnectionRecord, ProviderModelRecord} from '../../../providers/providerTypes.ts'
import {getTrimmedValue} from '../../providerRoutes/providerRoutesShared.ts'
import {getCodexStoredModelKey, getCodexStoredModelMap} from './getCodexStoredModelMap.ts'
import {getSelectableCodexModel} from './getSelectableCodexModel.ts'
import {toCodexVirtualId} from './toCodexVirtualId.ts'

export const getCodexVirtualModelsFromServer = async ({
  connection,
  storedModels,
}: {
  connection: ProviderConnectionRecord | null
  storedModels: ProviderModelRecord[]
}) => {
  if (!connection) {
    return []
  }

  try {
    const definition = requireProviderRegistryEntry(connection.providerKind)
    const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)
    const discoveredModels = await definition.listModels({connection, runtimeCredentials})
    const storedModelMap = getCodexStoredModelMap({preferredProviderConnectionId: connection.id, storedModels})
    const discoveredIds = new Set<string>()
    const mergedDiscoveredModels = discoveredModels
      .filter((model) => {
        const modelId = toCodexVirtualId(model.modelName, model.variant ?? model.version)
        const storedModel = storedModelMap.get(modelId)

        discoveredIds.add(modelId)

        return storedModel?.enabled ?? true
      })
      .map((model) => {
        return getSelectableCodexModel({
          createdAt: null,
          displayName: model.displayName,
          modelName: model.modelName,
          providerConnectionId: connection.id,
          updatedAt: null,
          version: model.variant ?? model.version,
        })
      })
    const missingStoredModels = Array.from(storedModelMap.values())
      .filter((model) => {
        return model.enabled && !discoveredIds.has(getCodexStoredModelKey(model))
      })
      .map((model) => {
        return getSelectableCodexModel({
          createdAt: model.createdAt,
          displayName: model.displayName ?? model.name,
          modelName: String(model.modelName ?? model.remoteModelId ?? model.name).trim(),
          providerConnectionId: model.providerConnectionId,
          updatedAt: model.updatedAt,
          version: getTrimmedValue(model.variant ?? model.version),
        })
      })

    return [...mergedDiscoveredModels, ...missingStoredModels]
  } catch (error) {
    console.warn('[models] Failed to load Codex models:', error instanceof Error ? error.message : error)
    return []
  }
}
