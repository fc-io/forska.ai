import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../../utils/providerModelLabel.ts'
import {getProviderModelMetadataOptions} from '../../providers/providerModelMetadata.ts'

export const getSelectableModelLabel = ({
  metadataJson,
  name,
  provider,
  version,
}: {
  metadataJson: unknown
  name: string
  provider: string | null
  version?: string | null
}) => {
  const baseLabel = provider === 'codex' ? `Codex: ${name}` : name

  return appendProviderModelThinkingBadgeLabel({
    label: baseLabel,
    thinking: getProviderModelThinkingBadgeValue({
      provider,
      thinking: getProviderModelMetadataOptions(metadataJson).thinking,
      version: version ?? null,
    }),
  })
}
