import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Show, Suspense} from 'solid-js'

import {ArticleAdminSection} from '../../../../../../components/main/articles/articleAdminSection'
import {ArticleTabs} from '../../../../../../components/main/articles/articleTabs'
import {StickyColumn} from '../../../../../../components/main/common/stickyColumn'
import {ReviewsCovidenceBadges} from '../../../../../../components/main/reviews/reviewsCovidenceBadges.tsx'
import {ReviewArticleDetails} from '../../../../../../components/main/projects/reviews/review/reviewArticleDetails.tsx'
import {ReviewAvailableJudgments} from '../../../../../../components/main/projects/reviews/review/reviewAvailableJudgments.tsx'
import {ReviewHumanAssessments} from '../../../../../../components/main/projects/reviews/review/reviewHumanAssessments.tsx'
import {ReviewJudgments} from '../../../../../../components/main/projects/reviews/review/reviewJudgments.tsx'
import {apiClient} from '../../../../../../services/apiClient.ts'
import {getArticleDocumentTitle} from '../../../../../utils/getArticleDocumentTitle'

const getCovidenceStageLabels = (stageMembership: Record<string, boolean>) => {
  return [
    stageMembership.irrelevant ? 'Irrelevant' : null,
    stageMembership.full_text ? 'Select' : null,
    stageMembership.excluded ? 'Excluded' : null,
    stageMembership.included ? 'Included' : null,
    stageMembership.all ? 'Screen' : null,
  ].filter((value): value is string => {
    return value !== null
  })
}

export const ReviewDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string; articleId: string}).id
  const articleId = (params() as {id: string; articleId: string}).articleId
  const [articleViewToShow, setArticleViewToShow] = createSignal<string | undefined>(undefined)
  const [isFulltextExpanded, setIsFulltextExpanded] = createSignal(false)

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

                    <Show when={(data().covidenceRelatedRecords?.length ?? 0) > 1}>
                      <div class="rounded-lg border border-amber-200 bg-amber-50 p-4">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h2 class="text-sm font-semibold text-amber-900">Covidence duplicate study group</h2>
                            <p class="mt-1 text-sm text-amber-800">
                              {data().covidenceRelatedRecords.length} records share the same study identity in this
                              import.
                            </p>
                          </div>
                          <ReviewsCovidenceBadges sourceMetadata={data().article.sourceMetadata} />
                        </div>
                        <div class="mt-4 space-y-3">
                          <For each={data().covidenceRelatedRecords}>
                            {(record) => {
                              const stageLabels = getCovidenceStageLabels(record.stageMembership)
                              const answerLabel = !record.isSeededHumanJudgmentAnswered
                                ? 'Unanswered'
                                : record.seededHumanJudgmentAnswer === 'yes'
                                  ? 'Seeded yes'
                                  : 'Seeded no'

                              return (
                                <div
                                  class={`rounded-lg border px-3 py-3 ${record.isCurrentRecord ? 'border-amber-400 bg-white' : 'border-amber-100 bg-white/70'}`}
                                >
                                  <div class="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                      <p class="font-medium text-stone-900">{record.articleTitle}</p>
                                      <p class="text-xs text-stone-500">{record.articleExternalId ?? record.id}</p>
                                    </div>
                                    <div class="flex flex-wrap items-center gap-2">
                                      <Show when={record.isCurrentRecord}>
                                        <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                                          Current record
                                        </span>
                                      </Show>
                                      <span
                                        class={`rounded-full px-2 py-0.5 text-xs font-medium ${record.hasStudyDecisionConflict ? 'bg-rose-100 text-rose-800' : 'bg-stone-100 text-stone-700'}`}
                                      >
                                        {answerLabel}
                                      </span>
                                    </div>
                                  </div>
                                  <div class="mt-2 flex flex-wrap gap-2 text-xs text-stone-600">
                                    <Show when={record.covidenceIds.length > 0}>
                                      <span>Covidence: {record.covidenceIds.join(', ')}</span>
                                    </Show>
                                    <Show when={record.referenceIds.length > 0}>
                                      <span>Ref: {record.referenceIds.join(', ')}</span>
                                    </Show>
                                    <Show when={stageLabels.length > 0}>
                                      <span>Stages: {stageLabels.join(', ')}</span>
                                    </Show>
                                  </div>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <ArticleTabs
                      activeTab="summary"
                      hasFullText={hasFullText()}
                      fullTextPDF={data().article.fullTextPDF}
                      basePath={`/projects/${projectId}/reviews-llm/${articleId}`}
                    />

                    <ReviewArticleDetails
                      article={data().article}
                      judgment={selectedJudgment()}
                      showTitle={false}
                      isFulltextExpanded={isFulltextExpanded()}
                      setIsFulltextExpanded={setIsFulltextExpanded}
                      viewMode="summary"
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

export const Route = createFileRoute('/projects/$id/reviews-llm/$articleId/')({component: ReviewDetail})
