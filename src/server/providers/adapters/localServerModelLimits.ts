import {type ProviderListedModel} from '../providerTypes.ts'

type LocalServerModelLimits = {contextLength: number | null; supportsImageInput: boolean | null}

type LocalServerModelLimitsInput = {models: ProviderListedModel[]; rootURL: string}

const localServerLimitsTimeoutMs = 5_000

const getJsonRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getPositiveInteger = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

const fetchLocalServerJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  return fetch(url, {...init, signal: AbortSignal.timeout(localServerLimitsTimeoutMs)})
    .then((response) => {
      return response.ok ? response.json() : null
    })
    .catch(() => {
      return null
    })
}

const getServerRootURL = (baseURL: string): string => {
  return baseURL.trim().replace(/\/+$/u, '').replace(/\/v1$/u, '')
}

const applyLocalServerModelLimits = (
  listedModel: ProviderListedModel,
  limits: LocalServerModelLimits | null,
): ProviderListedModel => {
  const metadata = getJsonRecord(listedModel.metadataJson)
  const discovery = getJsonRecord(metadata?.discovery)
  const contextWindow = getJsonRecord(discovery?.contextWindow)
  const capabilities = getJsonRecord(discovery?.capabilities)

  return limits && metadata && discovery
    ? {
        ...listedModel,
        metadataJson: {
          ...metadata,
          discovery: {
            ...discovery,
            capabilities: {
              ...capabilities,
              ...(limits.supportsImageInput === null ? {} : {supportsImageInput: limits.supportsImageInput}),
            },
            contextWindow:
              limits.contextLength === null
                ? contextWindow
                : {
                    inputTokens: limits.contextLength,
                    outputTokens: contextWindow?.outputTokens ?? null,
                    totalTokens: limits.contextLength,
                  },
          },
        },
      }
    : listedModel
}

const getLlamaCppServerLimits = async (rootURL: string): Promise<LocalServerModelLimits | null> => {
  const props = getJsonRecord(await fetchLocalServerJson(`${rootURL}/props`))
  const vision = getJsonRecord(props?.modalities)?.vision

  return props
    ? {
        contextLength: getPositiveInteger(getJsonRecord(props.default_generation_settings)?.n_ctx),
        supportsImageInput: typeof vision === 'boolean' ? vision : null,
      }
    : null
}

const getLmStudioImageInputSupport = (type: unknown): boolean | null => {
  return type === 'vlm' ? true : type === 'llm' ? false : null
}

const getLmStudioModelLimitsById = async (rootURL: string): Promise<Map<string, LocalServerModelLimits>> => {
  const body = getJsonRecord(await fetchLocalServerJson(`${rootURL}/api/v0/models`))
  const entries = Array.isArray(body?.data) ? body.data : []

  return new Map(
    entries
      .map(getJsonRecord)
      .filter((entry): entry is Record<string, unknown> => {
        return typeof entry?.id === 'string'
      })
      .map((entry) => {
        return [
          String(entry.id),
          {
            contextLength: getPositiveInteger(entry.max_context_length),
            supportsImageInput: getLmStudioImageInputSupport(entry.type),
          },
        ] as const
      }),
  )
}

const getOllamaContextLength = (modelInfo: Record<string, unknown> | null): number | null => {
  return Object.entries(modelInfo ?? {}).reduce<number | null>((resolved, [key, value]) => {
    return resolved ?? (key.endsWith('.context_length') ? getPositiveInteger(value) : null)
  }, null)
}

const getOllamaModelLimits = async ({
  modelName,
  rootURL,
}: {
  modelName: string
  rootURL: string
}): Promise<LocalServerModelLimits | null> => {
  const body = getJsonRecord(
    await fetchLocalServerJson(`${rootURL}/api/show`, {
      body: JSON.stringify({model: modelName}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const capabilities = Array.isArray(body?.capabilities) ? body.capabilities : null

  return body
    ? {
        contextLength: getOllamaContextLength(getJsonRecord(body.model_info)),
        supportsImageInput: capabilities ? capabilities.includes('vision') : null,
      }
    : null
}

export const getLlamaCppPropsMissingContextMessage = (rootURL: string): string => {
  return `llama.cpp ${rootURL}/props did not report default_generation_settings.n_ctx, so the per-slot context window is unknown and the models were not refreshed. Check that llama-server runs at this base URL, then refresh the models.`
}

const addLlamaCppServerLimits = async ({models, rootURL}: LocalServerModelLimitsInput) => {
  const limits = await getLlamaCppServerLimits(rootURL)

  if (limits?.contextLength == null) {
    throw new Error(getLlamaCppPropsMissingContextMessage(rootURL))
  }

  return models.map((listedModel) => {
    return applyLocalServerModelLimits(listedModel, limits)
  })
}

const addLmStudioModelLimits = async ({models, rootURL}: LocalServerModelLimitsInput) => {
  const limitsById = await getLmStudioModelLimitsById(rootURL)

  return models.map((listedModel) => {
    return applyLocalServerModelLimits(listedModel, limitsById.get(listedModel.remoteModelId) ?? null)
  })
}

const addOllamaModelLimits = async ({models, rootURL}: LocalServerModelLimitsInput) => {
  return Promise.all(
    models.map(async (listedModel) => {
      return applyLocalServerModelLimits(
        listedModel,
        await getOllamaModelLimits({modelName: listedModel.remoteModelId, rootURL}),
      )
    }),
  )
}

const localServerModelLimitLoaders: Partial<
  Record<string, (input: LocalServerModelLimitsInput) => Promise<ProviderListedModel[]>>
> = {llamacpp: addLlamaCppServerLimits, llmstudio: addLmStudioModelLimits, ollama: addOllamaModelLimits}

export const addLocalServerModelLimits = async ({
  baseURL,
  models,
  providerKind,
}: {
  baseURL: string | null
  models: ProviderListedModel[]
  providerKind: string
}): Promise<ProviderListedModel[]> => {
  const loader = localServerModelLimitLoaders[providerKind]

  return loader && baseURL && models.length > 0 ? loader({models, rootURL: getServerRootURL(baseURL)}) : models
}
