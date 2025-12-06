import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, Show, Suspense} from 'solid-js'

import {ReviewsArticlesBothTableContainer} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesBothTableContainer.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'
import {Button} from '../../../../../components/ui/button'
import {fetchSession} from '../../../../../services/fetchSession'
import {deleteProject, fetchProjectWithPrompts} from '../../../../../services/projectsService'
import {useUrlFilters} from '../../../../../utils/useUrlFilters.ts'

const ReviewsBoth = () => {
  const params = Route.useParams()
  const navigate = useNavigate()
  const [deletingProject, setDeletingProject] = createSignal(false)

  const filters = useUrlFilters({routePath: '/projects/$id/reviews-both/', routeParams: {id: params().id}})

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
      enabled: isAdmin(),
    }
  })

  const handleDeleteProject = async () => {
    const projectName = projectQuery.data?.project.name ?? 'this project'
    if (!confirm(`Are you sure you want to delete the project "${projectName}"? This action cannot be undone.`)) {
      return
    }

    setDeletingProject(true)
    try {
      await deleteProject(params().id)
      void navigate({to: '/projects'})
    } catch (error) {
      console.error('Failed to delete project:', error)
      alert(`Failed to delete project: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setDeletingProject(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense>
        <div class="flex justify-between items-center mb-6">
          <div class="flex items-center gap-4">
            <Button as={Link} to="/projects" variant="outline" size="sm">
              ← Back to Projects
            </Button>
            <h1 class="text-2xl font-bold">Project Reviews</h1>
            <span class="text-sm text-gray-500">ID: {params().id}</span>
          </div>
          <Show when={isAdmin()}>
            <div class="flex gap-2">
              <Button as={Link} to="/projects/$id" params={{id: params().id}} variant="outline">
                Project Details
              </Button>
              <Button as={Link} to="/projects/$id/humanAssessment" params={{id: params().id}} variant="outline">
                Human Assessment
              </Button>
              <Button as={Link} to="/projects/$id/edit" params={{id: params().id}}>
                Edit Project
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  return void handleDeleteProject()
                }}
                disabled={projectQuery.data?.hasJudgedArticles}
              >
                {deletingProject() ? 'Deleting...' : 'Delete Project'}
              </Button>
            </div>
          </Show>
        </div>
        <ReviewsTabs projectId={params().id} active="assessedBoth" />

        <ReviewsFilterControls
          projectId={params().id}
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

        <ReviewsArticlesBothTableContainer
          projectId={params().id}
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
  )
}

export const Route = createFileRoute('/projects/$id/reviews-both/')({component: ReviewsBoth})
