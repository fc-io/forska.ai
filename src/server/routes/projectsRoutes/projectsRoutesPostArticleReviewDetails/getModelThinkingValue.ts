import {getProviderModelMetadataOptions} from '../../../providers/providerModelMetadata.ts'
import {getJsonValue} from '../../../services/appQueryHelpers.ts'

export const getModelThinkingValue = (row: {modelMetadataJson: unknown}) => {
  return getProviderModelMetadataOptions(getJsonValue(row.modelMetadataJson)).thinking ?? null
}
