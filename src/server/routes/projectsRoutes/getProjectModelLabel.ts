import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../../utils/providerModelLabel.ts'
import {getProviderModelMetadataOptions} from '../../providers/providerModelMetadata.ts'
import {getJsonValue} from '../../services/appQueryHelpers.ts'

export const getProjectModelLabel = ({
  metadataJson,
  modelName,
  provider,
  version,
}: {
  metadataJson: unknown
  modelName: string | null
  provider: string | null
  version: string | null
}) => {
  return modelName
    ? appendProviderModelThinkingBadgeLabel({
        label: modelName,
        thinking: getProviderModelThinkingBadgeValue({
          provider,
          thinking: getProviderModelMetadataOptions(getJsonValue(metadataJson)).thinking,
          version,
        }),
      })
    : modelName
}
