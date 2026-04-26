import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, Show, Suspense} from 'solid-js'

import {ReviewsArticlesHumanTableContainer} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesHumanTableContainer.tsx'
import {ReviewsHumanFilterControls} from '../../../../../components/main/reviews/reviewsHumanFilterControls.tsx'
import {ReviewsProjectWarnings} from '../../../../../components/main/reviews/reviewsProjectWarnings.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'
import {Button} from '../../../../../components/ui/button'
import {archiveProject, fetchProjectWithPrompts} from '../../../../../services/projectsService'
import {useUrlFilters} from '../../../../../utils/useUrlFilters.ts'
import {useArchivedProjectRedirect, useProjectAccessQuery} from '../../projectAccessGuard'

const ReviewsHuman = () => {
  const params = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [archivingProject, setArchivingProject] = createSignal(false)
  const projectAccessQuery = useProjectAccessQuery(() => {
    return params().id
  })

  const filters = useUrlFilters({routePath: '/projects/$id/reviews-human/', routeParams: {id: params().id}})

  useArchivedProjectRedirect(projectAccessQuery)

  const projectQuery = useQuery(() => {
    return {
      queryKey: ['project', params().id, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(params().id)
      },
      enabled: projectAccessQuery.data !== undefined && !projectAccessQuery.data.archived,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    }
  })

  const handleArchiveProject = async () => {
    const projectName = projectQuery.data?.project?.name ?? 'this project'
    if (
      !confirm(
        `Are you sure you want to archive the project "${projectName}"? The project will be hidden from project lists but can be restored later.`,
      )
    ) {
      return
    }

    setArchivingProject(true)
    try {
      await archiveProject(queryClient, params().id)
      void navigate({to: '/projects'})
    } catch (error) {
      console.error('Failed to archive project:', error)
      alert(`Failed to archive project: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setArchivingProject(false)
    }
  }

  return (
    <Show
      when={!projectAccessQuery.isLoading && !projectAccessQuery.isError && !projectAccessQuery.data?.archived}
      fallback={
        <div class="min-h-screen bg-gray-50 p-6 mx-auto text-center py-8 text-red-600">
          {projectAccessQuery.isError
            ? `Error loading project: ${projectAccessQuery.error instanceof Error ? projectAccessQuery.error.message : String(projectAccessQuery.error)}`
            : 'Loading project reviews...'}
        </div>
      }
    >
      <div class="min-h-screen bg-gray-50 p-6 mx-auto">
        <Suspense>
          <div class="flex justify-between items-center mb-6">
            <div class="flex items-center gap-4">
              <Button as={Link} to="/projects" variant="outline" size="sm">
                ← Back to Projects
              </Button>
              <h1 class="text-2xl font-bold">Project Reviews</h1>
              <span class="text-sm text-gray-500">{projectQuery.data?.project?.name ?? 'Loading...'}</span>
            </div>
            <div class="flex gap-2">
              <Button as={Link} to="/projects/$id" params={{id: params().id} as never} variant="outline">
                Project Details
              </Button>
              <Show when={projectAccessQuery.data?.humanJudgmentMode !== 'summary'}>
                <Button
                  as={Link}
                  to="/projects/$id/humanAssessment"
                  params={{id: params().id} as never}
                  variant="outline"
                >
                  Human Assessment
                </Button>
              </Show>
              <Button as={Link} to="/projects/$id/edit" params={{id: params().id} as never}>
                Edit Project
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  return void handleArchiveProject()
                }}
              >
                {archivingProject() ? 'Archiving...' : 'Archive Project'}
              </Button>
            </div>
          </div>
          <ReviewsTabs projectId={params().id} active="assessedHuman" />

          <ReviewsProjectWarnings projectId={params().id} />

          <ReviewsHumanFilterControls
            projectId={params().id}
            covidenceDuplicatesOnly={filters.covidenceDuplicatesOnly()}
            setCovidenceDuplicatesOnly={filters.setCovidenceDuplicatesOnly}
            covidenceConflictsOnly={filters.covidenceConflictsOnly()}
            setCovidenceConflictsOnly={filters.setCovidenceConflictsOnly}
            promptFilters={filters.promptFilters}
            setPromptFilters={filters.setPromptFilters}
            pageLimit={filters.pageLimit}
            setPageLimit={filters.setPageLimit}
            setCurrentPage={filters.setCurrentPage}
            fromDate={filters.fromDate()}
            toDate={filters.toDate()}
            setFromDate={filters.setFromDate}
            setToDate={filters.setToDate}
            searchTitle={filters.searchTitle()}
            setSearchTitle={filters.setSearchTitle}
            appliedSearchTitle={filters.appliedSearchTitle()}
            onSubmitSearch={filters.onSubmitSearch}
          />

          <ReviewsArticlesHumanTableContainer
            projectId={params().id}
            covidenceDuplicatesOnly={filters.covidenceDuplicatesOnly}
            covidenceConflictsOnly={filters.covidenceConflictsOnly}
            promptFilters={filters.promptFilters}
            currentPage={filters.currentPage}
            setCurrentPage={filters.setCurrentPage}
            pageLimit={filters.pageLimit}
            fromDate={filters.fromDate}
            toDate={filters.toDate}
            searchTitle={filters.appliedSearchTitle}
          />
        </Suspense>
      </div>
    </Show>
  )
}
export const Route = createFileRoute('/projects/$id/reviews-human/')({component: ReviewsHuman})
