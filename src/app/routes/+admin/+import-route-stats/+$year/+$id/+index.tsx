import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createEffect, createSignal, Show, Suspense} from 'solid-js'

import {ArticleAdminSection} from '../../../../../../components/main/articles/articleAdminSection'
import {ArticleTabs} from '../../../../../../components/main/articles/articleTabs'
import {StickyColumn} from '../../../../../../components/main/common/stickyColumn'
import {ReviewArticleDetails} from '../../../../../../components/main/projects/reviews/review/reviewArticleDetails'
import {ReviewAvailableJudgments} from '../../../../../../components/main/projects/reviews/review/reviewAvailableJudgments'
import {fetchArticleDetails} from '../../../../../../services/articlesService'
import {fetchSession} from '../../../../../../services/fetchSession'
import {getArticleDocumentTitle} from '../../../../../utils/getArticleDocumentTitle'

const AdminImportRouteStatsArticleDetails = () => {
  const params = Route.useParams()
  const year = () => {
    return (params() as {year: string; id: string}).year
  }
  const articleId = () => {
    return (params() as {year: string; id: string}).id
  }

  const [articleViewToShow, setArticleViewToShow] = createSignal<string | undefined>(undefined)
  const [isFulltextExpanded, setIsFulltextExpanded] = createSignal(false)

  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const articleQuery = useQuery(() => {
    return {
      queryKey: ['admin-import-route-stats-article-details', articleId()],
      queryFn: () => {
        return fetchArticleDetails(articleId())
      },
    }
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

  const basePath = () => {
    return `/admin/import-route-stats/${year()}/${articleId()}`
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-7xl mx-auto space-y-6">
        <Link
          to="/admin/import-route-stats/$year"
          params={{year: year()}}
          class="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to {year()} articles
        </Link>

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
                      basePath={basePath()}
                    />

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
                    <Show when={isAdmin()}>
                      <Suspense
                        fallback={
                          <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 animate-pulse">
                            <div class="h-4 bg-amber-200 rounded w-24 mb-2" />
                            <div class="h-3 bg-amber-200 rounded w-full" />
                          </div>
                        }
                      >
                        <ArticleAdminSection articleId={articleId()} />
                      </Suspense>
                    </Show>
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

export const Route = createFileRoute('/admin/import-route-stats/$year/$id/')({
  component: AdminImportRouteStatsArticleDetails,
})
