import {For, Show} from 'solid-js'

type Prompt = {id: string; originalText: string; promptHeading?: string | null}
type Judgment = {id: string; promptId: string; answeredOriginal?: string | null}

type ReviewAvailableJudgmentsProps = {
  prompts: Prompt[]
  judgments?: Judgment[]
  humanAnswersByPrompt?: Record<string, string[]>
}

export const ReviewAvailableJudgments = (props: ReviewAvailableJudgmentsProps) => {
  const answersForPrompt = (pid: string) => {
    const arr = props.humanAnswersByPrompt?.[pid] || []
    return arr
  }
  const llmForPrompt = (pid: string) => {
    const list = (props.judgments || []).filter((j) => {
      return j.promptId === pid
    })
    return list
  }

  return (
    <div class="bg-white rounded-lg shadow h-fit mt-6">
      <div class="p-4 border-b">
        <h2 class="text-lg font-bold">Available Judgments (Cross-Project)</h2>
      </div>
      <div class="p-3 space-y-4">
        <For each={props.prompts}>
          {(p) => {
            const llm = llmForPrompt(p.id)
            const human = answersForPrompt(p.id)
            return (
              <div class="border rounded-md">
                <div class="px-3 py-2 bg-gray-50 border-b">
                  <div class="text-sm font-medium">{p.promptHeading || 'Prompt'}</div>
                  <div class="text-xs text-gray-600 truncate">{p.originalText}</div>
                </div>
                <div class="p-3 grid grid-cols-2 gap-3">
                  <div>
                    <div class="text-sm font-semibold mb-1">LLM</div>
                    <Show when={llm.length > 0} fallback={<div class="text-sm text-gray-500">No LLM judgments</div>}>
                      <ul class="list-disc list-inside text-sm space-y-1">
                        <For each={llm}>
                          {(j) => {
                            return <li>{j.answeredOriginal ?? '—'}</li>
                          }}
                        </For>
                      </ul>
                    </Show>
                  </div>
                  <div>
                    <div class="text-sm font-semibold mb-1">Human</div>
                    <Show when={human.length > 0} fallback={<div class="text-sm text-gray-500">No human answers</div>}>
                      <ul class="list-disc list-inside text-sm space-y-1">
                        <For each={human}>
                          {(ans) => {
                            return <li>{ans}</li>
                          }}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

