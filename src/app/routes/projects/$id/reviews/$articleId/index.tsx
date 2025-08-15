import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../../../services/apiClient.ts'

const ReviewDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string; articleId: string}).id
  const articleId = (params() as {id: string; articleId: string}).articleId

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
                {/* Article Information */}
                <div class="p-6 bg-white rounded-lg shadow">
                  <h1 class="text-2xl font-bold mb-4">Article Details</h1>
                  <div class="space-y-2">
                    <p class="text-lg font-semibold">
                      {data().article.articleTitle}
                    </p>
                    <Show when={data().article.articleAuthors}>
                      <p class="text-gray-600">
                        Authors: {data().article.articleAuthors?.join(', ')}
                      </p>
                    </Show>
                    <Show when={data().article.articleSummary}>
                      <div class="mt-4">
                        <h3 class="font-semibold mb-2">Summary</h3>
                        <p class="text-gray-700">
                          {data().article.articleSummary}
                        </p>
                      </div>
                    </Show>
                  </div>
                </div>

                {/* Review Information */}
                <Show when={data().review}>
                  <div class="p-6 bg-white rounded-lg shadow">
                    <h2 class="text-xl font-bold mb-4">Review Status</h2>
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <div>
                        <span class="font-semibold">Title: </span>
                        <span
                          class={
                            data().review?.reviewedTitle
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }
                        >
                          {data().review?.reviewedTitle
                            ? '✓ Reviewed'
                            : 'Not reviewed'}
                        </span>
                      </div>
                      <div>
                        <span class="font-semibold">Abstract: </span>
                        <span
                          class={
                            data().review?.reviewedAbstract
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }
                        >
                          {data().review?.reviewedAbstract
                            ? '✓ Reviewed'
                            : 'Not reviewed'}
                        </span>
                      </div>
                      <div>
                        <span class="font-semibold">Introduction: </span>
                        <span
                          class={
                            data().review?.reviewedIntro
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }
                        >
                          {data().review?.reviewedIntro
                            ? '✓ Reviewed'
                            : 'Not reviewed'}
                        </span>
                      </div>
                      <div>
                        <span class="font-semibold">Method: </span>
                        <span
                          class={
                            data().review?.reviewedMethod
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }
                        >
                          {data().review?.reviewedMethod
                            ? '✓ Reviewed'
                            : 'Not reviewed'}
                        </span>
                      </div>
                      <div>
                        <span class="font-semibold">Results: </span>
                        <span
                          class={
                            data().review?.reviewedResults
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }
                        >
                          {data().review?.reviewedResults
                            ? '✓ Reviewed'
                            : 'Not reviewed'}
                        </span>
                      </div>
                      <div>
                        <span class="font-semibold">Discussion: </span>
                        <span
                          class={
                            data().review?.reviewedDiscussion
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }
                        >
                          {data().review?.reviewedDiscussion
                            ? '✓ Reviewed'
                            : 'Not reviewed'}
                        </span>
                      </div>
                    </div>
                  </div>
                </Show>

                {/* Judgments and Prompts */}
                <div class="p-6 bg-white rounded-lg shadow">
                  <h2 class="text-xl font-bold mb-4">Judgments</h2>
                  <Show
                    when={data()?.judgments && data()?.judgments.length > 0}
                    fallback={
                      <p class="text-gray-500">No judgments available</p>
                    }
                  >
                    <div class="space-y-4">
                      <For each={data().judgments}>
                        {(judgment) => {
                          return (
                            <div class="border rounded-lg p-4">
                              <div class="mb-2">
                                <span class="font-semibold">Prompt: </span>
                                <span class="text-gray-700">
                                  {judgment.prompt.originalText}
                                </span>
                              </div>
                              <div class="grid grid-cols-2 gap-2 text-sm">
                                <div>
                                  <span class="font-semibold">Answer: </span>
                                  <span
                                    class={
                                      judgment.answeredOriginal === 'yes'
                                        ? 'text-green-600'
                                        : judgment.answeredOriginal === 'no'
                                          ? 'text-red-600'
                                          : 'text-yellow-600'
                                    }
                                  >
                                    {judgment.answeredOriginal}
                                  </span>
                                </div>
                                <Show when={judgment.confidenceOriginal}>
                                  <div>
                                    <span class="font-semibold">
                                      Confidence:{' '}
                                    </span>
                                    <span>{judgment.confidenceOriginal}%</span>
                                  </div>
                                </Show>
                              </div>
                              <Show when={judgment.explanation}>
                                <div class="mt-2">
                                  <span class="font-semibold text-sm">
                                    Explanation:{' '}
                                  </span>
                                  <p class="text-sm text-gray-600 mt-1">
                                    {judgment.explanation}
                                  </p>
                                </div>
                              </Show>

                              {/* Judgment Assessments */}
                              <Show
                                when={
                                  judgment.assessments
                                  && judgment.assessments.length > 0
                                }
                              >
                                <div class="mt-3 pt-3 border-t">
                                  <p class="font-semibold text-sm mb-2">
                                    Assessments:
                                  </p>
                                  <For each={judgment.assessments}>
                                    {(assessment) => {
                                      return (
                                        <div class="bg-gray-50 p-2 rounded text-sm mb-2">
                                          <div class="flex items-center gap-2">
                                            <span
                                              class={
                                                assessment.assessmentIsCorrect
                                                  ? 'text-green-600'
                                                  : 'text-red-600'
                                              }
                                            >
                                              {assessment.assessmentIsCorrect
                                                ? '✓ Correct'
                                                : '✗ Incorrect'}
                                            </span>
                                          </div>
                                          <Show
                                            when={assessment.assessmentComment}
                                          >
                                            <p class="text-gray-600 mt-1">
                                              {assessment.assessmentComment}
                                            </p>
                                          </Show>
                                        </div>
                                      )
                                    }}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
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
