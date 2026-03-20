import {type ModelSource} from '../../db/schemaTypes.ts'
import {
  assertSelectableModelId,
  assertSelectableModelIds,
  createProviderModelRecord,
  type DiscoveredProviderModel,
  getProviderModelsByIds,
  listSelectableModels,
  updateProviderModelRecord,
  upsertDiscoveredProviderModels,
} from '../services/providerConnectionQueryService.ts'
import {type ProviderConnectionRecord, type ProviderListedModel, type ProviderModelRecord} from './providerTypes.ts'

type DatabaseQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export const listSelectableProviderModels = async (): Promise<ProviderModelRecord[]> => {
  return listSelectableModels()
}

export const createProviderModel = async ({
  connection,
  displayName,
  metadataJson,
  modelName,
  remoteModelId,
  source,
  variant,
  version,
}: {
  connection: ProviderConnectionRecord
  displayName: string
  metadataJson: unknown
  modelName: string
  remoteModelId: string
  source: ModelSource
  variant: string | null
  version: string | null
}): Promise<ProviderModelRecord> => {
  return createProviderModelRecord({
    connection,
    displayName,
    metadataJson,
    modelName,
    remoteModelId,
    source,
    variant,
    version,
  })
}

export const updateProviderModel = async ({
  displayName,
  enabled,
  id,
  variant,
}: {
  displayName: string
  enabled: boolean
  id: string
  variant: string | null
}): Promise<ProviderModelRecord> => {
  return updateProviderModelRecord({displayName, enabled, id, variant})
}

const getDiscoveredProviderModel = (model: ProviderListedModel): DiscoveredProviderModel => {
  return {
    displayName: model.displayName,
    metadataJson: model.metadataJson,
    modelName: model.modelName,
    remoteModelId: model.remoteModelId,
    variant: model.variant,
    version: model.version,
  }
}

export const upsertDiscoveredModels = async ({
  connection,
  models,
}: {
  connection: ProviderConnectionRecord
  models: ProviderListedModel[]
}): Promise<ProviderModelRecord[]> => {
  return upsertDiscoveredProviderModels({connection, discoveredModels: models.map(getDiscoveredProviderModel)})
}

export const getProviderModels = async (modelIds: string[]): Promise<Map<string, ProviderModelRecord>> => {
  return getProviderModelsByIds(modelIds)
}

export const assertSelectableProviderModelId = async (
  databaseRunner: DatabaseQueryRunner,
  {errorMessage, modelId}: {errorMessage: string; modelId: string},
): Promise<string> => {
  return assertSelectableModelId(databaseRunner, {errorMessage, modelId})
}

export const assertSelectableProviderModelIds = async (
  databaseRunner: DatabaseQueryRunner,
  {errorMessage, modelIds}: {errorMessage: string; modelIds: string[]},
): Promise<string[]> => {
  return assertSelectableModelIds(databaseRunner, {errorMessage, modelIds})
}

export const getProviderModelRepository = () => {
  return {
    assertSelectableId: assertSelectableProviderModelId,
    assertSelectableIds: assertSelectableProviderModelIds,
    create: createProviderModel,
    getByIds: getProviderModels,
    listSelectable: listSelectableProviderModels,
    update: updateProviderModel,
    upsertDiscovered: upsertDiscoveredModels,
  }
}
