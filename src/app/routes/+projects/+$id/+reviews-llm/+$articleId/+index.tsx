import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Show, Suspense} from 'solid-js'

import {ReviewArticleDetails} from '../../../../../../components/main/projects/reviews/review/reviewArticleDetails.tsx'
import {ReviewAvailableJudgments} from '../../../../../../components/main/projects/reviews/review/reviewAvailableJudgments.tsx'
import {ReviewHumanAssessments} from '../../../../../../components/main/projects/reviews/review/reviewHumanAssessments.tsx'
import {ReviewJudgments} from '../../../../../../components/main/projects/reviews/review/reviewJudgments.tsx'
import {ReviewStatus} from '../../../../../../components/main/projects/reviews/review/reviewStatus.tsx'
import {apiClient} from '../../../../../../services/apiClient.ts'

export const ReviewDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string; articleId: string}).id
  const articleId = (params() as {id: string; articleId: string}).articleId
  const [articleViewToShow, setArticleViewToShow] = createSignal<string | undefined>(undefined)
  const [selectedHumanJudgmentId, setSelectedHumanJudgmentId] = createSignal<string | undefined>(undefined)
  const [selectedHumanUserName, setSelectedHumanUserName] = createSignal<string>('')

  const articleQuery = useQuery(() => {
    return {
      queryKey: ['article-review-details', projectId, articleId],
      queryFn: async () => {
        const response = await apiClient.api.projectsreview.post({projectId, articleId})

        if (!response.data) {
          throw new Error('Failed to fetch apiClient.api.projectsreview.pos')
        }
        console.log(response.data)
        return response.data
      },
    }
  })

  // Helper to find human judgment by ID across all groups
  const findHumanJudgment = (
    groups: Array<{
      userId: string
      userName: string
      judgments: Array<{id: string; prompt: {originalText: string}; answer: string | null; comment: string | null}>
    }>,
    id: string,
  ) => {
    for (const group of groups) {
      const judgment = group.judgments.find((j) => {
        return j.id === id
      })
      if (judgment) return judgment
    }
    return undefined
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-7xl mx-auto space-y-6">
        <Suspense>
          <Show when={articleQuery.isLoading}>
            <div class="p-4 bg-white rounded-lg shadow">
              <p class="text-gray-500">Loading article details...</p>
            </div>
          </Show>

          <Show when={articleQuery.error}>
            <div class="p-4 bg-red-50 rounded-lg shadow">
              <p class="text-red-600">Error loading article: {articleQuery.error?.message}</p>
            </div>
          </Show>

          <Show when={articleQuery.data}>
            {(data) => {
              // Find selected human judgment if applicable
              const selectedHumanJudgment = () => {
                const id = selectedHumanJudgmentId()
                if (!id || !data().humanAssessmentsByUser) return undefined
                return findHumanJudgment(data().humanAssessmentsByUser, id)
              }

              return (
                <div class="flex gap-6">
                  <div class="flex-1 space-y-6">
                    {/* Default view: no selection */}
                    <Show when={articleViewToShow() === undefined && !selectedHumanJudgmentId()}>
                      <ReviewArticleDetails article={data().article} />
                    </Show>

                    {/* LLM judgment selected */}
                    <Show
                      when={
                        articleViewToShow() !== undefined
                        && [...(data().judgments || []), ...(data().allJudgments || [])].find((j) => {
                          return j.id === articleViewToShow()
                        })
                      }
                    >
                      {(selected) => {
                        return <ReviewArticleDetails article={data().article} judgment={selected()} />
                      }}
                    </Show>

                    {/* Human judgment selected */}
                    <Show when={selectedHumanJudgment()}>
                      {(humanJudgment) => {
                        return (
                          <ReviewArticleDetails
                            article={data().article}
                            humanJudgment={{...humanJudgment(), userName: selectedHumanUserName()}}
                          />
                        )
                      }}
                    </Show>

                    <Show when={data().review}>
                      <ReviewStatus review={data().review} />
                    </Show>
                  </div>
                  <div class="w-96">
                    <ReviewJudgments
                      judgments={data().judgments}
                      setArticleViewToShow={(id) => {
                        setSelectedHumanJudgmentId(undefined) // Clear human selection when LLM is selected
                        setArticleViewToShow(id)
                      }}
                    />
                    <ReviewHumanAssessments
                      groups={data().humanAssessmentsByUser}
                      selectedJudgmentId={selectedHumanJudgmentId()}
                      onSelectJudgment={(id, userName) => {
                        setArticleViewToShow(undefined) // Clear LLM selection when human is selected
                        setSelectedHumanJudgmentId(id)
                        setSelectedHumanUserName(userName)
                      }}
                    />
                    <ReviewAvailableJudgments
                      judgments={data().allJudgments}
                      projectsById={data().projectsById}
                      setArticleViewToShow={(id) => {
                        setSelectedHumanJudgmentId(undefined) // Clear human selection when LLM is selected
                        setArticleViewToShow(id)
                      }}
                    />
                  </div>
                </div>
              )
            }}
          </Show>
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews-llm/$articleId/')({component: ReviewDetail})
