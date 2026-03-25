import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {createOpenAICompatibleAdapter} from './createOpenAICompatibleAdapter.ts'

export const createVllmAdapter = (catalog: ProviderCatalogEntry) => {
  return createOpenAICompatibleAdapter(catalog, {authFlow: 'optional-api-key', transportFamily: 'openai-chat'})
}
