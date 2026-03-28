import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|unsure'
type ModelOption = {id: string; modelName: string | null; name: string; provider: string | null; version: string | null}
type ModelsResponse = {data: ModelOption[]}
type EnsureModelResponse = {data: {modelId: string}; error: null}
type CovidenceAnalyzeResponse = {
  data: {
    counts: {
      conflictingStageMembershipCount: number
      fileCount: number
      filesByRole: Record<CovidenceFileRole, number>
      mergedRowCount: number
      missingMatchCount: number
      rowCount: number
      rowsByRole: Record<CovidenceFileRole, number>
    }
    detectedFiles: Array<{fileRole: CovidenceFileRole; format: 'csv' | 'ris'; rowCount: number; sourceFileName: string}>
    mode: CovidenceImportMode
    sampleMergedRows: Array<{
      articleKey: string
      articleKeySource: 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | 'unkeyed'
      citation: Record<string, string | null>
      exclusionReasons: string[]
      notes: string[]
      stageMembership: Record<CovidenceFileRole, boolean>
      tags: string[]
    }>
    warnings: {
      conflictingStageMemberships: Array<{
        articleKey: string
        conflictingFileRoles: CovidenceFileRole[]
        sourceRows: Array<{fileRole: CovidenceFileRole; rowNumber: number; sourceFileName: string}>
      }>
      missingMatches: Array<{
        articleKey: string | null
        articleKeySource: 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | null
        fileRole: Exclude<CovidenceFileRole, 'all'>
        rowNumber: number
        sourceFileName: string
      }>
    }
  }
}
type CovidenceCreateResponse = {
  success: boolean
  data: {
    covidenceProject: {created: boolean; id: string; modelId: string; name: string} | null
    covidencePrompt: {created: boolean; id: string; promptHeading: string; type: string} | null
    dataSource: {id: string; importRoute: string | null; title: string}
    stats: {importedCount: number; itemCount: number}
  }
}

const covidenceModeOptions: Array<{description: string; title: string; value: CovidenceImportMode}> = [
  {
    description:
      'All + irrelevant + full text packages. Seeds title/abstract decisions into a linked screening project.',
    title: 'Title / abstract screening',
    value: 'title_abstract',
  },
  {
    description:
      'All + irrelevant + full text + excluded + included packages. Seeds full-text review decisions and scope.',
    title: 'Full-text screening',
    value: 'full_text',
  },
]
const covidenceRoleLabels: Record<CovidenceFileRole, string> = {
  all: 'All references',
  excluded: 'Excluded',
  full_text: 'Full text',
  included: 'Included',
  irrelevant: 'Irrelevant',
}
const covidenceRoleHints: Record<CovidenceFileRole, string> = {
  all: 'Required. Canonical master export used for merge keys and article metadata.',
  excluded: 'Required for full-text imports. Marks excluded full-text decisions.',
  full_text: 'Required. Marks studies advanced to full-text review.',
  included: 'Required for full-text imports. Marks included full-text decisions.',
  irrelevant: 'Required. Marks studies excluded at title/abstract stage.',
}
const covidenceStageOrder: CovidenceFileRole[] = ['irrelevant', 'full_text', 'excluded', 'included']
const covidenceAllRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text', 'excluded', 'included']
const covidenceAnswerSetOptions: Array<{description: string; label: string; value: CovidencePromptAnswerSet}> = [
  {description: 'Use yes and no only.', label: 'Yes / No', value: 'yes|no'},
  {description: 'Allow an unsure answer for borderline studies.', label: 'Yes / No / Unsure', value: 'yes|no|unsure'},
]

const getRequiredCovidenceRoles = (mode: CovidenceImportMode): CovidenceFileRole[] => {
  return mode === 'full_text' ? covidenceAllRoles : ['all', 'irrelevant', 'full_text']
}

const getModelLabel = (model: ModelOption): string => {
  return model.provider?.toLowerCase() === 'codex' ? `Codex: ${model.name}` : model.name
}

const getSelectedUploadFiles = (filesByRole: Record<CovidenceFileRole, File | null>, mode: CovidenceImportMode) => {
  return getRequiredCovidenceRoles(mode).flatMap((fileRole) => {
    const file = filesByRole[fileRole]
    return file ? [{file, fileRole}] : []
  })
}

const getMissingCovidenceRoles = (filesByRole: Record<CovidenceFileRole, File | null>, mode: CovidenceImportMode) => {
  return getRequiredCovidenceRoles(mode).filter((fileRole) => {
    return filesByRole[fileRole] === null
  })
}

const getStageMembershipLabels = (stageMembership: Record<CovidenceFileRole, boolean>) => {
  return covidenceStageOrder.flatMap((fileRole) => {
    return stageMembership[fileRole] ? [covidenceRoleLabels[fileRole]] : []
  })
}

const fetchModels = async (): Promise<ModelOption[]> => {
  const response = await apiClient.api.models.get()
  const result = handleApiResponse<ModelsResponse>(
    response as unknown as {data?: ModelsResponse; error?: unknown; status?: number},
    'Failed to load models',
  )
  const models = result.data ?? []
  const normalizeProvider = (provider: string | null): string => {
    const value = String(provider ?? '')
      .trim()
      .toLowerCase()
    return value.length > 0 ? value : 'unknown'
  }
  const isCodex = (model: ModelOption): boolean => {
    return normalizeProvider(model.provider) === 'codex'
  }
  const hpcSorted = models
    .filter((model) => {
      return !isCodex(model)
    })
    .sort((left, right) => {
      return left.name.localeCompare(right.name)
    })
  const codexInApiOrder = models.filter(isCodex)

  return [...hpcSorted, ...codexInApiOrder]
}

const analyzeCovidencePackage = async (params: {
  files: Array<{file: File; fileRole: CovidenceFileRole}>
  mode: CovidenceImportMode
}) => {
  const response = await apiClient.api.datasources.import['covidence-analyze'].post(params)
  const result = handleApiResponse<CovidenceAnalyzeResponse>(
    response as unknown as {data?: CovidenceAnalyzeResponse; error?: unknown; status?: number},
    'Failed to analyze Covidence package',
  )

  return result.data
}

const ensureSelectedModelId = async (selectedModel: ModelOption): Promise<string> => {
  if (selectedModel.provider?.toLowerCase() !== 'codex') {
    return selectedModel.id
  }

  const modelName = selectedModel.modelName?.trim() ?? ''

  if (!modelName) {
    throw new Error('Selected Codex model is missing modelName')
  }

  const response = await apiClient.api.models.ensure.post({
    modelName,
    name: selectedModel.name,
    provider: 'codex',
    version: selectedModel.version ?? undefined,
  })
  const result = handleApiResponse<EnsureModelResponse>(
    response as unknown as {data?: EnsureModelResponse; error?: unknown; status?: number},
    'Failed to ensure Codex model',
  )

  return result.data.modelId
}

const createCovidenceImport = async (params: {
  answerSet: CovidencePromptAnswerSet
  description: string
  exclusionCriteria: string
  files: Array<{file: File; fileRole: CovidenceFileRole}>
  inclusionCriteria: string
  mode: CovidenceImportMode
  modelId: string
  title: string
}) => {
  const response = await apiClient.api.datasources.import['covidence-create'].post({
    answerSet: params.answerSet,
    description: params.description.trim() || undefined,
    exclusionCriteria: params.exclusionCriteria.trim(),
    files: params.files,
    inclusionCriteria: params.inclusionCriteria.trim(),
    mode: params.mode,
    modelId: params.modelId,
    title: params.title.trim(),
  })

  return handleApiResponse<CovidenceCreateResponse>(
    response as unknown as {data?: CovidenceCreateResponse; error?: unknown; status?: number},
    'Failed to import Covidence package',
  )
}

const AdminCovidenceImport = () => {
  const navigate = useNavigate()
  const [mode, setMode] = createSignal<CovidenceImportMode>('title_abstract')
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [selectedModelId, setSelectedModelId] = createSignal('')
  const [answerSet, setAnswerSet] = createSignal<CovidencePromptAnswerSet>('yes|no|unsure')
  const [inclusionCriteria, setInclusionCriteria] = createSignal('')
  const [exclusionCriteria, setExclusionCriteria] = createSignal('')
  const [pageError, setPageError] = createSignal('')
  const [filesByRole, setFilesByRole] = createStore<Record<CovidenceFileRole, File | null>>({
    all: null,
    excluded: null,
    full_text: null,
    included: null,
    irrelevant: null,
  })
  const [analysis, setAnalysis] = createSignal<CovidenceAnalyzeResponse['data'] | null>(null)

  const modelsQuery = useQuery(() => {
    return {queryKey: ['models', 'covidence-import'], queryFn: fetchModels, staleTime: 1000 * 60 * 5}
  })

  createEffect(() => {
    const firstModel = modelsQuery.data?.[0]

    if (firstModel && !selectedModelId()) {
      setSelectedModelId(firstModel.id)
    }
  })

  const requiredRoles = createMemo(() => {
    return getRequiredCovidenceRoles(mode())
  })

  const missingRoles = createMemo(() => {
    return getMissingCovidenceRoles(filesByRole, mode())
  })

  const selectedModel = createMemo(() => {
    return (
      (modelsQuery.data ?? []).find((model) => {
        return model.id === selectedModelId()
      }) ?? null
    )
  })

  const analyzeMutation = createMutation(() => {
    return {
      mutationFn: analyzeCovidencePackage,
      onSuccess: (data) => {
        setAnalysis(data)
      },
    }
  })

  const createMutationState = createMutation(() => {
    return {
      mutationFn: createCovidenceImport,
      onSuccess: (result) => {
        const projectId = result.data.covidenceProject?.id

        return projectId
          ? void navigate({params: {id: projectId}, to: '/projects/$id/edit'})
          : void navigate({params: {id: result.data.dataSource.id}, to: '/admin/datasources/$id/edit'})
      },
    }
  })

  const handleModeChange = (nextMode: CovidenceImportMode) => {
    setMode(nextMode)
    setAnalysis(null)
    setPageError('')
    setFilesByRole({all: null, excluded: null, full_text: null, included: null, irrelevant: null})
  }

  const handleFileChange = (fileRole: CovidenceFileRole, event: Event) => {
    const nextFile = event.currentTarget instanceof HTMLInputElement ? (event.currentTarget.files?.[0] ?? null) : null
    setFilesByRole(fileRole, nextFile)
    setAnalysis(null)
    setPageError('')
  }

  const handleAnalyze = () => {
    const nextMissingRoles = getMissingCovidenceRoles(filesByRole, mode())

    if (nextMissingRoles.length > 0) {
      setPageError(
        `Add the required files first: ${nextMissingRoles
          .map((fileRole) => {
            return covidenceRoleLabels[fileRole]
          })
          .join(', ')}`,
      )
      return
    }

    setPageError('')
    analyzeMutation.mutate({files: getSelectedUploadFiles(filesByRole, mode()), mode: mode()})
  }

  const handleSubmit = () => {
    const trimmedProjectName = projectName().trim()
    const trimmedInclusionCriteria = inclusionCriteria().trim()
    const trimmedExclusionCriteria = exclusionCriteria().trim()
    const nextMode = mode()
    const nextAnswerSet = answerSet()
    const nextDescription = description()
    const nextMissingRoles = getMissingCovidenceRoles(filesByRole, mode())
    const nextSelectedModel = selectedModel()
    const nextFiles = getSelectedUploadFiles(filesByRole, nextMode)

    if (!trimmedProjectName) {
      setPageError('Project name is required')
      return
    }

    if (!nextSelectedModel) {
      setPageError('Choose a model before importing')
      return
    }

    if (!trimmedInclusionCriteria || !trimmedExclusionCriteria) {
      setPageError('Inclusion and exclusion criteria are required')
      return
    }

    if (nextMissingRoles.length > 0) {
      setPageError(
        `Add the required files first: ${nextMissingRoles
          .map((fileRole) => {
            return covidenceRoleLabels[fileRole]
          })
          .join(', ')}`,
      )
      return
    }

    if (!analysis()) {
      setPageError('Analyze the Covidence package before importing')
      return
    }

    setPageError('')
    void ensureSelectedModelId(nextSelectedModel)
      .then((modelId) => {
        createMutationState.mutate({
          answerSet: nextAnswerSet,
          description: nextDescription,
          exclusionCriteria: trimmedExclusionCriteria,
          files: nextFiles,
          inclusionCriteria: trimmedInclusionCriteria,
          mode: nextMode,
          modelId,
          title: trimmedProjectName,
        })
      })
      .catch((error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to prepare selected model')
      })
  }

  const mutationError = () => {
    const analyzeError = analyzeMutation.error instanceof Error ? analyzeMutation.error.message : ''
    const createError = createMutationState.error instanceof Error ? createMutationState.error.message : ''

    return pageError() || analyzeError || createError
  }

  return (
    <div class="min-h-screen bg-stone-50 p-6">
      <div class="mx-auto max-w-7xl space-y-6">
        <div class="overflow-hidden rounded-3xl border border-stone-200 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_40%),linear-gradient(135deg,_#fff7ed,_#fffbeb_55%,_#ffffff)] shadow-sm">
          <div class="flex flex-wrap items-start justify-between gap-4 p-6 md:p-8">
            <div class="max-w-3xl space-y-3">
              <p class="text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">Admin import flow</p>
              <h1 class="text-3xl font-semibold tracking-tight text-stone-900">Covidence multi-file import</h1>
              <p class="max-w-2xl text-sm leading-6 text-stone-600">
                Upload the required Covidence exports, inspect merge warnings, then create the datasource, prompt,
                linked project, and seeded judgments in one pass.
              </p>
            </div>
            <Button as={Link} to="/admin/datasources" variant="outline" size="sm">
              Back to Data Sources
            </Button>
          </div>
        </div>

        <div class="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div class="space-y-6">
            <section class="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div class="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 class="text-lg font-semibold text-stone-900">1. Mode and project setup</h2>
                  <p class="mt-1 text-sm text-stone-500">
                    Choose the Covidence workflow and the linked project settings.
                  </p>
                </div>
                <span class="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                  {requiredRoles().length} files required
                </span>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <For each={covidenceModeOptions}>
                  {(option) => {
                    const isSelected = () => {
                      return mode() === option.value
                    }

                    return (
                      <button
                        type="button"
                        class={`rounded-2xl border p-4 text-left transition ${
                          isSelected()
                            ? 'border-amber-400 bg-amber-50 shadow-sm'
                            : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-white'
                        }`}
                        onClick={() => {
                          handleModeChange(option.value)
                        }}
                      >
                        <div class="flex items-start justify-between gap-4">
                          <div class="space-y-2">
                            <p class="text-sm font-semibold text-stone-900">{option.title}</p>
                            <p class="text-sm leading-6 text-stone-600">{option.description}</p>
                          </div>
                          <div class={`mt-1 h-3 w-3 rounded-full ${isSelected() ? 'bg-amber-500' : 'bg-stone-300'}`} />
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>

              <div class="mt-6 grid gap-5 md:grid-cols-2">
                <label class="space-y-2 text-sm font-medium text-stone-700">
                  <span>Project name</span>
                  <input
                    type="text"
                    value={projectName()}
                    onInput={(event) => {
                      setProjectName(event.currentTarget.value)
                    }}
                    placeholder="COVID screening import March 2026"
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  />
                  <p class="text-xs font-normal text-stone-500">
                    Used for both the datasource title and linked project name.
                  </p>
                </label>

                <label class="space-y-2 text-sm font-medium text-stone-700">
                  <span>Answer set</span>
                  <select
                    value={answerSet()}
                    onChange={(event) => {
                      setAnswerSet(event.currentTarget.value as CovidencePromptAnswerSet)
                    }}
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  >
                    <For each={covidenceAnswerSetOptions}>
                      {(option) => {
                        return <option value={option.value}>{option.label}</option>
                      }}
                    </For>
                  </select>
                  <p class="text-xs font-normal text-stone-500">
                    {covidenceAnswerSetOptions.find((option) => {
                      return option.value === answerSet()
                    })?.description ?? ''}
                  </p>
                </label>

                <div class="space-y-2 md:col-span-2">
                  <span class="block text-sm font-medium text-stone-700">Model</span>
                  <Show when={modelsQuery.isLoading}>
                    <p class="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-500">
                      Loading models...
                    </p>
                  </Show>
                  <Show when={modelsQuery.isError}>
                    <p class="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {modelsQuery.error instanceof Error ? modelsQuery.error.message : 'Failed to load models'}
                    </p>
                  </Show>
                  <Show when={!modelsQuery.isLoading && !modelsQuery.isError && (modelsQuery.data?.length ?? 0) > 0}>
                    <select
                      value={selectedModelId()}
                      onChange={(event) => {
                        setSelectedModelId(event.currentTarget.value)
                      }}
                      class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                    >
                      <For each={modelsQuery.data ?? []}>
                        {(model) => {
                          return <option value={model.id}>{getModelLabel(model)}</option>
                        }}
                      </For>
                    </select>
                  </Show>
                  <Show when={!modelsQuery.isLoading && !modelsQuery.isError && (modelsQuery.data?.length ?? 0) === 0}>
                    <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-stone-50 p-4">
                      <p class="text-sm text-stone-600">No models are available yet.</p>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          return void apiClient.api.judgments.model.get().then(() => {
                            return modelsQuery.refetch()
                          })
                        }}
                      >
                        Create default model
                      </Button>
                    </div>
                  </Show>
                </div>

                <label class="space-y-2 text-sm font-medium text-stone-700 md:col-span-2">
                  <span>Description</span>
                  <textarea
                    value={description()}
                    onInput={(event) => {
                      setDescription(event.currentTarget.value)
                    }}
                    rows={3}
                    placeholder="Optional notes for the imported datasource"
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  />
                </label>

                <label class="space-y-2 text-sm font-medium text-stone-700 md:col-span-2">
                  <span>Inclusion criteria</span>
                  <textarea
                    value={inclusionCriteria()}
                    onInput={(event) => {
                      setInclusionCriteria(event.currentTarget.value)
                    }}
                    rows={4}
                    placeholder="Adults with confirmed infection, randomized controlled trials, English full text..."
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  />
                </label>

                <label class="space-y-2 text-sm font-medium text-stone-700 md:col-span-2">
                  <span>Exclusion criteria</span>
                  <textarea
                    value={exclusionCriteria()}
                    onInput={(event) => {
                      setExclusionCriteria(event.currentTarget.value)
                    }}
                    rows={4}
                    placeholder="Animal studies, case reports, unavailable full text..."
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  />
                </label>
              </div>
            </section>

            <section class="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div class="mb-4">
                <h2 class="text-lg font-semibold text-stone-900">2. Upload required Covidence files</h2>
                <p class="mt-1 text-sm text-stone-500">
                  Switching modes resets selected files so the preview always matches the package.
                </p>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <For each={requiredRoles()}>
                  {(fileRole) => {
                    return (
                      <label class="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700 shadow-sm">
                        <div class="mb-2 flex items-center justify-between gap-3">
                          <span class="font-semibold text-stone-900">{covidenceRoleLabels[fileRole]}</span>
                          <span class="rounded-full bg-stone-200 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-stone-700">
                            {fileRole.replace('_', ' ')}
                          </span>
                        </div>
                        <p class="mb-3 text-xs leading-5 text-stone-500">{covidenceRoleHints[fileRole]}</p>
                        <input
                          type="file"
                          accept=".csv,.ris,text/csv,text/plain,application/octet-stream"
                          onChange={(event) => {
                            handleFileChange(fileRole, event)
                          }}
                          class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-amber-100 file:px-3 file:py-2 file:text-amber-900"
                        />
                        <Show when={filesByRole[fileRole]}>
                          <p class="mt-3 text-xs text-stone-600">
                            {filesByRole[fileRole]?.name} · {(filesByRole[fileRole]?.size ?? 0).toLocaleString()} bytes
                          </p>
                        </Show>
                      </label>
                    )
                  }}
                </For>
              </div>

              <div class="mt-6 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={handleAnalyze}
                  disabled={missingRoles().length > 0 || analyzeMutation.isPending}
                >
                  {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze package'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSubmit}
                  disabled={createMutationState.isPending || analyzeMutation.isPending}
                >
                  {createMutationState.isPending ? 'Importing...' : 'Create datasource and project'}
                </Button>
                <Show when={missingRoles().length > 0}>
                  <p class="text-sm text-stone-500">
                    Missing:{' '}
                    {missingRoles()
                      .map((fileRole) => {
                        return covidenceRoleLabels[fileRole]
                      })
                      .join(', ')}
                  </p>
                </Show>
              </div>

              <Show when={mutationError()}>
                <div class="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {mutationError()}
                </div>
              </Show>
            </section>
          </div>

          <div class="space-y-6">
            <section class="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div class="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 class="text-lg font-semibold text-stone-900">3. Analyze preview</h2>
                  <p class="mt-1 text-sm text-stone-500">
                    Review file detection, merge counts, and warnings before import.
                  </p>
                </div>
                <Show when={analysis()}>
                  <span class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                    Preview ready
                  </span>
                </Show>
              </div>

              <Show when={!analysis() && !analyzeMutation.isPending}>
                <div class="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 text-sm leading-6 text-stone-500">
                  Add the required files and run analysis to see merged article samples, detected formats, and package
                  warnings.
                </div>
              </Show>

              <Show when={analyzeMutation.isPending}>
                <div class="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-sm text-stone-500">
                  Inspecting package files...
                </div>
              </Show>

              <Show when={analysis()}>
                <div class="space-y-6">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Merged rows</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">{analysis()?.counts.mergedRowCount ?? 0}</p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Warnings</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">
                        {(analysis()?.counts.conflictingStageMembershipCount ?? 0)
                          + (analysis()?.counts.missingMatchCount ?? 0)}
                      </p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Detected files</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">{analysis()?.counts.fileCount ?? 0}</p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Parsed rows</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">{analysis()?.counts.rowCount ?? 0}</p>
                    </div>
                  </div>

                  <div class="space-y-3">
                    <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Detected package files</h3>
                    <div class="space-y-2">
                      <For each={analysis()?.detectedFiles ?? []}>
                        {(file) => {
                          return (
                            <div class="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
                              <div class="flex flex-wrap items-center justify-between gap-2">
                                <span class="font-medium text-stone-900">{file.sourceFileName}</span>
                                <span class="text-xs uppercase tracking-wide text-stone-500">
                                  {covidenceRoleLabels[file.fileRole]} · {file.format.toUpperCase()} ·{' '}
                                  {file.rowCount.toLocaleString()} rows
                                </span>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>

                  <div class="space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Warnings</h3>
                      <Show
                        when={
                          (analysis()?.warnings.conflictingStageMemberships.length ?? 0) === 0
                          && (analysis()?.warnings.missingMatches.length ?? 0) === 0
                        }
                      >
                        <span class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                          No warnings
                        </span>
                      </Show>
                    </div>

                    <Show when={(analysis()?.warnings.conflictingStageMemberships.length ?? 0) > 0}>
                      <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <p class="text-sm font-semibold text-amber-900">Conflicting stage memberships</p>
                        <div class="mt-3 space-y-2 text-sm text-amber-900">
                          <For each={analysis()?.warnings.conflictingStageMemberships ?? []}>
                            {(warning) => {
                              return (
                                <div class="rounded-xl bg-white/70 px-3 py-2">
                                  <p class="font-medium">{warning.articleKey}</p>
                                  <p class="text-xs text-amber-800">Roles: {warning.conflictingFileRoles.join(', ')}</p>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={(analysis()?.warnings.missingMatches.length ?? 0) > 0}>
                      <div class="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                        <p class="text-sm font-semibold text-rose-900">Rows missing a canonical match</p>
                        <div class="mt-3 space-y-2 text-sm text-rose-900">
                          <For each={analysis()?.warnings.missingMatches ?? []}>
                            {(warning) => {
                              return (
                                <div class="rounded-xl bg-white/70 px-3 py-2">
                                  <p class="font-medium">{warning.sourceFileName}</p>
                                  <p class="text-xs text-rose-800">
                                    {covidenceRoleLabels[warning.fileRole]} · row {warning.rowNumber}
                                    {warning.articleKey ? ` · key ${warning.articleKey}` : ''}
                                  </p>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>

                  <div class="space-y-3">
                    <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Merged row samples</h3>
                    <div class="space-y-3">
                      <For each={analysis()?.sampleMergedRows ?? []}>
                        {(row) => {
                          return (
                            <div class="rounded-2xl border border-stone-200 p-4">
                              <div class="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p class="font-semibold text-stone-900">{row.citation.title ?? 'Untitled article'}</p>
                                  <p class="mt-1 text-xs uppercase tracking-wide text-stone-500">
                                    {row.articleKeySource.replaceAll('_', ' ')} · {row.articleKey}
                                  </p>
                                </div>
                                <div class="flex flex-wrap gap-2">
                                  <For each={getStageMembershipLabels(row.stageMembership)}>
                                    {(label) => {
                                      return (
                                        <span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
                                          {label}
                                        </span>
                                      )
                                    }}
                                  </For>
                                </div>
                              </div>
                              <div class="mt-3 space-y-1 text-sm text-stone-600">
                                <Show when={row.citation.abstract}>
                                  <p class="line-clamp-3">{row.citation.abstract}</p>
                                </Show>
                                <Show when={row.tags.length > 0}>
                                  <p>Tags: {row.tags.join(', ')}</p>
                                </Show>
                                <Show when={row.exclusionReasons.length > 0}>
                                  <p>Exclusion reasons: {row.exclusionReasons.join(', ')}</p>
                                </Show>
                                <Show when={row.notes.length > 0}>
                                  <p>Notes: {row.notes.join(' | ')}</p>
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/covidence-import')({component: AdminCovidenceImport})
