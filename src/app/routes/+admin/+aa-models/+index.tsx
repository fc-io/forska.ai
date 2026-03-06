import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {
  type ColumnDef,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
} from '@tanstack/solid-table'
import {createSignal, For, Match, Show, Switch} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'
import {fetchSession} from '../../../../services/fetchSession'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ModelRow = {
  aa_id: string
  aa_name: string
  aa_creator: string
  aa_creator_slug: string
  aa_intelligence_index: number | null
  hf_repo: string | null
  hf_license: string | null
  hf_has_weights: boolean | null
  open_source_or_proprietary: 'Open weights' | 'Proprietary' | 'Unknown'
  model_params: number | null
  model_params_label: string | null
  default_tensor_type: string | null
  weights_vram_gib_est: number | null
  fits_256gb_gpu_weights_only: boolean | null
}

// Required models from Artificial Analysis (based on URL filter)
const REQUIRED_MODEL_SLUGS = [
  'kimi-k2-thinking',
  'mimo-v2-flash-reasoning',
  'deepseek-v3-2-reasoning',
  'minimax-m2-1',
  'minimax-m2',
  'gpt-oss-120b',
  'qwen3-235b-a22b-instruct-2507-reasoning',
  'apriel-v1-6-15b-thinker',
  'glm-4-6-reasoning',
  'qwen3-vl-235b-a22b-reasoning',
  'qwen3-next-80b-a3b-reasoning',
  'gpt-oss-20b',
  'deepseek-r1',
  'mimo-v2-flash',
]

// Helper to normalize name for matching
const normalizeForMatch = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// Column Definitions
// ─────────────────────────────────────────────────────────────────────────────

const columns: ColumnDef<ModelRow, unknown>[] = [
  {
    id: 'index',
    accessorFn: (row) => {
      return row.aa_intelligence_index
    },
    header: 'Index',
    size: 70,
    cell: (info) => {
      const value = info.getValue() as number | null
      return (
        <Show when={value !== null} fallback={<span class="text-gray-400">—</span>}>
          <span class="inline-flex items-center justify-center w-10 h-8 rounded bg-indigo-100 text-indigo-800 font-semibold text-sm">
            {value?.toFixed(0)}
          </span>
        </Show>
      )
    },
  },
  {
    id: 'name',
    accessorKey: 'aa_name',
    header: 'Model',
    size: 280,
    cell: (info) => {
      const row = info.row.original
      return (
        <div>
          <div class="font-medium text-gray-900">{row.aa_name}</div>
          <div class="text-xs text-gray-500 font-mono">{row.aa_id.slice(0, 8)}...</div>
        </div>
      )
    },
  },
  {
    id: 'creator',
    accessorKey: 'aa_creator',
    header: 'Creator',
    size: 120,
    cell: (info) => {
      return <span class="text-gray-700">{(info.getValue() as string) || '—'}</span>
    },
  },
  {
    id: 'type',
    accessorKey: 'open_source_or_proprietary',
    header: 'Type',
    size: 100,
    cell: (info) => {
      const type = info.getValue() as 'Open weights' | 'Proprietary' | 'Unknown'
      return (
        <Switch>
          <Match when={type === 'Open weights'}>
            <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
              Open
            </span>
          </Match>
          <Match when={type === 'Proprietary'}>
            <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
              Proprietary
            </span>
          </Match>
          <Match when={type === 'Unknown'}>
            <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
              Unknown
            </span>
          </Match>
        </Switch>
      )
    },
  },
  {
    id: 'params',
    accessorKey: 'model_params',
    header: 'Params',
    size: 80,
    cell: (info) => {
      const row = info.row.original
      return (
        <Show when={row.model_params_label} fallback={<span class="text-gray-400">—</span>}>
          <span class="text-indigo-700 font-medium">{row.model_params_label}</span>
        </Show>
      )
    },
  },
  {
    id: 'vram',
    accessorKey: 'weights_vram_gib_est',
    header: 'VRAM Est.',
    size: 110,
    cell: (info) => {
      const row = info.row.original
      return (
        <Show when={row.weights_vram_gib_est !== null} fallback={<span class="text-gray-400">—</span>}>
          <div>
            <span class="text-cyan-700 font-medium">{row.weights_vram_gib_est} GiB</span>
            <Show when={row.default_tensor_type}>
              <span class="text-xs text-gray-500 ml-1">({row.default_tensor_type})</span>
            </Show>
          </div>
          <Show when={row.fits_256gb_gpu_weights_only !== null}>
            <div class="text-xs">
              {row.fits_256gb_gpu_weights_only ? (
                <span class="text-green-600">✓ Fits 256GB</span>
              ) : (
                <span class="text-red-600">✗ Exceeds 256GB</span>
              )}
            </div>
          </Show>
        </Show>
      )
    },
  },
  {
    id: 'license',
    accessorKey: 'hf_license',
    header: 'License',
    size: 100,
    cell: (info) => {
      const license = info.getValue() as string | null
      return (
        <Show when={license} fallback={<span class="text-gray-400">—</span>}>
          <span class="text-gray-700 text-sm">{license}</span>
        </Show>
      )
    },
  },
  {
    id: 'huggingface',
    accessorKey: 'hf_repo',
    header: 'HuggingFace',
    size: 200,
    cell: (info) => {
      const row = info.row.original
      return (
        <Show when={row.hf_repo} fallback={<span class="text-gray-400">—</span>}>
          <div>
            <a
              href={`https://huggingface.co/${row.hf_repo}`}
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:underline text-sm flex items-center gap-1"
            >
              🤗 {row.hf_repo}
            </a>
            <Show when={row.hf_has_weights}>
              <span class="text-xs text-green-600">Has weights</span>
            </Show>
          </div>
        </Show>
      )
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const AdminAaModels = () => {
  const [filter, setFilter] = createSignal<'all' | 'required' | 'open' | 'proprietary'>('required')
  const [globalFilter, setGlobalFilter] = createSignal('')
  const [sorting, setSorting] = createSignal<SortingState>([{id: 'index', desc: true}])

  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const isSignedIn = () => {
    return Boolean(sessionQuery.data?.user)
  }

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
      enabled: isSignedIn(),
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    }
  })

  const meta = () => {
    return modelsQuery.data?.meta
  }

  // Check if a model matches any of the required slugs
  const isRequiredModel = (model: ModelRow): boolean => {
    const normalizedName = normalizeForMatch(model.aa_name)
    return REQUIRED_MODEL_SLUGS.some((slug) => {
      const normalizedSlug = normalizeForMatch(slug)
      // Check if the normalized name contains the slug or vice versa
      return normalizedName.includes(normalizedSlug) || normalizedSlug.includes(normalizedName)
    })
  }

  const filteredModels = (): ModelRow[] => {
    let models = modelsQuery.data?.models ?? []

    // Apply type filter
    const f = filter()
    if (f === 'required') {
      models = models.filter(isRequiredModel)
    } else if (f === 'open') {
      models = models.filter((m) => {
        return m.open_source_or_proprietary === 'Open weights'
      })
    } else if (f === 'proprietary') {
      models = models.filter((m) => {
        return m.open_source_or_proprietary === 'Proprietary'
      })
    }

    return models
  }

  const requiredModelsCount = () => {
    const models = modelsQuery.data?.models ?? []
    return models.filter(isRequiredModel).length
  }

  const table = createSolidTable({
    get data() {
      return filteredModels()
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    state: {
      get sorting() {
        return sorting()
      },
      get globalFilter() {
        return globalFilter()
      },
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getRowId: (row) => {
      return row.aa_id
    },
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Show when={sessionQuery.isLoading}>
        <div class="flex items-center justify-center h-64">
          <div class="flex items-center space-x-2">
            <svg class="animate-spin h-6 w-6 text-blue-600" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span class="text-gray-600">Checking permissions...</span>
          </div>
        </div>
      </Show>

      <Show when={sessionQuery.isError}>
        <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-6">
          <p class="text-red-600">
            Failed to load session: {sessionQuery.error instanceof Error ? sessionQuery.error.message : 'Unknown error'}
          </p>
        </div>
      </Show>

      <Show when={!sessionQuery.isLoading && !sessionQuery.isError}>
        <Show
          when={isSignedIn()}
          fallback={
            <div class="max-w-xl mx-auto text-center py-12">
              <h2 class="text-xl font-semibold text-gray-900">Sign in required</h2>
              <p class="mt-2 text-gray-600">You need to be signed in to view this page.</p>
              <Link to="/" class="mt-4 inline-block text-blue-600 hover:underline">
                Go back home
              </Link>
            </div>
          }
        >
          {/* Header */}
          <div class="flex justify-between items-center mb-6">
            <div>
              <h1 class="text-2xl font-bold flex items-center gap-2">
                <span>🤖</span>
                AI Models Directory
              </h1>
              <p class="text-sm text-gray-500 mt-1">Model data from Artificial Analysis with HuggingFace enrichment</p>
            </div>
            <button
              onClick={() => {
                return void modelsQuery.refetch()
              }}
              disabled={modelsQuery.isFetching}
              class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm disabled:opacity-50 flex items-center gap-2"
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
              {modelsQuery.isFetching ? 'Fetching...' : 'Refresh'}
            </button>
          </div>

          <Show when={modelsQuery.isLoading}>
            <div class="bg-white rounded-lg shadow p-8 text-center">
              <svg class="animate-spin h-10 w-10 text-blue-600 mx-auto mb-4" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <p class="text-gray-600">Fetching AI models from Artificial Analysis...</p>
              <p class="text-sm text-gray-500 mt-1">This may take a minute as we enrich data from HuggingFace</p>
            </div>
          </Show>

          <Show when={modelsQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-6">
              <p class="text-red-600 font-medium">Failed to load AI models</p>
              <p class="text-sm text-red-500 mt-1">
                Make sure the AA_API_KEY environment variable is set. HF_TOKEN is optional but enables enrichment.
              </p>
              <button
                onClick={() => {
                  return void modelsQuery.refetch()
                }}
                class="mt-3 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!modelsQuery.isLoading && !modelsQuery.isError && modelsQuery.data}>
            {/* Stats Cards */}
            <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">Total Models</div>
                <div class="text-2xl font-bold text-gray-900">{meta()?.totalModels.toLocaleString()}</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">Required Models</div>
                <div class="text-2xl font-bold text-indigo-600">{requiredModelsCount()}</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">Open Weights</div>
                <div class="text-2xl font-bold text-green-600">{meta()?.openWeightsCount.toLocaleString()}</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">Proprietary</div>
                <div class="text-2xl font-bold text-amber-600">{meta()?.proprietaryCount.toLocaleString()}</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">HF Enriched</div>
                <div class="text-lg font-semibold">
                  {meta()?.hfEnriched ? (
                    <span class="text-green-600">✓ Yes</span>
                  ) : (
                    <span class="text-gray-400">No token</span>
                  )}
                </div>
              </div>
            </div>

            {/* Filters */}
            <div class="mb-4 flex flex-wrap items-center gap-4 bg-white rounded-lg shadow p-4">
              {/* Search */}
              <div class="flex-1 min-w-[200px]">
                <input
                  type="text"
                  placeholder="Search models, creators, repos..."
                  value={globalFilter()}
                  onInput={(e) => {
                    return setGlobalFilter(e.currentTarget.value)
                  }}
                  class="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Type Filter */}
              <div class="flex items-center gap-2">
                <span class="text-sm text-gray-500">Filter:</span>
                <div class="flex rounded-lg overflow-hidden border border-gray-300">
                  <For each={['required', 'all', 'open', 'proprietary'] as const}>
                    {(f) => {
                      return (
                        <button
                          onClick={() => {
                            return setFilter(f)
                          }}
                          class={`px-3 py-1.5 text-sm transition-colors ${
                            filter() === f ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {f === 'required' ? 'Required' : f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Proprietary'}
                        </button>
                      )
                    }}
                  </For>
                </div>
              </div>

              {/* Result count */}
              <div class="text-sm text-gray-500">
                Showing <span class="font-semibold text-gray-900">{table.getRowModel().rows.length}</span> models
              </div>
            </div>

            {/* Table */}
            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <For each={table.getHeaderGroups()}>
                    {(headerGroup) => {
                      return (
                        <tr>
                          <For each={headerGroup.headers}>
                            {(header) => {
                              return (
                                <th
                                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                                  style={{width: `${header.getSize()}px`}}
                                  onClick={header.column.getToggleSortingHandler()}
                                >
                                  <div class="flex items-center gap-1">
                                    {header.isPlaceholder
                                      ? null
                                      : flexRender(header.column.columnDef.header, header.getContext())}
                                    <Show when={header.column.getIsSorted()}>
                                      <span>{header.column.getIsSorted() === 'desc' ? '↓' : '↑'}</span>
                                    </Show>
                                  </div>
                                </th>
                              )
                            }}
                          </For>
                        </tr>
                      )
                    }}
                  </For>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={table.getRowModel().rows}>
                    {(row) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <For each={row.getVisibleCells()}>
                            {(cell) => {
                              return (
                                <td
                                  class="px-4 py-3 text-sm text-gray-900"
                                  style={{width: `${cell.column.getSize()}px`}}
                                >
                                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </td>
                              )
                            }}
                          </For>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
              <Show when={table.getRowModel().rows.length === 0}>
                <div class="p-8 text-center text-gray-500">
                  {modelsQuery.data?.models?.length === 0
                    ? 'No models found. Check if AA_API_KEY is configured.'
                    : 'No models match the current filters.'}
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/aa-models/')({component: AdminAaModels})
