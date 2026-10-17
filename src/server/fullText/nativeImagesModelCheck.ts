import {providerTransportSupportsImageInput} from '../providers/providerImageInput.ts'
import {resolveProviderModelCapabilities} from '../providers/providerModelCapabilities.ts'
import {getProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type FullTextFigureMode} from './fullTextStrategy.ts'

type NativeImagesModelQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type NativeImagesModelCandidate = {
  label: string
  metadataJson: unknown
  providerKind: string | null
  remoteModelId: string | null
}

export const getNativeImagesModelErrorMessage = (modelLabel: string): string => {
  return `Model ${modelLabel} cannot receive images. Choose figure mode Descriptions or None, or another model.`
}

export const nativeImagesModelAcceptsImages = (model: NativeImagesModelCandidate): boolean => {
  const transportFamily = getProviderRegistryEntry(model.providerKind)?.transportFamily ?? null

  return (
    transportFamily !== null
    && providerTransportSupportsImageInput(transportFamily)
    && resolveProviderModelCapabilities(model).supportsImageInput?.value === true
  )
}

export const getNativeImagesModelError = ({
  figureMode,
  model,
}: {
  figureMode: FullTextFigureMode | null
  model: NativeImagesModelCandidate
}): string | null => {
  return figureMode === 'native_images' && !nativeImagesModelAcceptsImages(model)
    ? getNativeImagesModelErrorMessage(model.label)
    : null
}

const getNativeImagesModelCandidate = async (
  runner: NativeImagesModelQueryRunner,
  modelId: string,
): Promise<NativeImagesModelCandidate> => {
  const [row] = await runner.queryJson<NativeImagesModelCandidate>(`
    SELECT
      COALESCE(m.display_name, m.remote_model_id, m.name) AS label,
      TO_JSON(m.metadata_json) AS metadataJson,
      pc.provider_kind AS providerKind,
      m.remote_model_id AS remoteModelId
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  return row
    ? {...row, metadataJson: getJsonValue(row.metadataJson)}
    : {label: modelId, metadataJson: null, providerKind: null, remoteModelId: null}
}

export const getNativeImagesModelErrorForModelId = async ({
  figureMode,
  modelId,
  runner = getAppDatabaseService(),
}: {
  figureMode: FullTextFigureMode | null
  modelId: string
  runner?: NativeImagesModelQueryRunner
}): Promise<string | null> => {
  return figureMode === 'native_images'
    ? getNativeImagesModelError({figureMode, model: await getNativeImagesModelCandidate(runner, modelId)})
    : null
}
