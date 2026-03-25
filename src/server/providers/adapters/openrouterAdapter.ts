import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {createOpenAICompatibleAdapter} from './createOpenAICompatibleAdapter.ts'

export const createOpenrouterAdapter = (catalog: ProviderCatalogEntry) => {
  return createOpenAICompatibleAdapter(catalog, {authFlow: 'api-key', transportFamily: 'openai-chat'})
}
