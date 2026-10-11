import {formatDate} from 'date-fns'
import {Show} from 'solid-js'

import type {JudgmentJobStopConditions, JudgmentJobStopReason} from '../../../../../utils/judgmentJobStopConditions.ts'
import {formatJudgmentJobStopReason} from '../jobsPageShared'

type JobStopReasonBannerProps = {
  conditions: JudgmentJobStopConditions
  resumeBlockedHint: string | null
  stopReason: JudgmentJobStopReason
  stopReasonAt: Date | null
}

const getResumeGuidance = ({
  resumeBlockedHint,
  stopReason,
  stopWhenHumanAnsweredDone,
}: {
  resumeBlockedHint: string | null
  stopReason: JudgmentJobStopReason
  stopWhenHumanAnsweredDone: boolean
}) => {
  const humanAnsweredGuidance =
    stopReason === 'human_answered_done' && stopWhenHumanAnsweredDone
      ? 'Resume to judge newly human-answered articles, or turn the condition off to judge the rest.'
      : 'Resume to continue judging.'

  return resumeBlockedHint ?? humanAnsweredGuidance
}

export const JobStopReasonBanner = (props: JobStopReasonBannerProps) => {
  return (
    <div
      role="status"
      class="break-words rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 [overflow-wrap:anywhere]"
    >
      <p class="font-medium">
        Paused by stop condition:{' '}
        {formatJudgmentJobStopReason({
          conditions: props.conditions,
          reason: props.stopReason,
          stopReasonAt: props.stopReasonAt,
        })}
      </p>
      <Show when={props.stopReasonAt}>
        {(stopReasonAt) => {
          return <p class="mt-1 text-xs opacity-75">Paused at {formatDate(stopReasonAt(), 'yyyy-MM-dd HH:mm:ss')}</p>
        }}
      </Show>
      <p class="mt-2">
        {getResumeGuidance({
          resumeBlockedHint: props.resumeBlockedHint,
          stopReason: props.stopReason,
          stopWhenHumanAnsweredDone: props.conditions.stopWhenHumanAnsweredDone,
        })}
      </p>
    </div>
  )
}
