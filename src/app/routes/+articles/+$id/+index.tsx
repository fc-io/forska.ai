import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Show, Suspense} from 'solid-js'

import {ArticleTabs} from '../../../../components/main/articles/articleTabs'
import {StickyColumn} from '../../../../components/main/common/stickyColumn'
import {ReviewArticleDetails} from '../../../../components/main/projects/reviews/review/reviewArticleDetails'
import {ReviewAvailableJudgments} from '../../../../components/main/projects/reviews/review/reviewAvailableJudgments'
import {fetchArticleDetails} from '../../../../services/articlesService'

const AdminArticleDetails = () => {
  const params = Route.useParams()
  const [articleViewToShow, setArticleViewToShow] = createSignal<string | undefined>(undefined)
  const [isFulltextExpanded, setIsFulltextExpanded] = createSignal(false)

  const articleQuery = useQuery(() => {
    return {
      queryKey: ['admin-article-details', params().id],
      queryFn: () => {
        return fetchArticleDetails(params().id)
      },
    }
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
          <h1 class="text-2xl font-bold">Admin Article View</h1>
        </div>

        <Suspense fallback={<div class="p-4 bg-white rounded-lg shadow">Loading...</div>}>
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
                    <ArticleTabs
                      activeTab="summary"
                      hasFullText={hasFullText()}
                      fullTextPDF={data().article.fullTextPDF}
                      basePath={`/articles/${params().id}`}
                    />

                    {/* Default view: no selection */}
                    <Show when={articleViewToShow() === undefined}>
                      <ReviewArticleDetails
                        article={data().article}
                        showTitle={false}
                        enableSticky={true}
                        isFulltextExpanded={isFulltextExpanded()}
                        setIsFulltextExpanded={setIsFulltextExpanded}
                        viewMode="summary"
                        hidePdfButton={true}
                      />
                    </Show>

                    {/* LLM judgment selected */}
                    <Show
                      when={
                        articleViewToShow() !== undefined
                        && data().allJudgments.find((j) => {
                          return j.id === articleViewToShow()
                        })
                      }
                    >
                      {(selected) => {
                        return (
                          <ReviewArticleDetails
                            article={data().article}
                            judgment={selected()}
                            showTitle={false}
                            enableSticky={true}
                            isFulltextExpanded={isFulltextExpanded()}
                            setIsFulltextExpanded={setIsFulltextExpanded}
                            viewMode="summary"
                            hidePdfButton={true}
                          />
                        )
                      }}
                    </Show>
                  </div>
                  <StickyColumn class="w-96">
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

export const Route = createFileRoute('/articles/$id/')({component: AdminArticleDetails})
