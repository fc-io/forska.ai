import {createForm} from '@tanstack/solid-form'
import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import DOMPurify from 'dompurify'
import {createEffect, createMemo, createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

const stripQuotes = (s: string) => {
  const t = s.trim()
  const q = t[0]
  if ((q === '"' || q === "'") && t[t.length - 1] === q) {
    return t.slice(1, -1)
  }
  return t
}

const getEnumOptions = (typeStr?: string | null): string[] => {
  if (!typeStr) return []
  const parts = typeStr.split('|').map((p) => {
    return p.trim()
  })
  if (parts.length < 2) return []
  const options = parts
    .filter((p) => {
      return p !== 'null' && p !== 'undefined'
    })
    .map((p) => {
      return stripQuotes(p)
    })
  const hadAllQuoted = parts
    .filter((p) => {
      return p !== 'null' && p !== 'undefined'
    })
    .every((p) => {
      const t = p.trim()
      const q = t[0]
      return (q === '"' || q === "'") && t[t.length - 1] === q
    })
  return hadAllQuoted ? options : []
}

const typeIncludesNull = (typeStr?: string | null): boolean => {
  if (!typeStr) return false
  return typeStr.split('|').some((p) => {
    return p.trim() === 'null'
  })
}

type PromptAnswer = {
  prompt: string
  notes: string
  promptId?: string
  judgmentHumanId?: string
  promptType?: string | null
}

const isNonEmpty = (v: unknown): boolean => {
  return v != null && String(v).trim() !== ''
}

type HumanAssessmentInitResponse = {
  project: {id: string; name: string}
  article: {id: string; articleTitle: string; articleSummary: string | null}
  prompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    order: number | null
    type: string | null
  }>
  judgmentsHuman: Array<{id: string; promptId: string}>
}

const placeholderTitle = 'Loading article title…'
const placeholderAbstract = 'Loading abstract…'

export const HumanAssessment = () => {
  const params = Route.useParams()
  const projectId = createMemo(() => {
    return params().id
  })

  const [answers, setAnswers] = createSignal<PromptAnswer[]>([])
  const form = createForm(() => {
    const defaults = answers().reduce<Record<string, string>>((acc, a, i) => {
      const k = a.judgmentHumanId || a.promptId || `prompt-${i}`
      acc[k] = ''
      return acc
    }, {})
    return {
      defaultValues: defaults,
      onSubmit: async ({value}) => {
        const payload = {
          projectId: projectId(),
          answers: answers()
            .map((a, i) => {
              const k = a.judgmentHumanId || a.promptId || `prompt-${i}`
              return {meta: a, value: value[k] as unknown as string | null}
            })
            .filter(({meta, value}) => {
              const optional = typeIncludesNull(meta.promptType)
              const hasValue = value !== null && String(value).trim() !== ''
              return optional ? hasValue : true
            })
            .map(({meta, value}) => {
              return {
                judgmentHumanId: meta.judgmentHumanId!,
                answer: String(value ?? ''),
                comment: meta.notes?.trim() ? meta.notes : undefined,
              }
            }),
        }

        const response = await apiClient.api.humanassessment.submit.post(payload)
        const result = handleApiResponse<{data: {updated: number}}>(response, 'Failed to submit assessment')
        if (result.data.updated > 0) {
          setAnswers([])
          void initQuery.refetch()
        }
      },
    }
  })

  const initQuery = useQuery(() => {
    return {
      queryKey: ['human-assessment-init', projectId()],
      queryFn: async () => {
        const response = await apiClient.api.humanassessment.init.post({projectId: projectId()})
        const result = handleApiResponse<{data: HumanAssessmentInitResponse}>(
          response,
          'Failed to initialize human assessment',
        )
        return result.data
      },
      enabled: !!projectId(),
      staleTime: 0,
    }
  })

  const currentData = createMemo<HumanAssessmentInitResponse | undefined>(() => {
    return typeof initQuery.data === 'function'
      ? (initQuery.data as unknown as () => HumanAssessmentInitResponse | undefined)()
      : (initQuery.data as unknown as HumanAssessmentInitResponse | undefined)
  })

  const projectName = createMemo<string>(() => {
    return currentData()?.project.name ?? ''
  })
  const articleTitle = createMemo<string>(() => {
    return currentData()?.article.articleTitle ?? placeholderTitle
  })
  const articleAbstract = createMemo<string>(() => {
    return currentData()?.article.articleSummary ?? placeholderAbstract
  })

  const sanitizedAbstract = createMemo<TrustedHTML | string>(() => {
    const clean = DOMPurify.sanitize(articleAbstract() ?? '')
    const tt = (
      globalThis as unknown as {
        trustedTypes?: {
          createPolicy: (
            name: string,
            p: {createHTML: (s: string) => string},
          ) => {createHTML: (s: string) => TrustedHTML}
        }
      }
    ).trustedTypes
    const policy = tt?.createPolicy('humanAssessment#abstract', {
      createHTML: (s: string) => {
        return s
      },
    })
    return policy ? policy.createHTML(clean) : clean
  })

  createEffect(() => {
    const d =
      typeof initQuery.data === 'function'
        ? (initQuery.data as unknown as () => HumanAssessmentInitResponse | undefined)()
        : (initQuery.data as unknown as HumanAssessmentInitResponse | undefined)

    if (!d) return
    const judgmentsMap = new Map<string, string>(
      d.judgmentsHuman.map((j) => {
        return [j.promptId, j.id]
      }),
    )

    setAnswers(
      d.prompts.map((p) => {
        return {
          prompt: p.originalText,
          notes: '',
          promptId: p.id,
          judgmentHumanId: judgmentsMap.get(p.id),
          promptType: p.type ?? 'string',
        }
      }),
    )
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <h1 class="text-2xl font-bold">Human Assessment</h1>
          <Show when={projectName()}>
            <span class="text-sm text-muted-foreground">for {projectName()}</span>
          </Show>
        </div>
      </div>

      <div class="max-w-5xl mx-auto">
        <Suspense>
          <Show when={initQuery.isLoading}>
            <div class="p-4 bg-white rounded-lg shadow">
              <p class="text-gray-500">Initializing assessment…</p>
            </div>
          </Show>

          <Show when={initQuery.error}>
            <div class="p-4 bg-red-50 rounded-lg shadow">
              <p class="text-red-600">{String(initQuery.error)}</p>
            </div>
          </Show>

          <div class="space-y-6">
            <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div class="space-y-3">
                <div>
                  <div class="text-sm text-gray-500 mb-1">Title</div>
                  <div class="text-lg font-semibold">{articleTitle()}</div>
                </div>
                <div>
                  <div class="text-sm text-gray-500 mb-1">Abstract</div>
                  <div class="text-gray-900 leading-relaxed assessment-container" innerHTML={sanitizedAbstract()} />
                </div>
              </div>
            </section>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                void form.handleSubmit()
              }}
            >
              <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="space-y-6">
                  <For each={answers()}>
                    {(item, i) => {
                      const typeStr = item.promptType ?? 'string'
                      const enumOptions = getEnumOptions(typeStr)
                      const isOptional = typeIncludesNull(typeStr)
                      const groupName = item.judgmentHumanId || item.promptId || `prompt-${i()}`
                      return (
                        <div class="border rounded-md p-4">
                          <div class="font-medium mb-3">
                            {item.prompt}
                            <Show when={isOptional}>
                              <span class="ml-2 text-blue-600 text-sm">(optional)</span>
                            </Show>
                          </div>
                          <form.Field
                            name={groupName as never}
                            validators={{
                              onMount: ({value}) => {
                                return isOptional || isNonEmpty(value) ? undefined : 'Required'
                              },
                              onChange: ({value}) => {
                                return isOptional || isNonEmpty(value) ? undefined : 'Required'
                              },
                              onSubmit: ({value}) => {
                                return isOptional || isNonEmpty(value) ? undefined : 'Required'
                              },
                            }}
                          >
                            {(field) => {
                              return (
                                <Show
                                  when={enumOptions.length > 0}
                                  fallback={
                                    <input
                                      type="text"
                                      class="w-full max-w-xl border border-gray-300 rounded-md p-2 text-sm"
                                      name={groupName}
                                      value={String(field().state.value ?? '')}
                                      onInput={(e) => {
                                        field().setValue((e.currentTarget as HTMLInputElement).value as never)
                                      }}
                                      placeholder="Enter your answer"
                                    />
                                  }
                                >
                                  <div class="flex items-center gap-4 mb-3">
                                    <For each={enumOptions}>
                                      {(opt) => {
                                        return (
                                          <label class="inline-flex items-center gap-2 text-sm">
                                            <input
                                              type="radio"
                                              name={groupName}
                                              class="accent-blue-600"
                                              value={opt}
                                              checked={String(field().state.value ?? '') === opt}
                                              onChange={() => {
                                                field().setValue(opt as never)
                                              }}
                                            />
                                            {opt.charAt(0).toUpperCase() + opt.slice(1)}
                                          </label>
                                        )
                                      }}
                                    </For>
                                  </div>
                                </Show>
                              )
                            }}
                          </form.Field>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </section>

              <div class="flex items-center gap-3 mt-4">
                <form.Subscribe
                  selector={(s) => {
                    return s.canSubmit
                  }}
                >
                  {(canSubmit) => {
                    return (
                      <Button type="submit" disabled={!canSubmit()}>
                        Submit Assessment
                      </Button>
                    )
                  }}
                </form.Subscribe>
              </div>
            </form>
          </div>
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/humanAssessment')({component: HumanAssessment})
