import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {createOpenAICompatibleAdapter} from './createOpenAICompatibleAdapter.ts'

export const createLlmstudioAdapter = (catalog: ProviderCatalogEntry) => {
  return createOpenAICompatibleAdapter(catalog, {transportFamily: 'openai-chat'})
}
