import {
  type JudgmentsJobStopConditionsPatch,
  updateJudgmentsJobStopConditions,
} from '../../../../../../services/judgmentsJobsService'
import {
  type JudgmentJobStopConditions,
  maxJudgmentJobStopAfterArticles,
  maxJudgmentJobStopAfterTotalTokens,
} from '../../../../../../utils/judgmentJobStopConditions.ts'
import {formatNumber} from '../../jobsPageShared'
import {StopConditionCheckboxRow, StopConditionDeadlineRow, StopConditionNumberRow} from './jobStopConditionRows.tsx'

type JobStopConditionMenuProps = {
  admittedArticleCount: number | null
  conditions: JudgmentJobStopConditions
  jobId: string
  onSaved: () => Promise<unknown>
  totalTokens: number
}

const getArticleCapCaption = (admittedArticleCount: number | null, stopAfterArticles: number | null) => {
  return stopAfterArticles === null
    ? 'Off'
    : `${formatNumber(admittedArticleCount ?? 0)} of ${formatNumber(stopAfterArticles)} admitted`
}

const saveStopConditions = async (props: JobStopConditionMenuProps, patch: JudgmentsJobStopConditionsPatch) => {
  await updateJudgmentsJobStopConditions(props.jobId, patch)
  await props.onSaved()
}

export const JobStopConditionMenu = (props: JobStopConditionMenuProps) => {
  return (
    <div class="space-y-1 px-2 pb-1">
      <p class="pt-1 text-xs font-medium text-gray-500">Pause automatically when</p>
      <StopConditionNumberRow
        caption={getArticleCapCaption(props.admittedArticleCount, props.conditions.stopAfterArticles)}
        inputLabel="Pause after this many articles"
        label="Pause after"
        maxValue={maxJudgmentJobStopAfterArticles}
        unit="articles"
        value={props.conditions.stopAfterArticles}
        onSave={(stopAfterArticles) => {
          return saveStopConditions(props, {stopAfterArticles})
        }}
      />
      <StopConditionCheckboxRow
        checked={props.conditions.stopWhenHumanAnsweredDone}
        label="Pause when human-answered articles are done"
        onSave={(stopWhenHumanAnsweredDone) => {
          return saveStopConditions(props, {stopWhenHumanAnsweredDone})
        }}
      />
      <StopConditionNumberRow
        caption={`Current total: ${formatNumber(props.totalTokens)} tokens`}
        inputLabel="Pause after this many tokens"
        label="Pause after"
        maxValue={maxJudgmentJobStopAfterTotalTokens}
        unit="tokens"
        value={props.conditions.stopAfterTotalTokens}
        onSave={(stopAfterTotalTokens) => {
          return saveStopConditions(props, {stopAfterTotalTokens})
        }}
      />
      <StopConditionDeadlineRow
        value={props.conditions.stopAt}
        onSave={(stopAt) => {
          return saveStopConditions(props, {stopAt})
        }}
      />
    </div>
  )
}
