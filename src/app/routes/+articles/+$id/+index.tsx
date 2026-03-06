import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, Show, Suspense} from 'solid-js'

import {ArticleAdminSection} from '../../../../components/main/articles/articleAdminSection'
import {ArticleTabs} from '../../../../components/main/articles/articleTabs'
import {StickyColumn} from '../../../../components/main/common/stickyColumn'
import {ReviewArticleDetails} from '../../../../components/main/projects/reviews/review/reviewArticleDetails'
import {ReviewAvailableJudgments} from '../../../../components/main/projects/reviews/review/reviewAvailableJudgments'
import {fetchArticleDetails} from '../../../../services/articlesService'
import {getArticleDocumentTitle} from '../../../utils/getArticleDocumentTitle'

const ArticleDetails = () => {
  const params = Route.useParams()
  const [articleViewToShow, setArticleViewToShow] = createSignal<string | undefined>(undefined)
  const [isFulltextExpanded, setIsFulltextExpanded] = createSignal(false)

  const articleQuery = useQuery(() => {
    return {
      queryKey: ['article-details', params().id],
      queryFn: () => {
        return fetchArticleDetails(params().id)
      },
    }
  })

  const selectedJudgment = createMemo(() => {
    const data = articleQuery.data
    const selectedId = articleViewToShow()
    if (!data || !selectedId) return undefined

    return data.allJudgments.find((j) => {
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
        <div class="flex items-center gap-4 mb-4">
          <h1 class="text-2xl font-bold">Article View</h1>
        </div>

        <Show when={articleQuery.isLoading}>
          <div class="p-4 bg-white rounded-lg shadow">Loading...</div>
        </Show>

        <Show when={articleQuery.error}>
          <div class="p-4 bg-red-50 rounded-lg shadow">
            <p class="text-red-600">
              Error loading article:{' '}
              {articleQuery.error instanceof Error ? articleQuery.error.message : 'Unknown error'}
            </p>
          </div>
        </Show>

        <Show when={!articleQuery.isLoading && !articleQuery.error && articleQuery.data}>
          {(data) => {
            return (
              <div class="flex gap-6">
                <div class="flex-1 space-y-6">
                  <ArticleTabs
                    activeTab="summary"
                    hasFullText={hasFullText()}
                    fullTextPDF={data().article.fullTextPDF}
                    basePath={`/articles/${params().id}`}
                  />

                  <ReviewArticleDetails
                    article={data().article}
                    judgment={selectedJudgment()}
                    showTitle={false}
                    enableSticky={true}
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
                    <ArticleAdminSection articleId={params().id} />
                  </Suspense>
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
      </div>
    </div>
  )
}

export const Route = createFileRoute('/articles/$id/')({component: ArticleDetails})
