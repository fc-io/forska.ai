import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, Show, Suspense} from 'solid-js'

import {ArticleAdminSection} from '../../../../../../components/main/articles/articleAdminSection'
import {ArticleTabs} from '../../../../../../components/main/articles/articleTabs'
import {StickyColumn} from '../../../../../../components/main/common/stickyColumn'
import {ReviewArticleDetails} from '../../../../../../components/main/projects/reviews/review/reviewArticleDetails.tsx'
import {ReviewAvailableJudgments} from '../../../../../../components/main/projects/reviews/review/reviewAvailableJudgments.tsx'
import {ReviewHumanAssessments} from '../../../../../../components/main/projects/reviews/review/reviewHumanAssessments.tsx'
import {ReviewJudgments} from '../../../../../../components/main/projects/reviews/review/reviewJudgments.tsx'
import {apiClient} from '../../../../../../services/apiClient.ts'
import {getArticleDocumentTitle} from '../../../../../utils/getArticleDocumentTitle'

export const ReviewDetailFulltext = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string; articleId: string}).id
  const articleId = (params() as {id: string; articleId: string}).articleId
  const [articleViewToShow, setArticleViewToShow] = createSignal<string | undefined>(undefined)

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
      staleTime: 5 * 60 * 1000,
    }
  })

  const selectedJudgment = createMemo(() => {
    const data = articleQuery.data
    const selectedId = articleViewToShow()
    if (!data || !selectedId) return undefined

    const inProject = (data.judgments || []).find((j) => {
      return j.id === selectedId
    })
    return inProject
      ? inProject
      : (data.allJudgments || []).find((j) => {
          return j.id === selectedId
        })
  })

  createEffect(() => {
    document.title = getArticleDocumentTitle(articleQuery.data?.article?.articleTitle)
  })

  const hasFullText = () => {
    const article = articleQuery.data?.article
    const fullText = article?.fullText?.trim()
    const fullTextHtml = article?.fullTextHtml?.trim()
    return Boolean(fullText || fullTextHtml)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-7xl mx-auto space-y-6">
        <Suspense
          fallback={
            <div class="p-4 bg-white rounded-lg shadow">
              <p class="text-gray-500">Loading article details...</p>
            </div>
          }
        >
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
              return (
                <div class="flex gap-6">
                  <div class="flex-1 space-y-6">
                    <h1 class="text-2xl font-bold">Article Details</h1>

                    <ArticleTabs
                      activeTab="fulltext"
                      hasFullText={hasFullText()}
                      fullTextPDF={data().article.fullTextPDF}
                      basePath={`/projects/${projectId}/reviews-llm/${articleId}`}
                    />

                    <ReviewArticleDetails
                      article={data().article}
                      judgment={selectedJudgment()}
                      showTitle={false}
                      viewMode="fulltext"
                      hidePdfButton={true}
                    />
                  </div>
                  <StickyColumn class="w-96">
                    <Suspense
                      fallback={
                        <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 animate-pulse">
                          <div class="h-4 bg-amber-200 rounded w-24 mb-2" />
                          <div class="h-3 bg-amber-200 rounded w-full" />
                        </div>
                      }
                    >
                      <ArticleAdminSection articleId={articleId} />
                    </Suspense>
                    <ReviewJudgments
                      judgments={data().judgments}
                      setArticleViewToShow={setArticleViewToShow}
                      humanAnswersByPrompt={data().humanAnswersByPrompt}
                    />
                    <ReviewHumanAssessments groups={data().humanAssessmentsByUser} />
                    <ReviewAvailableJudgments
                      judgments={data().allJudgments}
                      projectsById={data().projectsById}
                      setArticleViewToShow={setArticleViewToShow}
                    />
                  </StickyColumn>
                </div>
              )
            }}
          </Show>
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews-llm/$articleId/fulltext')({component: ReviewDetailFulltext})
