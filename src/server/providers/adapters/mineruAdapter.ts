import {mineruConvertOptions} from '../../fullText/converters/mineruConverter.ts'
import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {getNormalizedProviderModelMetadata} from '../providerModelMetadata.ts'
import {type ProviderDefinition, type ProviderListedModel} from '../providerTypes.ts'
import {
  beginSecretlessProviderAuth,
  finishSecretlessProviderAuth,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

const mineruHealthTimeoutMs = 10_000

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getMineruRoute = (baseURL: string, route: string): string => {
  return `${baseURL.replace(/\/+$/, '')}${route}`
}

const getMineruHealthError = async (response: Response): Promise<Error> => {
  const body = await response.text().catch(() => {
    return ''
  })

  return new Error(`MinerU health check failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`.trim())
}

export const getMineruServerVersion = async (baseURL: string | null): Promise<string> => {
  const normalizedBaseURL = getTrimmedValue(baseURL)

  if (!normalizedBaseURL) {
    throw new Error('MinerU base URL is required')
  }

  const response = await fetch(getMineruRoute(normalizedBaseURL, '/v1/health'), {
    signal: AbortSignal.timeout(mineruHealthTimeoutMs),
  }).catch(() => {
    return null
  })

  if (!response) {
    throw new Error('MinerU server did not respond at the configured base URL')
  }

  if (!response.ok) {
    throw await getMineruHealthError(response)
  }

  const body = (await response.json().catch(() => {
    return null
  })) as {status?: unknown; version?: unknown} | null
  const version = typeof body?.version === 'string' ? body.version.trim() : ''

  if (body?.status !== 'ok' || version === '') {
    throw new Error('MinerU /v1/health did not report status ok with a version')
  }

  return version
}

export const getMineruListedModel = (serverVersion: string): ProviderListedModel => {
  const listedModel = {
    displayName: `MinerU ${mineruConvertOptions.tier}`,
    metadataJson: null,
    modelName: `mineru-${mineruConvertOptions.tier}`,
    remoteModelId: `mineru-${mineruConvertOptions.tier}`,
    variant: null,
    version: serverVersion,
  }

  return {
    ...listedModel,
    metadataJson: {
      ...getNormalizedProviderModelMetadata({
        listedModel,
        providerKind: 'mineru',
        rawMetadata: null,
        source: 'provider',
      }),
      converter: {kind: 'mineru', serverVersion, tier: mineruConvertOptions.tier},
    },
  }
}

const getMineruHealth = async ({baseURL, label}: {baseURL: string | null; label: string}) => {
  try {
    const version = await getMineruServerVersion(baseURL)

    return getProviderHealthSuccess({message: `${label} ${version} connected`, modelCount: 1})
  } catch (error) {
    return getProviderHealthFailure(error)
  }
}

export const createMineruAdapter = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  return {
    beginAuth: async ({connection}) => {
      return beginSecretlessProviderAuth({catalog, connection})
    },
    catalog,
    finishAuth: async ({connection}) => {
      return finishSecretlessProviderAuth({catalog, connection})
    },
    health: async ({runtimeCredentials}) => {
      return getMineruHealth({baseURL: runtimeCredentials.baseURL, label: catalog.label})
    },
    invoke: async () => {
      throw new Error('MinerU provider does not support judgment invocation')
    },
    kind: catalog.kind,
    listModels: async ({runtimeCredentials}) => {
      return [getMineruListedModel(await getMineruServerVersion(runtimeCredentials.baseURL))]
    },
    resolveRuntimeCredentials: async ({connection}) => {
      return resolveSecretlessRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async ({runtimeCredentials}) => {
      return getMineruHealth({baseURL: runtimeCredentials.baseURL, label: catalog.label})
    },
    transportFamily: 'mineru-convert',
  }
}
