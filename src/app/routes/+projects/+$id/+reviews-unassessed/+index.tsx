import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, Show} from 'solid-js'

import {ReviewsArticlesUnassessedTableContainer} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesUnassessedTableContainer.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsProjectWarnings} from '../../../../../components/main/reviews/reviewsProjectWarnings.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'
import {Button} from '../../../../../components/ui/button'
import {fetchSession} from '../../../../../services/fetchSession'
import {archiveProject, fetchProjectWithPrompts} from '../../../../../services/projectsService'
import {useUrlFilters} from '../../../../../utils/useUrlFilters.ts'

const ReviewsUnassessed = () => {
  const params = Route.useParams()
  const navigate = useNavigate()
  const projectId = (params() as {id: string}).id
  const [archivingProject, setArchivingProject] = createSignal(false)

  const filters = useUrlFilters({routePath: '/projects/$id/reviews-unassessed/', routeParams: {id: projectId}})

  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const projectQuery = useQuery(() => {
    return {
      queryKey: ['project', params().id, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(params().id)
      },
      refetchOnWindowFocus: true,
    }
  })

  const handleArchiveProject = async () => {
    const projectName = projectQuery.data?.project.name ?? 'this project'
    if (
      !confirm(
        `Are you sure you want to archive the project "${projectName}"? The project will be hidden from project lists but can be restored later.`,
      )
    ) {
      return
    }

    setArchivingProject(true)
    try {
      await archiveProject(params().id)
      void navigate({to: '/projects'})
    } catch (error) {
      console.error('Failed to archive project:', error)
      alert(`Failed to archive project: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setArchivingProject(false)
    }
  }

  // Data for the table is now loaded inside the table container component

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <h1 class="text-2xl font-bold">Project Reviews</h1>
          <span class="text-sm text-gray-500">{projectQuery.data?.project?.name ?? 'Loading...'}</span>
        </div>
        <Show when={isAdmin()}>
          <div class="flex gap-2">
            <Button as={Link} to="/projects/$id" params={{id: params().id} as never} variant="outline">
              Project Details
            </Button>
            <Button as={Link} to="/projects/$id/humanAssessment" params={{id: params().id} as never} variant="outline">
              Human Assessment
            </Button>
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
        </Show>
      </div>
      <ReviewsTabs projectId={projectId} active="unassessed" />

      <ReviewsProjectWarnings projectId={projectId} showClickhouse={true} />

      <ReviewsFilterControls
        projectId={projectId}
        promptFilters={() => {
          return {}
        }}
        setPromptFilters={() => {
          return
        }}
        pageLimit={filters.pageLimit}
        setPageLimit={filters.setPageLimit}
        setCurrentPage={filters.setCurrentPage}
        fromDate={filters.fromDate()}
        toDate={filters.toDate()}
        setFromDate={filters.setFromDate}
        setToDate={filters.setToDate}
        hidePromptSelectors={true}
        searchTitle={filters.searchTitle()}
        setSearchTitle={filters.setSearchTitle}
        appliedSearchTitle={filters.appliedSearchTitle()}
        onSubmitSearch={filters.onSubmitSearch}
      />

      <ReviewsArticlesUnassessedTableContainer
        projectId={projectId}
        currentPage={filters.currentPage}
        setCurrentPage={filters.setCurrentPage}
        pageLimit={filters.pageLimit}
        fromDate={filters.fromDate}
        toDate={filters.toDate}
        searchTitle={filters.appliedSearchTitle}
      />
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews-unassessed/')({component: ReviewsUnassessed})
