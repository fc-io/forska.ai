import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {createOpenAICompatibleAdapter} from './createOpenAICompatibleAdapter.ts'

export const createOllamaAdapter = (catalog: ProviderCatalogEntry) => {
  return createOpenAICompatibleAdapter(catalog, {
    authFlow: 'secretless',
    transportFamily: 'ollama-native-discovery',
    useNativeOllamaDiscovery: true,
  })
}
