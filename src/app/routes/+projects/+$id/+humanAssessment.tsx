import {createForm} from '@tanstack/solid-form'
import {useMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'
import {decodeAndSanitize} from '../../../utils/decodeAndSanitize'
import {useArchivedProjectRedirect, useProjectAccessQuery} from '../projectAccessGuard'

const humanAssessmentEmptyStateMessages = new Set(['No articles left to judge', 'No pending human assessments found'])

const getHumanAssessmentErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown error'
}

const isHumanAssessmentEmptyStateError = (error: unknown): boolean => {
  return humanAssessmentEmptyStateMessages.has(getHumanAssessmentErrorMessage(error))
}

type HumanAssessmentPrompt = {id: string; originalText: string; type: string | null}
type HumanAssessmentJudgment = {id: string; promptId: string}
type HumanAssessmentData = {
  project: {name: string}
  article: {articleTitle: string | null; articleSummary: string | null}
  prompts: HumanAssessmentPrompt[]
  judgmentsHuman: HumanAssessmentJudgment[]
}

export const HumanAssessment = () => {
  const params = Route.useParams()
  const queryClient = useQueryClient()
  const projectAccessQuery = useProjectAccessQuery(() => {
    return params().id
  })

  useArchivedProjectRedirect(projectAccessQuery)

  const query = useQuery(() => {
    return {
      queryKey: ['human-assessment-init', params().id],
      queryFn: async () => {
        const response = await apiClient.api.humanassessment.init.post({projectId: params().id})
        const {data} = handleApiResponse<{data: HumanAssessmentData}>(response, 'Failed to initialize human assessment')
        return data
      },
      enabled: !!params().id && projectAccessQuery.data !== undefined && !projectAccessQuery.data.archived,
      staleTime: 0,
    }
  })

  const data = () => {
    return query.data
  }
  const submitMutation = useMutation(() => {
    return {
      mutationFn: async (values: Record<string, string>) => {
        const answers = Object.entries(values).map(([judgmentHumanId, answer]) => {
          return {judgmentHumanId, answer}
        })

        const response = await apiClient.api.humanassessment.submit.post({projectId: params().id, answers})
        const {data} = handleApiResponse<{data: unknown}>(response, 'Failed to submit assessment')
        return data
      },
      onSuccess: async () => {
        form.reset()
        await queryClient.refetchQueries({queryKey: ['human-assessment-init', params().id]})
      },
    }
  })

  const form = createForm(() => {
    return {
      defaultValues: {} as Record<string, string>,
      onSubmit: async ({value}) => {
        await submitMutation.mutateAsync(value)
      },
    }
  })

  const parsePromptType = (typeStr: string | null) => {
    if (!typeStr) return {kind: 'string', isOptional: false}

    const isOptional = typeStr.toLowerCase().includes('null')
    const cleanType = typeStr.replace(/\s*\|\s*null/gi, '').trim()

    // Check if it's an enum (contains quotes and pipes)
    if (cleanType.includes("'") || cleanType.includes('"')) {
      const options = cleanType
        .split('|')
        .map((opt) => {
          return opt.trim().replace(/['"]/g, '')
        })
        .filter(Boolean)
      return {kind: 'enum' as const, options, isOptional}
    }

    return {kind: 'string' as const, isOptional}
  }

  return (
    <Show
      when={!projectAccessQuery.isLoading && !projectAccessQuery.isError && !projectAccessQuery.data?.archived}
      fallback={
        <div class="min-h-screen bg-gray-50 p-6 mx-auto text-center py-8 text-red-600">
          {projectAccessQuery.isError
            ? `Failed to load assessment: ${projectAccessQuery.error instanceof Error ? projectAccessQuery.error.message : String(projectAccessQuery.error)}`
            : 'Loading assessment...'}
        </div>
      }
    >
      <div class="min-h-screen bg-gray-50 p-6 mx-auto">
        <Show when={query.isLoading}>
          <div class="text-center py-8">Loading assessment...</div>
        </Show>

        <Show when={query.isError}>
          <Show
            when={isHumanAssessmentEmptyStateError(query.error)}
            fallback={
              <div class="text-center py-8 text-red-600">
                Failed to load assessment: {getHumanAssessmentErrorMessage(query.error)}
              </div>
            }
          >
            <div class="max-w-2xl mx-auto py-10">
              <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-6 py-8 text-center">
                <h2 class="text-xl font-semibold text-emerald-900">All caught up</h2>
                <p class="mt-2 text-sm text-emerald-800">
                  There are no articles left to judge in this project right now.
                </p>
                <p class="mt-1 text-sm text-emerald-700">
                  Check back later after more articles are added for assessment.
                </p>
              </div>
            </div>
          </Show>
        </Show>

        <Show when={!query.isLoading && !query.isError && data()}>
          <div class="flex justify-between items-center mb-6">
            <div class="flex items-center gap-4">
              <h1 class="text-2xl font-bold">Human Assessment</h1>
              <span class="text-sm text-muted-foreground">for {data()?.project.name}</span>
            </div>
          </div>

          <div class="max-w-5xl mx-auto">
            <div class="space-y-6">
              <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="space-y-3">
                  <div>
                    <div class="text-sm text-gray-500 mb-1">Title</div>
                    {/* eslint-disable solid/no-innerhtml */}
                    <div
                      class="text-lg font-semibold"
                      innerHTML={decodeAndSanitize(data()?.article.articleTitle ?? '')}
                    />
                    {/* eslint-enable solid/no-innerhtml */}
                  </div>
                  <div>
                    <div class="text-sm text-gray-500 mb-1">Abstract</div>
                    {/* eslint-disable solid/no-innerhtml */}
                    <div
                      class="text-gray-900 leading-relaxed assessment-container"
                      innerHTML={decodeAndSanitize(data()?.article.articleSummary ?? '')}
                    />
                    {/* eslint-enable solid/no-innerhtml */}
                  </div>
                </div>
              </section>

              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void form.handleSubmit()
                }}
              >
                <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <div class="space-y-6">
                    <For each={data()?.prompts ?? []}>
                      {(prompt) => {
                        const judgment = data()?.judgmentsHuman.find((j) => {
                          return j.promptId === prompt.id
                        })

                        if (!judgment) {
                          return null
                        }

                        const promptType = parsePromptType(prompt?.type ?? null)
                        return (
                          <form.Field
                            name={judgment.id}
                            defaultValue=""
                            children={(field) => {
                              return (
                                <div class="border rounded-md p-4">
                                  <div class="font-medium mb-3">
                                    {/* eslint-disable solid/no-innerhtml */}
                                    <span innerHTML={decodeAndSanitize(prompt?.originalText ?? '')} />
                                    {/* eslint-enable solid/no-innerhtml */}
                                    {!promptType.isOptional && <span class="text-red-500 ml-1">*</span>}
                                    {promptType.isOptional && (
                                      <span class="text-blue-500 ml-1 text-sm">(optional)</span>
                                    )}
                                  </div>
                                  {promptType.kind === 'string' && (
                                    <input
                                      type="text"
                                      class="w-full max-w-xl border border-gray-300 rounded-md p-2 text-sm"
                                      placeholder="Enter your answer"
                                      value={field().state.value ?? ''}
                                      onInput={(e) => {
                                        field().handleChange(e.currentTarget.value)
                                      }}
                                    />
                                  )}
                                  {promptType.kind === 'enum' && (
                                    <div class="space-y-2">
                                      <For each={promptType.options}>
                                        {(option) => {
                                          return (
                                            <label class="flex items-center gap-2 cursor-pointer">
                                              <input
                                                type="radio"
                                                name={judgment.id}
                                                value={option}
                                                checked={field().state.value === option}
                                                onChange={(e) => {
                                                  field().handleChange(e.currentTarget.value)
                                                }}
                                                class="w-4 h-4 text-blue-600"
                                              />
                                              <span class="text-sm">{option}</span>
                                            </label>
                                          )
                                        }}
                                      </For>
                                    </div>
                                  )}
                                </div>
                              )
                            }}
                          />
                        )
                      }}
                    </For>
                  </div>
                </section>

                <div class="flex items-center gap-3 mt-4">
                  <button
                    type="submit"
                    class="px-4 py-2 rounded-md bg-blue-600 text-white disabled:opacity-50"
                    disabled={submitMutation.isPending}
                  >
                    {submitMutation.isPending ? 'Submitting...' : 'Submit Assessment'}
                  </button>
                  {submitMutation.isSuccess && (
                    <span class="text-green-600 text-sm">Assessment submitted successfully!</span>
                  )}
                </div>
              </form>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}

export const Route = createFileRoute('/projects/$id/humanAssessment')({component: HumanAssessment})
