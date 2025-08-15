import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'

import {ReviewArticleDetails} from '../../../../../../components/main/projects/reviews/review/reviewArticleDetails.tsx'
import {ReviewJudgments} from '../../../../../../components/main/projects/reviews/review/reviewJudgments.tsx'
import {ReviewStatus} from '../../../../../../components/main/projects/reviews/review/reviewStatus.tsx'
import {apiClient} from '../../../../../../services/apiClient.ts'

const ReviewDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string; articleId: string}).id
  const articleId = (params() as {id: string; articleId: string}).articleId
  const [articleViewToShow, setArticleViewToShow] = createSignal<
    string | undefined
  >(undefined)

  const articleQuery = useQuery(() => {
    return {
      queryKey: ['article-review-details', projectId, articleId],
      queryFn: async () => {
        const response = await apiClient.api.projectsreview.post({
          projectId,
          articleId,
        })

        if (!response.data) {
          throw new Error('Failed to fetch apiClient.api.projectsreview.pos')
        }
        return response.data
      },
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-7xl mx-auto space-y-6">
        <Show when={articleQuery.isLoading}>
          <div class="p-4 bg-white rounded-lg shadow">
            <p class="text-gray-500">Loading article details...</p>
          </div>
        </Show>

        <Show when={articleQuery.error}>
          <div class="p-4 bg-red-50 rounded-lg shadow">
            <p class="text-red-600">
              Error loading article: {articleQuery.error?.message}
            </p>
          </div>
        </Show>

        <Show when={articleQuery.data}>
          {(data) => {
            return (
              <>
                <Show when={articleViewToShow() === undefined}>
                  <ReviewArticleDetails article={data().article} />
                </Show>
                <For each={data().judgments}>
                  {(judgment) => {
                    console.log(judgment.id)
                    return (
                      <Show when={articleViewToShow() === judgment.id}>
                        <ReviewArticleDetails
                          article={data().article}
                          judgment={judgment}
                        />
                      </Show>
                    )
                  }}
                </For>
                <Show when={data().review}>
                  <ReviewStatus review={data().review} />
                </Show>
                <ReviewJudgments
                  judgments={data().judgments}
                  setArticleViewToShow={setArticleViewToShow}
                />
              </>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews/$articleId/')({
  component: ReviewDetail,
})
