import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {createOpenAICompatibleAdapter} from './createOpenAICompatibleAdapter.ts'

export const createSglangAdapter = (catalog: ProviderCatalogEntry) => {
  return createOpenAICompatibleAdapter(catalog, {transportFamily: 'openai-chat'})
}
