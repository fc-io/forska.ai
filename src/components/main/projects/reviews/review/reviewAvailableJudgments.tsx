import {For, Show} from 'solid-js'

import {ReviewJudgmentItem} from './reviewJudgmentItem.tsx'

type Judgment = {
  id: string
  promptId: string
  answeredOriginal?: string | null
  confidenceOriginal?: number | null
  explanation?: string | null
  quotes?: unknown
  snapshotProjectId?: string | null
  snapshotProjectModelName?: string | null
  modelName?: string | null
  prompt?: {id?: string; originalText: string; promptHeading?: string | null; contentHash?: string | null}
}

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type ReviewAvailableJudgmentsProps = {
  judgments?: Judgment[]
  projectsById?: Record<string, {name: string}>
  setArticleViewToShow: SetArticleViewToShow
}

export const ReviewAvailableJudgments = (props: ReviewAvailableJudgmentsProps) => {
  const projectName = (projectId: string) => {
    if (!projectId) return 'Other/Unknown'
    return props.projectsById?.[projectId]?.name || projectId
  }

  const groupedByProject = () => {
    const list = props.judgments || []
    const byProject: Record<string, Judgment[]> = {}
    for (const j of list) {
      const key = j.snapshotProjectId || 'unknown'
      const arr = byProject[key] || []
      byProject[key] = [...arr, j]
    }
    return byProject
  }

  const sortedProjectIds = () => {
    const ids = Object.keys(groupedByProject())
    return ids.sort((a, b) => {
      return projectName(a).localeCompare(projectName(b))
    })
  }

  const sortJudgments = (list: Judgment[]) => {
    const copy = [...list]
    copy.sort((a, b) => {
      const ah = a.prompt?.promptHeading || a.prompt?.originalText || ''
      const bh = b.prompt?.promptHeading || b.prompt?.originalText || ''
      return ah.localeCompare(bh)
    })
    return copy
  }

  return (
    <div class="bg-white rounded-lg shadow h-fit mt-6">
      <div class="p-4 border-b">
        <h2 class="text-lg font-bold">Available Judgments (Cross-Project)</h2>
      </div>
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
                              },
                              answeredOriginal: j.answeredOriginal,
                              confidenceOriginal: j.confidenceOriginal ?? undefined,
                              explanation: j.explanation ?? undefined,
                              quotes: j.quotes,
                              modelName: j.modelName,
                              snapshotProjectModelName: j.snapshotProjectModelName,
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
    </div>
  )
}
