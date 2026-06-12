import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {
  type ComparisonProjectConflictResolutionImportMode,
  type ComparisonProjectConflictResolutionImportPreviewInput,
  type ComparisonProjectConflictResolutionImportSource,
  type ComparisonProjectSource,
  type ConflictResolutionImportSummary,
  type ConflictResolutionImportWarning,
  type ConflictResolutionImportWarningSourceRow,
  type ConflictResolutionImportWarningTargetArticle,
  createComparisonProjectFromProject,
  type CreateComparisonProjectFromProjectInput,
  type CreateComparisonProjectFromProjectResult,
  fetchComparisonProjectConflictResolutionImportPreview,
  fetchComparisonProjectConflictResolutionImportSources,
  fetchComparisonProjectSources,
} from '../../../services/comparisonProjectsService'

type PostCreateConflictResolutionImportWarningResult = {
  createdComparisonProject: CreateComparisonProjectFromProjectResult['data']
  summary: ConflictResolutionImportSummary
}

const importWarningCopy =
  'Matching duplicate decisions are imported once. Conflicting or ambiguous decisions are skipped and reported after creation.'

const conflictResolutionImportModeOptions: Array<{
  description: string
  label: string
  value: ComparisonProjectConflictResolutionImportMode
}> = [
  {
    description: 'Import only saved decisions for articles that are conflicts in the new compare project.',
    label: 'Only current conflicts',
    value: 'conflicting-only',
  },
  {
    description: 'Import saved decisions for every matched article, even if it is not currently a conflict.',
    label: 'All matched articles',
    value: 'all-matched',
  },
]

const formatContentSettings = (sourceProject: ComparisonProjectSource) => {
  const parts = [
    sourceProject.useTitle ? 'title' : null,
    sourceProject.useAbstract ? 'abstract' : null,
    sourceProject.useFulltextNoImages ? 'fulltext (no images)' : sourceProject.useFulltext ? 'fulltext' : null,
  ].filter(Boolean) as string[]

  return parts.length > 0 ? parts.join(' + ') : 'none'
}

const formatHumanJudgmentMode = (mode: ComparisonProjectConflictResolutionImportSource['humanJudgmentMode']) => {
  return mode === 'summary' ? 'Summary' : 'Prompt'
}

const formatResolutionCount = (count: number) => {
  return `${count} resolution${count === 1 ? '' : 's'}`
}

const getImportPreviewDuplicateCount = (summary: ConflictResolutionImportSummary) => {
  return summary.deduped + summary.skippedConflicting
}

const getOtherSkippedReasonStats = (summary: ConflictResolutionImportSummary) => {
  return [
    {
      label: 'Not currently conflicting',
      value: summary.skippedNotConflicting,
      description: 'Matched an article that is not eligible for conflict resolution in the new project.',
    },
    {
      label: 'No target match',
      value: summary.skippedNoTargetMatch,
      description: 'Could not match the saved decision to an article in the new project scope.',
    },
    {
      label: 'Invalid resolution value',
      value: summary.skippedInvalidValue,
      description: 'Saved answer does not map to exactly one summary option in the new project.',
    },
    {
      label: 'Ambiguous target match',
      value: summary.skippedAmbiguousTarget,
      description: 'Matched more than one eligible target article.',
    },
    {
      label: 'No usable match key',
      value: summary.skippedNoUsableKey,
      description: 'No DOI or external ID/title key was available for matching.',
    },
  ].filter((stat) => {
    return stat.value > 0
  })
}

const getOtherSkippedReasonCount = (summary: ConflictResolutionImportSummary) => {
  return getOtherSkippedReasonStats(summary).reduce((count, stat) => {
    return count + stat.value
  }, 0)
}

const ImportConflictResolutionPreviewStats = (props: {summary: ConflictResolutionImportSummary}) => {
  const stats = () => {
    return [
      {
        label: 'Total selected resolutions',
        value: props.summary.scanned,
        description: 'Across selected compare projects.',
      },
      {
        label: 'Duplicate rows',
        value: getImportPreviewDuplicateCount(props.summary),
        description: 'Duplicate rows removed or skipped before import.',
      },
      {
        label: 'Conflicting duplicates',
        value: props.summary.skippedConflicting,
        description: 'Duplicate rows with different answers; these are skipped.',
      },
      {
        label: 'Other skipped',
        value: getOtherSkippedReasonCount(props.summary),
        description: 'Skipped for match, eligibility, or value reasons.',
      },
      {
        label: 'Will import',
        value: props.summary.imported,
        description: 'Total resolutions created in the new compare project.',
      },
    ]
  }
  const otherSkippedReasonStats = () => {
    return getOtherSkippedReasonStats(props.summary)
  }

  return (
    <div class="rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <p class="text-sm font-medium text-emerald-950">Import preview</p>
      <div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <For each={stats()}>
          {(stat) => {
            return (
              <div class="rounded-md border border-emerald-100 bg-white/80 p-3">
                <p class="text-xs font-medium uppercase tracking-wide text-emerald-800">{stat.label}</p>
                <p class="mt-1 text-lg font-semibold text-gray-900">{formatResolutionCount(stat.value)}</p>
                <p class="mt-1 text-xs text-muted-foreground">{stat.description}</p>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={otherSkippedReasonStats().length > 0}>
        <div class="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p class="text-sm font-medium text-amber-950">Other skipped reasons</p>
          <div class="mt-2 space-y-2">
            <For each={otherSkippedReasonStats()}>
              {(stat) => {
                return (
                  <div class="rounded-md border border-amber-100 bg-white/80 p-3">
                    <div class="flex items-start justify-between gap-3">
                      <p class="text-sm font-medium text-gray-900">{stat.label}</p>
                      <p class="text-sm font-semibold text-gray-900">{formatResolutionCount(stat.value)}</p>
                    </div>
                    <p class="mt-1 text-xs text-muted-foreground">{stat.description}</p>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

const formatValue = (value: string | null | undefined) => {
  return value && value.trim().length > 0 ? value : 'Unknown'
}

const getWarningMatchKeys = (warning: ConflictResolutionImportWarning) => {
  return warning.matchKeys ?? (warning.matchKey ? [warning.matchKey] : [])
}

const getWarningMatchKinds = (warning: ConflictResolutionImportWarning) => {
  return warning.matchKinds ?? (warning.matchKind ? [warning.matchKind] : [])
}

const formatValueList = (values: string[]) => {
  return values.length > 0 ? values.join(', ') : null
}

const toggleStringSelection = (currentValues: string[], nextValue: string) => {
  return currentValues.includes(nextValue)
    ? currentValues.filter((value) => {
        return value !== nextValue
      })
    : [...currentValues, nextValue]
}

const hasSummaryPromptCriteria = (prompt: ComparisonProjectSource['prompts'][number]) => {
  return Boolean(prompt.criteriaDisposition && prompt.criteriaSectionKey)
}

const getSummaryPrompts = (sourceProject: ComparisonProjectSource | undefined) => {
  return [...(sourceProject?.prompts ?? [])].filter(hasSummaryPromptCriteria).sort((left, right) => {
    return left.order - right.order
  })
}

const getAdditionalSummaryProjectReason = (
  primarySourceProject: ComparisonProjectSource | undefined,
  additionalSourceProject: ComparisonProjectSource,
) => {
  if (!primarySourceProject) {
    return 'Select a primary project first.'
  }

  if (!additionalSourceProject.isSummaryCapable) {
    return 'Summary mode is unavailable for this project.'
  }

  if (getSummaryPrompts(additionalSourceProject).length === 0) {
    return 'No prompts with summary criteria metadata.'
  }

  return null
}

const hasPostCreateImportWarnings = (result: CreateComparisonProjectFromProjectResult) => {
  return (result.conflictResolutionImportSummary?.warnings.length ?? 0) > 0
}

const WarningSourceRowDetails = (props: {sourceRow: ConflictResolutionImportWarningSourceRow}) => {
  return (
    <div class="rounded-md border border-amber-200 bg-white/70 p-3">
      <p class="text-sm font-medium text-amber-950">
        Compare project: {props.sourceRow.compareProjectName} (ID: {props.sourceRow.compareProjectId})
      </p>
      <p class="mt-1 text-sm text-amber-900">
        Source article: {formatValue(props.sourceRow.articleTitle)} (ID: {props.sourceRow.articleId})
      </p>
      <Show when={props.sourceRow.externalArticleId}>
        <p class="mt-1 text-xs text-amber-800">Source external ID: {props.sourceRow.externalArticleId}</p>
      </Show>
      <p class="mt-1 text-sm text-amber-900">Resolution answer: {props.sourceRow.resolutionAnswer}</p>
      <Show when={props.sourceRow.matchKey}>
        <p class="mt-1 text-xs text-amber-800">Match key: {props.sourceRow.matchKey}</p>
      </Show>
      <Show when={props.sourceRow.matchKind}>
        <p class="mt-1 text-xs text-amber-800">Match kind: {props.sourceRow.matchKind}</p>
      </Show>
    </div>
  )
}

const WarningTargetArticleDetails = (props: {targetArticle: ConflictResolutionImportWarningTargetArticle}) => {
  return (
    <div class="rounded-md border border-amber-200 bg-white/70 p-3">
      <p class="text-sm text-amber-900">
        Target article: {formatValue(props.targetArticle.articleTitle)} (ID: {props.targetArticle.articleId})
      </p>
      <Show when={props.targetArticle.externalArticleId}>
        <p class="mt-1 text-xs text-amber-800">Target external ID: {props.targetArticle.externalArticleId}</p>
      </Show>
      <Show when={props.targetArticle.doiKeys.length > 0}>
        <p class="mt-1 text-xs text-amber-800">Target DOI keys: {props.targetArticle.doiKeys.join(', ')}</p>
      </Show>
    </div>
  )
}

const PostCreateConflictResolutionImportWarningsPanel = (props: {
  result: PostCreateConflictResolutionImportWarningResult
}) => {
  const warnings = () => {
    return props.result.summary.warnings
  }

  return (
    <section class="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4" role="status">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-amber-950">Compare project created with import warnings</h2>
          <p class="mt-1 text-sm text-amber-900">
            {props.result.createdComparisonProject.name} (ID: {props.result.createdComparisonProject.id}) was created.
            Some prior conflict-resolution decisions were skipped.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            as={Link}
            to="/compare-judgments/$id"
            params={{id: props.result.createdComparisonProject.id} as never}
            size="sm"
          >
            Open Compare Project
          </Button>
          <Button as={Link} to="/compare-judgments" variant="outline" size="sm">
            View Compare Projects
          </Button>
        </div>
      </div>

      <div class="mt-4 space-y-3">
        <For each={warnings()}>
          {(warning) => {
            const matchKeys = () => {
              return formatValueList(getWarningMatchKeys(warning))
            }
            const matchKinds = () => {
              return formatValueList(getWarningMatchKinds(warning))
            }
            const values = () => {
              return formatValueList(warning.values ?? (warning.value ? [warning.value] : []))
            }

            return (
              <article class="rounded-md border border-amber-200 bg-amber-100/40 p-3">
                <div class="space-y-1">
                  <p class="text-sm font-semibold text-amber-950">Skip reason: {warning.code}</p>
                  <p class="text-sm text-amber-900">{warning.message}</p>
                  <Show when={matchKeys()}>
                    <p class="text-xs text-amber-800">Match key: {matchKeys()}</p>
                  </Show>
                  <Show when={matchKinds()}>
                    <p class="text-xs text-amber-800">Match kind: {matchKinds()}</p>
                  </Show>
                  <Show when={values()}>
                    <p class="text-xs text-amber-800">Resolution values: {values()}</p>
                  </Show>
                </div>

                <div class="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p class="mb-2 text-xs font-semibold uppercase text-amber-800">Skipped source decisions</p>
                    <div class="space-y-2">
                      <For each={warning.sourceRows}>
                        {(sourceRow) => {
                          return <WarningSourceRowDetails sourceRow={sourceRow} />
                        }}
                      </For>
                    </div>
                  </div>

                  <div>
                    <p class="mb-2 text-xs font-semibold uppercase text-amber-800">Target articles</p>
                    <Show
                      when={warning.targetArticles.length > 0}
                      fallback={<p class="text-sm text-amber-900">Target article: Unknown</p>}
                    >
                      <div class="space-y-2">
                        <For each={warning.targetArticles}>
                          {(targetArticle) => {
                            return <WarningTargetArticleDetails targetArticle={targetArticle} />
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </article>
            )
          }}
        </For>
      </div>
    </section>
  )
}

export const CreateCompareJudgmentsFromProjectPage = () => {
  const navigate = useNavigate()
  const sourcesQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-sources'],
      queryFn: fetchComparisonProjectSources,
      staleTime: 1000 * 60 * 5,
      suspense: false,
    }
  })
  const [comparisonProjectName, setComparisonProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [compareWithHumans, setCompareWithHumans] = createSignal(false)
  const [allowConflictResolution, setAllowConflictResolution] = createSignal(false)
  const [summaryModeEnabled, setSummaryModeEnabled] = createSignal(false)
  const [selectedSourceProjectId, setSelectedSourceProjectId] = createSignal('')
  const [selectedAdditionalSourceProjectIds, setSelectedAdditionalSourceProjectIds] = createSignal<string[]>([])
  const [
    selectedConflictResolutionImportSourceComparisonProjectIds,
    setSelectedConflictResolutionImportSourceComparisonProjectIds,
  ] = createSignal<string[]>([])
  const [conflictResolutionImportMode, setConflictResolutionImportMode] =
    createSignal<ComparisonProjectConflictResolutionImportMode>('conflicting-only')
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [postCreateWarningResult, setPostCreateWarningResult] =
    createSignal<PostCreateConflictResolutionImportWarningResult | null>(null)

  const selectedSourceProject = createMemo(() => {
    return (sourcesQuery.data ?? []).find((sourceProject) => {
      return sourceProject.id === selectedSourceProjectId()
    })
  })
  const selectedAdditionalSourceProjects = createMemo(() => {
    return selectedAdditionalSourceProjectIds().reduce<ComparisonProjectSource[]>(
      (selectedProjects, sourceProjectId) => {
        const sourceProject = (sourcesQuery.data ?? []).find((candidateSourceProject) => {
          return candidateSourceProject.id === sourceProjectId
        })

        return sourceProject ? [...selectedProjects, sourceProject] : selectedProjects
      },
      [],
    )
  })
  const additionalSourceProjects = createMemo(() => {
    return (sourcesQuery.data ?? []).filter((sourceProject) => {
      return sourceProject.id !== selectedSourceProjectId()
    })
  })
  const selectedSourceProjectSummaryPrompts = createMemo(() => {
    return getSummaryPrompts(selectedSourceProject())
  })
  const selectedProjectCount = createMemo(() => {
    return selectedSourceProjectId() ? 1 + selectedAdditionalSourceProjectIds().length : 0
  })
  const isConflictResolutionAvailable = createMemo(() => {
    return summaryModeEnabled()
  })
  const isConflictResolutionImportAvailable = createMemo(() => {
    return Boolean(selectedSourceProjectId() && summaryModeEnabled() && allowConflictResolution())
  })
  const conflictResolutionImportSourcesQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-conflict-resolution-import-sources'],
      queryFn: fetchComparisonProjectConflictResolutionImportSources,
      enabled: isConflictResolutionImportAvailable(),
      staleTime: 1000 * 60 * 5,
      suspense: false,
    }
  })
  const selectedConflictResolutionImportSourceIds = createMemo(() => {
    return isConflictResolutionImportAvailable() ? selectedConflictResolutionImportSourceComparisonProjectIds() : []
  })
  const conflictResolutionImportPreviewInput = createMemo((): ComparisonProjectConflictResolutionImportPreviewInput => {
    return {
      compareWithHumans: compareWithHumans(),
      allowConflictResolution: isConflictResolutionAvailable() && allowConflictResolution(),
      humanJudgmentMode: summaryModeEnabled() ? 'summary' : 'prompt',
      summarySourceProjectId: summaryModeEnabled() ? selectedSourceProjectId() : null,
      sourceProjectId: selectedSourceProjectId(),
      sourceProjectIds: summaryModeEnabled()
        ? [selectedSourceProjectId(), ...selectedAdditionalSourceProjectIds()]
        : [selectedSourceProjectId()],
      conflictResolutionImportMode: conflictResolutionImportMode(),
      conflictResolutionImportSourceComparisonProjectIds: selectedConflictResolutionImportSourceIds(),
    }
  })
  const conflictResolutionImportPreviewQuery = useQuery(() => {
    const input = conflictResolutionImportPreviewInput()

    return {
      queryKey: ['comparison-project-conflict-resolution-import-preview', input],
      queryFn: () => {
        return fetchComparisonProjectConflictResolutionImportPreview(input)
      },
      enabled: selectedConflictResolutionImportSourceIds().length > 0,
      staleTime: 1000 * 30,
      suspense: false,
    }
  })
  const summaryModeUnavailableReason = createMemo(() => {
    if (sourcesQuery.isLoading) {
      return 'Select a primary project after projects finish loading.'
    }

    if (sourcesQuery.isError) {
      return sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'
    }

    if (!selectedSourceProjectId()) {
      return 'Select a primary project to enable summary mode.'
    }

    if (!selectedSourceProject()?.isSummaryCapable) {
      return 'Selected primary project is not summary-capable.'
    }

    return selectedSourceProjectSummaryPrompts().length === 0
      ? 'Selected primary project has no prompts with summary criteria metadata.'
      : null
  })
  const conflictResolutionImportUnavailableReason = createMemo(() => {
    if (!selectedSourceProjectId()) {
      return 'Select a primary project before importing conflict resolutions.'
    }

    if (!summaryModeEnabled()) {
      return summaryModeUnavailableReason() ?? 'Turn on Summary mode before importing conflict resolutions.'
    }

    return allowConflictResolution() ? null : 'Enable Allow conflict resolution before importing prior decisions.'
  })
  const additionalProjectValidationError = createMemo(() => {
    if (!summaryModeEnabled()) {
      return null
    }

    const invalidSourceProject = selectedAdditionalSourceProjects().find((sourceProject) => {
      return Boolean(getAdditionalSummaryProjectReason(selectedSourceProject(), sourceProject))
    })

    if (!invalidSourceProject) {
      return null
    }

    const reason = getAdditionalSummaryProjectReason(selectedSourceProject(), invalidSourceProject)

    return reason ? `${invalidSourceProject.name}: ${reason}` : null
  })
  const canSubmit = createMemo(() => {
    return Boolean(
      comparisonProjectName().trim()
      && selectedSourceProjectId()
      && (!summaryModeEnabled() || (!summaryModeUnavailableReason() && !additionalProjectValidationError()))
      && !isLoading(),
    )
  })

  createEffect(() => {
    if (!isConflictResolutionAvailable()) {
      setAllowConflictResolution(false)
    }
  })

  createEffect(() => {
    if (!isConflictResolutionImportAvailable()) {
      setSelectedConflictResolutionImportSourceComparisonProjectIds([])
    }
  })

  createEffect(() => {
    if (!conflictResolutionImportSourcesQuery.isSuccess) {
      return
    }

    const availableSourceIds = new Set(
      (conflictResolutionImportSourcesQuery.data ?? []).map((sourceProject) => {
        return sourceProject.id
      }),
    )

    setSelectedConflictResolutionImportSourceComparisonProjectIds((currentValues) => {
      return currentValues.filter((sourceProjectId) => {
        return availableSourceIds.has(sourceProjectId)
      })
    })
  })

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    setError(null)
    setPostCreateWarningResult(null)

    if (!selectedSourceProjectId().trim()) {
      setError('Select a primary project to compare from')
      return
    }

    const summaryValidationError = summaryModeEnabled()
      ? (summaryModeUnavailableReason() ?? additionalProjectValidationError())
      : null

    if (summaryValidationError) {
      setError(summaryValidationError)
      return
    }

    const conflictResolutionImportSourceComparisonProjectIds = selectedConflictResolutionImportSourceIds()
    const createComparisonProjectInput: CreateComparisonProjectFromProjectInput = {
      name: comparisonProjectName().trim(),
      description: description().trim() || undefined,
      compareWithHumans: compareWithHumans(),
      allowConflictResolution: isConflictResolutionAvailable() && allowConflictResolution(),
      humanJudgmentMode: summaryModeEnabled() ? 'summary' : 'prompt',
      summarySourceProjectId: summaryModeEnabled() ? selectedSourceProjectId() : null,
      sourceProjectId: selectedSourceProjectId(),
      sourceProjectIds: summaryModeEnabled()
        ? [selectedSourceProjectId(), ...selectedAdditionalSourceProjectIds()]
        : [selectedSourceProjectId()],
      ...(conflictResolutionImportSourceComparisonProjectIds.length > 0
        ? {
            conflictResolutionImportMode: conflictResolutionImportMode(),
            conflictResolutionImportSourceComparisonProjectIds,
          }
        : {}),
    }

    setIsLoading(true)

    try {
      const result = await createComparisonProjectFromProject(createComparisonProjectInput)

      if (hasPostCreateImportWarnings(result) && result.conflictResolutionImportSummary) {
        setPostCreateWarningResult({
          createdComparisonProject: result.data,
          summary: result.conflictResolutionImportSummary,
        })
        return
      }

      void navigate({to: '/compare-judgments'})
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'An unexpected error occurred'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} to="/compare-judgments" variant="outline" size="sm">
          ← Back to Compare Judgments
        </Button>
        <h1 class="text-3xl font-bold">Create Compare Project</h1>
      </div>

      <Show when={postCreateWarningResult()}>
        {(result) => {
          return <PostCreateConflictResolutionImportWarningsPanel result={result()} />
        }}
      </Show>

      <div class="bg-card border rounded-lg p-6">
        <Show when={error()}>
          <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{error()}</div>
        </Show>

        <form
          onSubmit={(event) => {
            return void handleSubmit(event)
          }}
          class="space-y-6"
        >
          <div>
            <label for="comparison-project-name" class="block text-sm font-medium mb-2">
              Name *
            </label>
            <input
              id="comparison-project-name"
              type="text"
              value={comparisonProjectName()}
              onInput={(event) => {
                return setComparisonProjectName(event.currentTarget.value)
              }}
              placeholder="Enter comparison project name"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              required
            />
          </div>

          <div>
            <label for="comparison-project-description" class="block text-sm font-medium mb-2">
              Description
            </label>
            <textarea
              id="comparison-project-description"
              value={description()}
              onInput={(event) => {
                return setDescription(event.currentTarget.value)
              }}
              placeholder="Describe what this comparison project is for..."
              rows="4"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
            />
          </div>

          <div>
            <div class="flex items-center justify-between mb-2 gap-3">
              <p class="block text-sm font-medium">Primary Project</p>
              <Show when={selectedProjectCount() > 0}>
                <span class="text-xs text-muted-foreground">{selectedProjectCount()} selected for comparison</span>
              </Show>
            </div>
            <p class="text-xs text-muted-foreground mb-3">
              The primary project controls content settings and, in summary mode, supplies the human summary judgments.
            </p>
            <Show when={sourcesQuery.isLoading}>
              <p class="text-sm text-muted-foreground">Loading projects...</p>
            </Show>
            <Show when={sourcesQuery.isError}>
              <p class="text-sm text-red-600">
                {sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'}
              </p>
            </Show>
            <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError && (sourcesQuery.data?.length ?? 0) === 0}>
              <p class="text-sm text-muted-foreground">No source projects with prompts available.</p>
            </Show>
            <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError && (sourcesQuery.data?.length ?? 0) > 0}>
              <div class="space-y-2">
                <For each={sourcesQuery.data ?? []}>
                  {(sourceProject) => {
                    return (
                      <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                        <input
                          type="radio"
                          name="source-project"
                          class="mt-1"
                          checked={selectedSourceProjectId() === sourceProject.id}
                          onChange={() => {
                            setSelectedSourceProjectId(sourceProject.id)
                            setSelectedAdditionalSourceProjectIds((currentValues) => {
                              const nextValues = currentValues.filter((value) => {
                                return value !== sourceProject.id
                              })

                              return sourceProject.isSummaryCapable && getSummaryPrompts(sourceProject).length > 0
                                ? nextValues.filter((value) => {
                                    const nextProject = (sourcesQuery.data ?? []).find((candidateSourceProject) => {
                                      return candidateSourceProject.id === value
                                    })

                                    return nextProject
                                      ? !getAdditionalSummaryProjectReason(sourceProject, nextProject)
                                      : false
                                  })
                                : []
                            })

                            if (!sourceProject.isSummaryCapable || getSummaryPrompts(sourceProject).length === 0) {
                              setSummaryModeEnabled(false)
                            }
                          }}
                        />
                        <div class="flex-1">
                          <div class="flex items-center gap-2 flex-wrap">
                            <p class="text-sm font-medium text-gray-900">{sourceProject.name}</p>
                            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                              {sourceProject.modelName}
                            </span>
                          </div>
                          <p class="text-xs text-muted-foreground mt-1">
                            Content: {formatContentSettings(sourceProject)}
                          </p>
                          <p class="text-xs text-muted-foreground mt-1">
                            Prompts: {sourceProject.prompts.length} · Import routes: {sourceProject.importRoutes.length}
                          </p>
                          <p
                            class="text-xs mt-1"
                            classList={{
                              'text-emerald-700': sourceProject.isSummaryCapable,
                              'text-muted-foreground': !sourceProject.isSummaryCapable,
                            }}
                          >
                            {sourceProject.isSummaryCapable
                              ? `Summary mode available · ${getSummaryPrompts(sourceProject).length} summary prompts`
                              : 'Summary mode unavailable for this project'}
                          </p>
                          <Show when={sourceProject.description}>
                            <p class="text-xs text-muted-foreground mt-1">{sourceProject.description}</p>
                          </Show>
                        </div>
                      </label>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          <Show when={selectedSourceProjectId()}>
            <div class="border border-input rounded-md p-4 bg-muted/20">
              <label class="flex items-start gap-3" classList={{'cursor-pointer': !summaryModeUnavailableReason()}}>
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={summaryModeEnabled()}
                  disabled={Boolean(summaryModeUnavailableReason())}
                  onChange={(event) => {
                    setSummaryModeEnabled(event.currentTarget.checked)

                    if (event.currentTarget.checked) {
                      setCompareWithHumans(true)
                    }

                    if (!event.currentTarget.checked) {
                      setSelectedAdditionalSourceProjectIds([])
                    }
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Summary mode</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    Compare each article using the primary project's final human decision instead of each individual
                    prompt judgment. This uses the primary project's summary prompts and keeps that project as the main
                    human reference for any extra projects you compare.
                  </p>
                  <Show when={summaryModeUnavailableReason()}>
                    <p class="text-xs text-muted-foreground mt-1">{summaryModeUnavailableReason()}</p>
                  </Show>
                </div>
              </label>
            </div>

            <div class="border border-input rounded-md p-4 bg-muted/20">
              <label
                class="flex items-start gap-3"
                classList={{
                  'cursor-pointer': isConflictResolutionAvailable(),
                  'opacity-60': !isConflictResolutionAvailable(),
                }}
              >
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={isConflictResolutionAvailable() && allowConflictResolution()}
                  disabled={!isConflictResolutionAvailable()}
                  onChange={(event) => {
                    return setAllowConflictResolution(event.currentTarget.checked)
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Allow conflict resolution</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    Add an article-level conflict handling column on the judgments comparison page.
                  </p>
                  <Show when={!isConflictResolutionAvailable()}>
                    <p class="text-xs text-muted-foreground mt-1">Available in Summary mode only.</p>
                  </Show>
                </div>
              </label>
            </div>

            <div class="border border-input rounded-md p-4 bg-muted/20">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={compareWithHumans()}
                  onChange={(event) => {
                    setCompareWithHumans(event.currentTarget.checked)

                    if (!event.currentTarget.checked) {
                      setSummaryModeEnabled(false)
                    }
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Compare with humans</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    Save that this comparison should include human judgments in future result views.
                  </p>
                </div>
              </label>
            </div>
          </Show>

          <Show when={summaryModeEnabled() && selectedSourceProject()}>
            <details class="border border-input rounded-md p-4 bg-muted/10" open>
              <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-medium text-gray-900">Additional Projects to Compare With</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    The primary project stays the human summary source. Additional projects add their own summary
                    results.
                  </p>
                </div>
                <span class="text-xs text-muted-foreground">
                  {selectedAdditionalSourceProjectIds().length} selected
                </span>
              </summary>

              <div class="mt-4 space-y-2">
                <Show when={additionalSourceProjects().length === 0}>
                  <p class="text-sm text-muted-foreground">No additional projects are available.</p>
                </Show>
                <For each={additionalSourceProjects()}>
                  {(sourceProject) => {
                    const disabledReason = createMemo(() => {
                      return getAdditionalSummaryProjectReason(selectedSourceProject(), sourceProject)
                    })

                    return (
                      <label
                        class="flex items-start gap-3 border border-input rounded-md p-3"
                        classList={{
                          'cursor-pointer hover:bg-muted/50': !disabledReason(),
                          'opacity-60': Boolean(disabledReason()),
                        }}
                      >
                        <input
                          type="checkbox"
                          class="mt-1"
                          checked={selectedAdditionalSourceProjectIds().includes(sourceProject.id)}
                          disabled={Boolean(disabledReason())}
                          onChange={() => {
                            setSelectedAdditionalSourceProjectIds((currentValues) => {
                              return toggleStringSelection(currentValues, sourceProject.id)
                            })
                          }}
                        />
                        <div class="flex-1">
                          <div class="flex items-center gap-2 flex-wrap">
                            <p class="text-sm font-medium text-gray-900">{sourceProject.name}</p>
                            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                              {sourceProject.modelName}
                            </span>
                          </div>
                          <p class="text-xs text-muted-foreground mt-1">
                            Content: {formatContentSettings(sourceProject)}
                          </p>
                          <p class="text-xs text-muted-foreground mt-1">
                            Summary prompts: {getSummaryPrompts(sourceProject).length} · Import routes:{' '}
                            {sourceProject.importRoutes.length}
                          </p>
                          <Show when={disabledReason()}>
                            <p class="text-xs text-red-600 mt-1">{disabledReason()}</p>
                          </Show>
                        </div>
                      </label>
                    )
                  }}
                </For>
              </div>
            </details>
          </Show>

          <Show when={summaryModeEnabled() && additionalProjectValidationError()}>
            <p class="text-sm text-red-600">{additionalProjectValidationError()}</p>
          </Show>

          <div
            class="border border-input rounded-md p-4 bg-muted/10"
            classList={{'opacity-60': !isConflictResolutionImportAvailable()}}
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-sm font-medium text-gray-900">Import Conflict Resolutions</p>
                <p class="text-xs text-muted-foreground mt-1">
                  Reuse saved conflict-resolution decisions from earlier compare projects.
                </p>
              </div>
              <Show when={isConflictResolutionImportAvailable()}>
                <span class="text-xs text-muted-foreground">
                  {selectedConflictResolutionImportSourceComparisonProjectIds().length} selected
                </span>
              </Show>
            </div>

            <p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3 mt-3">
              {importWarningCopy}
            </p>

            <Show when={!isConflictResolutionImportAvailable()}>
              <p class="text-sm text-muted-foreground mt-3">{conflictResolutionImportUnavailableReason()}</p>
            </Show>

            <Show when={isConflictResolutionImportAvailable()}>
              <div class="mt-4 space-y-2">
                <div class="rounded-md border border-input bg-background p-3">
                  <p class="text-sm font-medium text-gray-900">Import scope</p>
                  <div class="mt-3 grid gap-2 md:grid-cols-2">
                    <For each={conflictResolutionImportModeOptions}>
                      {(option) => {
                        return (
                          <label class="flex cursor-pointer items-start gap-3 rounded-md border border-input p-3 hover:bg-muted/50">
                            <input
                              checked={conflictResolutionImportMode() === option.value}
                              class="mt-1"
                              name="conflict-resolution-import-mode"
                              onChange={() => {
                                setConflictResolutionImportMode(option.value)
                              }}
                              type="radio"
                            />
                            <span>
                              <span class="block text-sm font-medium text-gray-900">{option.label}</span>
                              <span class="mt-1 block text-xs text-muted-foreground">{option.description}</span>
                            </span>
                          </label>
                        )
                      }}
                    </For>
                  </div>
                </div>

                <Show when={conflictResolutionImportSourcesQuery.isLoading}>
                  <p class="text-sm text-muted-foreground">Loading conflict resolution import sources...</p>
                </Show>
                <Show when={conflictResolutionImportSourcesQuery.isError}>
                  <p class="text-sm text-red-600">
                    {conflictResolutionImportSourcesQuery.error instanceof Error
                      ? conflictResolutionImportSourcesQuery.error.message
                      : 'Failed to load conflict resolution import sources'}
                  </p>
                </Show>
                <Show
                  when={
                    !conflictResolutionImportSourcesQuery.isLoading
                    && !conflictResolutionImportSourcesQuery.isError
                    && (conflictResolutionImportSourcesQuery.data?.length ?? 0) === 0
                  }
                >
                  <p class="text-sm text-muted-foreground">
                    No compare projects with saved conflict resolutions are available.
                  </p>
                </Show>
                <Show
                  when={
                    !conflictResolutionImportSourcesQuery.isLoading
                    && !conflictResolutionImportSourcesQuery.isError
                    && (conflictResolutionImportSourcesQuery.data?.length ?? 0) > 0
                  }
                >
                  <div class="space-y-2">
                    <For each={conflictResolutionImportSourcesQuery.data ?? []}>
                      {(sourceProject) => {
                        return (
                          <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                            <input
                              type="checkbox"
                              class="mt-1"
                              checked={selectedConflictResolutionImportSourceComparisonProjectIds().includes(
                                sourceProject.id,
                              )}
                              onChange={() => {
                                setSelectedConflictResolutionImportSourceComparisonProjectIds((currentValues) => {
                                  return toggleStringSelection(currentValues, sourceProject.id)
                                })
                              }}
                            />
                            <div class="flex-1">
                              <div class="flex items-center gap-2 flex-wrap">
                                <p class="text-sm font-medium text-gray-900">{sourceProject.name}</p>
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                                  {formatHumanJudgmentMode(sourceProject.humanJudgmentMode)}
                                </span>
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                                  {formatResolutionCount(sourceProject.resolutionCount)}
                                </span>
                              </div>
                              <Show when={sourceProject.description}>
                                <p class="text-xs text-muted-foreground mt-1">{sourceProject.description}</p>
                              </Show>
                            </div>
                          </label>
                        )
                      }}
                    </For>
                  </div>

                  <Show when={selectedConflictResolutionImportSourceIds().length === 0}>
                    <p class="text-sm text-muted-foreground">
                      Select one or more compare projects to preview import stats.
                    </p>
                  </Show>

                  <Show when={selectedConflictResolutionImportSourceIds().length > 0}>
                    <Show when={conflictResolutionImportPreviewQuery.isLoading}>
                      <p class="text-sm text-muted-foreground">Calculating import preview...</p>
                    </Show>
                    <Show when={conflictResolutionImportPreviewQuery.isError}>
                      <p class="text-sm text-red-600">
                        {conflictResolutionImportPreviewQuery.error instanceof Error
                          ? conflictResolutionImportPreviewQuery.error.message
                          : 'Failed to calculate conflict resolution import preview'}
                      </p>
                    </Show>
                    <Show
                      when={
                        conflictResolutionImportPreviewQuery.isSuccess
                          ? conflictResolutionImportPreviewQuery.data
                          : null
                      }
                    >
                      {(summary) => {
                        return <ImportConflictResolutionPreviewStats summary={summary()} />
                      }}
                    </Show>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>

          <div class="flex gap-3 pt-4">
            <Button type="submit" disabled={!canSubmit()}>
              {isLoading() ? 'Creating...' : 'Create Comparison Project'}
            </Button>
            <Button as={Link} to="/compare-judgments" variant="outline">
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/create-from-project')({
  component: CreateCompareJudgmentsFromProjectPage,
})
