import {listProviderConnections} from '../../providers/providerConnectionRepository.ts'
import {getSelectableModelLabel} from './getSelectableModelLabel.ts'

export const modelsRoutesGetStored = async () => {
  const connections = await listProviderConnections()

  return {
    data: connections.flatMap((connection) => {
      return connection.models.map((model) => {
        return {
          ...model,
          label: getSelectableModelLabel({
            metadataJson: model.metadataJson,
            name: model.displayName ?? model.name,
            provider: model.provider,
            version: model.variant ?? model.version,
          }),
        }
      })
    }),
  }
}
