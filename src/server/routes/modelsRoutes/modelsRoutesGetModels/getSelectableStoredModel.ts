import type {ProviderModelRecord} from '../../../providers/providerTypes.ts'
import {getSelectableModelLabel} from '../getSelectableModelLabel.ts'

export const getSelectableStoredModel = (model: ProviderModelRecord) => {
  return {
    apiKeyVariable: null,
    baseURL: model.baseURL,
    createdAt: model.createdAt,
    id: model.id,
    label: getSelectableModelLabel({
      metadataJson: model.metadataJson,
      name: model.displayName ?? model.name,
      provider: model.provider,
      version: model.variant ?? model.version,
    }),
    modelName: model.modelName,
    name: model.displayName ?? model.name,
    provider: model.provider,
    providerConnectionId: model.providerConnectionId,
    updatedAt: model.updatedAt,
    version: model.variant ?? model.version,
    workerUrls: null,
  }
}
