import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {For, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

// type InitResponse = Awaited<ReturnType<typeof apiClient.api.humanassessment.init.post>>

export const HumanAssessment = () => {
  const params = Route.useParams()

  const initQuery = useQuery(() => {
    return {
      queryKey: ['human-assessment-init', params().id],
      queryFn: async () => {
        const response = await apiClient.api.humanassessment.init.post({projectId: params().id})
        const data = handleApiResponse(response, 'Failed to initialize human assessment')
        return data.data
      },
      enabled: !!params().id,
    }
  })

  const data = () => {
    return initQuery.data
  }

  return (
    <Suspense fallback={<div class="min-h-screen bg-gray-50 p-6">Loading assessment...</div>}>
      <div class="min-h-screen bg-gray-50 p-6 mx-auto">
        <div class="flex justify-between items-center mb-6">
          <div class="flex items-center gap-4">
            <h1 class="text-2xl font-bold">Human Assessment</h1>
            {data() && <span class="text-sm text-muted-foreground">for {data.project.name}</span>}
          </div>
        </div>

        <div class="max-w-5xl mx-auto">
          <div class="space-y-6">
            <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div class="space-y-3">
                <div>
                  <div class="text-sm text-gray-500 mb-1">Title</div>
                  <div class="text-lg font-semibold">{data()?.article.articleTitle}</div>
                </div>
                <div>
                  <div class="text-sm text-gray-500 mb-1">Abstract</div>
                  <div class="text-gray-900 leading-relaxed assessment-container">
                    {data()?.article.articleSummary ?? ''}
                  </div>
                </div>
              </div>
            </section>

            <form>
              <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="space-y-6">
                  <For each={data()?.prompts ?? []}>
                    {(p) => {
                      return (
                        <div class="border rounded-md p-4">
                          <div class="font-medium mb-3">{p.originalText}</div>
                          <input
                            type="text"
                            class="w-full max-w-xl border border-gray-300 rounded-md p-2 text-sm"
                            name={p.id}
                            placeholder="Enter your answer"
                          />
                        </div>
                      )
                    }}
                  </For>
                </div>
              </section>

              <div class="flex items-center gap-3 mt-4">
                <button type="submit" class="px-4 py-2 rounded-md bg-blue-600 text-white">
                  Submit Assessment
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </Suspense>
  )
}

export const Route = createFileRoute('/projects/$id/humanAssessment')({component: HumanAssessment})
