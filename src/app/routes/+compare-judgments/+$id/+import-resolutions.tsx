import {useMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createMemo, createSignal, Match, Show, Switch} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {
  analyzeComparisonProjectConflictResolutionImport,
  commitComparisonProjectConflictResolutionImport,
  type ComparisonProjectConflictResolutionImportAnalyzePreview,
  type ComparisonProjectConflictResolutionImportCommitResponse,
  type ComparisonProjectConflictResolutionTransferArtifact,
  fetchComparisonProjectJudgmentsMetadata,
} from '../../../../services/comparisonProjectsService.ts'
import {
  getAnalyzeImportDisabledReason,
  getCommitImportDisabledReason,
  getResolutionCountLabel,
  readConflictResolutionImportFile,
} from './+import-resolutions/compareProjectImportResolutionsHelpers.ts'
import {CompareProjectImportResolutionsResults} from './+import-resolutions/compareProjectImportResolutionsResults.tsx'

const getComparisonProjectId = (params: Record<string, string>) => {
  return 'id' in params ? params.id : ''
}

const getDroppedJsonFile = (dataTransfer: DataTransfer | null) => {
  return dataTransfer?.files.item(0) ?? null
}

const getErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error ? error.message : fallback
}

const CompareProjectImportResolutionsPage = () => {
  const params = Route.useParams()
  const queryClient = useQueryClient()
  const comparisonProjectId = () => {
    return getComparisonProjectId(params() as Record<string, string>)
  }
  const [selectedFileName, setSelectedFileName] = createSignal<string | null>(null)
  const [parsedArtifact, setParsedArtifact] = createSignal<ComparisonProjectConflictResolutionTransferArtifact | null>(
    null,
  )
  const [fileError, setFileError] = createSignal<string | null>(null)
  const [analyzeError, setAnalyzeError] = createSignal<string | null>(null)
  const [commitError, setCommitError] = createSignal<string | null>(null)
  const [analyzePreview, setAnalyzePreview] =
    createSignal<ComparisonProjectConflictResolutionImportAnalyzePreview | null>(null)
  const [commitResult, setCommitResult] = createSignal<ComparisonProjectConflictResolutionImportCommitResponse | null>(
    null,
  )
  const [isDraggingFile, setIsDraggingFile] = createSignal(false)

  const comparisonProjectQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-import-resolutions-metadata', comparisonProjectId()],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsMetadata(comparisonProjectId())
      },
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    }
  })

  const analyzeMutation = useMutation(() => {
    return {
      mutationFn: (artifact: ComparisonProjectConflictResolutionTransferArtifact) => {
        return analyzeComparisonProjectConflictResolutionImport(comparisonProjectId(), artifact)
      },
      onError: (error: unknown) => {
        setAnalyzeError(getErrorMessage(error, 'Failed to analyze import'))
      },
      onSuccess: (preview: ComparisonProjectConflictResolutionImportAnalyzePreview) => {
        setAnalyzeError(null)
        setCommitResult(null)
        setAnalyzePreview(preview)
      },
    }
  })

  const commitMutation = useMutation(() => {
    return {
      mutationFn: (artifact: ComparisonProjectConflictResolutionTransferArtifact) => {
        return commitComparisonProjectConflictResolutionImport(comparisonProjectId(), artifact)
      },
      onError: (error: unknown) => {
        setCommitError(getErrorMessage(error, 'Failed to commit import'))
      },
      onSuccess: async (result: ComparisonProjectConflictResolutionImportCommitResponse) => {
        setCommitError(null)
        setCommitResult(result)
        setAnalyzePreview(result)
        await Promise.all([
          queryClient.invalidateQueries({queryKey: ['comparison-project-judgments-page', comparisonProjectId()]}),
          queryClient.invalidateQueries({queryKey: ['comparison-project-stats', comparisonProjectId()]}),
        ])
      },
    }
  })

  const resetReviewState = () => {
    setAnalyzePreview(null)
    setCommitResult(null)
    setAnalyzeError(null)
    setCommitError(null)
  }
  const handleFile = async (file: File | null) => {
    setFileError(null)
    resetReviewState()

    if (!file) {
      setSelectedFileName(null)
      setParsedArtifact(null)
      return
    }

    setSelectedFileName(file.name)

    try {
      const parsedFile = await readConflictResolutionImportFile(file)
      setParsedArtifact(parsedFile.artifact)
    } catch (error) {
      setParsedArtifact(null)
      setFileError(getErrorMessage(error, 'Failed to read selected file'))
    }
  }
  const handleAnalyze = () => {
    const artifact = parsedArtifact()

    if (!artifact) {
      setAnalyzeError('Choose a valid JSON export file before analyzing.')
      return
    }

    setCommitResult(null)
    setAnalyzePreview(null)
    setAnalyzeError(null)
    setCommitError(null)
    analyzeMutation.mutate(artifact)
  }
  const handleCommit = () => {
    const artifact = parsedArtifact()

    if (!artifact) {
      setCommitError('Choose a valid JSON export file before committing.')
      return
    }

    setCommitError(null)
    commitMutation.mutate(artifact)
  }
  const analyzeDisabledReason = createMemo(() => {
    return getAnalyzeImportDisabledReason({
      hasArtifact: Boolean(parsedArtifact()),
      isAnalyzing: analyzeMutation.isPending,
      isCommitting: commitMutation.isPending,
    })
  })
  const commitDisabledReason = createMemo(() => {
    return getCommitImportDisabledReason({
      analyzeSucceeded: Boolean(analyzePreview()),
      hasArtifact: Boolean(parsedArtifact()),
      hasCommitted: Boolean(commitResult()),
      importableCount: analyzePreview()?.summary.importable ?? 0,
      isAnalyzing: analyzeMutation.isPending,
      isCommitting: commitMutation.isPending,
    })
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <Button
            as={Link}
            to="/compare-judgments/$id"
            params={{id: comparisonProjectId()} as never}
            variant="outline"
            size="sm"
          >
            ← Back to Comparison
          </Button>
          <div>
            <h1 class="text-2xl font-bold">Import conflict resolutions</h1>
            <p class="text-sm text-gray-500">{comparisonProjectQuery.data?.name ?? 'Loading comparison project...'}</p>
          </div>
        </div>
      </div>

      <Show when={comparisonProjectQuery.isError}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {getErrorMessage(comparisonProjectQuery.error, 'Failed to load comparison project')}
        </div>
      </Show>

      <Show when={comparisonProjectQuery.isPending}>
        <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">Loading comparison project...</div>
      </Show>

      <Show when={!comparisonProjectQuery.isPending && !comparisonProjectQuery.isError && comparisonProjectQuery.data}>
        {(comparisonProject) => {
          return (
            <div class="space-y-6">
              <section class="rounded-lg bg-white p-6 shadow">
                <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div>
                    <h2 class="text-lg font-semibold">Review conflict-resolution export</h2>
                    <p class="mt-1 max-w-3xl text-sm text-gray-600">
                      Import only adds saved conflict-resolution decisions to articles already present in the target
                      comparison project.
                    </p>
                    <Show when={!comparisonProject().allowConflictResolution}>
                      <div class="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        This comparison project does not currently allow conflict resolution imports.
                      </div>
                    </Show>
                  </div>
                  <div class="flex flex-wrap items-start gap-2">
                    <Button
                      disabled={Boolean(analyzeDisabledReason())}
                      onClick={handleAnalyze}
                      title={analyzeDisabledReason() ?? undefined}
                      type="button"
                    >
                      <Show when={analyzeMutation.isPending} fallback="Analyze import">
                        Analyzing...
                      </Show>
                    </Button>
                    <Button
                      disabled={Boolean(commitDisabledReason())}
                      onClick={handleCommit}
                      title={commitDisabledReason() ?? undefined}
                      type="button"
                      variant="outline"
                    >
                      <Switch>
                        <Match when={commitMutation.isPending}>Committing...</Match>
                        <Match when={commitResult()}>Committed</Match>
                        <Match when={true}>Commit import</Match>
                      </Switch>
                    </Button>
                  </div>
                </div>

                <label
                  class={`mt-5 flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors ${
                    isDraggingFile() ? 'border-blue-400 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
                  }`}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setIsDraggingFile(true)
                  }}
                  onDragLeave={() => {
                    setIsDraggingFile(false)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    setIsDraggingFile(false)
                    void handleFile(getDroppedJsonFile(event.dataTransfer))
                  }}
                >
                  <span class="text-sm font-medium text-gray-900">
                    Choose or drop a .json conflict-resolution export
                  </span>
                  <span class="mt-1 text-xs text-gray-500">
                    Selected file is analyzed before any decisions are saved.
                  </span>
                  <input
                    accept=".json,application/json"
                    class="sr-only"
                    data-testid="conflict-resolution-import-file"
                    onChange={(event) => {
                      void handleFile(event.currentTarget.files?.item(0) ?? null)
                    }}
                    type="file"
                  />
                </label>

                <Show when={selectedFileName()}>
                  {(fileName) => {
                    return <p class="mt-3 text-sm text-gray-600">Selected: {fileName()}</p>
                  }}
                </Show>
              </section>

              <Show when={fileError()}>
                {(message) => {
                  return (
                    <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                      {message()}
                    </div>
                  )
                }}
              </Show>

              <Show when={analyzeError()}>
                {(message) => {
                  return (
                    <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                      {message()}
                    </div>
                  )
                }}
              </Show>

              <Show when={commitError()}>
                {(message) => {
                  return (
                    <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                      {message()}
                    </div>
                  )
                }}
              </Show>

              <Show when={commitResult()}>
                {(result) => {
                  return (
                    <div class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                      Imported {getResolutionCountLabel(result().summary.inserted)}.
                    </div>
                  )
                }}
              </Show>

              <Show when={analyzePreview()}>
                {(preview) => {
                  return <CompareProjectImportResolutionsResults preview={preview()} />
                }}
              </Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/$id/import-resolutions')({
  component: CompareProjectImportResolutionsPage,
})
