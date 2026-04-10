import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, onCleanup, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button.tsx'
import {
  getProviderModelOptions,
  getProviderModelSupportedOptions,
  type ProviderModelOptions,
  type ProviderModelThinkingOption,
} from '../../../../utils/providerModelOptions.ts'
import {
  getComparableModelNames,
  getRuntimeModelNamesForProvider,
  hasRuntimeModelMatch,
} from '../../../../utils/providerRuntimeModelMatch.ts'
import {isQwen35Model} from '../../../../utils/qwen35Thinking.ts'
import {ProviderConnectionForm} from '../../+admin/+models/providerConnectionForm.tsx'
import {
  addManualProviderModel,
  type CodexDeviceLoginJob,
  deleteProviderConnection,
  ensureCodexProviderModel,
  fetchCodexLoginJob,
  fetchCodexStatus,
  fetchProviderConnectionDiscoveredModels,
  fetchProviderConnections,
  formatTimestamp,
  getNullableTrimmedValue,
  getProviderModelContextLength,
  getProviderModelDiscoverySource,
  getProviderModelReasoningEfforts,
  getProviderSecretStatus,
  getRuntimeWorkerUrlsForProvider,
  getTrimmedValue,
  getWorkerUrlsFromInputValue,
  getWorkerUrlsInputValue,
  type ProviderConnection,
  type ProviderListedModel,
  type ProviderModel,
  startCodexLogin,
  supportsRuntimeWorkerUrls,
  syncProviderConnectionModels,
  testProviderConnectionApi,
  updateProviderConnection,
  updateProviderModel,
} from '../../+admin/+models/providerConnectionsClient.ts'
import {getConnectionApiKeyUiState} from '../../+admin/+models/providerUiState.ts'
import {
  getProviderCatalogOptions,
  getProviderDisplayLabel,
  getProviderSelectionKind,
  shouldHideProviderBaseURLField,
} from '../providerCatalogUi.ts'
import {ProviderRuntimeStateCard} from '../providerRuntimeStateCard.tsx'

type ConnectionFormState = {
  apiKey: string
  baseURL: string
  enabled: boolean
  label: string
  manualWorkerUrls: string
  maxInflightRequests: string
  providerKind: string
  workerUrlMode: 'manual' | 'runtime'
}

type ManualModelFormState = {
  displayName: string
  remoteModelId: string
  thinking: ProviderModelThinkingOption
  variant: string
}

type ProviderPageModel = ProviderModel & {persistedId: string | null}
type ProviderPageModelDraft = ProviderPageModel & {
  displayNameValue: string
  thinkingValue: ProviderModelThinkingOption
  variantValue: string
}

const getTrimmedModelValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getNormalizedProviderKind = (value: string | null | undefined): string => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

const getMaxInflightRequestsInputValue = (value: number | null | undefined): string => {
  return value == null ? '' : String(value)
}

const getSubmittedMaxInflightRequests = (value: string): {error: string | null; value: number | null} => {
  const normalized = value.trim()

  if (normalized === '') {
    return {error: null, value: null}
  }

  const parsed = Number(normalized)

  return Number.isInteger(parsed) && parsed > 0
    ? {error: null, value: parsed}
    : {error: 'Prompts in Progress limit must be empty or a positive integer', value: null}
}

const getMaxInflightRequestsHelpText = (providerKind: string | null | undefined): string => {
  const normalizedProviderKind = getNormalizedProviderKind(providerKind)
  const isCodex = normalizedProviderKind === 'codex'
  const isRuntimeBacked = ['ollama', 'llmstudio', 'llamacpp', 'sglang', 'vllm'].includes(normalizedProviderKind)

  return isCodex
    ? 'Leave empty to use the provider-family default. Codex App falls back to `CODEX_MAX_INFLIGHT`.'
    : isRuntimeBacked
      ? "Leave empty to use the provider-family default. Runtime-backed providers fall back to the current runtime capacity when available, or Forska's global capacity when no runtime-backed limit is active."
      : "Leave empty to use the provider-family default. Codex App falls back to `CODEX_MAX_INFLIGHT`, and runtime-backed providers fall back to the current runtime capacity when available or Forska's global capacity."
}

const getProviderPageModelKey = ({
  modelName,
  remoteModelId,
  variant,
  version,
}: {
  modelName: string | null
  remoteModelId: string | null
  variant: string | null
  version: string | null
}) => {
  const normalizedModelName = getTrimmedModelValue(remoteModelId) ?? getTrimmedModelValue(modelName) ?? 'model'
  const normalizedVariant = getTrimmedModelValue(variant ?? version) ?? 'auto'

  return `${normalizedModelName}:${normalizedVariant}`
}

const stripCodexThinkingSuffix = (value: string | null | undefined): string => {
  const normalized = String(value ?? '').trim()
  const stripped = normalized.replace(/\s*\(thinking:[^)]+\)$/i, '').trim()

  return stripped || normalized
}

const getCodexModelDisplayName = (model: {
  displayName: string | null
  modelName: string | null
  name: string
  remoteModelId: string | null
}) => {
  return stripCodexThinkingSuffix(
    getTrimmedModelValue(model.remoteModelId)
      ?? getTrimmedModelValue(model.modelName)
      ?? getTrimmedModelValue(model.displayName)
      ?? model.name,
  )
}

const getCodexModelVariantLabel = (model: {variant: string | null; version: string | null}) => {
  return getTrimmedModelValue(model.variant ?? model.version) ?? 'auto'
}

const isQwen35ProviderModel = (model: {modelName: string | null; remoteModelId: string | null}) => {
  return isQwen35Model(getTrimmedModelValue(model.remoteModelId ?? model.modelName) ?? '')
}

const supportsProviderModelThinking = (model: {
  metadataJson: unknown
  modelName: string | null
  remoteModelId: string | null
}) => {
  return getProviderModelSupportedOptions(model.metadataJson).thinking || isQwen35ProviderModel(model)
}

const getProviderModelThinkingValue = (model: {
  metadataJson: unknown
  modelName: string | null
  remoteModelId: string | null
  variant: string | null
  version: string | null
}): ProviderModelThinkingOption => {
  const thinking =
    getProviderModelOptions(model.metadataJson).thinking
    ?? getProviderModelOptions({variant: model.variant ?? model.version}).thinking

  return thinking ?? 'disabled'
}

const getProviderPageModels = ({
  connection,
  discoveredCodexModels,
}: {
  connection: ProviderConnection | null
  discoveredCodexModels: ProviderListedModel[]
}): ProviderPageModel[] => {
  if (!connection) {
    return []
  }

  if (connection.providerKind !== 'codex') {
    return connection.models.map((model) => {
      return {...model, persistedId: model.id}
    })
  }

  const storedModelMap = new Map(
    connection.models.map((model) => {
      return [getProviderPageModelKey(model), model]
    }),
  )
  const discoveredKeys = new Set<string>()
  const discoveredModels = discoveredCodexModels.map((model) => {
    const modelKey = getProviderPageModelKey(model)
    const storedModel = storedModelMap.get(modelKey)

    discoveredKeys.add(modelKey)

    return {
      baseURL: storedModel?.baseURL ?? null,
      createdAt: storedModel?.createdAt ?? null,
      displayName: storedModel?.displayName ?? model.displayName,
      enabled: storedModel?.enabled ?? true,
      id: storedModel?.id ?? `codex:${modelKey}`,
      metadataJson: storedModel?.metadataJson ?? model.metadataJson,
      modelName: storedModel?.modelName ?? model.modelName,
      name: storedModel?.name ?? model.displayName,
      persistedId: storedModel?.id ?? null,
      provider: 'codex',
      providerConnectionId: storedModel?.providerConnectionId ?? connection.id,
      remoteModelId: storedModel?.remoteModelId ?? model.remoteModelId,
      source: storedModel?.source ?? 'discovered',
      updatedAt: storedModel?.updatedAt ?? null,
      variant: storedModel?.variant ?? model.variant,
      version: storedModel?.version ?? model.version,
    }
  })
  const storedOnlyModels = connection.models
    .filter((model) => {
      return !discoveredKeys.has(getProviderPageModelKey(model))
    })
    .map((model) => {
      return {...model, persistedId: model.id}
    })

  return discoveredModels.length > 0 ? [...discoveredModels, ...storedOnlyModels] : storedOnlyModels
}

const getProviderPageModelDraft = (model: ProviderPageModel): ProviderPageModelDraft => {
  return {
    ...model,
    displayNameValue: model.displayName ?? model.name,
    thinkingValue: getProviderModelThinkingValue(model),
    variantValue: model.variant ?? '',
  }
}

const hasProviderPageModelDraftChanges = ({
  draft,
  source,
}: {
  draft: ProviderPageModelDraft
  source: ProviderPageModel | undefined
}) => {
  return source
    ? draft.provider === 'codex'
      ? draft.enabled !== source.enabled
      : draft.enabled !== source.enabled
        || draft.displayNameValue !== (source.displayName ?? source.name)
        || draft.thinkingValue !== getProviderModelThinkingValue(source)
        || draft.variantValue !== (source.variant ?? '')
    : false
}

const getConnectionFormState = (connection: ProviderConnection | null): ConnectionFormState => {
  return {
    apiKey: '',
    baseURL: connection?.baseURL ?? '',
    enabled: connection?.enabled ?? true,
    label: connection?.label ?? '',
    manualWorkerUrls: getWorkerUrlsInputValue(connection?.config.manualWorkerUrls ?? []),
    maxInflightRequests: getMaxInflightRequestsInputValue(connection?.maxInflightRequests),
    providerKind: connection?.providerKind ?? 'openai',
    workerUrlMode: connection?.config.workerUrlMode ?? 'manual',
  }
}

const getEmptyManualModelFormState = (): ManualModelFormState => {
  return {displayName: '', remoteModelId: '', thinking: 'disabled', variant: ''}
}

const getSubmittedModelOptions = ({
  supportsThinking,
  thinkingValue,
}: {
  supportsThinking: boolean
  thinkingValue: ProviderModelThinkingOption
}): ProviderModelOptions | undefined => {
  return supportsThinking ? {thinking: thinkingValue} : undefined
}

const ProviderDetailPage = () => {
  const params = Route.useParams()
  const navigate = useNavigate()
  const providerId = () => {
    return (params() as {id: string}).id
  }
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryKey: ['provider-connections', providerId()],
      queryFn: fetchProviderConnections,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30,
      suspense: false,
    }
  })
  const [loadedConnectionId, setLoadedConnectionId] = createSignal<string | null>(null)
  const [connectionForm, setConnectionForm] = createStore<ConnectionFormState>(getConnectionFormState(null))
  const [manualModelForm, setManualModelForm] = createStore<ManualModelFormState>(getEmptyManualModelFormState())
  const [pageMessage, setPageMessage] = createSignal('')
  const [pageError, setPageError] = createSignal('')
  const [modelDrafts, setModelDrafts] = createSignal<ProviderPageModelDraft[]>([])
  const [loadedModelDraftKey, setLoadedModelDraftKey] = createSignal('')
  const [codexLoginJobId, setCodexLoginJobId] = createSignal<string | null>(null)
  const [codexLoginJob, setCodexLoginJob] = createSignal<CodexDeviceLoginJob | null>(null)
  const [isStartingCodexLogin, setIsStartingCodexLogin] = createSignal(false)
  const [codexLoginError, setCodexLoginError] = createSignal('')

  const updateConnectionMutation = createMutation(() => {
    return {
      mutationFn: updateProviderConnection,
      onSuccess: async (connection: ProviderConnection) => {
        setPageError('')
        setPageMessage(`Updated ${connection.label}`)
        setConnectionForm(getConnectionFormState(connection))
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const testConnectionMutation = createMutation(() => {
    return {
      mutationFn: testProviderConnectionApi,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(result.message)
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const syncConnectionMutation = createMutation(() => {
    return {
      mutationFn: syncProviderConnectionModels,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(`Synced ${result.count} models`)
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const deleteConnectionMutation = createMutation(() => {
    return {
      mutationFn: deleteProviderConnection,
      onSuccess: async () => {
        await providerConnectionsQuery.refetch()
        void navigate({to: '/providers' as never})
      },
    }
  })
  const addManualModelMutation = createMutation(() => {
    return {
      mutationFn: addManualProviderModel,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(`Added model ${result.modelId}`)
        setManualModelForm(getEmptyManualModelFormState())
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const updateModelMutation = createMutation(() => {
    return {mutationFn: updateProviderModel}
  })

  const connections = () => {
    return providerConnectionsQuery.data?.connections ?? []
  }

  const catalog = () => {
    return providerConnectionsQuery.data?.catalog ?? []
  }

  const catalogOptions = () => {
    return getProviderCatalogOptions(catalog())
  }

  const runtime = () => {
    return providerConnectionsQuery.data?.runtime ?? null
  }

  const selectedConnection = () => {
    return (
      connections().find((connection) => {
        return connection.id === providerId()
      }) ?? null
    )
  }

  const activeCatalogOption = () => {
    const connection = selectedConnection()

    return (
      catalogOptions().find((entry) => {
        return (
          entry.selectedKind
          === getProviderSelectionKind({config: connection?.config, providerKind: connection?.providerKind})
        )
      }) ?? null
    )
  }

  const activeRuntimeWorkerUrls = () => {
    return getRuntimeWorkerUrlsForProvider({providerKind: connectionForm.providerKind, runtime: runtime()})
  }

  const shouldShowConnectionApiKeyField = () => {
    const connection = selectedConnection()

    return connection
      ? getConnectionApiKeyUiState({hasSecret: connection.hasSecret, providerKind: connection.providerKind})
          .shouldShowField
      : false
  }

  const isOptionalConnectionApiKey = () => {
    const connection = selectedConnection()

    return connection
      ? getConnectionApiKeyUiState({hasSecret: connection.hasSecret, providerKind: connection.providerKind}).isOptional
      : false
  }

  const getConnectionProviderLabel = (connection: ProviderConnection) => {
    return getProviderDisplayLabel({
      catalog: catalog(),
      config: connection.config,
      providerKind: connection.providerKind,
    })
  }

  const codexStatusQuery = useQuery(() => {
    return {
      enabled: selectedConnection()?.providerKind === 'codex',
      queryKey: ['codex-status', selectedConnection()?.id ?? 'none'],
      queryFn: fetchCodexStatus,
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })
  const codexDiscoveredModelsQuery = useQuery(() => {
    return {
      enabled: selectedConnection()?.providerKind === 'codex',
      queryKey: ['provider-connection-discovered-models', selectedConnection()?.id ?? 'none'],
      queryFn: async () => {
        const connectionId = selectedConnection()?.id

        return connectionId ? fetchProviderConnectionDiscoveredModels(connectionId) : []
      },
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })

  createEffect(() => {
    const connection = selectedConnection()

    if (!connection || loadedConnectionId() === connection.id) {
      return
    }

    setLoadedConnectionId(connection.id)
    setConnectionForm(getConnectionFormState(connection))
    setManualModelForm(getEmptyManualModelFormState())
    setPageError('')
    setPageMessage('')
  })

  createEffect(() => {
    const jobId = codexLoginJobId()
    const job = codexLoginJob()
    const isRunning = Boolean(jobId && job?.state === 'running')

    if (!jobId || !isRunning) {
      return
    }

    const interval = setInterval(() => {
      void fetchCodexLoginJob(jobId)
        .then((updated) => {
          setCodexLoginJob(updated)
          if (updated.state !== 'running') {
            void codexStatusQuery.refetch()
          }
        })
        .catch((error) => {
          setCodexLoginError(error instanceof Error ? error.message : 'Failed to fetch Codex login job')
        })
    }, 1000)

    onCleanup(() => {
      clearInterval(interval)
    })
  })

  const submitConnectionForm = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    const maxInflightRequests = getSubmittedMaxInflightRequests(connectionForm.maxInflightRequests)

    if (maxInflightRequests.error) {
      setPageError(maxInflightRequests.error)
      return
    }

    try {
      await updateConnectionMutation.mutateAsync({
        apiKey: getTrimmedValue(connectionForm.apiKey) || undefined,
        baseURL: getNullableTrimmedValue(connectionForm.baseURL),
        enabled: connectionForm.enabled,
        id: connection.id,
        label: connectionForm.label,
        llamaCppMode: connection.config.llamaCppMode,
        manualWorkerUrls: getWorkerUrlsFromInputValue(connectionForm.manualWorkerUrls),
        maxInflightRequests: maxInflightRequests.value,
        workerUrlMode: connectionForm.workerUrlMode,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to save provider connection')
    }
  }

  const clearStoredSecret = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await updateConnectionMutation.mutateAsync({
        baseURL: connection.baseURL,
        clearSecret: true,
        enabled: connection.enabled,
        id: connection.id,
        label: connection.label,
        llamaCppMode: connection.config.llamaCppMode,
        manualWorkerUrls: connection.config.manualWorkerUrls,
        workerUrlMode: connection.config.workerUrlMode,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to clear provider secret')
    }
  }

  const runConnectionTest = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await testConnectionMutation.mutateAsync(connection.id)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to test provider connection')
    }
  }

  const runConnectionSync = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await syncConnectionMutation.mutateAsync(connection.id)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to sync provider models')
    }
  }

  const removeProviderConnection = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    const confirmed = globalThis.confirm(
      `Remove ${connection.label}? Unreferenced models are deleted. If any models are still used by projects, comparison projects, or judgments, this provider is archived instead so old results remain reviewable.`,
    )

    if (!confirmed) {
      return
    }

    try {
      await deleteConnectionMutation.mutateAsync(connection.id)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to remove provider connection')
    }
  }

  const submitManualModel = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await addManualModelMutation.mutateAsync({
        displayName: getTrimmedValue(manualModelForm.displayName) || undefined,
        id: connection.id,
        options: getSubmittedModelOptions({
          supportsThinking: isQwen35Model(manualModelForm.remoteModelId),
          thinkingValue: manualModelForm.thinking,
        }),
        remoteModelId: manualModelForm.remoteModelId,
        variant: getTrimmedValue(manualModelForm.variant) || undefined,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to add manual model')
    }
  }

  const isCodexConnection = () => {
    return selectedConnection()?.providerKind === 'codex'
  }

  const providerModels = () => {
    return getProviderPageModels({
      connection: selectedConnection(),
      discoveredCodexModels: codexDiscoveredModelsQuery.data ?? [],
    })
  }

  const providerModelSourceMap = createMemo(() => {
    return new Map(
      providerModels().map((model) => {
        return [model.id, model]
      }),
    )
  })

  const hasModelDraftChanges = createMemo(() => {
    const sourceMap = providerModelSourceMap()

    return modelDrafts().some((draft) => {
      return hasProviderPageModelDraftChanges({draft, source: sourceMap.get(draft.id)})
    })
  })

  const allModelDraftsEnabled = createMemo(() => {
    return (
      modelDrafts().length > 0
      && modelDrafts().every((draft) => {
        return draft.enabled
      })
    )
  })

  const noModelDraftsEnabled = createMemo(() => {
    return modelDrafts().every((draft) => {
      return !draft.enabled
    })
  })

  const selectedConnectionRuntimeModelNames = createMemo(() => {
    return getRuntimeModelNamesForProvider({providerKind: selectedConnection()?.providerKind, runtime: runtime()})
  })

  const selectedConnectionUsesActiveRuntime = createMemo(() => {
    return (
      getNormalizedProviderKind(selectedConnection()?.providerKind)
      === getNormalizedProviderKind(runtime()?.providerKind)
    )
  })

  const currentEnabledModelNames = createMemo(() => {
    const sourceModels = modelDrafts().length > 0 ? modelDrafts() : providerModels()

    return getComparableModelNames(
      sourceModels
        .filter((draft) => {
          return draft.enabled
        })
        .flatMap((draft) => {
          return [draft.remoteModelId, draft.modelName]
        }),
    )
  })

  const selectedConnectionRuntimeBanner = createMemo(() => {
    const connection = selectedConnection()
    const runtimeModelNames = selectedConnectionRuntimeModelNames()
    const runtimeLabel = runtimeModelNames.join(', ')

    if (!connection || connection.providerKind !== 'sglang' || !selectedConnectionUsesActiveRuntime()) {
      return null
    }

    if (runtimeModelNames.length === 0) {
      return {
        className: 'mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900',
        message:
          'Launcher runtime is active for this SGLang connection, but its model name is unavailable. Job start still checks the live runtime before running.',
      }
    }

    return hasRuntimeModelMatch({
      candidateModelNames: currentEnabledModelNames(),
      providerKind: connection.providerKind,
      runtime: runtime(),
    })
      ? {
          className: 'mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900',
          message: `Active SGLang runtime model: ${runtimeLabel}.`,
        }
      : {
          className: 'mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900',
          message: `Active SGLang runtime model: ${runtimeLabel}. None of this connection's enabled models match, so project runs will be blocked until they do.`,
        }
  })

  createEffect(() => {
    const models = providerModels()
    const draftKey = [
      selectedConnection()?.id ?? 'none',
      ...models.map((model) => {
        return `${model.id}:${model.enabled}:${model.displayName ?? model.name}:${model.variant ?? ''}:${getProviderModelThinkingValue(model)}:${model.persistedId ?? ''}`
      }),
    ].join('|')

    if (loadedModelDraftKey() === draftKey) {
      return
    }

    setLoadedModelDraftKey(draftKey)
    setModelDrafts(models.map(getProviderPageModelDraft))
  })

  const updateModelDraft = ({
    id,
    updates,
  }: {
    id: string
    updates: Partial<Pick<ProviderPageModelDraft, 'displayNameValue' | 'enabled' | 'thinkingValue' | 'variantValue'>>
  }) => {
    setModelDrafts((drafts) => {
      return drafts.map((draft) => {
        return draft.id === id ? {...draft, ...updates} : draft
      })
    })
  }

  const setAllModelDraftsEnabled = (enabled: boolean) => {
    setModelDrafts((drafts) => {
      return drafts.map((draft) => {
        return {...draft, enabled}
      })
    })
  }

  const submitModelsForm = async (event: Event) => {
    event.preventDefault()
    setPageError('')
    setPageMessage('')
    const sourceMap = providerModelSourceMap()
    const changedDrafts = modelDrafts().filter((draft) => {
      return hasProviderPageModelDraftChanges({draft, source: sourceMap.get(draft.id)})
    })

    if (changedDrafts.length === 0) {
      setPageMessage('No model changes to save')
      return
    }

    try {
      await Promise.all(
        changedDrafts.map(async (draft) => {
          const persistedModelId =
            draft.persistedId
            ?? (draft.provider === 'codex'
              ? await ensureCodexProviderModel({
                  modelName: getTrimmedModelValue(draft.remoteModelId ?? draft.modelName) ?? draft.name,
                  name: draft.displayNameValue,
                  version: getTrimmedModelValue(draft.variant ?? draft.version) ?? undefined,
                })
              : draft.id)

          return updateModelMutation.mutateAsync({
            displayName: draft.displayNameValue,
            enabled: draft.enabled,
            id: persistedModelId,
            options: getSubmittedModelOptions({
              supportsThinking: supportsProviderModelThinking(draft),
              thinkingValue: draft.thinkingValue,
            }),
            variant:
              draft.provider === 'codex'
                ? (getTrimmedModelValue(draft.variant ?? draft.version) ?? undefined)
                : (getTrimmedModelValue(draft.variantValue) ?? undefined),
          })
        }),
      )
      await providerConnectionsQuery.refetch()

      if (isCodexConnection()) {
        await codexDiscoveredModelsQuery.refetch()
      }

      setPageMessage(
        changedDrafts.length === 1 ? 'Saved 1 model change' : `Saved ${changedDrafts.length} model changes`,
      )
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to update models')
    }
  }

  const startCodexDeviceLogin = async () => {
    setIsStartingCodexLogin(true)
    setCodexLoginError('')

    try {
      const result = await startCodexLogin()
      if (!result.job) {
        await codexStatusQuery.refetch()
        return
      }

      setCodexLoginJobId(result.job.id)
      setCodexLoginJob(result.job)
    } catch (error) {
      setCodexLoginError(error instanceof Error ? error.message : 'Failed to start Codex login')
    } finally {
      setIsStartingCodexLogin(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="mx-auto max-w-7xl space-y-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-sm font-medium uppercase tracking-wide text-gray-500">Provider</p>
            <h1 class="text-2xl font-bold text-gray-900">
              {selectedConnection()?.label
                ?? getProviderDisplayLabel({catalog: catalog(), providerKind: connectionForm.providerKind})}
            </h1>
            <p class="text-sm text-gray-500">
              Manage provider settings here, then choose which models stay enabled for this provider.
            </p>
          </div>
          <Button as={Link} to={'/providers' as never} variant="outline">
            Back to Providers
          </Button>
        </div>

        <Show when={pageMessage()}>
          <div class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {pageMessage()}
          </div>
        </Show>

        <Show when={pageError()}>
          <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{pageError()}</div>
        </Show>

        <Show when={providerConnectionsQuery.isLoading}>
          <div class="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
            Loading provider...
          </div>
        </Show>

        <Show when={providerConnectionsQuery.isError}>
          <div class="rounded-lg border border-red-200 bg-red-50 p-4">
            <p class="text-red-600">Failed to load provider</p>
            <Button
              class="mt-2"
              onClick={() => {
                return void providerConnectionsQuery.refetch()
              }}
            >
              Retry
            </Button>
          </div>
        </Show>

        <Show
          when={!providerConnectionsQuery.isLoading && !providerConnectionsQuery.isError && selectedConnection()}
          fallback={
            <Show when={!providerConnectionsQuery.isLoading && !providerConnectionsQuery.isError}>
              <div class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <h2 class="text-lg font-semibold text-gray-900">Provider Not Found</h2>
                <p class="mt-2 text-sm text-gray-500">
                  This provider connection does not exist anymore or has been removed.
                </p>
                <Button as={Link} class="mt-4" to={'/providers' as never} variant="outline">
                  Back to Providers
                </Button>
              </div>
            </Show>
          }
        >
          {(connection) => {
            return (
              <div class="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                <div class="space-y-6">
                  <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div class="mb-4 flex items-start justify-between gap-3">
                      <div>
                        <h2 class="text-lg font-semibold text-gray-900">Edit Provider</h2>
                        <p class="text-sm text-gray-500">
                          Update provider settings, stored secrets, and runtime config.
                        </p>
                      </div>
                      <span class="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-600">
                        {getConnectionProviderLabel(connection())}
                      </span>
                    </div>

                    <div class="mb-4">
                      <ProviderRuntimeStateCard connection={connection()} title="Matched runtime status" />
                    </div>

                    <div class="space-y-4">
                      <ProviderConnectionForm
                        apiKeyOptional={isOptionalConnectionApiKey()}
                        hasStoredSecret={connection().hasSecret}
                        kind={connection().providerKind}
                        onApiKeyChange={(value) => {
                          setConnectionForm('apiKey', value)
                        }}
                        onBaseURLChange={(value) => {
                          setConnectionForm('baseURL', value)
                        }}
                        onClearStoredSecret={() => {
                          return void clearStoredSecret()
                        }}
                        onEnabledChange={(value) => {
                          setConnectionForm('enabled', value)
                        }}
                        onLabelChange={(value) => {
                          setConnectionForm('label', value)
                        }}
                        onWorkerUrlModeChange={(value) => {
                          setConnectionForm('workerUrlMode', value)
                        }}
                        onWorkerUrlsChange={(value) => {
                          setConnectionForm('manualWorkerUrls', value)
                        }}
                        providerLabel={activeCatalogOption()?.label ?? getConnectionProviderLabel(connection())}
                        runtimeWorkerUrls={activeRuntimeWorkerUrls()}
                        secretStatus={getProviderSecretStatus(connection())}
                        showApiKeyField={shouldShowConnectionApiKeyField()}
                        showBaseURLField={
                          !shouldHideProviderBaseURLField({
                            config: connection().config,
                            providerKind: connection().providerKind,
                          })
                        }
                        showEnabledToggle={true}
                        supportsRuntimeWorkerUrls={supportsRuntimeWorkerUrls(connection().providerKind)}
                        supportsWorkerUrls={Boolean(activeCatalogOption()?.supportsWorkerUrls)}
                        values={connectionForm}
                      />

                      <div class="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4">
                        <label class="block text-sm font-medium text-gray-900" for="provider-max-inflight-requests">
                          Prompts in Progress limit
                        </label>
                        <input
                          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                          id="provider-max-inflight-requests"
                          inputMode="numeric"
                          min="1"
                          onInput={(event) => {
                            setConnectionForm('maxInflightRequests', event.currentTarget.value)
                          }}
                          placeholder="Default"
                          step="1"
                          type="number"
                          value={connectionForm.maxInflightRequests}
                        />
                        <p class="text-sm text-gray-600">{getMaxInflightRequestsHelpText(connection().providerKind)}</p>
                      </div>

                      <Show
                        when={
                          supportsRuntimeWorkerUrls(connection().providerKind)
                          && connectionForm.workerUrlMode === 'runtime'
                        }
                      >
                        <div
                          class={`rounded-lg border px-4 py-3 text-sm ${activeRuntimeWorkerUrls().length > 0 ? 'border-blue-200 bg-blue-50 text-blue-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                        >
                          <p class="font-medium">Runtime-only worker routing</p>
                          <p class="mt-1">
                            This connection ignores saved manual worker URLs and uses only launcher-discovered runtime
                            worker URLs for the current server session.
                          </p>
                          <p class="mt-1 break-words">
                            Active runtime URLs:{' '}
                            {activeRuntimeWorkerUrls().length > 0
                              ? activeRuntimeWorkerUrls().join(', ')
                              : 'none detected'}
                          </p>
                          <p class="mt-1 text-xs opacity-80">
                            The saved base URL still stays in provider config, but runtime worker URLs become the active
                            endpoint for requests, tests, and model discovery when available.
                          </p>
                        </div>
                      </Show>

                      <div class="flex flex-wrap gap-3">
                        <button
                          class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={updateConnectionMutation.isPending}
                          onClick={() => {
                            return void submitConnectionForm()
                          }}
                          type="button"
                        >
                          {updateConnectionMutation.isPending ? 'Saving...' : 'Save Provider'}
                        </button>
                        <button
                          class="rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={testConnectionMutation.isPending}
                          onClick={() => {
                            return void runConnectionTest()
                          }}
                          type="button"
                        >
                          {testConnectionMutation.isPending ? 'Testing...' : 'Test'}
                        </button>
                        <button
                          class="rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={syncConnectionMutation.isPending || !activeCatalogOption()?.supportsDiscovery}
                          onClick={() => {
                            return void runConnectionSync()
                          }}
                          type="button"
                        >
                          {syncConnectionMutation.isPending ? 'Syncing...' : 'Sync Models'}
                        </button>
                        <button
                          class="rounded-md border border-red-200 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={deleteConnectionMutation.isPending}
                          onClick={() => {
                            return void removeProviderConnection()
                          }}
                          type="button"
                        >
                          {deleteConnectionMutation.isPending ? 'Removing...' : 'Remove'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <Show when={connection().providerKind === 'codex'}>
                    <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                      <h2 class="text-lg font-semibold text-gray-900">Codex Login</h2>
                      <div class="mt-4 space-y-3 text-sm text-gray-700">
                        <Show when={codexStatusQuery.isLoading}>
                          <p class="text-gray-500">Checking Codex status...</p>
                        </Show>
                        <Show when={codexStatusQuery.data}>
                          <div>
                            <span class="font-medium">Login:</span>{' '}
                            <span class={codexStatusQuery.data?.cli.loggedIn ? 'text-green-700' : 'text-amber-700'}>
                              {codexStatusQuery.data?.cli.loggedIn
                                ? `Logged in${codexStatusQuery.data?.cli.method ? ` (${codexStatusQuery.data?.cli.method})` : ''}`
                                : 'Not logged in'}
                            </span>
                          </div>
                          <div>
                            <span class="font-medium">App-server:</span>{' '}
                            <span class={codexStatusQuery.data?.appServerReady ? 'text-green-700' : 'text-amber-700'}>
                              {codexStatusQuery.data?.appServerReady ? 'Ready' : 'Not ready'}
                            </span>
                          </div>
                          <p class="break-all font-mono text-xs text-gray-500">{codexStatusQuery.data?.codexBin}</p>
                          <p class="text-xs text-gray-500">{codexStatusQuery.data?.message}</p>
                        </Show>

                        <Show when={!codexStatusQuery.data?.cli.loggedIn}>
                          <button
                            class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isStartingCodexLogin()}
                            onClick={() => {
                              return void startCodexDeviceLogin()
                            }}
                            type="button"
                          >
                            {isStartingCodexLogin() ? 'Starting Codex Login...' : 'Sign in to Codex'}
                          </button>
                        </Show>

                        <Show when={codexLoginError()}>
                          <p class="text-sm text-red-600">{codexLoginError()}</p>
                        </Show>

                        <Show when={codexLoginJob()}>
                          <div class="rounded-md border border-gray-200 bg-gray-50 p-4">
                            <p class="mb-2 text-sm font-medium text-gray-900">Device login</p>
                            <Show when={codexLoginJob()?.deviceUrl}>
                              <p class="text-sm text-gray-700">
                                Open:{' '}
                                <a
                                  class="text-blue-700 underline"
                                  href={codexLoginJob()?.deviceUrl ?? '#'}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  {codexLoginJob()?.deviceUrl}
                                </a>
                              </p>
                            </Show>
                            <Show when={codexLoginJob()?.deviceCode}>
                              <p class="text-sm text-gray-700">
                                Code: <span class="font-mono">{codexLoginJob()?.deviceCode}</span>
                              </p>
                            </Show>
                            <pre class="mt-3 whitespace-pre-wrap font-mono text-xs text-gray-800">
                              {codexLoginJob()?.output.join('\n')}
                            </pre>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </Show>

                  <Show when={!isCodexConnection()}>
                    <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                      <h2 class="text-lg font-semibold text-gray-900">Add Model</h2>
                      <p class="mt-1 text-sm text-gray-500">
                        Adding models is separate from adding providers. Use this after the provider connection already
                        exists.
                      </p>
                      <div class="mt-4 space-y-4">
                        <div>
                          <label class="mb-2 block text-sm font-medium text-gray-700">Remote Model ID</label>
                          <input
                            class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                            onInput={(event) => {
                              setManualModelForm('remoteModelId', event.currentTarget.value)
                            }}
                            type="text"
                            value={manualModelForm.remoteModelId}
                          />
                        </div>
                        <div>
                          <label class="mb-2 block text-sm font-medium text-gray-700">Display Name</label>
                          <input
                            class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                            onInput={(event) => {
                              setManualModelForm('displayName', event.currentTarget.value)
                            }}
                            placeholder="Optional"
                            type="text"
                            value={manualModelForm.displayName}
                          />
                        </div>
                        <Show
                          when={isQwen35Model(manualModelForm.remoteModelId)}
                          fallback={
                            <div>
                              <label class="mb-2 block text-sm font-medium text-gray-700">Variant</label>
                              <input
                                class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                                onInput={(event) => {
                                  setManualModelForm('variant', event.currentTarget.value)
                                }}
                                placeholder="Optional"
                                type="text"
                                value={manualModelForm.variant}
                              />
                            </div>
                          }
                        >
                          <div>
                            <label class="mb-2 block text-sm font-medium text-gray-700">Thinking</label>
                            <select
                              class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                              onChange={(event) => {
                                setManualModelForm('thinking', event.currentTarget.value as ProviderModelThinkingOption)
                              }}
                              value={manualModelForm.thinking}
                            >
                              <option value="disabled">Disabled</option>
                              <option value="enabled">Enabled</option>
                            </select>
                          </div>
                        </Show>
                        <button
                          class="rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={addManualModelMutation.isPending}
                          onClick={() => {
                            return void submitManualModel()
                          }}
                          type="button"
                        >
                          {addManualModelMutation.isPending ? 'Adding...' : 'Add Model'}
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>

                <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div class="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h2 class="text-lg font-semibold text-gray-900">Models</h2>
                      <p class="text-sm text-gray-500">
                        {isCodexConnection()
                          ? 'Enable or disable the models and reasoning variants currently available from Codex App.'
                          : 'Enable, disable, rename, and configure the models available on this provider.'}
                      </p>
                    </div>
                    <div class="text-xs font-medium uppercase tracking-wide text-gray-500">
                      {modelDrafts().length} total
                    </div>
                  </div>

                  <Show
                    when={isCodexConnection() && codexDiscoveredModelsQuery.isLoading && providerModels().length === 0}
                  >
                    <div class="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
                      Loading Codex models...
                    </div>
                  </Show>

                  <Show when={isCodexConnection() && codexDiscoveredModelsQuery.isError}>
                    <div class="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                      {codexDiscoveredModelsQuery.error instanceof Error
                        ? codexDiscoveredModelsQuery.error.message
                        : 'Failed to load the live Codex model catalog. Showing saved models only.'}
                    </div>
                  </Show>

                  <Show when={selectedConnectionRuntimeBanner()}>
                    {(banner) => {
                      return <div class={banner().className}>{banner().message}</div>
                    }}
                  </Show>

                  <Show
                    when={modelDrafts().length > 0}
                    fallback={
                      <div class="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
                        {isCodexConnection()
                          ? 'No Codex models are available right now.'
                          : 'No models yet. Use sync or add a manual model for this provider.'}
                      </div>
                    }
                  >
                    <form
                      class="space-y-4"
                      onSubmit={(event) => {
                        return void submitModelsForm(event)
                      }}
                    >
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p class="text-sm text-gray-500">
                          {hasModelDraftChanges() ? 'You have unsaved model changes.' : 'No unsaved model changes.'}
                        </p>
                        <div class="flex flex-wrap gap-2">
                          <button
                            class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={modelDrafts().length === 0 || allModelDraftsEnabled()}
                            onClick={() => {
                              return setAllModelDraftsEnabled(true)
                            }}
                            type="button"
                          >
                            Select all
                          </button>
                          <button
                            class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={modelDrafts().length === 0 || noModelDraftsEnabled()}
                            onClick={() => {
                              return setAllModelDraftsEnabled(false)
                            }}
                            type="button"
                          >
                            Deselect all
                          </button>
                          <button
                            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={updateModelMutation.isPending || !hasModelDraftChanges()}
                            type="submit"
                          >
                            {updateModelMutation.isPending ? 'Saving...' : 'Save Models'}
                          </button>
                        </div>
                      </div>

                      <div class="overflow-x-auto rounded-lg border border-gray-200">
                        <Show
                          when={isCodexConnection()}
                          fallback={
                            <table class="min-w-full divide-y divide-gray-200 text-sm">
                              <thead class="bg-gray-50">
                                <tr>
                                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                    Model
                                  </th>
                                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                    Variant / Options
                                  </th>
                                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                    Enabled
                                  </th>
                                </tr>
                              </thead>
                              <tbody class="divide-y divide-gray-200 bg-white">
                                <For each={modelDrafts()}>
                                  {(model) => {
                                    return (
                                      <tr>
                                        <td class="px-4 py-3 align-top">
                                          <input
                                            class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
                                            onInput={(event) => {
                                              return updateModelDraft({
                                                id: model.id,
                                                updates: {displayNameValue: event.currentTarget.value},
                                              })
                                            }}
                                            type="text"
                                            value={model.displayNameValue}
                                          />
                                          <div class="mt-2 text-xs text-gray-500">
                                            {model.remoteModelId ?? model.modelName ?? '-'} • {model.source ?? 'manual'}
                                          </div>
                                          <Show when={getProviderModelContextLength(model.metadataJson)}>
                                            <div class="mt-1 text-xs text-gray-500">
                                              Context {getProviderModelContextLength(model.metadataJson)} tokens
                                            </div>
                                          </Show>
                                          <Show when={getProviderModelDiscoverySource(model.metadataJson)}>
                                            <div class="mt-1 text-xs text-gray-500">
                                              Discovery {getProviderModelDiscoverySource(model.metadataJson)}
                                            </div>
                                          </Show>
                                          <Show when={getProviderModelReasoningEfforts(model.metadataJson).length > 0}>
                                            <div class="mt-1 text-xs text-gray-500">
                                              Reasoning{' '}
                                              {getProviderModelReasoningEfforts(model.metadataJson).join(', ')}
                                            </div>
                                          </Show>
                                        </td>
                                        <td class="px-4 py-3 align-top">
                                          <input
                                            class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
                                            onInput={(event) => {
                                              return updateModelDraft({
                                                id: model.id,
                                                updates: {variantValue: event.currentTarget.value},
                                              })
                                            }}
                                            type="text"
                                            value={model.variantValue}
                                          />
                                          <Show when={supportsProviderModelThinking(model)}>
                                            <div class="mt-2">
                                              <label class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                                                Thinking
                                              </label>
                                              <select
                                                class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
                                                onChange={(event) => {
                                                  return updateModelDraft({
                                                    id: model.id,
                                                    updates: {
                                                      thinkingValue: event.currentTarget
                                                        .value as ProviderModelThinkingOption,
                                                    },
                                                  })
                                                }}
                                                value={model.thinkingValue}
                                              >
                                                <option value="disabled">Disabled</option>
                                                <option value="enabled">Enabled</option>
                                              </select>
                                            </div>
                                          </Show>
                                          <div class="mt-2 text-xs text-gray-500">
                                            Created {formatTimestamp(model.createdAt)}
                                          </div>
                                        </td>
                                        <td class="px-4 py-3 align-top">
                                          <label class="inline-flex items-center gap-2 text-sm text-gray-700">
                                            <input
                                              checked={model.enabled}
                                              onChange={(event) => {
                                                return updateModelDraft({
                                                  id: model.id,
                                                  updates: {enabled: event.currentTarget.checked},
                                                })
                                              }}
                                              type="checkbox"
                                            />
                                            Enabled
                                          </label>
                                        </td>
                                      </tr>
                                    )
                                  }}
                                </For>
                              </tbody>
                            </table>
                          }
                        >
                          <table class="min-w-full divide-y divide-gray-200 text-sm">
                            <thead class="bg-gray-50">
                              <tr>
                                <th class="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                  Model
                                </th>
                                <th class="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                  Thinking
                                </th>
                                <th class="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                  Enabled
                                </th>
                              </tr>
                            </thead>
                            <tbody class="divide-y divide-gray-200 bg-white">
                              <For each={modelDrafts()}>
                                {(model) => {
                                  return (
                                    <tr>
                                      <td class="px-4 py-2 align-middle text-sm text-gray-900">
                                        <div class="flex items-center gap-2">
                                          <span
                                            class="font-medium"
                                            title={model.remoteModelId ?? model.modelName ?? model.name}
                                          >
                                            {getCodexModelDisplayName(model)}
                                          </span>
                                          <Show when={model.persistedId}>
                                            <span class="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                                              Saved
                                            </span>
                                          </Show>
                                        </div>
                                      </td>
                                      <td class="px-4 py-2 align-middle">
                                        <span class="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-blue-700">
                                          {getCodexModelVariantLabel(model)}
                                        </span>
                                      </td>
                                      <td class="px-4 py-2 align-middle">
                                        <label class="inline-flex items-center gap-2 text-sm text-gray-700">
                                          <input
                                            checked={model.enabled}
                                            onChange={(event) => {
                                              return updateModelDraft({
                                                id: model.id,
                                                updates: {enabled: event.currentTarget.checked},
                                              })
                                            }}
                                            type="checkbox"
                                          />
                                          Enabled
                                        </label>
                                      </td>
                                    </tr>
                                  )
                                }}
                              </For>
                            </tbody>
                          </table>
                        </Show>
                      </div>
                    </form>
                  </Show>
                </div>
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/providers/$id/' as never)({component: ProviderDetailPage})
