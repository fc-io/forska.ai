import {For, Show} from 'solid-js'

type ReviewHumanAggregatesProps = {
  prompts: Array<{id: string; originalText: string}>
  humanAnswersByPrompt?: Record<string, string[]>
}

export const ReviewHumanAggregates = (props: ReviewHumanAggregatesProps) => {
  const countsFor = (promptId: string) => {
    const answers = props.humanAnswersByPrompt?.[promptId] ?? []
    const map = new Map<string, number>()
    for (const a of answers) {
      const key = String(a)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => {
      return b[1] - a[1]
    })
  }

  return (
    <Show when={props.prompts.length > 0}>
      <div class="bg-white rounded-lg shadow h-fit mt-6">
        <div class="p-4 border-b">
          <h2 class="text-lg font-bold">Human answers (aggregated)</h2>
        </div>
        <div class="p-2 space-y-3">
          <For each={props.prompts}>
            {(p) => {
              const rows = countsFor(p.id)
              return (
                <div>
                  <p class="text-sm font-medium text-gray-900 line-clamp-2">{p.originalText}</p>
                  <Show when={rows.length > 0} fallback={<p class="text-xs text-gray-500">No answers yet</p>}>
                    <div class="mt-1 flex flex-wrap gap-2">
                      <For each={rows}>
                        {([answer, count]) => {
                          return (
                            <span class="px-2 py-1 text-xs rounded bg-gray-100 text-gray-800">{answer}: {count}</span>
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
      </div>
    </Show>
  )
}
