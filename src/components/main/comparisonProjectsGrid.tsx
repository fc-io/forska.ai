import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {
  archiveComparisonProject,
  fetchComparisonProjects,
  unarchiveComparisonProject,
} from '../../services/comparisonProjectsService'
import {Button} from '../ui/button'

type ComparisonProject = Awaited<ReturnType<typeof fetchComparisonProjects>>[number]

type ComparisonProjectsGridProps = {
  comparisonProjects: ComparisonProject[]
  isArchived?: boolean
  onChange?: () => void
}

const getComparisonProjectContentUsedLabel = (comparisonProject: ComparisonProject) => {
  const parts = [
    comparisonProject.useTitle || comparisonProject.useAbstract
      ? comparisonProject.useTitle && comparisonProject.useAbstract
        ? 'Article Title and Abstract'
        : comparisonProject.useTitle
          ? 'Article Title'
          : 'Article Abstract'
      : null,
    comparisonProject.useFulltext ? 'Use Full Text (with images)' : null,
    comparisonProject.useFulltextNoImages ? 'Use Full Text (without images)' : null,
  ].filter(Boolean) as string[]

  return parts.length > 0 ? parts.join(' · ') : 'none'
}

const formatDateValue = (value: Date | string | null) => {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : 'Unknown'
}

export const ComparisonProjectsGrid = (props: ComparisonProjectsGridProps) => {
  const sortedComparisonProjects = createMemo(() => {
    return [...props.comparisonProjects].sort((left, right) => {
      return left.name.localeCompare(right.name)
    })
  })

  const [pendingComparisonProjects, setPendingComparisonProjects] = createSignal<Set<string>>(new Set())

  const updatePendingComparisonProjects = (comparisonProjectId: string, isPending: boolean) => {
    setPendingComparisonProjects((current) => {
      const next = new Set(current)

      if (isPending) {
        next.add(comparisonProjectId)
      } else {
        next.delete(comparisonProjectId)
      }

      return next
    })
  }

  const handleArchiveComparisonProject = async (comparisonProjectId: string) => {
    updatePendingComparisonProjects(comparisonProjectId, true)

    try {
      await archiveComparisonProject(comparisonProjectId)
      props.onChange?.()
    } catch (error) {
      console.error('Failed to archive comparison project:', error)
    } finally {
      updatePendingComparisonProjects(comparisonProjectId, false)
    }
  }

  const handleUnarchiveComparisonProject = async (comparisonProjectId: string) => {
    updatePendingComparisonProjects(comparisonProjectId, true)

    try {
      await unarchiveComparisonProject(comparisonProjectId)
      props.onChange?.()
    } catch (error) {
      console.error('Failed to unarchive comparison project:', error)
    } finally {
      updatePendingComparisonProjects(comparisonProjectId, false)
    }
  }

  return (
    <ul class="flex flex-col gap-6 mb-8 list-none p-0">
      <For each={sortedComparisonProjects()}>
        {(comparisonProject) => {
          const description = comparisonProject.description ?? ''

          return (
            <li>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="flex items-start justify-between gap-3 mb-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <h2 class="text-xl font-semibold truncate">
                      <Link
                        to="/compare-judgments/$id"
                        params={{id: comparisonProject.id} as never}
                        class="hover:text-blue-600"
                      >
                        {comparisonProject.name}
                      </Link>
                    </h2>
                    <p class="text-sm text-muted-foreground">
                      Content: {getComparisonProjectContentUsedLabel(comparisonProject)}
                    </p>
                  </div>
                  <div class="flex items-center gap-2 flex-wrap justify-end">
                    <Show
                      when={props.isArchived}
                      fallback={
                        <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          Active
                        </span>
                      }
                    >
                      <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        Archived
                      </span>
                    </Show>
                    <span
                      class={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${comparisonProject.compareWithHumans ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}
                    >
                      {comparisonProject.compareWithHumans ? 'Compare with humans' : 'LLM only'}
                    </span>
                    <span class="text-sm text-muted-foreground">
                      Created: {formatDateValue(comparisonProject.createdAt)}
                    </span>
                  </div>
                </div>
                <Show when={description !== ''}>
                  <p class="text-muted-foreground mb-4">
                    {description.length > 120 ? `${description.slice(0, 120).trim()}...` : description}
                  </p>
                </Show>
                <div class="grid gap-2 text-sm text-muted-foreground mb-4 sm:grid-cols-2">
                  <p>
                    Prompts: {comparisonProject.promptCount} · Import routes: {comparisonProject.routeCount}
                  </p>
                  <p>Article content: {getComparisonProjectContentUsedLabel(comparisonProject)}</p>
                </div>
                <div class="flex gap-2">
                  <Button as={Link} to="/compare-judgments/$id" params={{id: comparisonProject.id} as never} size="sm">
                    Open Comparison
                  </Button>
                  <Show when={!props.isArchived}>
                    <Button
                      as={Link}
                      to="/compare-judgments/$id/edit"
                      params={{id: comparisonProject.id} as never}
                      size="sm"
                      variant="outline"
                    >
                      Edit
                    </Button>
                  </Show>
                  <Show when={props.isArchived}>
                    <Button
                      size="sm"
                      class="px-3 py-1 text-sm"
                      disabled={pendingComparisonProjects().has(comparisonProject.id)}
                      onClick={() => {
                        void handleUnarchiveComparisonProject(comparisonProject.id)
                      }}
                    >
                      {pendingComparisonProjects().has(comparisonProject.id) ? 'Unarchiving...' : 'Unarchive'}
                    </Button>
                  </Show>
                  <Show when={!props.isArchived}>
                    <Button
                      size="sm"
                      variant="outline"
                      class="px-3 py-1 text-sm"
                      disabled={pendingComparisonProjects().has(comparisonProject.id)}
                      onClick={() => {
                        void handleArchiveComparisonProject(comparisonProject.id)
                      }}
                    >
                      {pendingComparisonProjects().has(comparisonProject.id) ? 'Archiving...' : 'Archive'}
                    </Button>
                  </Show>
                </div>
              </div>
            </li>
          )
        }}
      </For>
    </ul>
  )
}
