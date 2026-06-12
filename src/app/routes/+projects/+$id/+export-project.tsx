import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Match, Show, Switch} from 'solid-js'

import {
  fetchProjectTransferExportSummary,
  ProjectTransferExportAction,
  type ProjectTransferExportSummary,
} from '../../../../components/main/projectsGrid/projectTransferExportAction.tsx'
import {Button} from '../../../../components/ui/button'
import {useProjectAccessQuery} from '../projectAccessGuard'

type CountCard = {detail: string; label: string; value: number}

const getCountLabel = (value: number) => {
  return new Intl.NumberFormat().format(value)
}

const getSummaryCountCards = (summary: ProjectTransferExportSummary): CountCard[] => {
  return [
    {detail: 'Articles in this project export scope.', label: 'Articles exported', value: summary.articleCount},
    {
      detail: 'Answered LLM judgments that match this project model, prompts, and content settings.',
      label: 'LLM judgments exported',
      value: summary.judgmentCount,
    },
    {
      detail: `${getCountLabel(summary.promptHumanJudgmentCount)} prompt-level and ${getCountLabel(summary.summaryHumanJudgmentCount)} summary human judgments.`,
      label: 'Human judgments exported',
      value: summary.humanJudgmentCount,
    },
  ]
}

const getProjectAccessErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

export const ExportProject = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const projectAccessQuery = useProjectAccessQuery(() => {
    return projectId
  })
  const exportSummaryQuery = useQuery(() => {
    return {
      enabled: projectAccessQuery.data !== undefined,
      queryFn: () => {
        return fetchProjectTransferExportSummary(projectId)
      },
      queryKey: ['project-transfer-export-summary', projectId],
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="mx-auto max-w-5xl space-y-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-4">
            <Show
              when={projectAccessQuery.data?.archived}
              fallback={
                <Button as={Link} to="/projects" variant="outline" size="sm">
                  Back to Projects
                </Button>
              }
            >
              <Button as={Link} to="/projects/archived" variant="outline" size="sm">
                Back to Archived Projects
              </Button>
            </Show>
            <div>
              <h1 class="text-3xl font-bold text-gray-900">Export Project</h1>
              <p class="text-sm text-muted-foreground">
                Create a project transfer package that can be imported into another Forska instance.
              </p>
            </div>
          </div>
          <Show when={!projectAccessQuery.data?.archived}>
            <Button as={Link} to="/projects/$id/export" params={{id: projectId} as never} variant="outline" size="sm">
              Export CSV Data
            </Button>
          </Show>
        </div>

        <Switch>
          <Match when={projectAccessQuery.isLoading}>
            <div class="rounded-lg border border-gray-200 bg-white p-6 text-sm text-muted-foreground">
              Loading project export details...
            </div>
          </Match>
          <Match when={projectAccessQuery.isError}>
            <div class="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
              Failed to load project: {getProjectAccessErrorMessage(projectAccessQuery.error)}
            </div>
          </Match>
          <Match when={projectAccessQuery.data}>
            {(project) => {
              return (
                <div class="space-y-6">
                  <section class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                    <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p class="text-sm font-medium text-muted-foreground">Project</p>
                        <h2 class="text-xl font-semibold text-gray-900">{project().name}</h2>
                      </div>
                      <Show when={project().archived}>
                        <span class="inline-flex w-fit items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                          Archived
                        </span>
                      </Show>
                    </div>
                  </section>

                  <section class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                    <div class="mb-4">
                      <h2 class="text-lg font-semibold text-gray-900">What Will Be Exported</h2>
                      <p class="text-sm text-muted-foreground">
                        These counts are the records currently in scope for the project transfer package.
                      </p>
                    </div>
                    <Switch>
                      <Match when={exportSummaryQuery.isLoading}>
                        <p class="text-sm text-muted-foreground">Loading export counts...</p>
                      </Match>
                      <Match when={exportSummaryQuery.isError}>
                        <p class="text-sm text-red-700">
                          Failed to load export counts: {getProjectAccessErrorMessage(exportSummaryQuery.error)}
                        </p>
                      </Match>
                      <Match when={exportSummaryQuery.data}>
                        {(summary) => {
                          return (
                            <div class="grid gap-4 md:grid-cols-3">
                              <For each={getSummaryCountCards(summary())}>
                                {(card) => {
                                  return (
                                    <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                                      <p class="text-sm font-medium text-muted-foreground">{card.label}</p>
                                      <p class="mt-1 text-3xl font-semibold text-gray-900">
                                        {getCountLabel(card.value)}
                                      </p>
                                      <p class="mt-2 text-xs text-muted-foreground">{card.detail}</p>
                                    </div>
                                  )
                                }}
                              </For>
                            </div>
                          )
                        }}
                      </Match>
                    </Switch>
                  </section>

                  <section class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                    <div class="mb-5">
                      <h2 class="text-lg font-semibold text-gray-900">Project Transfer Package</h2>
                      <p class="text-sm text-muted-foreground">
                        The package includes project settings, prompts, articles, judgments, human judgments, reviews,
                        provider/model snapshots, and article files needed for import.
                      </p>
                    </div>
                    <ProjectTransferExportAction projectId={projectId} showModeDetails class="px-4 py-2 text-sm" />
                  </section>
                </div>
              )
            }}
          </Match>
        </Switch>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/export-project')({component: ExportProject})
