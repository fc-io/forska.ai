import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {type ProviderDefinition} from '../providerTypes.ts'
import {
  beginSecretlessProviderAuth,
  finishSecretlessProviderAuth,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getDoclingRoute = (baseURL: string, route: string): string => {
  return `${baseURL.replace(/\/+$/, '')}${route}`
}

const isAcceptableDoclingStatus = (status: number): boolean => {
  return status >= 200 && status < 500 && status !== 404
}

const assertDoclingAvailable = async (baseURL: string | null): Promise<void> => {
  const normalizedBaseURL = getTrimmedValue(baseURL)

  if (!normalizedBaseURL) {
    throw new Error('Docling base URL is required')
  }

  const openApiResponse = await fetch(getDoclingRoute(normalizedBaseURL, '/openapi.json')).catch(() => {
    return null
  })

  if (openApiResponse?.ok) {
    return
  }

  const convertResponse = await fetch(getDoclingRoute(normalizedBaseURL, '/v1/convert/source')).catch(() => {
    return null
  })

  if (convertResponse && isAcceptableDoclingStatus(convertResponse.status)) {
    return
  }

  throw new Error('Docling server did not respond at the configured base URL')
}

export const createDoclingAdapter = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  return {
    beginAuth: async ({connection}) => {
      return beginSecretlessProviderAuth({catalog, connection})
    },
    catalog,
    finishAuth: async ({connection}) => {
      return finishSecretlessProviderAuth({catalog, connection})
    },
    health: async ({runtimeCredentials}) => {
      try {
        await assertDoclingAvailable(runtimeCredentials.baseURL)

        return getProviderHealthSuccess({message: `${catalog.label} connected`, modelCount: null})
      } catch (error) {
        return getProviderHealthFailure(error)
      }
    },
    invoke: async () => {
      throw new Error('Docling provider does not support judgment invocation')
    },
    kind: catalog.kind,
    listModels: async () => {
      return []
    },
    resolveRuntimeCredentials: async ({connection}) => {
      return resolveSecretlessRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async ({runtimeCredentials}) => {
      try {
        await assertDoclingAvailable(runtimeCredentials.baseURL)

        return getProviderHealthSuccess({message: `${catalog.label} reachable`, modelCount: null})
      } catch (error) {
        return getProviderHealthFailure(error)
      }
    },
    transportFamily: 'docling-convert',
  }
}
