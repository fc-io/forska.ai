import {createMemo, createSignal, For, Show} from 'solid-js'

import {ReviewJudgmentItem} from './reviewJudgmentItem.tsx'

type Judgment = {
  id: string
  promptId: string
  answeredOriginal?: string | null
  answeredOriginalAsArray?: string[] | null
  confidenceOriginal?: number | null
  explanation?: string | null
  quotes?: unknown
  snapshotProjectId?: string | null
  snapshotProjectModelName?: string | null
  modelName?: string | null
  modelProvider?: string | null
  modelVersion?: string | null
  prompt?: {id?: string; originalText: string; promptHeading?: string | null; contentHash?: string | null}
  useTitle?: boolean
  useAbstract?: boolean
  useFulltext?: boolean
  useFulltextNoImages?: boolean
  chunkingStrategy?: string | null
}

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type ReviewAvailableJudgmentsProps = {
  judgments?: Judgment[]
  projectsById?: Record<string, {name: string}>
  setArticleViewToShow: SetArticleViewToShow
}

export const ReviewAvailableJudgments = (props: ReviewAvailableJudgmentsProps) => {
  const [isOpen, setIsOpen] = createSignal(false)

  const projectName = (projectId: string) => {
    if (!projectId) return 'Other/Unknown'
    return props.projectsById?.[projectId]?.name || projectId
  }

  const count = () => {
    return props.judgments?.length ?? 0
  }

  const groupedByProject = createMemo(() => {
    const list = props.judgments || []
    const byProject: Record<string, Judgment[]> = {}
    for (const j of list) {
      const key = j.snapshotProjectId || 'unknown'
      const arr = byProject[key] || []
      byProject[key] = [...arr, j]
    }
    return byProject
  })

  const sortedProjectIds = createMemo(() => {
    const projectsById = props.projectsById
    const getName = (projectId: string) => {
      if (!projectId) return 'Other/Unknown'
      return projectsById?.[projectId]?.name || projectId
    }
    const ids = Object.keys(groupedByProject())
    return ids.sort((a, b) => {
      return getName(a).localeCompare(getName(b))
    })
  })

  // Pure utility - sorts array without reactivity concerns
  const sortJudgments = (list: Judgment[]): Judgment[] => {
    const copy = [...list]
    copy.sort((a, b) => {
      const ah = a.prompt?.promptHeading || a.prompt?.originalText || ''
      const bh = b.prompt?.promptHeading || b.prompt?.originalText || ''
      return ah.localeCompare(bh)
    })
    return copy
  }

  return (
    <div class="bg-white rounded-lg shadow h-fit mt-6 first:mt-0">
      <div class="p-4 border-b flex items-center justify-between gap-3">
        <div class="flex items-baseline gap-2">
          <h2 class="text-lg font-bold">LLM assessment (Cross-Project)</h2>
          <span class="text-xs text-gray-500">({count()})</span>
        </div>
        <button
          type="button"
          class="p-1 rounded hover:bg-gray-50"
          aria-expanded={isOpen()}
          onClick={() => {
            setIsOpen(!isOpen())
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke="currentColor"
            class="w-4 h-4 transition-transform duration-200"
            classList={{'rotate-90': isOpen()}}
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>

      <Show when={isOpen()}>
        <Show
          when={(props.judgments?.length || 0) > 0}
          fallback={<div class="p-4 text-sm text-gray-500">No cross-project LLM judgments</div>}
        >
          <div class="p-2 space-y-4">
            <For each={sortedProjectIds()}>
              {(pid) => {
                const list = sortJudgments(groupedByProject()[pid] || [])
                return (
                  <div class="rounded-md">
                    <div class="px-3 py-2">
                      <div class="text-sm font-semibold">{projectName(pid)}</div>
                    </div>
                    <div class="p-2">
                      <For each={list}>
                        {(j) => {
                          return (
                            <ReviewJudgmentItem
                              judgment={{
                                id: j.id,
                                promptId: j.promptId,
                                prompt: {
                                  id: j.prompt?.id || j.promptId,
                                  originalText: j.prompt?.originalText || '',
                                  contentHash: j.prompt?.contentHash,
                                  promptHeading: j.prompt?.promptHeading,
                                },
                                answeredOriginal: j.answeredOriginal,
                                answeredOriginalAsArray: j.answeredOriginalAsArray,
                                confidenceOriginal: j.confidenceOriginal ?? undefined,
                                explanation: j.explanation ?? undefined,
                                quotes: j.quotes,
                                modelName: j.modelName,
                                modelProvider: j.modelProvider,
                                modelVersion: j.modelVersion,
                                snapshotProjectModelName: j.snapshotProjectModelName,
                                useTitle: j.useTitle,
                                useAbstract: j.useAbstract,
                                useFulltext: j.useFulltext,
                                useFulltextNoImages: j.useFulltextNoImages,
                                chunkingStrategy: j.chunkingStrategy,
                              }}
                              setArticleViewToShow={props.setArticleViewToShow}
                            />
                          )
                        }}
                      </For>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
