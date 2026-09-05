import {useMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Match, Show, Switch} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {
  analyzeComparisonProjectConflictResolutionImport,
  analyzeComparisonProjectConflictResolutionPdfImport,
  commitComparisonProjectConflictResolutionImport,
  commitComparisonProjectConflictResolutionPdfImport,
  type ComparisonProjectConflictResolutionImportAnalyzePreview,
  type ComparisonProjectConflictResolutionImportCommitResponse,
  type ComparisonProjectConflictResolutionImportMode,
  type ComparisonProjectConflictResolutionImportOverwriteMode,
  type ComparisonProjectConflictResolutionImportRequest,
  type ComparisonProjectConflictResolutionPdfImportRequest,
  type ComparisonProjectConflictResolutionPdfUndecidedMode,
  type ComparisonProjectConflictResolutionTransferArtifact,
  fetchComparisonProjectJudgmentsMetadata,
} from '../../../../services/comparisonProjectsService.ts'
import {
  type ConflictResolutionImportFileKind,
  getAnalyzeImportDisabledReason,
  getCommitImportDisabledReason,
  getCommitSummaryStats,
  getConflictResolutionImportFileKind,
  getResolutionCountLabel,
  readConflictResolutionImportFile,
} from './+import-resolutions/compareProjectImportResolutionsHelpers.ts'
import {CompareProjectImportResolutionsResults} from './+import-resolutions/compareProjectImportResolutionsResults.tsx'
import {
  getConflictResolutionImportCommittedSearchParams,
  getConflictResolutionImportRefreshQueryKeys,
} from './compareProjectConflictResolutionImportReturn.ts'

const getComparisonProjectId = (params: Record<string, string>) => {
  return 'id' in params ? params.id : ''
}

const getDroppedJsonFile = (dataTransfer: DataTransfer | null) => {
  return dataTransfer?.files.item(0) ?? null
}

const getErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error ? error.message : fallback
}

const conflictResolutionImportModeOptions: Array<{
  description: string
  label: string
  value: ComparisonProjectConflictResolutionImportMode
}> = [
  {
    description: 'Import only saved decisions for articles that are currently conflicts in this comparison project.',
    label: 'Only current conflicts',
    value: 'conflicting-only',
  },
  {
    description: 'Import saved decisions for every matched article, even if it is not currently a conflict.',
    label: 'All matched articles',
    value: 'all-matched',
  },
]

const conflictResolutionImportOverwriteModeOptions: Array<{
  description: string
  label: string
  value: ComparisonProjectConflictResolutionImportOverwriteMode
}> = [
  {
    description: 'Keep existing target decisions and import only empty target rows.',
    label: 'Skip existing',
    value: 'skip-existing',
  },
  {
    description: 'Replace target decisions only when the PDF contains a different selected value.',
    label: 'Overwrite different',
    value: 'overwrite-different',
  },
]

const pdfUndecidedModeOptions: Array<{
  description: string
  label: string
  value: ComparisonProjectConflictResolutionPdfUndecidedMode
}> = [
  {
    description: 'Leave articles marked Undecided out of the import and keep any existing target resolution.',
    label: 'Ignore undecided',
    value: 'ignore',
  },
  {
    description: 'Treat Undecided as a request to clear the target conflict resolution for those articles.',
    label: 'Set to not set',
    value: 'clear',
  },
]

export const CompareProjectImportResolutionsPage = () => {
  const params = Route.useParams()
  const queryClient = useQueryClient()
  const comparisonProjectId = () => {
    return getComparisonProjectId(params() as Record<string, string>)
  }
  const [selectedFileName, setSelectedFileName] = createSignal<string | null>(null)
  const [parsedArtifact, setParsedArtifact] = createSignal<ComparisonProjectConflictResolutionTransferArtifact | null>(
    null,
  )
  const [selectedFileKind, setSelectedFileKind] = createSignal<ConflictResolutionImportFileKind | null>(null)
  const [selectedPdfFile, setSelectedPdfFile] = createSignal<File | null>(null)
  const [fileError, setFileError] = createSignal<string | null>(null)
  const [analyzeError, setAnalyzeError] = createSignal<string | null>(null)
  const [commitError, setCommitError] = createSignal<string | null>(null)
  const [analyzePreview, setAnalyzePreview] =
    createSignal<ComparisonProjectConflictResolutionImportAnalyzePreview | null>(null)
  const [commitResult, setCommitResult] = createSignal<ComparisonProjectConflictResolutionImportCommitResponse | null>(
    null,
  )
  const [importMode, setImportMode] = createSignal<ComparisonProjectConflictResolutionImportMode>('conflicting-only')
  const [overwriteMode, setOverwriteMode] =
    createSignal<ComparisonProjectConflictResolutionImportOverwriteMode>('skip-existing')
  const [pdfUndecidedMode, setPdfUndecidedMode] =
    createSignal<ComparisonProjectConflictResolutionPdfUndecidedMode>('ignore')
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
      mutationFn: (
        request: ComparisonProjectConflictResolutionImportRequest | ComparisonProjectConflictResolutionPdfImportRequest,
      ) => {
        return 'file' in request
          ? analyzeComparisonProjectConflictResolutionPdfImport(comparisonProjectId(), request)
          : analyzeComparisonProjectConflictResolutionImport(comparisonProjectId(), request)
      },
      onError: (
        error: unknown,
        request: ComparisonProjectConflictResolutionImportRequest | ComparisonProjectConflictResolutionPdfImportRequest,
      ) => {
        if (!isCurrentImportRequest(request)) {
          return
        }

        setAnalyzeError(getErrorMessage(error, 'Failed to analyze import'))
      },
      onSuccess: (
        preview: ComparisonProjectConflictResolutionImportAnalyzePreview,
        request: ComparisonProjectConflictResolutionImportRequest | ComparisonProjectConflictResolutionPdfImportRequest,
      ) => {
        if (!isCurrentImportRequest(request)) {
          return
        }

        setAnalyzeError(null)
        setCommitResult(null)
        setAnalyzePreview(preview)
      },
    }
  })

  const commitMutation = useMutation(() => {
    return {
      mutationFn: (
        request: ComparisonProjectConflictResolutionImportRequest | ComparisonProjectConflictResolutionPdfImportRequest,
      ) => {
        return 'file' in request
          ? commitComparisonProjectConflictResolutionPdfImport(comparisonProjectId(), request)
          : commitComparisonProjectConflictResolutionImport(comparisonProjectId(), request)
      },
      onError: (error: unknown) => {
        setCommitError(getErrorMessage(error, 'Failed to commit import'))
      },
      onSuccess: async (result: ComparisonProjectConflictResolutionImportCommitResponse) => {
        setCommitError(null)
        setCommitResult(result)
        setAnalyzePreview(result)
        await Promise.all(
          getConflictResolutionImportRefreshQueryKeys(comparisonProjectId()).map((queryKey) => {
            return queryClient.invalidateQueries({queryKey})
          }),
        )
      },
    }
  })

  const resetReviewState = () => {
    setAnalyzePreview(null)
    setCommitResult(null)
    setAnalyzeError(null)
    setCommitError(null)
  }
  const getImportRequest = (artifact: ComparisonProjectConflictResolutionTransferArtifact) => {
    return {artifact, importMode: importMode(), overwriteMode: overwriteMode()}
  }
  const getPdfImportRequest = (file: File) => {
    return {file, importMode: importMode(), overwriteMode: overwriteMode(), pdfUndecidedMode: pdfUndecidedMode()}
  }
  const getSelectedImportRequest = () => {
    const pdfFile = selectedPdfFile()

    if (selectedFileKind() === 'pdf' && pdfFile) {
      return getPdfImportRequest(pdfFile)
    }

    const artifact = parsedArtifact()

    return artifact ? getImportRequest(artifact) : null
  }
  const isCurrentImportRequest = (
    request: ComparisonProjectConflictResolutionImportRequest | ComparisonProjectConflictResolutionPdfImportRequest,
  ) => {
    return 'file' in request
      ? selectedPdfFile() === request.file
          && selectedFileKind() === 'pdf'
          && importMode() === request.importMode
          && overwriteMode() === request.overwriteMode
          && pdfUndecidedMode() === request.pdfUndecidedMode
      : parsedArtifact() === request.artifact
          && selectedFileKind() === 'json'
          && importMode() === request.importMode
          && overwriteMode() === request.overwriteMode
  }
  const handleFile = async (file: File | null) => {
    setFileError(null)
    resetReviewState()

    if (!file) {
      setSelectedFileName(null)
      setParsedArtifact(null)
      setSelectedPdfFile(null)
      setSelectedFileKind(null)
      return
    }

    setSelectedFileName(file.name)
    const fileKind = getConflictResolutionImportFileKind(file)

    if (!fileKind) {
      setParsedArtifact(null)
      setSelectedPdfFile(null)
      setSelectedFileKind(null)
      setFileError('Choose a .json or .pdf conflict-resolution export file.')
      return
    }

    setSelectedFileKind(fileKind)

    try {
      if (fileKind === 'pdf') {
        setParsedArtifact(null)
        setSelectedPdfFile(file)
        analyzeMutation.mutate(getPdfImportRequest(file))
        return
      }

      const parsedFile = await readConflictResolutionImportFile(file)
      setParsedArtifact(parsedFile.artifact)
      setSelectedPdfFile(null)
      analyzeMutation.mutate(getImportRequest(parsedFile.artifact))
    } catch (error) {
      setParsedArtifact(null)
      setSelectedPdfFile(null)
      setSelectedFileKind(null)
      setFileError(getErrorMessage(error, 'Failed to read selected file'))
    }
  }
  const handleAnalyze = () => {
    const request = getSelectedImportRequest()

    if (!request) {
      setAnalyzeError('Choose a valid JSON or PDF export file before analyzing.')
      return
    }

    setCommitResult(null)
    setAnalyzePreview(null)
    setAnalyzeError(null)
    setCommitError(null)
    analyzeMutation.mutate(request)
  }
  const handleCommit = () => {
    const request = getSelectedImportRequest()

    if (!request) {
      setCommitError('Choose a valid JSON or PDF export file before committing.')
      return
    }

    setCommitError(null)
    commitMutation.mutate(request)
  }
  const handleImportModeChange = (nextImportMode: ComparisonProjectConflictResolutionImportMode) => {
    setImportMode(nextImportMode)
    resetReviewState()

    const request = getSelectedImportRequest()

    if (request) {
      analyzeMutation.mutate({...request, importMode: nextImportMode})
    }
  }
  const handleOverwriteModeChange = (nextOverwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode) => {
    setOverwriteMode(nextOverwriteMode)
    resetReviewState()

    const request = getSelectedImportRequest()

    if (request) {
      analyzeMutation.mutate({...request, overwriteMode: nextOverwriteMode})
    }
  }
  const handlePdfUndecidedModeChange = (nextPdfUndecidedMode: ComparisonProjectConflictResolutionPdfUndecidedMode) => {
    setPdfUndecidedMode(nextPdfUndecidedMode)
    resetReviewState()

    const pdfFile = selectedPdfFile()

    if (pdfFile) {
      analyzeMutation.mutate({...getPdfImportRequest(pdfFile), pdfUndecidedMode: nextPdfUndecidedMode})
    }
  }
  const hasImportFile = () => {
    return Boolean(parsedArtifact() || selectedPdfFile())
  }
  const shouldShowOverwriteMode = () => {
    const summary = analyzePreview()?.summary

    return Boolean(summary && (summary.skippedExisting > 0 || summary.overwriteCandidates > 0))
  }
  const shouldShowPdfUndecidedMode = () => {
    return selectedFileKind() === 'pdf' && (analyzePreview()?.source.pdfUndecidedRowCount ?? 0) > 0
  }
  const analyzeDisabledReason = createMemo(() => {
    return getAnalyzeImportDisabledReason({
      hasArtifact: hasImportFile(),
      isAnalyzing: analyzeMutation.isPending,
      isCommitting: commitMutation.isPending,
    })
  })
  const commitDisabledReason = createMemo(() => {
    return getCommitImportDisabledReason({
      analyzeSucceeded: Boolean(analyzePreview()),
      hasArtifact: hasImportFile(),
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
                      Import adds saved conflict-resolution decisions to matched articles already present in the target
                      comparison project. Choose whether non-conflicting matches should be included.
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

                <div class="mt-5 rounded-md border border-gray-200 bg-gray-50 p-4">
                  <p class="text-sm font-medium text-gray-900">Import scope</p>
                  <div class="mt-3 grid gap-3 md:grid-cols-2">
                    <For each={conflictResolutionImportModeOptions}>
                      {(option) => {
                        return (
                          <label class="flex cursor-pointer items-start gap-3 rounded-md border border-gray-200 bg-white p-3 hover:bg-gray-50">
                            <input
                              checked={importMode() === option.value}
                              class="mt-1"
                              name="conflict-resolution-import-mode"
                              onChange={() => {
                                handleImportModeChange(option.value)
                              }}
                              type="radio"
                            />
                            <span>
                              <span class="block text-sm font-medium text-gray-900">{option.label}</span>
                              <span class="mt-1 block text-xs text-gray-500">{option.description}</span>
                            </span>
                          </label>
                        )
                      }}
                    </For>
                  </div>
                </div>

                <Show when={shouldShowOverwriteMode()}>
                  <div class="mt-5 rounded-md border border-gray-200 bg-gray-50 p-4">
                    <p class="text-sm font-medium text-gray-900">Existing target decisions</p>
                    <div class="mt-3 grid gap-3 md:grid-cols-2">
                      <For each={conflictResolutionImportOverwriteModeOptions}>
                        {(option) => {
                          return (
                            <label class="flex cursor-pointer items-start gap-3 rounded-md border border-gray-200 bg-white p-3 hover:bg-gray-50">
                              <input
                                checked={overwriteMode() === option.value}
                                class="mt-1"
                                name="conflict-resolution-import-overwrite-mode"
                                onChange={() => {
                                  handleOverwriteModeChange(option.value)
                                }}
                                type="radio"
                              />
                              <span>
                                <span class="block text-sm font-medium text-gray-900">{option.label}</span>
                                <span class="mt-1 block text-xs text-gray-500">{option.description}</span>
                              </span>
                            </label>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={shouldShowPdfUndecidedMode()}>
                  <div class="mt-5 rounded-md border border-gray-200 bg-gray-50 p-4">
                    <p class="text-sm font-medium text-gray-900">Undecided PDF selections</p>
                    <p class="mt-1 text-xs text-gray-500">
                      The PDF contains {getResolutionCountLabel(analyzePreview()?.source.pdfUndecidedRowCount ?? 0)}{' '}
                      marked Undecided. Choose how those articles should be handled before committing.
                    </p>
                    <div class="mt-3 grid gap-3 md:grid-cols-2">
                      <For each={pdfUndecidedModeOptions}>
                        {(option) => {
                          return (
                            <label class="flex cursor-pointer items-start gap-3 rounded-md border border-gray-200 bg-white p-3 hover:bg-gray-50">
                              <input
                                checked={pdfUndecidedMode() === option.value}
                                class="mt-1"
                                name="conflict-resolution-pdf-undecided-mode"
                                onChange={() => {
                                  handlePdfUndecidedModeChange(option.value)
                                }}
                                type="radio"
                              />
                              <span>
                                <span class="block text-sm font-medium text-gray-900">{option.label}</span>
                                <span class="mt-1 block text-xs text-gray-500">{option.description}</span>
                              </span>
                            </label>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

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
                    Choose or drop a .json or .pdf conflict-resolution export
                  </span>
                  <span class="mt-1 text-xs text-gray-500">
                    Selected file is analyzed automatically before any decisions are saved.
                  </span>
                  <input
                    accept=".json,.pdf,application/json,application/pdf"
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
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p class="font-medium">Import committed</p>
                          <p class="mt-1">
                            Inserted {getResolutionCountLabel(result().summary.inserted)} and skipped{' '}
                            {getResolutionCountLabel(result().summary.skipped)}.
                          </p>
                        </div>
                        <Button
                          as={Link}
                          to="/compare-judgments/$id"
                          params={{id: comparisonProjectId()} as never}
                          search={getConflictResolutionImportCommittedSearchParams() as never}
                          variant="outline"
                          size="sm"
                        >
                          Back to comparison
                        </Button>
                      </div>
                      <div class="mt-3 flex flex-wrap gap-2">
                        <For each={getCommitSummaryStats(result().summary)}>
                          {(stat) => {
                            return (
                              <span class="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-white/80 px-3 py-1.5">
                                <span class="font-medium text-emerald-950">{stat.label}</span>
                                <span>{getResolutionCountLabel(stat.value)}</span>
                              </span>
                            )
                          }}
                        </For>
                      </div>
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
