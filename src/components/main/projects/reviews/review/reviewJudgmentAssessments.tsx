import {For, Show} from 'solid-js'

type ReviewJudgmentAssessmentsProps = {
  assessments: Array<{assessmentIsCorrect?: boolean | null; assessmentComment?: string | null}>
}

export const ReviewJudgmentAssessments = (props: ReviewJudgmentAssessmentsProps) => {
  return (
    <div class="mt-3 pt-3 border-t">
      <p class="font-semibold text-sm mb-2">Assessments:</p>
      <For each={props.assessments}>
        {(assessment) => {
          return (
            <div class="bg-gray-50 p-2 rounded text-sm mb-2">
              <div class="flex items-center gap-2">
                <span class={assessment.assessmentIsCorrect ? 'text-green-600' : 'text-red-600'}>
                  {assessment.assessmentIsCorrect ? '✓ Correct' : '✗ Incorrect'}
                </span>
              </div>
              <Show when={assessment.assessmentComment}>
                <p class="text-gray-600 mt-1 break-words">{assessment.assessmentComment}</p>
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}
