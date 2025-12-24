import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Match, Show, Suspense, Switch} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'
import {fetchSession} from '../../../../services/fetchSession'

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const AdminAaModels = () => {
  const [filter, setFilter] = createSignal<'all' | 'open' | 'proprietary' | 'unknown'>('all')
  const [search, setSearch] = createSignal('')
  const [sortBy, setSortBy] = createSignal<'index' | 'name' | 'params' | 'vram'>('index')
  const [sortDir, setSortDir] = createSignal<'asc' | 'desc'>('desc')

  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const modelsQuery = useQuery(() => {
    return {
      queryKey: ['aa-models'],
      queryFn: async () => {
        const response = await apiClient.api['aa-models'].get()
        if (response.error) {
          throw new Error(
            typeof response.error === 'object' && 'value' in response.error
              ? String((response.error as {value: unknown}).value)
              : 'Failed to fetch AI models',
          )
        }
        if (!response.data?.data) {
          throw new Error('No data returned')
        }
        return response.data.data
      },
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }
  const meta = () => {
    return modelsQuery.data?.meta
  }

  const filteredModels = () => {
    let models = modelsQuery.data?.models ?? []

    // Apply type filter
    const f = filter()
    if (f === 'open')
      models = models.filter((m) => {
        return m.open_source_or_proprietary === 'Open weights'
      })
    else if (f === 'proprietary')
      models = models.filter((m) => {
        return m.open_source_or_proprietary === 'Proprietary'
      })
    else if (f === 'unknown')
      models = models.filter((m) => {
        return m.open_source_or_proprietary === 'Unknown'
      })

    // Apply search
    const s = search().toLowerCase().trim()
    if (s) {
      models = models.filter((m) => {
        return (
          m.aa_name.toLowerCase().includes(s)
          || m.aa_creator.toLowerCase().includes(s)
          || (m.hf_repo?.toLowerCase().includes(s) ?? false)
        )
      })
    }

    // Apply sort
    const sort = sortBy()
    const dir = sortDir()
    models = [...models].sort((a, b) => {
      let cmp = 0
      switch (sort) {
        case 'index':
          cmp = (a.aa_intelligence_index ?? -999) - (b.aa_intelligence_index ?? -999)
          break
        case 'name':
          cmp = a.aa_name.localeCompare(b.aa_name)
          break
        case 'params':
          cmp = (a.model_params ?? 0) - (b.model_params ?? 0)
          break
        case 'vram':
          cmp = (a.weights_vram_gib_est ?? 0) - (b.weights_vram_gib_est ?? 0)
          break
      }
      return dir === 'desc' ? -cmp : cmp
    })

    return models
  }

  const toggleSort = (col: 'index' | 'name' | 'params' | 'vram') => {
    if (sortBy() === col) {
      setSortDir(sortDir() === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir('desc')
    }
  }

  const SortIcon = (props: {col: 'index' | 'name' | 'params' | 'vram'}) => {
    return (
      <Show when={sortBy() === props.col}>
        <span class="ml-1">{sortDir() === 'desc' ? '↓' : '↑'}</span>
      </Show>
    )
  }

  const TypeBadge = (props: {type: 'Open weights' | 'Proprietary' | 'Unknown'}) => {
    return (
      <Switch>
        <Match when={props.type === 'Open weights'}>
          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
            Open weights
          </span>
        </Match>
        <Match when={props.type === 'Proprietary'}>
          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
            Proprietary
          </span>
        </Match>
        <Match when={props.type === 'Unknown'}>
          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
            Unknown
          </span>
        </Match>
      </Switch>
    )
  }

  return (
    <div class="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6">
      <Suspense
        fallback={
          <div class="flex items-center justify-center h-64">
            <div class="flex items-center space-x-3">
              <svg class="animate-spin h-8 w-8 text-indigo-400" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span class="text-slate-300 text-lg">Checking permissions...</span>
            </div>
          </div>
        }
      >
        <Show
          when={isAdmin()}
          fallback={
            <div class="max-w-xl mx-auto text-center py-16">
              <div class="bg-slate-800/50 rounded-xl p-8 border border-slate-700">
                <h2 class="text-2xl font-semibold text-white">Unauthorized</h2>
                <p class="mt-3 text-slate-400">You need admin access to view this page.</p>
                <Link
                  to="/"
                  class="mt-6 inline-block px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
                >
                  Go back home
                </Link>
              </div>
            </div>
          }
        >
          {/* Header */}
          <div class="max-w-7xl mx-auto mb-8">
            <div class="flex items-center justify-between">
              <div>
                <h1 class="text-3xl font-bold text-white flex items-center gap-3">
                  <span class="text-4xl">🤖</span>
                  AI Models Directory
                </h1>
                <p class="mt-2 text-slate-400">Model data from Artificial Analysis with HuggingFace enrichment</p>
              </div>
              <button
                onClick={() => {
                  return void modelsQuery.refetch()
                }}
                disabled={modelsQuery.isFetching}
                class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <Show when={modelsQuery.isFetching}>
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      class="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      stroke-width="4"
                      fill="none"
                    />
                    <path
                      class="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                </Show>
                {modelsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
          </div>

          <Show when={modelsQuery.isError}>
            <div class="max-w-7xl mx-auto mb-6">
              <div class="p-4 rounded-xl bg-red-900/30 border border-red-700">
                <p class="text-red-300 font-medium">Failed to load AI models</p>
                <p class="text-sm text-red-400 mt-1">
                  Make sure the AA_API_KEY environment variable is set. HF_TOKEN is optional but enables enrichment.
                </p>
                <button
                  onClick={() => {
                    return void modelsQuery.refetch()
                  }}
                  class="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-500"
                >
                  Retry
                </button>
              </div>
            </div>
          </Show>

          <Show when={!modelsQuery.isLoading && !modelsQuery.isError && modelsQuery.data}>
            {/* Stats Cards */}
            <div class="max-w-7xl mx-auto mb-6">
              <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div class="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
                  <div class="text-sm text-slate-400">Total Models</div>
                  <div class="text-3xl font-bold text-white mt-1">{meta()?.totalModels.toLocaleString()}</div>
                </div>
                <div class="bg-emerald-900/30 backdrop-blur rounded-xl p-4 border border-emerald-700/50">
                  <div class="text-sm text-emerald-300">Open Weights</div>
                  <div class="text-3xl font-bold text-emerald-400 mt-1">
                    {meta()?.openWeightsCount.toLocaleString()}
                  </div>
                </div>
                <div class="bg-amber-900/30 backdrop-blur rounded-xl p-4 border border-amber-700/50">
                  <div class="text-sm text-amber-300">Proprietary</div>
                  <div class="text-3xl font-bold text-amber-400 mt-1">{meta()?.proprietaryCount.toLocaleString()}</div>
                </div>
                <div class="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
                  <div class="text-sm text-slate-400">Unknown</div>
                  <div class="text-3xl font-bold text-slate-300 mt-1">{meta()?.unknownCount.toLocaleString()}</div>
                </div>
                <div class="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
                  <div class="text-sm text-slate-400">HF Enriched</div>
                  <div class="text-xl font-bold text-white mt-1">
                    {meta()?.hfEnriched ? (
                      <span class="text-green-400">✓ Yes</span>
                    ) : (
                      <span class="text-slate-500">No token</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Filters */}
            <div class="max-w-7xl mx-auto mb-4">
              <div class="flex flex-wrap items-center gap-4 bg-slate-800/40 rounded-xl p-4 border border-slate-700">
                {/* Search */}
                <div class="flex-1 min-w-[200px]">
                  <input
                    type="text"
                    placeholder="Search models, creators, repos..."
                    value={search()}
                    onInput={(e) => {
                      return setSearch(e.currentTarget.value)
                    }}
                    class="w-full px-4 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* Type Filter */}
                <div class="flex items-center gap-2">
                  <span class="text-sm text-slate-400">Filter:</span>
                  <div class="flex rounded-lg overflow-hidden border border-slate-600">
                    <For each={['all', 'open', 'proprietary', 'unknown'] as const}>
                      {(f) => {
                        return (
                          <button
                            onClick={() => {
                              return setFilter(f)
                            }}
                            class={`px-3 py-1.5 text-sm transition-colors ${
                              filter() === f
                                ? 'bg-indigo-600 text-white'
                                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                            }`}
                          >
                            {f === 'all'
                              ? 'All'
                              : f === 'open'
                                ? 'Open'
                                : f === 'proprietary'
                                  ? 'Proprietary'
                                  : 'Unknown'}
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>

                {/* Result count */}
                <div class="text-sm text-slate-400">
                  Showing <span class="font-semibold text-white">{filteredModels().length}</span> models
                </div>
              </div>
            </div>

            {/* Table */}
            <div class="max-w-7xl mx-auto">
              <div class="bg-slate-800/60 backdrop-blur rounded-xl border border-slate-700 overflow-hidden">
                <div class="overflow-x-auto">
                  <table class="min-w-full divide-y divide-slate-700">
                    <thead class="bg-slate-900/50">
                      <tr>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          <button
                            onClick={() => {
                              return toggleSort('index')
                            }}
                            class="flex items-center hover:text-white transition-colors"
                          >
                            Index
                            <SortIcon col="index" />
                          </button>
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          <button
                            onClick={() => {
                              return toggleSort('name')
                            }}
                            class="flex items-center hover:text-white transition-colors"
                          >
                            Model
                            <SortIcon col="name" />
                          </button>
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          Creator
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          Type
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          <button
                            onClick={() => {
                              return toggleSort('params')
                            }}
                            class="flex items-center hover:text-white transition-colors"
                          >
                            Params
                            <SortIcon col="params" />
                          </button>
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          <button
                            onClick={() => {
                              return toggleSort('vram')
                            }}
                            class="flex items-center hover:text-white transition-colors"
                          >
                            VRAM Est.
                            <SortIcon col="vram" />
                          </button>
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          License
                        </th>
                        <th class="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                          HuggingFace
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-700/50">
                      <For each={filteredModels()}>
                        {(model) => {
                          return (
                            <tr class="hover:bg-slate-700/30 transition-colors">
                              <td class="px-4 py-3 whitespace-nowrap">
                                <Show
                                  when={model.aa_intelligence_index !== null}
                                  fallback={<span class="text-slate-500">—</span>}
                                >
                                  <span class="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white font-bold text-sm">
                                    {model.aa_intelligence_index?.toFixed(0)}
                                  </span>
                                </Show>
                              </td>
                              <td class="px-4 py-3">
                                <div class="text-white font-medium">{model.aa_name}</div>
                                <div class="text-xs text-slate-500 font-mono">{model.aa_id}</div>
                              </td>
                              <td class="px-4 py-3 whitespace-nowrap">
                                <span class="text-slate-300">{model.aa_creator || '—'}</span>
                              </td>
                              <td class="px-4 py-3 whitespace-nowrap">
                                <TypeBadge type={model.open_source_or_proprietary} />
                              </td>
                              <td class="px-4 py-3 whitespace-nowrap">
                                <Show when={model.model_params_label} fallback={<span class="text-slate-500">—</span>}>
                                  <span class="text-indigo-300 font-medium">{model.model_params_label}</span>
                                </Show>
                              </td>
                              <td class="px-4 py-3 whitespace-nowrap">
                                <Show
                                  when={model.weights_vram_gib_est !== null}
                                  fallback={<span class="text-slate-500">—</span>}
                                >
                                  <div>
                                    <span class="text-cyan-300 font-medium">{model.weights_vram_gib_est} GiB</span>
                                    <Show when={model.default_tensor_type}>
                                      <span class="text-xs text-slate-500 ml-1">({model.default_tensor_type})</span>
                                    </Show>
                                  </div>
                                  <Show when={model.fits_256gb_gpu_weights_only !== null}>
                                    <div class="text-xs">
                                      {model.fits_256gb_gpu_weights_only ? (
                                        <span class="text-green-400">✓ Fits 256GB</span>
                                      ) : (
                                        <span class="text-red-400">✗ Exceeds 256GB</span>
                                      )}
                                    </div>
                                  </Show>
                                </Show>
                              </td>
                              <td class="px-4 py-3 whitespace-nowrap">
                                <Show when={model.hf_license} fallback={<span class="text-slate-500">—</span>}>
                                  <span class="text-slate-300 text-sm">{model.hf_license}</span>
                                </Show>
                              </td>
                              <td class="px-4 py-3 whitespace-nowrap">
                                <Show when={model.hf_repo} fallback={<span class="text-slate-500">—</span>}>
                                  <a
                                    href={`https://huggingface.co/${model.hf_repo}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="text-indigo-400 hover:text-indigo-300 text-sm flex items-center gap-1"
                                  >
                                    🤗 {model.hf_repo}
                                  </a>
                                  <Show when={model.hf_has_weights}>
                                    <span class="text-xs text-green-400">Has weights</span>
                                  </Show>
                                </Show>
                              </td>
                            </tr>
                          )
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Show>

          <Show when={modelsQuery.isLoading}>
            <div class="max-w-7xl mx-auto">
              <div class="bg-slate-800/60 backdrop-blur rounded-xl p-16 border border-slate-700 text-center">
                <svg class="animate-spin h-12 w-12 text-indigo-400 mx-auto mb-4" viewBox="0 0 24 24">
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                    fill="none"
                  />
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <p class="text-slate-300 text-lg">Fetching AI models from Artificial Analysis...</p>
                <p class="text-slate-500 text-sm mt-2">This may take a minute as we enrich data from HuggingFace</p>
              </div>
            </div>
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/aa-models/')({component: AdminAaModels})
