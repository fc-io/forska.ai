import {For, Show} from 'solid-js'

import {ReviewHumanJudgmentItem} from './reviewHumanJudgmentItem.tsx'

type HumanGroup = {
  userId: string
  userName: string
  judgments: Array<{id: string; prompt: {originalText: string}; answer: string | null; comment: string | null}>
}

type ReviewHumanAssessmentsProps = {groups?: HumanGroup[]}

export const ReviewHumanAssessments = (props: ReviewHumanAssessmentsProps) => {
  return (
    <Show when={props.groups && props.groups.length > 0}>
      <div class="space-y-6 mt-6">
        <For each={props.groups}>
          {(group) => {
            return (
              <div class="bg-white rounded-lg shadow h-fit">
                <div class="p-4 border-b">
                  <h2 class="text-lg font-bold">{group.userName}</h2>
                </div>
                <div class="p-2">
                  <For each={group.judgments}>
                    {(judgment) => {
                      return <ReviewHumanJudgmentItem judgment={judgment} />
                    }}
                  </For>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
